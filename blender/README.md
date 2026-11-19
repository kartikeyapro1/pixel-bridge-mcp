# PixelBridge Blender worker

`pixelbridge_bpy.py` is the Blender-side half of PixelBridge. The TypeScript MCP server runs it as a
separate Blender process, once per operation. It speaks a file-based JSON protocol and uses only
`bpy`, `bmesh`, `mathutils` and the Python standard library.

Tested with Blender 5.3.0 (Python 3.13) on Windows 11, without a GPU.

## Invocation

```
blender --background --factory-startup --disable-autoexec \
  --python blender/pixelbridge_bpy.py -- <request.json> <response.json>
```

The worker reads one request, performs one op, and always writes a response file (atomically, via
`<response>.tmp` and a rename).

| Exit code | Meaning |
|---|---|
| 0 | `{"ok": true, "result": {...}, "warnings": [...], "elapsedMs": n}` |
| 2 | `{"ok": false, "error": {"code": "...", "message": "..."}, "warnings": [...]}` |

The worker prints optional progress to stderr only. Unexpected exceptions are reported as `INTERNAL`,
with only the last traceback line included.

Error codes: `INVALID_REQUEST`, `INVALID_SPEC`, `NOT_FOUND`, `OPEN_FAILED`, `SAVE_FAILED`,
`IMAGE_LOAD_FAILED`, `IMAGE_SAVE_FAILED`, `EMPTY_SCENE`, `RENDER_FAILED`, `EXPORT_FAILED`,
`IMPORT_FAILED`, `INTERNAL`. An unknown `op`, primitive or modifier type returns `INVALID_SPEC`.

All paths must be absolute.

## Ops

### `probe`
```json
{"op": "probe"}
```
→ `{"blenderVersion": "5.3.0", "blenderVersionString": "5.3.0", "pythonVersion": "3.13.13", "gltf": true, "fbx": true, "obj": true, "background": true}`

### `build`
```json
{"op": "build", "spec": { ...ModelSpec... },
 "references": [{"view": "front", "path": "C:/refs/front.png"}],
 "outputBlend": "C:/work/pip.blend"}
```
Clears the scene, builds every part, applies `origin`, joins the parts if `join` is set, adds any
reference planes, and saves a compressed `.blend`. Missing parent directories are created. The result
has the same shape as `inspect`, plus `blendPath` and `references` (the number of planes added).
`spec.parts` may be empty. You then get a `.blend` that contains only reference planes, sized to
`referenceHeightM`, or 2.0 m when that is not set.

### `render`
```json
{"op": "render", "blendPath": "C:/work/pip.blend", "outDir": "C:/work/renders",
 "views": ["front", "side", "back", "three_quarter", "top"],
 "resolution": 512, "engine": "workbench", "transparent": false}
```
Renders orthographic, square images. The camera is fitted to the evaluated bounds of all model meshes,
with 10% padding. Reference planes, plus any cameras and lights already in the file, are excluded.
Writes `<outDir>/<view>.png`. → `{"renders": [{"view", "path", "width", "height"}], "engine"}`.

| Engine | Setup | Notes |
|---|---|---|
| `workbench` | Studio light, material colour, outline | Fastest (about 0.15 s per view) |
| `eevee` | 3-point area-light rig, grey world, AgX, 32 samples | Runs headless. The first render in a fresh process compiles shaders (about 1.5 s warm, about 12 s the first time on a machine) |
| `cycles` | Same rig, CPU, 32 samples, adaptive sampling, OIDN denoise | — |

`resolution` is 64 to 2048 (default 512).

### `inspect`
```json
{"op": "inspect", "blendPath": "C:/work/pip.blend"}
```
→
```json
{"objects": [{"name", "type", "vertices", "triangles", "materials": [], "dimensions": [x, y, z], "hasUVs", "modifiers": ["bevel"]}],
 "totals": {"meshObjects", "vertices", "triangles", "materials"},
 "bounds": {"min": [], "max": [], "size": []},
 "issues": {"nonManifoldEdges", "looseVertices", "zeroAreaFaces"},
 "armatures": 0, "unitScale": 1.0}
```
- Vertex and triangle counts come from the evaluated mesh, after modifiers.
- Bounds are in world space.
- Objects in `PB_References` are excluded.
- A boundary edge (for example on a `plane` primitive) counts as non-manifold.

### `export`
```json
{"op": "export", "blendPath": "C:/work/pip.blend", "format": "glb", "outPath": "C:/out/pip.glb", "applyModifiers": true}
```
Exports model meshes and armatures only. References, cameras and lights are left out.
→ `{"path", "bytes", "format", "files": [{"path", "bytes"}], "objects"}`

| Format | Exporter | Settings |
|---|---|---|
| `glb` | `export_scene.gltf` | Binary GLB |
| `gltf` | `export_scene.gltf` | `GLTF_SEPARATE` (`.gltf` + `.bin`) |
| `fbx` | `export_scene.fbx` | `-Z` forward, `Y` up, `FBX_SCALE_NONE` |
| `obj` | `wm.obj_export` | Writes a `.mtl` next to the `.obj` |

### `inspect_file`
```json
{"op": "inspect_file", "path": "C:/out/pip.glb"}
```
Imports a `.glb`, `.gltf`, `.fbx` or `.obj` into an empty scene. Returns the `inspect` shape plus
`path` and `bytes`. A failed import returns `IMPORT_FAILED`.

glTF stores split vertices at UV seams and sharp edges, so for glTF:
- `vertices` is the imported (split) count.
- The topology `issues` are counted after welding vertices by position.

### `thumbnail`
```json
{"op": "thumbnail", "maxSize": 512,
 "items": [{"src": "C:/refs/front.webp", "dst": "C:/tmp/front_512.png"}]}
```
- Source images can be `.png`, `.jpg`/`.jpeg` or `.webp`. Each output is a PNG.
- Images are downscaled so the longest side is at most `maxSize` (64 to 2048, default 512), keeping
  the aspect ratio. They are never upscaled.
- One request takes at most 16 items.

→ `{"thumbnails": [{"src", "dst", "width", "height"}]}`

## ModelSpec

See `examples/specs/cartoon-cat.json` and `examples/specs/simple-crate.json`.

**Parts**

- **Transforms.** `location`, `rotation` (XYZ Euler, degrees) and `scale` are world-space. `parent`
  only builds the hierarchy; the world placement is kept.
- **Primitive defaults:**

  | Primitive | Defaults |
  |---|---|
  | `cube` | size 1 |
  | `plane` | size 1 |
  | `uv_sphere` | radius 0.5, segments 32, rings 16 |
  | `ico_sphere` | radius 0.5, subdivisions 2 |
  | `cylinder` | radius 0.5, depth 1, vertices 32 (`segments` is also accepted) |
  | `cone` | radius1 0.5, radius2 0, depth 1, vertices 32 |
  | `torus` | majorRadius 0.5, minorRadius 0.15, majorSegments 32, minorSegments 12 |

  Every primitive gets a `UVMap`.
- **Shading.** `smooth` uses smooth shading and marks edges sharper than 60° as sharp. `flat` is
  flat shading.
- **`mirrorX`.** Adds an exact mirror copy across the YZ plane. The mesh data is reflected and its
  faces reversed, so the copy has positive scale and exports cleanly. `simple_deform` amounts are
  sign-corrected for the copy; this was checked for every mode and axis against a negative-scale
  reference. The copy's name:
  - swaps a `.L`/`.R` or `_L`/`_R` suffix if the name has one;
  - otherwise gets `.R` when the original is at x ≥ 0 (the character's left), or `.L` when it is at
    x < 0.

  A mirrored child is parented to its parent's mirror copy, if there is one.
- **Modifier notes:**
  - `simple_deform`: `taper` uses `factor`. `bend` and `twist` use `angle` in degrees; `factor` is
    accepted as an alias.
  - `mirror` mirrors around the part's own origin.

**Spec-level options**

- **`join: true`.** Bakes every part (modifiers and transforms) into one mesh object named
  `spec.name`, with its origin at the world origin. Material slots are preserved.
- **`origin`.**
  - `bottom_center` moves the model so that the bounds are centred in X and Y, with the lowest point
    at z = 0.
  - `center` centres the bounds on the origin.
  - `none` leaves the model where it is.

**Limits** (enforced here and also by the TypeScript side)

| Item | Limit |
|---|---|
| Parts, including mirror copies | ≤ 300 |
| Segments / vertices | 3 to 128 |
| Rings | 3 to 64 |
| Subdivisions | 1 to 6 |
| Subsurf levels | 0 to 3 |
| Bevel segments | 1 to 8 |
| Modifiers per part | ≤ 8 |
| `location` and `scale` components | within ±1000 (non-zero scale) |
| Materials | ≤ 64 |
| Names | `[A-Za-z0-9_.\- ]`, 1 to 64 characters |
| Request file | ≤ 2 MiB |

Unknown keys are ignored and reported as warnings.

**Warnings**

- A part rotated relative to a non-uniformly scaled parent produces a shear. glTF and FBX cannot
  store it, so exporters approximate that part's transform, and `build` warns. Parent only to
  uniformly scaled parts, or don't use `parent`.

## Coordinates

- Blender is Z-up, metres, `unitScale` 1.0.
- Models face **-Y**, so Blender's Front view (numpad 1) looks from -Y towards +Y. The character's
  left side is +X.
- The glTF export converts to Y-up (`export_yup`). FBX and OBJ are written with `-Z` forward and `Y`
  up.

**Render views** (direction from the model to the camera)

| View | Camera direction | Image orientation |
|---|---|---|
| `front` | -Y | |
| `back` | +Y | |
| `side` | +X | Shows the character's left profile, facing image-left |
| `three_quarter` | (+1, -1, +0.6) | |
| `top` | +Z | The front of the model is at the bottom of the image |

**Reference planes** (collection `PB_References`, `hide_render`, excluded from inspect and export)

Each plane is placed `1.5 × max dimension` behind the model, as seen from its view. Planes are
unlit: an emission shader plus image alpha. The images are packed into the `.blend`.

- **Height.** The image height equals the model's bounds height, or `referenceHeightM` if set. The
  width follows the image's aspect ratio.
- **Bottom edge.** The bottom edge is at the model's lowest point.

| View | Position | Facing | Image right points to |
|---|---|---|---|
| `front` | y = +d | -Y | +X |
| `side` | x = -d | +X | +Y (the character faces image-left) |
| `back` | y = -d | +Y | -X |

## Security notes

These are mitigations; the worker is **not a sandbox**.

- **`--factory-startup`** ignores the user's startup file and preferences, so user-installed add-ons
  and startup scripts do not load. Only bundled add-ons (glTF, FBX, Cycles) are available.
- **`--disable-autoexec`** blocks Python scripts embedded in `.blend` files, such as registered text
  blocks and driver expressions, when files are opened.
- **No code execution from requests.** The worker never `exec`s or `eval`s request content. A model
  is described only by the declarative ModelSpec.
- **No network.** The worker opens no network connections.
- **Full user privileges.** Blender still runs with the full privileges of the calling user. It
  reads and writes any path it is given, and parsing untrusted `.blend`, FBX or glTF files uses
  Blender's native importers. Run it under a restricted account or inside a container if inputs are
  untrusted.

## License

`pixelbridge_bpy.py` imports `bpy` and is therefore licensed **GPL-3.0-or-later** (SPDX header in
the file). The rest of PixelBridge is Apache-2.0. It only runs this script as a separate Blender
process and exchanges JSON files with it; it does not link against Blender.
