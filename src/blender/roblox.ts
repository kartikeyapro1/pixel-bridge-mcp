import type { PixelBridgeConfig } from '../core/config.js';
import type { SceneStats } from './spec.js';

/**
 * Pre-import checks for Roblox Studio's 3D Importer. Limits are conservative,
 * configurable defaults drawn from Roblox developer documentation and forum
 * guidance (per-mesh triangle cap ≈20k). Passing these checks does not guarantee
 * a clean import; always verify in Studio.
 */

export interface ValidationReport {
  profile: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
  sizeStuds: [number, number, number];
}

export function validateForRoblox(stats: SceneStats, cfg: PixelBridgeConfig['roblox']): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  const meshes = stats.objects.filter((o) => o.type === 'MESH');

  if (meshes.length === 0) errors.push('No mesh objects found.');
  for (const m of meshes) {
    if (m.triangles > cfg.maxTrianglesPerMesh) {
      errors.push(
        `Mesh "${m.name}" has ${m.triangles} triangles; Roblox's per-mesh limit is about ${cfg.maxTrianglesPerMesh}. Reduce subdivision/segments or split the mesh.`,
      );
    }
    if (m.materials.length > 1) {
      warnings.push(
        `Mesh "${m.name}" uses ${m.materials.length} materials. Roblox MeshParts take one material/SurfaceAppearance; the importer may split it or you may need a texture atlas.`,
      );
    }
    if (!m.hasUVs) warnings.push(`Mesh "${m.name}" has no UV map; textures cannot be applied without one.`);
  }
  if (meshes.length > 50) warnings.push(`${meshes.length} separate meshes; consider joining parts (spec "join": true) to reduce instance count.`);

  const sizeStuds = stats.bounds.size.map((m) => Math.round((m / cfg.metersPerStud) * 100) / 100) as [number, number, number];
  const maxDim = Math.max(...sizeStuds);
  if (maxDim > cfg.maxPartSizeStuds) errors.push(`Model is ${maxDim} studs across; Roblox parts are limited to ${cfg.maxPartSizeStuds}.`);
  if (maxDim > 0 && maxDim < 0.05) warnings.push(`Model is only ${maxDim} studs across; check export units.`);

  if (stats.issues.nonManifoldEdges > 0) {
    warnings.push(`${stats.issues.nonManifoldEdges} non-manifold edges (often fine for separate primitives, but can cause shading/collision issues).`);
  }
  if (stats.issues.zeroAreaFaces > 0) warnings.push(`${stats.issues.zeroAreaFaces} zero-area faces.`);
  if (stats.issues.looseVertices > 0) warnings.push(`${stats.issues.looseVertices} loose vertices.`);
  if (stats.armatures === 0) {
    info.push('Static mesh: no armature. It will import as a model, not an animatable R15/skinned character rig.');
  } else {
    info.push(`${stats.armatures} armature(s) found. PixelBridge does not verify Roblox rig requirements; check bone naming/skinning in Studio.`);
  }
  info.push(`Approximate size in Studio: ${sizeStuds.join(' × ')} studs (at ${cfg.metersPerStud} m/stud).`);
  info.push(`Triangles total: ${stats.totals.triangles}.`);
  info.push('Material base colours may not carry over through every format; verify appearance in Studio.');

  return { profile: 'roblox', ok: errors.length === 0, errors, warnings, info, sizeStuds };
}
