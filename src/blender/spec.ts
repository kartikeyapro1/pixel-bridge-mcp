import { z } from 'zod';

/**
 * Declarative model specification. Agents describe geometry as data; the bundled
 * Blender script (blender/pixelbridge_bpy.py) interprets it. No agent-supplied
 * Python is ever executed. Limits here are mirrored in the Python interpreter.
 *
 * Conventions: meters, Z-up, the model faces -Y (Blender's "Front" view).
 */

const name = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.\- ]+$/, 'Use letters, digits, space, _ . -');
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const bounded = (max: number) => vec3.refine((v) => v.every((x) => Math.abs(x) <= max), `Components must be within ±${max}`);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use #RRGGBB');
const axis = z.enum(['x', 'y', 'z']);

export const modifierSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subsurf'), levels: z.number().int().min(0).max(3) }),
  z.object({ type: z.literal('bevel'), width: z.number().min(0).max(10), segments: z.number().int().min(1).max(8).default(2) }),
  z.object({ type: z.literal('solidify'), thickness: z.number().min(-10).max(10) }),
  z.object({ type: z.literal('mirror'), axis }),
  z.object({
    type: z.literal('simple_deform'),
    mode: z.enum(['taper', 'bend', 'twist']),
    factor: z.number().min(-20).max(20),
    axis: axis.default('z'),
  }),
]);

export const partSchema = z.object({
  name,
  primitive: z.enum(['cube', 'uv_sphere', 'ico_sphere', 'cylinder', 'cone', 'torus', 'plane']),
  params: z
    .object({
      radius: z.number().positive().max(1000),
      radius1: z.number().min(0).max(1000),
      radius2: z.number().min(0).max(1000),
      depth: z.number().positive().max(1000),
      size: z.number().positive().max(1000),
      segments: z.number().int().min(3).max(128),
      rings: z.number().int().min(3).max(64),
      subdivisions: z.number().int().min(1).max(6),
      vertices: z.number().int().min(3).max(128),
      majorRadius: z.number().positive().max(1000),
      minorRadius: z.number().positive().max(1000),
      majorSegments: z.number().int().min(3).max(128),
      minorSegments: z.number().int().min(3).max(128),
    })
    .partial()
    .default({}),
  location: bounded(1000).default([0, 0, 0]),
  rotation: bounded(3600).default([0, 0, 0]),
  scale: bounded(1000).default([1, 1, 1]),
  material: z.string().max(64).optional(),
  shading: z.enum(['smooth', 'flat']).default('smooth'),
  modifiers: z.array(modifierSchema).max(8).default([]),
  mirrorX: z.boolean().default(false),
  parent: name.optional(),
});

export const materialSchema = z.object({
  baseColor: hex,
  roughness: z.number().min(0).max(1).default(0.5),
  metallic: z.number().min(0).max(1).default(0),
  emission: hex.optional(),
  emissionStrength: z.number().min(0).max(100).optional(),
});

export const modelSpecSchema = z
  .object({
    name,
    /** May be empty: a scene with only reference planes, for manual modelling. */
    parts: z.array(partSchema).max(300),
    materials: z.record(z.string().max(64), materialSchema).default({}),
    join: z.boolean().default(false),
    origin: z.enum(['bottom_center', 'center', 'none']).default('bottom_center'),
    referenceHeightM: z.number().positive().max(1000).optional(),
  })
  .superRefine((spec, ctx) => {
    const names = new Set<string>();
    let count = 0;
    for (const [i, p] of spec.parts.entries()) {
      if (names.has(p.name)) ctx.addIssue({ code: 'custom', path: ['parts', i, 'name'], message: `Duplicate part name "${p.name}"` });
      names.add(p.name);
      count += p.mirrorX ? 2 : 1;
      if (p.material && !(p.material in spec.materials)) {
        ctx.addIssue({ code: 'custom', path: ['parts', i, 'material'], message: `Unknown material "${p.material}"` });
      }
    }
    for (const [i, p] of spec.parts.entries()) {
      if (p.parent && !names.has(p.parent)) {
        ctx.addIssue({ code: 'custom', path: ['parts', i, 'parent'], message: `Unknown parent "${p.parent}"` });
      }
    }
    if (count > 300) ctx.addIssue({ code: 'custom', path: ['parts'], message: `Too many parts including mirrored copies (${count} > 300)` });
  });

export type ModelSpec = z.infer<typeof modelSpecSchema>;

export const RENDER_VIEWS = ['front', 'side', 'back', 'three_quarter', 'top'] as const;
export type RenderView = (typeof RENDER_VIEWS)[number];
export const EXPORT_FORMATS = ['glb', 'gltf', 'fbx', 'obj'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Stats returned by the Blender `inspect` / `inspect_file` / `build` ops. */
export interface SceneStats {
  objects: {
    name: string;
    type: string;
    vertices: number;
    triangles: number;
    materials: string[];
    dimensions: [number, number, number];
    hasUVs: boolean;
    modifiers: string[];
  }[];
  totals: { meshObjects: number; vertices: number; triangles: number; materials: number };
  bounds: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  issues: { nonManifoldEdges: number; looseVertices: number; zeroAreaFaces: number };
  armatures: number;
  unitScale: number;
}
