# SPDX-License-Identifier: GPL-3.0-or-later
"""PixelBridge Blender worker.

Run as a separate Blender process:

    blender --background --factory-startup --disable-autoexec \
        --python blender/pixelbridge_bpy.py -- <request.json> <response.json>

Reads one JSON request, performs one operation and always writes a JSON
response. Exit code 0 on success, 2 on a handled error.
"""

from __future__ import annotations

import json
import math
import os
import platform
import re
import sys
import time
import traceback
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

# --------------------------------------------------------------------------
# Limits and constants
# --------------------------------------------------------------------------

MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_PARTS = 300
MAX_SEGMENTS = 128
MAX_RINGS = 64
MAX_SUBDIVISIONS = 6
MAX_SUBSURF = 3
MAX_COORD = 1000.0
MAX_DIMENSION = 1000.0
MAX_ROTATION_DEG = 36000.0
MAX_MATERIALS = 64
MAX_THUMBNAILS = 16
DEFAULT_REFERENCE_HEIGHT = 2.0
NAME_RE = re.compile(r"^[A-Za-z0-9_.\- ]{1,64}$")
HEX_RE = re.compile(r"^#?[0-9A-Fa-f]{6}$")

REF_COLLECTION = "PB_References"
REF_PREFIX = "PB_Ref_"
RIG_PREFIX = "PB_Rig_"

PRIMITIVES = ("cube", "uv_sphere", "ico_sphere", "cylinder", "cone", "torus", "plane")
MODIFIER_TYPES = ("subsurf", "bevel", "solidify", "mirror", "simple_deform")
VIEWS = ("front", "side", "back", "three_quarter", "top")
ENGINES = {"workbench": "BLENDER_WORKBENCH", "eevee": "BLENDER_EEVEE", "cycles": "CYCLES"}
EXPORT_FORMATS = {"glb": ".glb", "gltf": ".gltf", "fbx": ".fbx", "obj": ".obj"}
IMPORT_EXTS = (".glb", ".gltf", ".fbx", ".obj")
IMAGE_EXTS = (".png", ".jpg", ".jpeg")
THUMB_SRC_EXTS = (".png", ".jpg", ".jpeg", ".webp")

PART_KEYS = {"name", "primitive", "params", "location", "rotation", "scale", "material",
             "shading", "modifiers", "mirrorX", "parent"}
SPEC_KEYS = {"name", "parts", "materials", "join", "origin", "referenceHeightM"}
MATERIAL_KEYS = {"baseColor", "roughness", "metallic", "emission", "emissionStrength"}
PARAM_KEYS = {"radius", "radius1", "radius2", "depth", "size", "segments", "rings",
              "subdivisions", "vertices", "majorRadius", "minorRadius", "majorSegments",
              "minorSegments"}
MODIFIER_KEYS = {
    "subsurf": {"type", "levels"},
    "bevel": {"type", "width", "segments"},
    "solidify": {"type", "thickness"},
    "mirror": {"type", "axis"},
    "simple_deform": {"type", "mode", "factor", "angle", "axis"},
}

# Reflection across the YZ plane (x -> -x).
MIRROR_X = Matrix.Diagonal((-1.0, 1.0, 1.0, 1.0))


class PBError(Exception):
    """A handled error reported to the caller with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def log(msg: str) -> None:
    print(f"[pixelbridge] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Validation helpers
# --------------------------------------------------------------------------

def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def req_number(obj: Dict[str, Any], key: str, default: Optional[float], lo: float, hi: float,
               where: str) -> float:
    v = obj.get(key, default)
    if v is None:
        raise PBError("INVALID_SPEC", f"{where}.{key} is required")
    if not _is_number(v):
        raise PBError("INVALID_SPEC", f"{where}.{key} must be a finite number")
    if v < lo or v > hi:
        raise PBError("INVALID_SPEC", f"{where}.{key}={v} out of range [{lo}, {hi}]")
    return float(v)


def req_int(obj: Dict[str, Any], key: str, default: Optional[int], lo: int, hi: int,
            where: str) -> int:
    v = obj.get(key, default)
    if v is None:
        raise PBError("INVALID_SPEC", f"{where}.{key} is required")
    if not _is_number(v) or float(v) != int(v):
        raise PBError("INVALID_SPEC", f"{where}.{key} must be an integer")
    v = int(v)
    if v < lo or v > hi:
        raise PBError("INVALID_SPEC", f"{where}.{key}={v} out of range [{lo}, {hi}]")
    return v


def req_bool(obj: Dict[str, Any], key: str, default: bool, where: str) -> bool:
    v = obj.get(key, default)
    if not isinstance(v, bool):
        raise PBError("INVALID_REQUEST", f"{where}.{key} must be a boolean")
    return v


def req_vec3(obj: Dict[str, Any], key: str, default: Sequence[float], limit: float,
             where: str) -> Tuple[float, float, float]:
    v = obj.get(key, list(default))
    if not isinstance(v, list) or len(v) != 3 or not all(_is_number(x) for x in v):
        raise PBError("INVALID_SPEC", f"{where}.{key} must be an array of 3 finite numbers")
    if any(abs(x) > limit for x in v):
        raise PBError("INVALID_SPEC", f"{where}.{key} components must be within +/-{limit}")
    return (float(v[0]), float(v[1]), float(v[2]))


def req_name(v: Any, where: str) -> str:
    if not isinstance(v, str) or not NAME_RE.match(v):
        raise PBError("INVALID_SPEC",
                      f"{where} must match [A-Za-z0-9_.\\- ] and be 1-64 characters")
    return v


def req_enum(v: Any, allowed: Sequence[str], where: str, code: str = "INVALID_SPEC") -> str:
    if not isinstance(v, str) or v not in allowed:
        raise PBError(code, f"{where} must be one of {list(allowed)}, got {v!r}")
    return v


def req_abs_path(req: Dict[str, Any], key: str, exts: Optional[Sequence[str]] = None,
                 must_exist: bool = False) -> str:
    v = req.get(key)
    if not isinstance(v, str) or not v or "\x00" in v:
        raise PBError("INVALID_REQUEST", f"{key} must be a non-empty string path")
    if not os.path.isabs(v):
        raise PBError("INVALID_REQUEST", f"{key} must be an absolute path")
    v = os.path.normpath(v)
    if exts is not None and not v.lower().endswith(tuple(exts)):
        raise PBError("INVALID_REQUEST", f"{key} must end with one of {list(exts)}")
    if must_exist and not os.path.isfile(v):
        raise PBError("NOT_FOUND", f"{key} does not exist: {v}")
    return v


def warn_unknown(obj: Dict[str, Any], known: set, where: str, warnings: List[str]) -> None:
    for k in obj:
        if k not in known:
            warnings.append(f"ignored unknown key {where}.{k}")


def hex_to_linear(hex_str: str) -> Tuple[float, float, float]:
    """Convert '#RRGGBB' (sRGB) to linear RGB as used by Blender colour sockets."""
    h = hex_str.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (out[0], out[1], out[2])


# --------------------------------------------------------------------------
# Spec validation
# --------------------------------------------------------------------------

def validate_params(primitive: str, params: Any, where: str, warnings: List[str]) -> Dict[str, Any]:
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise PBError("INVALID_SPEC", f"{where} must be an object")
    warn_unknown(params, PARAM_KEYS, where, warnings)
    d = MAX_DIMENSION
    out: Dict[str, Any] = {}
    if primitive == "cube":
        out["size"] = req_number(params, "size", 1.0, 1e-5, d, where)
    elif primitive == "plane":
        out["size"] = req_number(params, "size", 1.0, 1e-5, d, where)
    elif primitive == "uv_sphere":
        out["radius"] = req_number(params, "radius", 0.5, 1e-5, d, where)
        out["segments"] = req_int(params, "segments", 32, 3, MAX_SEGMENTS, where)
        out["rings"] = req_int(params, "rings", 16, 3, MAX_RINGS, where)
    elif primitive == "ico_sphere":
        out["radius"] = req_number(params, "radius", 0.5, 1e-5, d, where)
        out["subdivisions"] = req_int(params, "subdivisions", 2, 1, MAX_SUBDIVISIONS, where)
    elif primitive in ("cylinder", "cone"):
        key = "vertices" if "vertices" in params else "segments"
        out["vertices"] = req_int(params, key, 32, 3, MAX_SEGMENTS, where)
        out["depth"] = req_number(params, "depth", 1.0, 1e-5, d, where)
        if primitive == "cylinder":
            out["radius"] = req_number(params, "radius", 0.5, 1e-5, d, where)
        else:
            r1_default = params.get("radius", 0.5) if _is_number(params.get("radius")) else 0.5
            out["radius1"] = req_number(params, "radius1", r1_default, 0.0, d, where)
            out["radius2"] = req_number(params, "radius2", 0.0, 0.0, d, where)
            if out["radius1"] <= 0 and out["radius2"] <= 0:
                raise PBError("INVALID_SPEC", f"{where}: cone needs radius1 or radius2 > 0")
    elif primitive == "torus":
        out["majorRadius"] = req_number(params, "majorRadius", 0.5, 1e-5, d, where)
        out["minorRadius"] = req_number(params, "minorRadius", 0.15, 1e-5, d, where)
        out["majorSegments"] = req_int(params, "majorSegments", 32, 3, MAX_SEGMENTS, where)
        out["minorSegments"] = req_int(params, "minorSegments", 12, 3, MAX_SEGMENTS, where)
    return out


def validate_modifier(m: Any, where: str, warnings: List[str]) -> Dict[str, Any]:
    if not isinstance(m, dict):
        raise PBError("INVALID_SPEC", f"{where} must be an object")
    mtype = req_enum(m.get("type"), MODIFIER_TYPES, f"{where}.type")
    warn_unknown(m, MODIFIER_KEYS[mtype], where, warnings)
    out: Dict[str, Any] = {"type": mtype}
    if mtype == "subsurf":
        out["levels"] = req_int(m, "levels", 1, 0, MAX_SUBSURF, where)
    elif mtype == "bevel":
        out["width"] = req_number(m, "width", 0.02, 0.0, MAX_DIMENSION, where)
        out["segments"] = req_int(m, "segments", 2, 1, 8, where)
    elif mtype == "solidify":
        out["thickness"] = req_number(m, "thickness", 0.02, -MAX_DIMENSION, MAX_DIMENSION, where)
    elif mtype == "mirror":
        out["axis"] = req_enum(m.get("axis", "x"), ("x", "y", "z"), f"{where}.axis")
    elif mtype == "simple_deform":
        out["mode"] = req_enum(m.get("mode"), ("taper", "bend", "twist"), f"{where}.mode")
        out["axis"] = req_enum(m.get("axis", "z"), ("x", "y", "z"), f"{where}.axis")
        if out["mode"] == "taper":
            out["factor"] = req_number(m, "factor", 0.5, -10.0, 10.0, where)
        else:
            key = "angle" if "angle" in m else "factor"
            out["angle"] = req_number(m, key, 45.0, -3600.0, 3600.0, where)
    return out


def validate_spec(spec: Any, warnings: List[str]) -> Dict[str, Any]:
    if not isinstance(spec, dict):
        raise PBError("INVALID_SPEC", "spec must be an object")
    warn_unknown(spec, SPEC_KEYS, "spec", warnings)
    out: Dict[str, Any] = {"name": req_name(spec.get("name"), "spec.name")}

    mats_in = spec.get("materials", {}) or {}
    if not isinstance(mats_in, dict):
        raise PBError("INVALID_SPEC", "spec.materials must be an object")
    if len(mats_in) > MAX_MATERIALS:
        raise PBError("INVALID_SPEC", f"at most {MAX_MATERIALS} materials")
    materials: Dict[str, Dict[str, Any]] = {}
    for key, m in mats_in.items():
        where = f"spec.materials.{key}"
        req_name(key, f"material key {key!r}")
        if not isinstance(m, dict):
            raise PBError("INVALID_SPEC", f"{where} must be an object")
        warn_unknown(m, MATERIAL_KEYS, where, warnings)
        bc = m.get("baseColor", "#CCCCCC")
        if not isinstance(bc, str) or not HEX_RE.match(bc):
            raise PBError("INVALID_SPEC", f"{where}.baseColor must be #RRGGBB")
        mat = {
            "baseColor": bc,
            "roughness": req_number(m, "roughness", 0.5, 0.0, 1.0, where),
            "metallic": req_number(m, "metallic", 0.0, 0.0, 1.0, where),
            "emission": None,
            "emissionStrength": 0.0,
        }
        if m.get("emission") is not None:
            em = m["emission"]
            if not isinstance(em, str) or not HEX_RE.match(em):
                raise PBError("INVALID_SPEC", f"{where}.emission must be #RRGGBB")
            mat["emission"] = em
            mat["emissionStrength"] = req_number(m, "emissionStrength", 1.0, 0.0, 1000.0, where)
        materials[key] = mat
    out["materials"] = materials

    parts_in = spec.get("parts")
    if not isinstance(parts_in, list):
        raise PBError("INVALID_SPEC", "spec.parts must be an array (may be empty)")
    if len(parts_in) > MAX_PARTS:
        raise PBError("INVALID_SPEC", f"too many parts ({len(parts_in)} > {MAX_PARTS})")

    parts: List[Dict[str, Any]] = []
    for i, p in enumerate(parts_in):
        where = f"spec.parts[{i}]"
        if not isinstance(p, dict):
            raise PBError("INVALID_SPEC", f"{where} must be an object")
        warn_unknown(p, PART_KEYS, where, warnings)
        prim = req_enum(p.get("primitive"), PRIMITIVES, f"{where}.primitive")
        part = {
            "name": req_name(p.get("name"), f"{where}.name"),
            "primitive": prim,
            "params": validate_params(prim, p.get("params"), f"{where}.params", warnings),
            "location": req_vec3(p, "location", (0, 0, 0), MAX_COORD, where),
            "rotation": req_vec3(p, "rotation", (0, 0, 0), MAX_ROTATION_DEG, where),
            "scale": req_vec3(p, "scale", (1, 1, 1), MAX_COORD, where),
            "shading": req_enum(p.get("shading", "smooth"), ("smooth", "flat"), f"{where}.shading"),
            "mirrorX": req_bool(p, "mirrorX", False, where),
            "material": None,
            "parent": None,
            "modifiers": [],
        }
        if any(abs(s) < 1e-6 for s in part["scale"]):
            raise PBError("INVALID_SPEC", f"{where}.scale components must be non-zero")
        if p.get("material") is not None:
            mk = p["material"]
            if not isinstance(mk, str) or mk not in materials:
                raise PBError("INVALID_SPEC", f"{where}.material {mk!r} is not defined in spec.materials")
            part["material"] = mk
        if p.get("parent") is not None:
            part["parent"] = req_name(p["parent"], f"{where}.parent")
        mods = p.get("modifiers", []) or []
        if not isinstance(mods, list) or len(mods) > 8:
            raise PBError("INVALID_SPEC", f"{where}.modifiers must be an array of at most 8")
        part["modifiers"] = [validate_modifier(m, f"{where}.modifiers[{j}]", warnings)
                             for j, m in enumerate(mods)]
        parts.append(part)

    expanded = expand_mirrors(parts)
    if len(expanded) > MAX_PARTS:
        raise PBError("INVALID_SPEC",
                      f"too many parts including mirrored copies ({len(expanded)} > {MAX_PARTS})")
    names = set()
    for p in expanded:
        if p["name"] in names:
            raise PBError("INVALID_SPEC", f"duplicate part name {p['name']!r}")
        names.add(p["name"])
    for p in expanded:
        if p["parent"] is not None and p["parent"] not in names:
            raise PBError("INVALID_SPEC", f"part {p['name']!r} has unknown parent {p['parent']!r}")
        if p["parent"] == p["name"]:
            raise PBError("INVALID_SPEC", f"part {p['name']!r} cannot parent itself")
    _check_parent_cycles(expanded)
    out["parts"] = expanded

    out["join"] = req_bool(spec, "join", False, "spec")
    out["origin"] = req_enum(spec.get("origin", "bottom_center"),
                             ("bottom_center", "center", "none"), "spec.origin")
    rh = spec.get("referenceHeightM")
    out["referenceHeightM"] = None if rh is None else req_number(
        spec, "referenceHeightM", None, 1e-3, MAX_DIMENSION, "spec")
    return out


def _mirror_name(name: str, x: float) -> str:
    for a, b in ((".L", ".R"), (".R", ".L"), ("_L", "_R"), ("_R", "_L")):
        if name.endswith(a):
            return name[: -len(a)] + b
    # Character faces -Y, so its left side is +X.
    return name + (".R" if x >= 0 else ".L")


def expand_mirrors(parts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    mirrored_names = {p["name"]: _mirror_name(p["name"], p["location"][0])
                      for p in parts if p["mirrorX"]}
    out: List[Dict[str, Any]] = []
    for p in parts:
        out.append(dict(p, mirrorOf=None))
        if p["mirrorX"]:
            q = dict(p)
            q["name"] = mirrored_names[p["name"]]
            q["mirrorOf"] = p["name"]
            parent = p["parent"]
            q["parent"] = mirrored_names.get(parent, parent) if parent else None
            out.append(q)
    return out


def _check_parent_cycles(parts: List[Dict[str, Any]]) -> None:
    parent_of = {p["name"]: p["parent"] for p in parts}
    for start in parent_of:
        seen = set()
        cur: Optional[str] = start
        while cur is not None:
            if cur in seen:
                raise PBError("INVALID_SPEC", f"parent cycle involving {start!r}")
            seen.add(cur)
            cur = parent_of.get(cur)


# --------------------------------------------------------------------------
# Scene helpers
# --------------------------------------------------------------------------

def clear_scene() -> None:
    """Remove every object and orphan datablock so we start from an empty scene."""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights,
                 bpy.data.images, bpy.data.armatures, bpy.data.curves):
        for block in list(coll):
            coll.remove(block)
    scene = bpy.context.scene
    for child in list(scene.collection.children):
        bpy.data.collections.remove(child)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    us = scene.unit_settings
    us.system = "METRIC"
    us.scale_length = 1.0
    us.length_unit = "METERS"


def is_reference(obj: bpy.types.Object) -> bool:
    if obj.name.startswith(REF_PREFIX):
        return True
    return any(c.name == REF_COLLECTION for c in obj.users_collection)


def model_mesh_objects() -> List[bpy.types.Object]:
    return [o for o in bpy.context.scene.objects
            if o.type == "MESH" and not is_reference(o) and not o.name.startswith(RIG_PREFIX)]


def open_blend(path: str) -> None:
    try:
        bpy.ops.wm.open_mainfile(filepath=path, load_ui=False)
    except Exception as exc:  # noqa: BLE001
        raise PBError("OPEN_FAILED", f"could not open .blend: {_short(exc)}")


def ensure_parent_dir(path: str) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def _short(exc: BaseException) -> str:
    text = str(exc).strip().splitlines()
    return (text[-1] if text else type(exc).__name__)[:500]


# --------------------------------------------------------------------------
# Mesh construction
# --------------------------------------------------------------------------

def _build_torus(bm: bmesh.types.BMesh, uv_layer, major: float, minor: float,
                 nmaj: int, nmin: int) -> None:
    grid = []
    for i in range(nmaj):
        a = 2 * math.pi * i / nmaj
        ca, sa = math.cos(a), math.sin(a)
        row = []
        for j in range(nmin):
            b = 2 * math.pi * j / nmin
            r = major + minor * math.cos(b)
            row.append(bm.verts.new((r * ca, r * sa, minor * math.sin(b))))
        grid.append(row)
    for i in range(nmaj):
        i2 = (i + 1) % nmaj
        for j in range(nmin):
            j2 = (j + 1) % nmin
            f = bm.faces.new((grid[i][j], grid[i2][j], grid[i2][j2], grid[i][j2]))
            uvs = ((i / nmaj, j / nmin), ((i + 1) / nmaj, j / nmin),
                   ((i + 1) / nmaj, (j + 1) / nmin), (i / nmaj, (j + 1) / nmin))
            for loop, uv in zip(f.loops, uvs):
                loop[uv_layer].uv = uv


def build_primitive_mesh(name: str, primitive: str, params: Dict[str, Any],
                         mirror_x: bool) -> bpy.types.Mesh:
    """Create a mesh datablock for a primitive with UVs, centred on its local origin."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    if primitive == "cube":
        bmesh.ops.create_cube(bm, size=params["size"], calc_uvs=True)
    elif primitive == "plane":
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=params["size"] / 2.0,
                              calc_uvs=True)
    elif primitive == "uv_sphere":
        bmesh.ops.create_uvsphere(bm, u_segments=params["segments"], v_segments=params["rings"],
                                  radius=params["radius"], calc_uvs=True)
    elif primitive == "ico_sphere":
        bmesh.ops.create_icosphere(bm, subdivisions=params["subdivisions"],
                                   radius=params["radius"], calc_uvs=True)
    elif primitive == "cylinder":
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=params["vertices"],
                              radius1=params["radius"], radius2=params["radius"],
                              depth=params["depth"], calc_uvs=True)
    elif primitive == "cone":
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=params["vertices"],
                              radius1=params["radius1"], radius2=params["radius2"],
                              depth=params["depth"], calc_uvs=True)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    elif primitive == "torus":
        _build_torus(bm, uv, params["majorRadius"], params["minorRadius"],
                     params["majorSegments"], params["minorSegments"])
    else:
        raise PBError("INVALID_SPEC", f"unknown primitive {primitive!r}")
    if mirror_x:
        bmesh.ops.transform(bm, matrix=MIRROR_X, verts=bm.verts)
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def _mirrored_deform_sign(mode: str, axis: str) -> float:
    """Sign applied to a simple_deform amount so that, on x-mirrored mesh data,
    the result is the exact mirror image of the original part."""
    if mode == "twist":
        return -1.0
    if mode == "taper":
        return -1.0 if axis == "x" else 1.0
    # bend: Blender bends along the axis' secondary coordinate; only Y is asymmetric in x.
    return -1.0 if axis == "y" else 1.0


def add_modifiers(obj: bpy.types.Object, mods: List[Dict[str, Any]], mirrored: bool) -> None:
    for i, m in enumerate(mods):
        t = m["type"]
        name = f"{t}_{i}"
        if t == "subsurf":
            md = obj.modifiers.new(name, "SUBSURF")
            md.levels = m["levels"]
            md.render_levels = m["levels"]
        elif t == "bevel":
            md = obj.modifiers.new(name, "BEVEL")
            md.width = m["width"]
            md.segments = m["segments"]
            md.limit_method = "ANGLE"
        elif t == "solidify":
            md = obj.modifiers.new(name, "SOLIDIFY")
            md.thickness = m["thickness"]
        elif t == "mirror":
            md = obj.modifiers.new(name, "MIRROR")
            md.use_axis = (m["axis"] == "x", m["axis"] == "y", m["axis"] == "z")
            md.use_clip = True
        elif t == "simple_deform":
            md = obj.modifiers.new(name, "SIMPLE_DEFORM")
            md.deform_method = m["mode"].upper()
            md.deform_axis = m["axis"].upper()
            sign = _mirrored_deform_sign(m["mode"], m["axis"]) if mirrored else 1.0
            if m["mode"] == "taper":
                md.factor = m["factor"] * sign
            else:
                md.angle = math.radians(m["angle"]) * sign
        else:
            raise PBError("INVALID_SPEC", f"unknown modifier {t!r}")


def make_material(key: str, m: Dict[str, Any]) -> bpy.types.Material:
    mat = bpy.data.materials.new(key)
    if mat.node_tree is None:
        mat.use_nodes = True
    base = hex_to_linear(m["baseColor"])
    mat.diffuse_color = (*base, 1.0)
    mat.roughness = m["roughness"]
    mat.metallic = m["metallic"]
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (*base, 1.0)
        bsdf.inputs["Roughness"].default_value = m["roughness"]
        bsdf.inputs["Metallic"].default_value = m["metallic"]
        if m["emission"]:
            bsdf.inputs["Emission Color"].default_value = (*hex_to_linear(m["emission"]), 1.0)
            bsdf.inputs["Emission Strength"].default_value = m["emissionStrength"]
    return mat


def _part_matrix(p: Dict[str, Any]) -> Tuple[Vector, Euler, Vector]:
    loc = Vector(p["location"])
    rx, ry, rz = (math.radians(a) for a in p["rotation"])
    if p["mirrorOf"] is not None:
        loc.x = -loc.x
        ry, rz = -ry, -rz
    return loc, Euler((rx, ry, rz), "XYZ"), Vector(p["scale"])


def _has_shear(m: Matrix, tol: float = 1e-5) -> bool:
    """True if a 4x4 matrix cannot be represented exactly as translation/rotation/scale."""
    loc, rot, scl = m.decompose()
    rebuilt = Matrix.LocRotScale(loc, rot, scl)
    return any(abs(m[i][j] - rebuilt[i][j]) > tol for i in range(3) for j in range(3))


def apply_shading(mesh: bpy.types.Mesh, shading: str) -> None:
    if shading == "flat":
        mesh.shade_flat()
    else:
        mesh.shade_smooth()
        mesh.set_sharp_from_angle(angle=math.radians(60.0))


def world_bounds(objs: Sequence[bpy.types.Object]) -> Optional[Tuple[Vector, Vector]]:
    """Bounds of the evaluated (post-modifier) geometry in world space."""
    if not objs:
        return None
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    found = False
    for obj in objs:
        ev = obj.evaluated_get(depsgraph)
        mesh = ev.to_mesh()
        try:
            mw = ev.matrix_world
            for v in mesh.vertices:
                w = mw @ v.co
                found = True
                for i in range(3):
                    if w[i] < lo[i]:
                        lo[i] = w[i]
                    if w[i] > hi[i]:
                        hi[i] = w[i]
        finally:
            ev.to_mesh_clear()
    return (lo, hi) if found else None


def build_parts(spec: Dict[str, Any], warnings: List[str]) -> List[bpy.types.Object]:
    scene = bpy.context.scene
    coll = bpy.data.collections.new(spec["name"])
    scene.collection.children.link(coll)
    materials = {k: make_material(k, m) for k, m in spec["materials"].items()}
    objects: Dict[str, bpy.types.Object] = {}
    for p in spec["parts"]:
        mirrored = p["mirrorOf"] is not None
        mesh = build_primitive_mesh(p["name"], p["primitive"], p["params"], mirrored)
        apply_shading(mesh, p["shading"])
        if p["material"]:
            mesh.materials.append(materials[p["material"]])
        obj = bpy.data.objects.new(p["name"], mesh)
        coll.objects.link(obj)
        loc, rot, scl = _part_matrix(p)
        obj.location = loc
        obj.rotation_mode = "XYZ"
        obj.rotation_euler = rot
        obj.scale = scl
        add_modifiers(obj, p["modifiers"], mirrored)
        objects[p["name"]] = obj
    bpy.context.view_layer.update()
    # Spec transforms are world-space; parenting only builds the hierarchy.
    for p in spec["parts"]:
        if p["parent"]:
            child, parent = objects[p["name"]], objects[p["parent"]]
            child.parent = parent
            child.matrix_parent_inverse = parent.matrix_world.inverted()
            if _has_shear(parent.matrix_world.inverted() @ child.matrix_world):
                warnings.append(
                    f"part {p['name']!r} is rotated relative to non-uniformly scaled parent "
                    f"{p['parent']!r}; glTF/FBX cannot store the resulting shear, so exports "
                    "will approximate its transform (use a uniformly scaled parent or none)")
    bpy.context.view_layer.update()
    unused = set(materials) - {p["material"] for p in spec["parts"] if p["material"]}
    for k in sorted(unused):
        warnings.append(f"material {k!r} is defined but not used")
    return list(objects.values())


def apply_origin(objs: List[bpy.types.Object], mode: str) -> None:
    if mode == "none":
        return
    b = world_bounds(objs)
    if b is None:
        return
    lo, hi = b
    centre = (lo + hi) / 2.0
    offset = Vector((-centre.x, -centre.y, -lo.z if mode == "bottom_center" else -centre.z))
    for obj in objs:
        if obj.parent is None:
            obj.location = obj.location + offset
    bpy.context.view_layer.update()


def join_parts(objs: List[bpy.types.Object], name: str) -> bpy.types.Object:
    """Bake every part (modifiers + transforms) into one mesh object at the world origin."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    coll = objs[0].users_collection[0]
    baked: List[bpy.types.Object] = []
    for obj in objs:
        ev = obj.evaluated_get(depsgraph)
        mesh = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True,
                                               depsgraph=depsgraph)
        mesh.transform(ev.matrix_world)
        if ev.matrix_world.is_negative:
            mesh.flip_normals()
        tmp = bpy.data.objects.new(f"{obj.name}__baked", mesh)
        coll.objects.link(tmp)
        baked.append(tmp)
    old_meshes = [o.data for o in objs]
    for obj in objs:
        bpy.data.objects.remove(obj, do_unlink=True)
    for m in old_meshes:
        if m.users == 0:
            bpy.data.meshes.remove(m)
    view_layer = bpy.context.view_layer
    view_layer.update()
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in baked:
        o.select_set(True)
    view_layer.objects.active = baked[0]
    with bpy.context.temp_override(active_object=baked[0], selected_objects=baked,
                                   selected_editable_objects=baked):
        bpy.ops.object.join()
    joined = view_layer.objects.active
    joined.name = name
    joined.data.name = name
    for m in list(bpy.data.meshes):
        if m.users == 0:
            bpy.data.meshes.remove(m)
    return joined


# --------------------------------------------------------------------------
# Reference planes
# --------------------------------------------------------------------------

def make_reference_material(name: str, image: bpy.types.Image) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    emit = nt.nodes.new("ShaderNodeEmission")
    transp = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(tex.outputs["Color"], emit.inputs["Color"])
    nt.links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
    nt.links.new(transp.outputs["BSDF"], mix.inputs[1])
    nt.links.new(emit.outputs["Emission"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    try:
        mat.surface_render_method = "BLENDED"
    except (AttributeError, TypeError):
        pass
    return mat


def make_reference_plane(view: str, image: bpy.types.Image, height: float,
                         lo: Vector, hi: Vector, distance: float,
                         coll: bpy.types.Collection) -> bpy.types.Object:
    """Build a vertical, image-textured quad behind the model for one view.

    front: plane at y=+d (behind a -Y-facing model), normal -Y, image right = +X.
    side:  plane at x=-d, normal +X, seen from +X (character's left profile), image right = +Y.
    back:  plane at y=-d, normal +Y, seen from +Y, image right = -X.
    """
    w_px, h_px = image.size[0], image.size[1]
    aspect = (w_px / h_px) if h_px > 0 else 1.0
    width = height * aspect
    centre = (lo + hi) / 2.0
    z0, z1 = lo.z, lo.z + height
    hw = width / 2.0
    if view == "front":
        y = centre.y + distance
        corners = [(centre.x - hw, y, z0), (centre.x + hw, y, z0),
                   (centre.x + hw, y, z1), (centre.x - hw, y, z1)]
    elif view == "back":
        y = centre.y - distance
        corners = [(centre.x + hw, y, z0), (centre.x - hw, y, z0),
                   (centre.x - hw, y, z1), (centre.x + hw, y, z1)]
    else:  # side
        x = centre.x - distance
        corners = [(x, centre.y - hw, z0), (x, centre.y + hw, z0),
                   (x, centre.y + hw, z1), (x, centre.y - hw, z1)]
    name = f"{REF_PREFIX}{view}"
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(corners, [], [(0, 1, 2, 3)])
    uv = mesh.uv_layers.new(name="UVMap")
    for loop, co in zip(uv.data, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop.uv = co
    mesh.materials.append(make_reference_material(name, image))
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    coll.objects.link(obj)
    obj.hide_render = True
    obj.hide_select = True
    obj.display_type = "TEXTURED"
    return obj


def add_references(refs: Any, model_objs: List[bpy.types.Object],
                   ref_height: Optional[float], warnings: List[str]) -> int:
    if refs is None:
        return 0
    if not isinstance(refs, list) or len(refs) > 3:
        raise PBError("INVALID_REQUEST", "references must be an array of at most 3 items")
    b = world_bounds(model_objs)
    if b is None:
        # No model parts: references only, centred on the origin, feet at z=0.
        height = ref_height if ref_height else DEFAULT_REFERENCE_HEIGHT
        lo, hi = Vector((0.0, 0.0, 0.0)), Vector((0.0, 0.0, height))
        max_dim = height
    else:
        lo, hi = b
        size = hi - lo
        max_dim = max(size.x, size.y, size.z, 1e-3)
        height = ref_height if ref_height else max(size.z, 1e-3)
    coll = bpy.data.collections.new(REF_COLLECTION)
    bpy.context.scene.collection.children.link(coll)
    coll.hide_render = True
    seen = set()
    for i, r in enumerate(refs):
        if not isinstance(r, dict):
            raise PBError("INVALID_REQUEST", f"references[{i}] must be an object")
        view = req_enum(r.get("view"), ("front", "side", "back"), f"references[{i}].view",
                        "INVALID_REQUEST")
        if view in seen:
            raise PBError("INVALID_REQUEST", f"duplicate reference view {view!r}")
        seen.add(view)
        path = req_abs_path(r, "path", IMAGE_EXTS, must_exist=True)
        try:
            image = bpy.data.images.load(path, check_existing=False)
            image.pack()
        except Exception as exc:  # noqa: BLE001
            raise PBError("IMAGE_LOAD_FAILED", f"could not load reference {view}: {_short(exc)}")
        if image.size[0] == 0 or image.size[1] == 0:
            raise PBError("IMAGE_LOAD_FAILED", f"reference {view} image has zero size")
        image.name = f"{REF_PREFIX}{view}"
        make_reference_plane(view, image, height, lo, hi, max_dim * 1.5, coll)
    return len(seen)


# --------------------------------------------------------------------------
# Inspection
# --------------------------------------------------------------------------

def _mesh_issues(mesh: bpy.types.Mesh, mw: Matrix, weld: bool = False) -> Tuple[int, int, int]:
    """Count non-manifold edges, loose vertices and zero-area faces in world space.

    weld=True merges coincident vertices first, so attribute seams stored as split
    vertices (glTF) are not reported as open edges.
    """
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        bm.transform(mw)
        if weld:
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
        non_manifold = sum(1 for e in bm.edges if not e.is_manifold and not e.is_wire)
        loose = sum(1 for v in bm.verts if not v.link_edges)
        zero = sum(1 for f in bm.faces if f.calc_area() < 1e-12)
        return non_manifold, loose, zero
    finally:
        bm.free()


def inspect_scene(weld_seams: bool = False) -> Dict[str, Any]:
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    objs = model_mesh_objects()
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    objects = []
    total_v = total_t = 0
    nm_total = loose_total = zero_total = 0
    mat_names: set = set()
    for obj in sorted(objs, key=lambda o: o.name):
        ev = obj.evaluated_get(depsgraph)
        mesh = ev.to_mesh()
        try:
            mesh.calc_loop_triangles()
            nverts = len(mesh.vertices)
            ntris = len(mesh.loop_triangles)
            mw = ev.matrix_world
            for v in mesh.vertices:
                w = mw @ v.co
                for i in range(3):
                    lo[i] = min(lo[i], w[i])
                    hi[i] = max(hi[i], w[i])
            nm, loose, zero = _mesh_issues(mesh, mw, weld_seams)
            has_uv = len(mesh.uv_layers) > 0
        finally:
            ev.to_mesh_clear()
        mats = [s.material.name for s in obj.material_slots if s.material is not None]
        mat_names.update(mats)
        total_v += nverts
        total_t += ntris
        nm_total += nm
        loose_total += loose
        zero_total += zero
        objects.append({
            "name": obj.name,
            "type": obj.type,
            "vertices": nverts,
            "triangles": ntris,
            "materials": mats,
            "dimensions": [round(x, 5) for x in obj.dimensions],
            "hasUVs": has_uv,
            "modifiers": [m.type.lower() for m in obj.modifiers],
        })
    if not objects:
        lo = hi = Vector((0.0, 0.0, 0.0))
    return {
        "objects": objects,
        "totals": {"meshObjects": len(objects), "vertices": total_v, "triangles": total_t,
                   "materials": len(mat_names)},
        "bounds": {"min": [round(x, 5) for x in lo], "max": [round(x, 5) for x in hi],
                   "size": [round(x, 5) for x in (hi - lo)]},
        "issues": {"nonManifoldEdges": nm_total, "looseVertices": loose_total,
                   "zeroAreaFaces": zero_total},
        "armatures": sum(1 for o in scene.objects if o.type == "ARMATURE"),
        "unitScale": scene.unit_settings.scale_length,
    }


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

VIEW_DIRS = {
    # Direction from the model centre towards the camera; character faces -Y.
    "front": Vector((0.0, -1.0, 0.0)),
    "back": Vector((0.0, 1.0, 0.0)),
    "side": Vector((1.0, 0.0, 0.0)),
    "three_quarter": Vector((1.0, -1.0, 0.6)).normalized(),
    "top": Vector((0.0, 0.0, 1.0)),
}


def _look_rotation(direction_to_cam: Vector, view: str) -> Matrix:
    forward = -direction_to_cam.normalized()
    up_hint = Vector((0.0, 1.0, 0.0)) if view == "top" else Vector((0.0, 0.0, 1.0))
    right = forward.cross(up_hint).normalized()
    up = right.cross(forward).normalized()
    # Camera looks along its local -Z with +Y up.
    return Matrix((right, up, -forward)).transposed()


def _setup_world(scene: bpy.types.Scene, colour: Tuple[float, float, float], strength: float) -> None:
    world = scene.world or bpy.data.worlds.new("PB_World")
    scene.world = world
    world.color = colour
    if world.node_tree is None:
        world.use_nodes = True
    bg = next((n for n in world.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg is not None:
        bg.inputs["Color"].default_value = (*colour, 1.0)
        bg.inputs["Strength"].default_value = strength


def _add_light_rig(scene: bpy.types.Scene, centre: Vector, radius: float) -> None:
    rig = (
        ("key", Vector((1.2, -1.6, 1.4)), 120.0, 1.0),
        ("fill", Vector((-1.6, -1.0, 0.6)), 45.0, 1.5),
        ("rim", Vector((0.2, 1.8, 1.6)), 80.0, 1.0),
    )
    d = max(radius, 0.1) * 3.0
    for name, direction, power, size_mul in rig:
        light = bpy.data.lights.new(f"{RIG_PREFIX}{name}", "AREA")
        light.energy = power * (d * d) / 9.0
        light.size = max(radius, 0.1) * size_mul
        obj = bpy.data.objects.new(f"{RIG_PREFIX}{name}", light)
        scene.collection.objects.link(obj)
        pos = centre + direction.normalized() * d
        obj.matrix_world = Matrix.Translation(pos) @ _look_rotation(pos - centre, "front").to_4x4()


def configure_render(scene: bpy.types.Scene, engine: str, resolution: int, transparent: bool,
                     centre: Vector, radius: float) -> None:
    r = scene.render
    try:
        r.engine = ENGINES[engine]
    except TypeError:
        if engine != "eevee":
            raise
        r.engine = "BLENDER_EEVEE_NEXT"  # Blender 4.2-4.4 name
    r.resolution_x = resolution
    r.resolution_y = resolution
    r.resolution_percentage = 100
    r.film_transparent = transparent
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA" if transparent else "RGB"
    r.image_settings.color_depth = "8"
    r.use_file_extension = True
    if engine == "workbench":
        sh = scene.display.shading
        sh.light = "STUDIO"
        sh.color_type = "MATERIAL"
        sh.show_cavity = False
        sh.show_object_outline = True
        sh.show_specular_highlight = True
        scene.display.render_aa = "8"
        scene.view_settings.view_transform = "Standard"
        _setup_world(scene, (0.8, 0.8, 0.8), 1.0)
    else:
        scene.view_settings.view_transform = "AgX"
        _setup_world(scene, (0.6, 0.6, 0.62), 0.35)
        _add_light_rig(scene, centre, radius)
        if engine == "eevee":
            scene.eevee.taa_render_samples = 32
        else:
            scene.cycles.device = "CPU"
            scene.cycles.samples = 32
            scene.cycles.use_adaptive_sampling = True
            scene.cycles.use_denoising = True
            scene.cycles.max_bounces = 4


def op_render(req: Dict[str, Any], warnings: List[str]) -> Dict[str, Any]:
    blend = req_abs_path(req, "blendPath", (".blend",), must_exist=True)
    out_dir = req.get("outDir")
    if not isinstance(out_dir, str) or not os.path.isabs(out_dir) or "\x00" in out_dir:
        raise PBError("INVALID_REQUEST", "outDir must be an absolute path")
    out_dir = os.path.normpath(out_dir)
    views = req.get("views", ["front", "three_quarter"])
    if not isinstance(views, list) or not views or len(views) > len(VIEWS):
        raise PBError("INVALID_REQUEST", f"views must be a non-empty subset of {list(VIEWS)}")
    for v in views:
        req_enum(v, VIEWS, "views[]", "INVALID_REQUEST")
    if len(set(views)) != len(views):
        raise PBError("INVALID_REQUEST", "views must not contain duplicates")
    resolution = req.get("resolution", 512)
    if not _is_number(resolution) or int(resolution) != resolution or not 64 <= resolution <= 2048:
        raise PBError("INVALID_REQUEST", "resolution must be an integer in [64, 2048]")
    resolution = int(resolution)
    engine = req_enum(req.get("engine", "workbench"), tuple(ENGINES), "engine", "INVALID_REQUEST")
    transparent = req_bool(req, "transparent", False, "request")

    open_blend(blend)
    scene = bpy.context.scene
    for obj in scene.objects:
        if is_reference(obj):
            obj.hide_render = True
        elif obj.type in ("CAMERA", "LIGHT"):
            obj.hide_render = True
    objs = [o for o in model_mesh_objects() if not o.hide_render]
    b = world_bounds(objs)
    if b is None:
        raise PBError("EMPTY_SCENE", "no renderable mesh objects found")
    lo, hi = b
    centre = (lo + hi) / 2.0
    radius = max((hi - lo).length / 2.0, 1e-3)
    corners = [Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]

    configure_render(scene, engine, resolution, transparent, centre, radius)
    cam_data = bpy.data.cameras.new(f"{RIG_PREFIX}camera")
    cam_data.type = "ORTHO"
    cam = bpy.data.objects.new(f"{RIG_PREFIX}camera", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    os.makedirs(out_dir, exist_ok=True)

    renders = []
    for view in views:
        direction = VIEW_DIRS[view]
        rot = _look_rotation(direction, view)
        right, up = rot.col[0], rot.col[1]
        ext_r = max(abs((c - centre).dot(right)) for c in corners)
        ext_u = max(abs((c - centre).dot(up)) for c in corners)
        cam_data.ortho_scale = max(ext_r, ext_u) * 2.0 * 1.1
        dist = radius * 4.0 + 1.0
        cam_data.clip_start = 0.01
        cam_data.clip_end = dist + radius * 4.0
        cam.matrix_world = Matrix.Translation(centre + direction * dist) @ rot.to_4x4()
        path = os.path.join(out_dir, f"{view}.png")
        scene.render.filepath = path
        t0 = time.time()
        try:
            bpy.ops.render.render(write_still=True)
        except Exception as exc:  # noqa: BLE001
            raise PBError("RENDER_FAILED", f"{engine} render of {view} failed: {_short(exc)}")
        if not os.path.isfile(path) or os.path.getsize(path) == 0:
            raise PBError("RENDER_FAILED", f"{engine} render of {view} produced no file")
        log(f"rendered {view} in {time.time() - t0:.2f}s")
        renders.append({"view": view, "path": path, "width": resolution, "height": resolution})
    return {"renders": renders, "engine": engine}


# --------------------------------------------------------------------------
# Export / import
# --------------------------------------------------------------------------

def _select_only(objs: Sequence[bpy.types.Object]) -> None:
    view_layer = bpy.context.view_layer
    for o in view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    if objs:
        view_layer.objects.active = objs[0]


def op_export(req: Dict[str, Any], warnings: List[str]) -> Dict[str, Any]:
    blend = req_abs_path(req, "blendPath", (".blend",), must_exist=True)
    fmt = req_enum(req.get("format"), tuple(EXPORT_FORMATS), "format", "INVALID_REQUEST")
    out_path = req_abs_path(req, "outPath", (EXPORT_FORMATS[fmt],))
    apply_mods = req_bool(req, "applyModifiers", True, "request")
    open_blend(blend)
    scene = bpy.context.scene
    objs = model_mesh_objects()
    objs += [o for o in scene.objects if o.type == "ARMATURE" and not is_reference(o)]
    if not objs:
        raise PBError("EMPTY_SCENE", "no mesh objects to export")
    if any(o.matrix_world.is_negative for o in objs):
        warnings.append("some objects have negative scale; importers may flip their normals")
    _select_only(objs)
    ensure_parent_dir(out_path)
    try:
        if fmt in ("glb", "gltf"):
            bpy.ops.export_scene.gltf(
                filepath=out_path,
                export_format="GLB" if fmt == "glb" else "GLTF_SEPARATE",
                use_selection=True, export_apply=apply_mods, export_yup=True,
                export_cameras=False, export_lights=False, export_animations=False)
        elif fmt == "fbx":
            bpy.ops.export_scene.fbx(
                filepath=out_path, use_selection=True, object_types={"MESH", "ARMATURE"},
                use_mesh_modifiers=apply_mods, mesh_smooth_type="FACE",
                apply_scale_options="FBX_SCALE_NONE", bake_anim=False,
                path_mode="AUTO", add_leaf_bones=False)
        else:
            bpy.ops.wm.obj_export(
                filepath=out_path, export_selected_objects=True, apply_modifiers=apply_mods,
                export_materials=True, export_uv=True, export_normals=True,
                forward_axis="NEGATIVE_Z", up_axis="Y")
    except Exception as exc:  # noqa: BLE001
        raise PBError("EXPORT_FAILED", f"{fmt} export failed: {_short(exc)}")
    if not os.path.isfile(out_path):
        raise PBError("EXPORT_FAILED", f"{fmt} export produced no file")
    files = [out_path]
    sidecar = os.path.splitext(out_path)[0] + (".bin" if fmt == "gltf" else ".mtl")
    if fmt in ("gltf", "obj") and os.path.isfile(sidecar):
        files.append(sidecar)
    return {"path": out_path, "bytes": os.path.getsize(out_path), "format": fmt,
            "files": [{"path": f, "bytes": os.path.getsize(f)} for f in files],
            "objects": len(objs)}


def op_inspect_file(req: Dict[str, Any], warnings: List[str]) -> Dict[str, Any]:
    path = req_abs_path(req, "path", IMPORT_EXTS, must_exist=True)
    clear_scene()
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in (".glb", ".gltf"):
            # glTF stores split vertices at seams/sharp edges; merge so topology stats are meaningful.
            res = bpy.ops.import_scene.gltf(filepath=path, merge_vertices=True)
        elif ext == ".fbx":
            res = bpy.ops.import_scene.fbx(filepath=path)
        else:
            res = bpy.ops.wm.obj_import(filepath=path)
    except Exception as exc:  # noqa: BLE001
        raise PBError("IMPORT_FAILED", f"import of {os.path.basename(path)} failed: {_short(exc)}")
    if "FINISHED" not in res:
        raise PBError("IMPORT_FAILED", f"import of {os.path.basename(path)} did not finish")
    result = inspect_scene(weld_seams=ext in (".glb", ".gltf"))
    if result["totals"]["meshObjects"] == 0:
        warnings.append("file contains no mesh objects")
    result["path"] = path
    result["bytes"] = os.path.getsize(path)
    return result


# --------------------------------------------------------------------------
# Ops
# --------------------------------------------------------------------------

def _op_available(module: str, name: str) -> bool:
    try:
        getattr(getattr(bpy.ops, module), name).get_rna_type()
        return True
    except Exception:  # noqa: BLE001
        return False


def op_probe(req: Dict[str, Any], warnings: List[str]) -> Dict[str, Any]:
    return {
        "blenderVersion": ".".join(str(x) for x in bpy.app.version),
        "blenderVersionString": bpy.app.version_string,
        "pythonVersion": platform.python_version(),
        "gltf": _op_available("export_scene", "gltf"),
        "fbx": _op_available("export_scene", "fbx"),
        "obj": _op_available("wm", "obj_export"),
        "background": bool(bpy.app.background),
    }


def op_build(req: Dict[str, Any], warnings: List[str]) -> Dict[str, Any]:
    out_blend = req_abs_path(req, "outputBlend", (".blend",))
    spec = validate_spec(req.get("spec"), warnings)
    clear_scene()
    objs = build_parts(spec, warnings)
    apply_origin(objs, spec["origin"])
    if spec["join"] and objs:
        joined = join_parts(objs, spec["name"])
        objs = [joined]
    if not objs:
        warnings.append("spec has no parts; the .blend contains only reference planes (if any)")
    n_refs = add_references(req.get("references"), objs, spec["referenceHeightM"], warnings)
    ensure_parent_dir(out_blend)
    try:
        # Versions are managed by PixelBridge; don't leave Blender's .blend1 backups behind.
        bpy.context.preferences.filepaths.save_version = 0
        bpy.ops.wm.save_as_mainfile(filepath=out_blend, check_existing=False, compress=True)
    except Exception as exc:  # noqa: BLE001
        raise PBError("SAVE_FAILED", f"could not save .blend: {_short(exc)}")
    result = inspect_scene()
    result["blendPath"] = out_blend
    result["references"] = n_refs
    return result


def op_inspect(req: Dict[str, Any], warnings: List[str]) -> Dict[str, Any]:
    blend = req_abs_path(req, "blendPath", (".blend",), must_exist=True)
    open_blend(blend)
    return inspect_scene()


def op_thumbnail(req: Dict[str, Any], warnings: List[str]) -> Dict[str, Any]:
    """Downscale images (never upscale) to PNGs whose longest side is <= maxSize."""
    items = req.get("items")
    if not isinstance(items, list) or not items or len(items) > MAX_THUMBNAILS:
        raise PBError("INVALID_REQUEST", f"items must be an array of 1-{MAX_THUMBNAILS} entries")
    max_size = req.get("maxSize", 512)
    if not _is_number(max_size) or int(max_size) != max_size or not 64 <= max_size <= 2048:
        raise PBError("INVALID_REQUEST", "maxSize must be an integer in [64, 2048]")
    max_size = int(max_size)
    thumbs = []
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            raise PBError("INVALID_REQUEST", f"items[{i}] must be an object")
        src = req_abs_path(it, "src", THUMB_SRC_EXTS, must_exist=True)
        dst = req_abs_path(it, "dst", (".png",))
        try:
            image = bpy.data.images.load(src, check_existing=False)
            w, h = image.size[0], image.size[1]
        except Exception as exc:  # noqa: BLE001
            raise PBError("IMAGE_LOAD_FAILED", f"could not load {os.path.basename(src)}: {_short(exc)}")
        if w == 0 or h == 0:
            raise PBError("IMAGE_LOAD_FAILED", f"{os.path.basename(src)} has zero size or is unreadable")
        scale = min(1.0, max_size / float(max(w, h)))
        nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
        try:
            if (nw, nh) != (w, h):
                image.scale(nw, nh)
            ensure_parent_dir(dst)
            image.filepath_raw = dst
            image.file_format = "PNG"
            image.save()
        except Exception as exc:  # noqa: BLE001
            raise PBError("IMAGE_SAVE_FAILED", f"could not write thumbnail for {os.path.basename(src)}: {_short(exc)}")
        finally:
            bpy.data.images.remove(image)
        if not os.path.isfile(dst):
            raise PBError("IMAGE_SAVE_FAILED", f"thumbnail was not written: {dst}")
        thumbs.append({"src": src, "dst": dst, "width": nw, "height": nh})
    return {"thumbnails": thumbs}


OPS: Dict[str, Callable[[Dict[str, Any], List[str]], Dict[str, Any]]] = {
    "thumbnail": op_thumbnail,
    "probe": op_probe,
    "build": op_build,
    "render": op_render,
    "inspect": op_inspect,
    "export": op_export,
    "inspect_file": op_inspect_file,
}


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def _script_args() -> List[str]:
    argv = sys.argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


def _write_response(path: str, payload: Dict[str, Any]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    os.replace(tmp, path)


def _read_request(path: str) -> Dict[str, Any]:
    if not os.path.isfile(path):
        raise PBError("INVALID_REQUEST", "request file not found")
    if os.path.getsize(path) > MAX_REQUEST_BYTES:
        raise PBError("INVALID_REQUEST", f"request file exceeds {MAX_REQUEST_BYTES} bytes")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            req = json.load(fh)
    except (ValueError, UnicodeDecodeError) as exc:
        raise PBError("INVALID_REQUEST", f"request is not valid JSON: {exc}")
    if not isinstance(req, dict):
        raise PBError("INVALID_REQUEST", "request must be a JSON object")
    return req


def main() -> int:
    args = _script_args()
    if len(args) != 2:
        log("usage: blender -b --python pixelbridge_bpy.py -- <request.json> <response.json>")
        return 2
    req_path, resp_path = args
    warnings: List[str] = []
    t0 = time.time()
    try:
        req = _read_request(req_path)
        op = req.get("op")
        if op not in OPS:
            raise PBError("INVALID_SPEC", f"unknown op {op!r}; expected one of {sorted(OPS)}")
        log(f"op={op}")
        result = OPS[op](req, warnings)
        payload: Dict[str, Any] = {"ok": True, "result": result, "warnings": warnings,
                                   "elapsedMs": int((time.time() - t0) * 1000)}
        code = 0
    except PBError as exc:
        payload = {"ok": False, "error": {"code": exc.code, "message": exc.message},
                   "warnings": warnings}
        code = 2
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc().strip().splitlines()
        payload = {"ok": False, "error": {"code": "INTERNAL",
                                          "message": f"{type(exc).__name__}: {_short(exc)}",
                                          "detail": tb[-1][:500] if tb else ""},
                   "warnings": warnings}
        code = 2
    try:
        _write_response(resp_path, payload)
    except OSError as exc:
        log(f"could not write response: {exc}")
        return 2
    return code


if __name__ == "__main__":
    sys.exit(main())
