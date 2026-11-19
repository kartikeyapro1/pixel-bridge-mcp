import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockJobProvider } from '../../src/providers/mock.js';
import { cleanup, makeBridge, tempDir, type TestBridge } from '../helpers.js';

describe('JobService', () => {
  let t: TestBridge | undefined;
  afterEach(() => {
    t?.done();
    t = undefined;
  });

  it('submits, polls and downloads a video into the project', async () => {
    t = makeBridge({ pollsUntilDone: 2 });
    const sub = await t.pb.jobs.submit({ kind: 'video', prompt: 'cat walk cycle', collection: 'pip' });
    expect(sub.status).toBe('submitted');
    const id = sub.job!.id;
    const first = await t.pb.jobs.refresh(id);
    expect(first.job.status).toBe('running');
    const second = await t.pb.jobs.refresh(id);
    expect(second.job.status).toBe('downloaded');
    expect(second.assets[0]!.path).toBe('assets/videos/pip/videos/pip-video.mp4');
    expect(existsSync(path.join(t.dir, second.assets[0]!.path))).toBe(true);
    // Terminal jobs return the same assets without contacting the provider again.
    const third = await t.pb.jobs.refresh(id);
    expect(third.assets.map((a) => a.id)).toEqual(second.assets.map((a) => a.id));
    expect(t.pb.ctx.budget.summary().committedUsd).toBeCloseTo(0.01);
  });

  it('survives a server restart (job state is persisted)', async () => {
    const dir = tempDir();
    const provider = new MockJobProvider(0.01, 1);
    const a = makeBridge({ dir, jobProviders: [provider] });
    const id = (await a.pb.jobs.submit({ kind: 'video', prompt: 'x', collection: 'c' })).job!.id;
    a.done();
    const b = makeBridge({ dir, jobProviders: [provider] });
    expect(b.pb.jobs.list().map((j) => j.id)).toContain(id);
    const r = await b.pb.jobs.refresh(id);
    expect(r.job.status).toBe('downloaded');
    b.done();
    cleanup(dir);
  });

  it('records provider failures', async () => {
    const p = new MockJobProvider(0.01, 1, new Set(['mock-video']));
    t = makeBridge({ jobProviders: [p] });
    const id = (await t.pb.jobs.submit({ kind: 'video', prompt: 'x', collection: 'c' })).job!.id;
    const r = await t.pb.jobs.refresh(id);
    expect(r.job).toMatchObject({ status: 'failed', error: 'mock failure' });
    // Unknown whether a failed job is billed → still counted, visible as unknown.
    expect(t.pb.ctx.budget.summary().unknownUsd).toBeCloseTo(0.01);
  });

  it('cancels queued jobs and releases their reservation', async () => {
    t = makeBridge({ pollsUntilDone: 5 });
    const id = (await t.pb.jobs.submit({ kind: 'video', prompt: 'x', collection: 'c' })).job!.id;
    const r = await t.pb.jobs.cancel(id);
    expect(r.outcome).toBe('cancelled');
    expect(r.job.status).toBe('cancelled');
    expect(t.pb.ctx.budget.summary().committedUsd).toBe(0);
  });

  it('limits concurrently running jobs', async () => {
    t = makeBridge({
      pollsUntilDone: 10,
      config: { providers: { mock: { enabled: true } }, budget: { maxInFlight: 2 } },
    });
    await t.pb.jobs.submit({ kind: 'video', prompt: 'a', collection: 'c' });
    await t.pb.jobs.submit({ kind: 'video', prompt: 'b', collection: 'c' });
    await expect(t.pb.jobs.submit({ kind: 'video', prompt: 'c', collection: 'c' })).rejects.toMatchObject({
      code: 'CONCURRENCY_LIMIT',
    });
  });

  it('keeps a completed job resumable when the download fails', async () => {
    const p = new MockJobProvider(0.01, 1);
    let failNext = true;
    const original = p.download.bind(p);
    p.download = async (url: string) => {
      if (failNext) {
        failNext = false;
        throw new Error('connection reset');
      }
      return original(url);
    };
    t = makeBridge({ jobProviders: [p] });
    const id = (await t.pb.jobs.submit({ kind: '3d', image: undefined, prompt: 'x', collection: 'c' })).job!
      .id;
    await expect(t.pb.jobs.refresh(id)).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    expect(t.pb.jobs.get(id).status).toBe('completed');
    const r = await t.pb.jobs.refresh(id);
    expect(r.job.status).toBe('downloaded');
    expect(r.assets[0]!.kind).toBe('model');
  });

  it('reuses a completed identical job from cache', async () => {
    t = makeBridge({ pollsUntilDone: 1 });
    const id = (await t.pb.jobs.submit({ kind: 'video', prompt: 'same', collection: 'c' })).job!.id;
    await t.pb.jobs.refresh(id);
    const again = await t.pb.jobs.submit({ kind: 'video', prompt: 'same', collection: 'c' });
    expect(again.status).toBe('cached');
    expect(again.assets).toHaveLength(1);
  });
});
