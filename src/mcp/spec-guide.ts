/** Returned by the get_model_spec_guide tool. Kept compact: it is read by agents. */
export const MODEL_SPEC_GUIDE = `# PixelBridge model spec

A model is JSON data, interpreted by PixelBridge's bundled Blender script. No Python is accepted.

## Conventions
- Units: meters. Z is up. The model FACES -Y (Blender "Front" view looks from -Y toward +Y).
- The character's left side is +X (the viewer's right in the front view). Use "mirrorX": true for symmetric pairs.
- origin "bottom_center" (default) moves the model so its lowest point rests on z=0.
- Rotation is XYZ Euler in DEGREES.

## Top level
{
  "name": "pip",                       // [A-Za-z0-9_.- ], ≤64 chars
  "materials": { "<key>": { "baseColor": "#RRGGBB", "roughness": 0-1, "metallic": 0-1, "emission"?: "#RRGGBB", "emissionStrength"?: n } },
  "parts": [ <part>, ... ],            // ≤300 including mirrored copies; may be empty (references only)
  "join": false,                        // true = apply modifiers and join into one mesh (good for Roblox)
  "origin": "bottom_center" | "center" | "none",
  "referenceHeightM": 1.2               // optional: height used to scale reference planes
}

## Part
{
  "name": "head",                       // unique
  "primitive": "cube" | "uv_sphere" | "ico_sphere" | "cylinder" | "cone" | "torus" | "plane",
  "params": { "radius", "radius1", "radius2", "depth", "size", "segments" (≤128), "rings" (≤64),
              "subdivisions" (≤6), "vertices" (≤128), "majorRadius", "minorRadius", "majorSegments", "minorSegments" },
  "location": [x, y, z], "rotation": [degX, degY, degZ], "scale": [sx, sy, sz],
  "material": "<material key>",
  "shading": "smooth" | "flat",
  "modifiers": [
    { "type": "subsurf", "levels": 0-3 },
    { "type": "bevel", "width": m, "segments": 1-8 },
    { "type": "solidify", "thickness": m },
    { "type": "mirror", "axis": "x" | "y" | "z" },
    { "type": "simple_deform", "mode": "taper" | "bend" | "twist", "factor": n, "axis": "x" | "y" | "z" }
  ],
  "mirrorX": true,                      // also create a copy mirrored across X (ears, eyes, limbs)
  "parent": "<other part name>"
}

Primitive notes: cube "size" is the edge length (scale it for boxes). cylinder/cone use "radius"/"depth"
(cone: radius1 bottom, radius2 top). Spheres use "radius", "segments", "rings". Scale spheres to make ellipsoids.

## Budget and Roblox
- Keep total triangles under ~20,000 per mesh for Roblox. subsurf multiplies faces by 4 per level:
  prefer low segment counts plus subsurf 1-2 over high segment counts.
- Use few materials per mesh if you plan to join.

## Workflow
1. build_blender_model { collection, spec, references: [{view:"front", image:"ast_…"}, ...] }
2. render_model_previews { blendAssetId } → compare renders with the reference images.
3. Write down the 3-5 most significant differences (proportions, silhouette, colour, missing parts),
   edit the spec, and build again with a "note" describing the change. Previous versions are kept.
4. Stop when renders match well enough or the version limit is reached; then export_3d_asset { formats: ["glb"] }.

Primitive modelling produces stylised, blocky-to-soft shapes. It will not reproduce detailed sculpted
characters. Lean into a stylised look: chunky silhouettes, bold colours, smooth primitives.

## Example (tiny)
{
  "name": "crate",
  "materials": { "wood": { "baseColor": "#9a6b3f", "roughness": 0.8 } },
  "parts": [ { "name": "box", "primitive": "cube", "params": { "size": 1 }, "location": [0, 0, 0.5],
               "material": "wood", "shading": "flat", "modifiers": [ { "type": "bevel", "width": 0.04, "segments": 2 } ] } ],
  "join": true
}
A full character example ships in examples/specs/cartoon-cat.json.
`;
