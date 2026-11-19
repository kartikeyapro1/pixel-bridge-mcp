import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PixelBridgeError } from '../../src/core/errors.js';
import type { ImageProvider } from '../../src/providers/types.js';
import { MockImageProvider } from '../../src/providers/mock.js';
import { isPng } from '../../src/util/png.js';
import { makeBridge, type TestBridge } from '../helpers.js';

describe('ImageService', () => {
  let t: TestBridge;
  afterEach(() => t?.done());

  it('generates, saves into the collection, registers metadata and writes a manifest', async () => {
    t = makeBridge();
    const r = await t.pb.images.generate({
      prompt: 'orange cat',
      collection: 'Pip the Cat',
      role: 'concept',
    });
    expect(r.status).toBe('generated');
    const a = r.assets[0]!;
    expect(a.path).toBe('assets/characters/pip-the-cat/references/pip-the-cat-concept.png');
    const abs = path.join(t.dir, a.path);
    expect(isPng(readFileSync(abs))).toBe(true);
    expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toMatchObject({ provider: 'mock', prompt: 'orange cat', actualCostUsd: 0.01 });
    const manifest = JSON.parse(
      readFileSync(path.join(t.dir, 'assets/characters/pip-the-cat/manifest.json'), 'utf8'),
    ) as {
      assets: { id: string; path: string }[];
    };
    expect(manifest.assets[0]).toMatchObject({ id: a.id, path: 'references/pip-the-cat-concept.png' });
  });

  it('serves identical requests from cache at zero cost, unless bypassed', async () => {
    t = makeBridge();
    const req = { prompt: 'same', collection: 'c' };
    const first = await t.pb.images.generate(req);
    const second = await t.pb.images.generate(req);
    expect(second.status).toBe('cached');
    expect(second.costUsd).toBe(0);
    expect(second.assets[0]!.id).toBe(first.assets[0]!.id);
    expect(t.images.calls).toHaveLength(1);
    const third = await t.pb.images.generate({ ...req, bypassCache: true });
    expect(third.status).toBe('generated');
    expect(third.assets[0]!.path).not.toBe(first.assets[0]!.path); // collision-safe name
    expect(t.images.calls).toHaveLength(2);
  });

  it('invalidates the cache when the cached file was modified or deleted', async () => {
    t = makeBridge();
    const first = await t.pb.images.generate({ prompt: 'p', collection: 'c' });
    writeFileSync(path.join(t.dir, first.assets[0]!.path), 'tampered');
    const again = await t.pb.images.generate({ prompt: 'p', collection: 'c' });
    expect(again.status).toBe('generated');
  });

  it('dry run quotes without spending or writing', async () => {
    t = makeBridge();
    const r = await t.pb.images.generate({ prompt: 'p', collection: 'c', dryRun: true });
    expect(r.status).toBe('dry_run');
    expect(r.estimate.estimatedUsd).toBe(0.01);
    expect(t.images.calls).toHaveLength(0);
    expect(t.pb.ctx.budget.summary().committedUsd).toBe(0);
  });

  it('requires approval above the threshold and accepts confirmCostUsd', async () => {
    t = makeBridge({
      config: {
        providers: { mock: { enabled: true, costPerCallUsd: 0.5 } },
        budget: { approvalThresholdUsd: 0.25 },
      },
    });
    t.images = t.pb.ctx.imageProvider() as MockImageProvider;
    await expect(t.pb.images.generate({ prompt: 'p', collection: 'c' })).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    expect(t.pb.ctx.budget.summary().committedUsd).toBe(0);
    const r = await t.pb.images.generate({ prompt: 'p', collection: 'c', confirmCostUsd: 0.5 });
    expect(r.status).toBe('generated');
  });

  it('stops at the project budget', async () => {
    t = makeBridge({
      config: {
        providers: { mock: { enabled: true, costPerCallUsd: 0.2 } },
        budget: { projectLimitUsd: 0.5 },
      },
    });
    t.images = t.pb.ctx.imageProvider() as MockImageProvider;
    await t.pb.images.generate({ prompt: 'a', collection: 'c' });
    await t.pb.images.generate({ prompt: 'b', collection: 'c' });
    await expect(t.pb.images.generate({ prompt: 'c', collection: 'c' })).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
  });

  it('releases the reservation when the provider definitely did not bill, keeps it otherwise', async () => {
    const failing = (details: Record<string, unknown>): ImageProvider => {
      const m = new MockImageProvider(0.1);
      m.generate = async () => {
        throw new PixelBridgeError('PROVIDER_REJECTED', 'nope', { details });
      };
      return m;
    };
    t = makeBridge({ imageProviders: [failing({ billed: false })] });
    await expect(t.pb.images.generate({ prompt: 'p', collection: 'c' })).rejects.toThrow('nope');
    expect(t.pb.ctx.budget.summary()).toMatchObject({ committedUsd: 0, unknownUsd: 0, inFlight: 0 });
    t.done();

    t = makeBridge({ imageProviders: [failing({ mayHaveBilled: true })] });
    await expect(t.pb.images.generate({ prompt: 'p', collection: 'c' })).rejects.toThrow('nope');
    expect(t.pb.ctx.budget.summary().unknownUsd).toBeCloseTo(0.1);
  });

  it('turnaround: front generated, other views edited with the front as reference', async () => {
    t = makeBridge();
    const quote = await t.pb.images.turnaround({
      collection: 'pip',
      description: 'an orange cat',
      dryRun: true,
    });
    expect(quote.totalEstimateUsd).toBeCloseTo(0.03);
    const r = await t.pb.images.turnaround({
      collection: 'pip',
      description: 'an orange cat',
      views: ['side', 'back'],
    });
    expect(r.status).toBe('generated');
    expect(r.views.map((v) => v.view)).toEqual(['front', 'side', 'back']);
    expect(t.images.calls.map((c) => c.op)).toEqual(['generate', 'edit', 'edit']);
    const front = r.views[0]!.outcome!.assets[0]!;
    const side = r.views[1]!.outcome!.assets[0]!;
    expect(side.referenceIds).toEqual([front.id]);
    expect(side.parentId).toBe(front.id);
    expect(t.images.calls[1]!.params.prompt).toMatch(/side profile/);
    expect(r.warnings.join(' ')).toMatch(/not guaranteed to be geometrically consistent/);
  });

  it('turnaround approval applies to the total', async () => {
    t = makeBridge({
      config: {
        providers: { mock: { enabled: true, costPerCallUsd: 0.1 } },
        budget: { approvalThresholdUsd: 0.25 },
      },
    });
    t.images = t.pb.ctx.imageProvider() as MockImageProvider;
    await expect(t.pb.images.turnaround({ collection: 'x', description: 'y' })).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    const r = await t.pb.images.turnaround({ collection: 'x', description: 'y', confirmCostUsd: 0.3 });
    expect(r.status).toBe('generated');
  });

  it('rejects reference images outside the project or that are not images', async () => {
    t = makeBridge();
    await expect(
      t.pb.images.edit({ prompt: 'p', collection: 'c', images: ['../../outside.png'] }),
    ).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_PROJECT',
    });
    writeFileSync(path.join(t.dir, 'notes.txt'), 'hello');
    await expect(t.pb.images.edit({ prompt: 'p', collection: 'c', images: ['notes.txt'] })).rejects.toThrow(
      /not a PNG/,
    );
    expect(existsSync(path.join(t.dir, 'assets'))).toBe(false);
  });
});
