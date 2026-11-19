import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/core/logger.js';
import { ProjectPaths } from '../../src/core/paths.js';
import { BlenderService } from '../../src/services/blender-service.js';
import { isPng, pngSize } from '../../src/util/png.js';
import { makeBridge, testConfig, tempDir, cleanup, type TestBridge } from '../helpers.js';

/**
 * Real Blender integration tests. They run only when Blender is installed
 * (auto-detected, or BLENDER_PATH) and are skipped — not passed — otherwise.
 * Set PIXELBRIDGE_SKIP_BLENDER=1 to skip explicitly.
 */

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/specs');
const probeDir = tempDir('pb-probe-');
const info = await new BlenderService(
  testConfig().blender,
  new ProjectPaths(probeDir),
  silentLogger,
).detect();
cleanup(probeDir);
const skipReason =
  process.env.PIXELBRIDGE_SKIP_BLENDER === '1'
    ? 'PIXELBRIDGE_SKIP_BLENDER=1'
    : !info.found || !info.supported
      ? info.message
      : null;
if (skipReason) console.warn(`[blender integration] SKIPPED: ${skipReason}`);

describe.skipIf(skipReason !== null)(`Blender integration (${info.version ?? 'not found'})`, () => {
  let t: TestBridge;
  beforeAll(() => {
    t = makeBridge();
  });
  afterAll(() => t?.done());

  it('builds, renders, exports and validates the simple crate', async () => {
    const spec = JSON.parse(readFileSync(path.join(examples, 'simple-crate.json'), 'utf8')) as unknown;
    const built = await t.pb.models.build({ collection: 'crate', category: 'props', spec });
    expect(built.version).toBe(1);
    expect(statSync(path.join(t.dir, built.blend.path)).size).toBeGreaterThan(1000);
    expect(existsSync(path.join(t.dir, `${built.blend.path}1`))).toBe(false); // no .blend1 backup
    expect(built.stats.totals.meshObjects).toBe(1);
    expect(built.stats.bounds.min[2]).toBeCloseTo(0, 3); // origin bottom_center
    expect(built.validation.ok).toBe(true);

    const r = await t.pb.models.render({
      blendAssetId: built.blend.id,
      views: ['front', 'three_quarter'],
      resolution: 128,
    });
    expect(r.renders).toHaveLength(2);
    for (const a of r.renders) {
      const data = readFileSync(path.join(t.dir, a.path));
      expect(isPng(data)).toBe(true);
      expect(pngSize(data)).toEqual({ width: 128, height: 128 });
    }

    const ex = await t.pb.models.export({ blendAssetId: built.blend.id, formats: ['glb', 'obj'] });
    expect(ex.exports.map((e) => e.format)).toEqual(['glb', 'obj']);
    for (const e of ex.exports) {
      expect(existsSync(path.join(t.dir, e.asset.path))).toBe(true);
      expect(e.stats.totals.triangles).toBe(built.stats.totals.triangles);
      expect(e.validation.ok).toBe(true);
    }
  }, 120_000);

  it('runs the character pipeline: references → model with reference planes → previews → export', async () => {
    const sheet = await t.pb.images.turnaround({
      collection: 'pip',
      description: 'an original orange chibi cat',
    });
    const ref = (view: string) => sheet.views.find((v) => v.view === view)!.outcome!.assets[0]!.id;
    const spec = JSON.parse(readFileSync(path.join(examples, 'cartoon-cat.json'), 'utf8')) as unknown;
    const built = await t.pb.models.build({
      collection: 'pip',
      spec,
      references: [
        { view: 'front', image: ref('front') },
        { view: 'side', image: ref('side') },
        { view: 'back', image: ref('back') },
      ],
      note: 'initial blockout',
    });
    expect(built.blend.referenceIds).toHaveLength(3);
    expect(built.stats.totals.triangles).toBeLessThan(20_000);
    expect(built.validation.ok).toBe(true);
    // Reference planes must not leak into stats or exports.
    expect(
      built.stats.objects.some(
        (o) => /ref/i.test(o.name) && o.type === 'MESH' && o.materials.some((m) => /ref/i.test(m)),
      ),
    ).toBe(false);

    const r = await t.pb.models.render({ blendAssetId: built.blend.id, resolution: 256 });
    expect(r.renders.map((a) => a.role)).toEqual(['render-front', 'render-side', 'render-three_quarter']);
    expect(r.references).toHaveLength(3);
    const thumbs = await t.pb.models.thumbnails(
      r.references.map((a) => path.join(t.dir, a.path)),
      128,
    );
    for (const th of thumbs) {
      const s = pngSize(readFileSync(th))!;
      expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(128);
    }

    // A refinement creates version 2 linked to version 1; version 1 is kept.
    const v2 = await t.pb.models.build({ collection: 'pip', spec, note: 'refinement' });
    expect(v2.version).toBe(2);
    expect(v2.blend.parentId).toBe(built.blend.id);
    expect(existsSync(path.join(t.dir, built.blend.path))).toBe(true);

    const ex = await t.pb.models.export({ blendAssetId: v2.blend.id, formats: ['glb', 'fbx'] });
    expect(ex.exports.every((e) => e.validation.ok)).toBe(true);
    const v = await t.pb.models.validate(ex.exports[0]!.asset.id);
    expect(v.report.ok).toBe(true);
    expect(v.report.sizeStuds[2]).toBeGreaterThan(3);
  }, 240_000);

  it('rejects specs the interpreter would refuse before starting Blender', async () => {
    await expect(
      t.pb.models.build({
        collection: 'bad',
        spec: { name: 'x', parts: [{ name: 'a', primitive: 'teapot' }] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('enforces the model version cap', async () => {
    const capped = makeBridge({
      config: { providers: { mock: { enabled: true } }, pipeline: { maxModelVersions: 1 } },
    });
    try {
      const spec = JSON.parse(readFileSync(path.join(examples, 'simple-crate.json'), 'utf8')) as unknown;
      await capped.pb.models.build({ collection: 'c', spec });
      await expect(capped.pb.models.build({ collection: 'c', spec })).rejects.toMatchObject({
        code: 'REFINEMENT_LIMIT',
      });
    } finally {
      capped.done();
    }
  }, 120_000);
});
