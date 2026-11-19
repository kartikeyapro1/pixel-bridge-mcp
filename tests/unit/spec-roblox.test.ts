import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateForRoblox } from '../../src/blender/roblox.js';
import { modelSpecSchema, type SceneStats } from '../../src/blender/spec.js';
import { parseConfig } from '../../src/core/config.js';

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/specs');

describe('modelSpecSchema', () => {
  it('accepts every bundled example spec', () => {
    const files = readdirSync(examples).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const r = modelSpecSchema.safeParse(JSON.parse(readFileSync(path.join(examples, f), 'utf8')));
      expect(r.success, `${f}: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
    }
  });

  it('applies defaults', () => {
    const s = modelSpecSchema.parse({ name: 'x', parts: [{ name: 'a', primitive: 'cube' }] });
    expect(s.parts[0]).toMatchObject({
      location: [0, 0, 0],
      scale: [1, 1, 1],
      shading: 'smooth',
      mirrorX: false,
    });
    expect(s.origin).toBe('bottom_center');
  });

  it.each([
    ['unknown primitive', { name: 'x', parts: [{ name: 'a', primitive: 'teapot' }] }],
    [
      'unknown modifier',
      { name: 'x', parts: [{ name: 'a', primitive: 'cube', modifiers: [{ type: 'python' }] }] },
    ],
    [
      'subsurf too high',
      { name: 'x', parts: [{ name: 'a', primitive: 'cube', modifiers: [{ type: 'subsurf', levels: 6 }] }] },
    ],
    [
      'segments too high',
      { name: 'x', parts: [{ name: 'a', primitive: 'uv_sphere', params: { segments: 4096 } }] },
    ],
    ['bad name', { name: 'x; import os', parts: [] }],
    [
      'duplicate part',
      {
        name: 'x',
        parts: [
          { name: 'a', primitive: 'cube' },
          { name: 'a', primitive: 'cube' },
        ],
      },
    ],
    ['unknown material', { name: 'x', parts: [{ name: 'a', primitive: 'cube', material: 'nope' }] }],
    ['unknown parent', { name: 'x', parts: [{ name: 'a', primitive: 'cube', parent: 'b' }] }],
    ['huge location', { name: 'x', parts: [{ name: 'a', primitive: 'cube', location: [1e9, 0, 0] }] }],
    [
      'too many parts',
      {
        name: 'x',
        parts: Array.from({ length: 160 }, (_, i) => ({ name: `p${i}`, primitive: 'cube', mirrorX: true })),
      },
    ],
  ])('rejects %s', (_label, spec) => {
    expect(modelSpecSchema.safeParse(spec).success).toBe(false);
  });
});

const stats = (over: Partial<SceneStats> = {}): SceneStats => ({
  objects: [
    {
      name: 'body',
      type: 'MESH',
      vertices: 100,
      triangles: 1000,
      materials: ['fur'],
      dimensions: [1, 1, 1.2],
      hasUVs: true,
      modifiers: [],
    },
  ],
  totals: { meshObjects: 1, vertices: 100, triangles: 1000, materials: 1 },
  bounds: { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 1.2], size: [1, 1, 1.2] },
  issues: { nonManifoldEdges: 0, looseVertices: 0, zeroAreaFaces: 0 },
  armatures: 0,
  unitScale: 1,
  ...over,
});

describe('validateForRoblox', () => {
  const cfg = parseConfig({}).roblox;
  it('passes a small static mesh and reports size in studs', () => {
    const r = validateForRoblox(stats(), cfg);
    expect(r.ok).toBe(true);
    expect(r.sizeStuds[2]).toBeCloseTo(1.2 / 0.28, 1);
    expect(r.info.join(' ')).toMatch(/no armature/);
  });
  it('fails meshes over the triangle cap', () => {
    const s = stats();
    s.objects[0]!.triangles = 25_000;
    const r = validateForRoblox(s, cfg);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/25000 triangles/);
  });
  it('warns on multiple materials, missing UVs and non-manifold geometry', () => {
    const s = stats({ issues: { nonManifoldEdges: 4, looseVertices: 0, zeroAreaFaces: 0 } });
    s.objects[0]!.materials = ['a', 'b'];
    s.objects[0]!.hasUVs = false;
    const r = validateForRoblox(s, cfg);
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(3);
  });
  it('fails empty scenes and oversize models', () => {
    expect(validateForRoblox(stats({ objects: [] }), cfg).ok).toBe(false);
    expect(
      validateForRoblox(stats({ bounds: { min: [0, 0, 0], max: [1000, 1, 1], size: [1000, 1, 1] } }), cfg).ok,
    ).toBe(false);
  });
});
