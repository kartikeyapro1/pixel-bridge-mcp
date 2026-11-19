# Roblox workflow

PixelBridge prepares files for Roblox Studio. **It never uploads or publishes.** You import with
Studio's 3D Importer.

## Steps

1. Build and refine the model (`build_blender_model`, `render_model_previews`).
   For a single MeshPart, set `"join": true` in the spec.
2. `export_3d_asset { blendAssetId, formats: ["glb"] }` (FBX also works). Each export is re-imported
   in a clean Blender scene and validated.
3. In Studio: Home → Import 3D → choose `assets/<category>/<collection>/exports/<name>-vNNN.glb`.
4. Check the result in Studio. Size, materials and orientation are the usual things to adjust.

## What `validate_3d_asset` checks (profile `roblox`)

| Check                                               | Default                                 | Severity |
| --------------------------------------------------- | --------------------------------------- | -------- |
| Triangles per mesh                                  | ≤ 20,000 (`roblox.maxTrianglesPerMesh`) | error    |
| Largest dimension                                   | ≤ 2048 studs at 0.28 m/stud             | error    |
| Mesh present                                        | ≥ 1                                     | error    |
| Materials per mesh                                  | 1 recommended                           | warning  |
| UV map                                              | present                                 | warning  |
| Non-manifold edges, loose vertices, zero-area faces | 0                                       | warning  |
| Armature                                            | reported                                | info     |

These limits are conservative defaults drawn from Roblox developer documentation and forum
guidance. Studio may decimate or reject differently; the import in Studio is the real test.

## Not covered

- R15 / skinned character rigs: PixelBridge does not create or verify rigs.
- Textures/SurfaceAppearance: primitive models use material base colours; how those carry over
  depends on format and Studio version.
- Collision fidelity and LOD settings are configured in Studio.
- Publishing, asset IDs and marketplace upload are deliberately not supported.
