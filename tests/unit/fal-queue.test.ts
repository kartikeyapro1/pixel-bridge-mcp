import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config.js';
import { extractFiles, FalQueueProvider } from '../../src/providers/fal-queue.js';
import { fakeFetch, jsonResponse } from '../helpers.js';

const KEY = 'fal-key-0123456789abcdef';
const MODEL = 'fal-ai/test-video/i2v';
const Q = 'https://queue.fal.run';

function provider(handler: Parameters<typeof fakeFetch>[0], modelCfg: Record<string, unknown> = {}) {
  const cfg = parseConfig({
    providers: {
      fal: {
        maxRetries: 1,
        timeoutMs: 1000,
        models: {
          [MODEL]: {
            kind: 'video',
            pricing: { perSecondUsd: 0.1 },
            fields: { prompt: 'prompt', image: 'image_url', duration: 'duration' },
            allowedDurations: [5, 10],
            ...modelCfg,
          },
          'fal-ai/unpriced': { kind: 'video' },
        },
      },
    },
  });
  const f = fakeFetch(handler);
  return { p: new FalQueueProvider(cfg.providers.fal, KEY, f.fn), calls: f.calls };
}

const submitBody = {
  request_id: 'req1',
  status_url: `${Q}/fal-ai/test-video/requests/req1/status`,
  response_url: `${Q}/fal-ai/test-video/requests/req1`,
  cancel_url: `${Q}/fal-ai/test-video/requests/req1/cancel`,
};

describe('FalQueueProvider', () => {
  it('estimates from configured per-second pricing and refuses unpriced models', () => {
    const { p } = provider(() => jsonResponse({}));
    expect(
      p.estimate({ kind: 'video', model: MODEL, prompt: 'x', durationSeconds: 5 }).estimatedUsd,
    ).toBeCloseTo(0.5);
    // no duration → most expensive allowed duration
    expect(p.estimate({ kind: 'video', model: MODEL, prompt: 'x' }).estimatedUsd).toBeCloseTo(1.0);
    expect(() => p.estimate({ kind: 'video', model: 'fal-ai/unpriced', prompt: 'x' })).toThrow(
      /No verified price/,
    );
  });

  it('validates durations, kinds and endpoint ids', () => {
    const { p } = provider(() => jsonResponse({}));
    expect(() => p.validate({ kind: 'video', model: MODEL, durationSeconds: 7 })).toThrow(/not allowed/);
    expect(() => p.validate({ kind: '3d', model: MODEL })).toThrow(/configured as video/);
    expect(() => p.validate({ kind: 'video', model: '../../etc' })).toThrow(/Invalid fal endpoint/);
    expect(() => p.validate({ kind: 'video', model: 'fal-ai/missing' })).toThrow(/not configured/);
  });

  it('submits with mapped fields and Key auth, then polls and collects outputs', async () => {
    const { p, calls } = provider((url) => {
      if (url === `${Q}/${MODEL}`) return jsonResponse(submitBody);
      if (url.endsWith('/status')) return jsonResponse({ status: 'COMPLETED' });
      return jsonResponse({
        video: { url: 'https://v3.fal.media/files/out.mp4', content_type: 'video/mp4' },
        thumbnail: { url: 'https://v3.fal.media/t.png' },
      });
    });
    const { remoteId, state } = await p.submit({
      kind: 'video',
      model: MODEL,
      prompt: 'cat walks',
      durationSeconds: 5,
      image: { data: Buffer.from([1, 2, 3]), filename: 'a.png', mime: 'image/png' },
    });
    expect(remoteId).toBe('req1');
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ prompt: 'cat walks', duration: '5' });
    expect(body.image_url).toMatch(/^data:image\/png;base64,/);
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Key ${KEY}`);
    expect(await p.poll(state)).toEqual({ status: 'completed' });
    const out = await p.outputs(state, 'video');
    expect(out.files.map((f) => f.ext).sort()).toEqual(['mp4', 'png']);
  });

  it('maps queue states and failures', async () => {
    let status: Record<string, unknown> = { status: 'IN_QUEUE', queue_position: 3 };
    const { p } = provider(() => jsonResponse(status));
    const state = { statusUrl: submitBody.status_url, responseUrl: submitBody.response_url };
    expect(await p.poll(state)).toEqual({ status: 'queued', position: 3 });
    status = { status: 'IN_PROGRESS' };
    expect(await p.poll(state)).toEqual({ status: 'running' });
    status = { status: 'COMPLETED', error: 'nsfw', error_type: 'content_policy' };
    expect(await p.poll(state)).toEqual({ status: 'failed', error: 'content_policy: nsfw' });
  });

  it('refuses to send the API key to a host other than the queue', async () => {
    const { p, calls } = provider(() =>
      jsonResponse({ ...submitBody, status_url: 'https://evil.example.com/steal' }),
    );
    await expect(p.submit({ kind: 'video', model: MODEL, prompt: 'x' })).rejects.toThrow(/unexpected host/);
    await expect(p.poll({ statusUrl: 'https://evil.example.com/s' })).rejects.toThrow(/unexpected host/);
    expect(calls.every((c) => new URL(c.url).host === 'queue.fal.run')).toBe(true);
  });

  it('downloads outputs without credentials', async () => {
    const { p, calls } = provider(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } }),
    );
    const buf = await p.download('https://v3.fal.media/files/out.mp4', 1000);
    expect([...buf]).toEqual([1, 2, 3]);
    expect(JSON.stringify(calls[0]!.init?.headers ?? {})).not.toContain(KEY);
    await expect(p.download('http://insecure.example.com/x.mp4', 1000)).rejects.toThrow(/non-HTTPS/);
  });

  it('enforces the download size limit', async () => {
    const { p } = provider(() => new Response(new Uint8Array(100)));
    await expect(p.download('https://v3.fal.media/x.mp4', 10)).rejects.toThrow(/limit/);
  });

  it('maps cancel responses', async () => {
    for (const [status, expected] of [
      [200, 'cancelled'],
      [202, 'requested'],
      [400, 'too_late'],
      [404, 'not_found'],
    ] as const) {
      const { p } = provider(() => jsonResponse({}, status));
      expect(await p.cancel({ cancelUrl: submitBody.cancel_url })).toBe(expected);
    }
  });

  it('extractFiles walks nested results', () => {
    const files = extractFiles({
      model_mesh: { url: 'https://x.test/m.glb' },
      images: [{ url: 'https://x.test/a.png', file_name: 'a.png' }],
    });
    expect(files.map((f) => `${f.role}:${f.ext}`)).toEqual(['model_mesh:glb', 'images.0:png']);
  });
});
