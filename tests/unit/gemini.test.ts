import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config.js';
import { silentLogger } from '../../src/core/logger.js';
import {
  chooseTier,
  GeminiImageProvider,
  GeminiVideoProvider,
  nearestAspect,
  usageCost,
} from '../../src/providers/gemini.js';
import type { ImageParams } from '../../src/providers/types.js';
import { encodePng } from '../../src/util/png.js';
import { PixelBridge } from '../../src/services/pixelbridge.js';
import { createServer } from '../../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { cleanup, fakeFetch, jsonResponse, tempDir } from '../helpers.js';

const KEY = 'test-gemini-key-0123456789abcdefghijklmnop';
const API = 'https://generativelanguage.googleapis.com/v1beta';
const png = encodePng(4, 4, () => [0, 128, 255, 255]);
const img = { data: png, filename: 'ref.png', mime: 'image/png' };

const cfg = (over: Record<string, unknown> = {}) =>
  parseConfig({ providers: { gemini: { maxRetries: 1, timeoutMs: 1000, ...over } } }).providers.gemini;

const imageInteraction = (usage?: Record<string, unknown>) => ({
  id: 'v1_img',
  status: 'completed',
  steps: [
    { type: 'user_input', content: [{ type: 'text', text: 'x' }] },
    { type: 'thought', content: [{ type: 'thought', text: '...' }] },
    {
      type: 'model_output',
      content: [
        { type: 'text', text: 'Here you go' },
        { type: 'image', mime_type: 'image/png', data: png.toString('base64') },
      ],
    },
  ],
  ...(usage ? { usage } : {}),
});

const params = (over: Partial<ImageParams> = {}): ImageParams => ({
  model: 'gemini-nano-banana-2.1',
  prompt: 'an orange cat',
  size: '1024x1024',
  quality: 'medium',
  background: 'auto',
  outputFormat: 'png',
  n: 1,
  ...over,
});

describe('Gemini size mapping', () => {
  it('maps WxH to the nearest supported aspect ratio', () => {
    expect(nearestAspect('1024x1024')).toBe('1:1');
    expect(nearestAspect('1024x1536')).toBe('2:3');
    expect(nearestAspect('1920x1080')).toBe('16:9');
    expect(nearestAspect('2560x1080')).toBe('21:9');
    expect(nearestAspect('auto')).toBeNull();
  });
  it('picks a tier from the long side; high quality means at least 2K', () => {
    const tiers = ['1K', '2K', '4K'] as const;
    expect(chooseTier('1024x1024', 'medium', [...tiers])).toBe('1K');
    expect(chooseTier('1024x1024', 'high', [...tiers])).toBe('2K');
    expect(chooseTier('2048x2048', 'low', [...tiers])).toBe('2K');
    expect(chooseTier('4000x2000', 'low', [...tiers])).toBe('4K');
    expect(chooseTier('2048x2048', 'low', ['1K'])).toBe('1K');
  });
});

describe('GeminiImageProvider', () => {
  it('sends an Interactions request with one key header and parses the image', async () => {
    const f = fakeFetch(() =>
      jsonResponse(
        imageInteraction({
          total_input_tokens: 20,
          total_output_tokens: 1320,
          output_tokens_by_modality: [
            { modality: 'IMAGE', tokens: 1120 },
            { modality: 'TEXT', tokens: 200 },
          ],
        }),
      ),
    );
    const p = new GeminiImageProvider(cfg(), KEY, f.fn);
    const res = await p.generate(params({ size: '1024x1536' }));
    expect(res.images[0]!.data.equals(png)).toBe(true);
    expect(f.calls[0]!.url).toBe(`${API}/interactions`);
    const headers = f.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe(KEY);
    expect(headers['Api-Revision']).toBe('2026-05-20');
    const body = JSON.parse(f.calls[0]!.init!.body as string) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body).toMatchObject({
      model: 'gemini-nano-banana-2.1',
      response_format: { type: 'image', aspect_ratio: '2:3', image_size: '1K' },
      store: false,
      generation_config: { thinking_level: 'minimal' },
    });
    expect(body.response_format.mime_type).toBeUndefined(); // API accepts only image/jpeg here
    // 20 in × $1.5/M + 1120 image × $30/M + 200 text × $7.5/M
    expect(res.actualCostUsd).toBeCloseTo(0.03513, 5);
  });

  it('sends reference images inline for edits', async () => {
    const f = fakeFetch(() => jsonResponse(imageInteraction()));
    await new GeminiImageProvider(cfg(), KEY, f.fn).edit({ ...params(), images: [img, img] });
    const body = JSON.parse(f.calls[0]!.init!.body as string) as { input: { type: string; data?: string }[] };
    expect(body.input.map((i) => i.type)).toEqual(['text', 'image', 'image']);
    expect(body.input[1]!.data).toBe(png.toString('base64'));
  });

  it('reports when the model returns text instead of an image', async () => {
    const f = fakeFetch(() =>
      jsonResponse({
        id: 'x',
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot draw that' }] }],
      }),
    );
    await expect(new GeminiImageProvider(cfg(), KEY, f.fn).generate(params())).rejects.toThrow(
      /I cannot draw that/,
    );
  });

  it('maps API errors and never leaks the key', async () => {
    const f = fakeFetch(() =>
      jsonResponse(
        { error: { code: 400, message: `API key not valid: ${KEY}`, status: 'INVALID_ARGUMENT' } },
        400,
      ),
    );
    const err = (await new GeminiImageProvider(cfg(), KEY, f.fn)
      .generate(params())
      .catch((e: unknown) => e)) as {
      code: string;
      message: string;
    };
    expect(err.code).toBe('PROVIDER_REJECTED');
    expect(err.message).not.toContain(KEY);
  });

  it('validates unsupported options before any request', () => {
    const p = new GeminiImageProvider(cfg(), KEY, fakeFetch(() => jsonResponse({})).fn);
    expect(() => p.validate(params({ background: 'transparent' }))).toThrow(/transparent/);
    expect(() => p.validate(params({ outputFormat: 'webp' }))).toThrow(/png or jpeg/);
    expect(() => p.validate(params({ n: 2 }))).toThrow(/one image per call/);
    expect(() => p.validate(params({ model: 'imagen-4' }))).toThrow(/No price/);
    expect(() => p.validate(params({ size: 'huge' }))).toThrow(/Invalid size/);
    expect(p.edit({ ...params(), images: [img], mask: img })).rejects.toThrow(/masks/);
  });

  it('estimates from the published per-image price', () => {
    const p = new GeminiImageProvider(cfg(), KEY, fakeFetch(() => jsonResponse({})).fn);
    const gen = p.estimate(params(), 'generate', 0);
    expect(gen.estimatedUsd).toBeGreaterThan(0.0336);
    expect(gen.estimatedUsd).toBeLessThan(0.045);
    expect(p.estimate(params({ quality: 'high' }), 'generate', 0).estimatedUsd).toBeGreaterThan(0.0504);
    expect(p.estimate(params(), 'edit', 3).estimatedUsd).toBeGreaterThan(gen.estimatedUsd);
  });

  it('refuses a base URL on another host (the key must only go to Google)', () => {
    expect(() => new GeminiImageProvider(cfg({ baseUrl: 'https://evil.example.com/v1beta' }), KEY)).toThrow(
      /must point at/,
    );
  });
});

describe('usageCost', () => {
  it('returns null without usage and an upper bound without a modality breakdown', () => {
    const rates = { inputPerM: 1, textOutPerM: 1, mediaOutPerM: 10 };
    expect(usageCost(undefined, rates, 'image')).toBeNull();
    expect(usageCost({ total_input_tokens: 0, total_output_tokens: 1000 }, rates, 'image')).toBeCloseTo(0.01);
    expect(
      usageCost(
        { total_input_tokens: 0, total_output_tokens: 1000, output_tokens_by_modality: { image: 500 } },
        rates,
        'image',
      ),
    ).toBeCloseTo(0.0055);
  });
});

describe('GeminiVideoProvider', () => {
  const videoB64 = Buffer.from('fake-mp4-bytes').toString('base64');
  const done = (content: Record<string, unknown>) => ({
    id: 'v1_vid',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', ...content }] }],
    usage: {
      total_input_tokens: 100,
      total_output_tokens: 46336,
      output_tokens_by_modality: [{ modality: 'VIDEO', tokens: 46336 }],
    },
  });

  it('estimates from the published token rate', () => {
    const p = new GeminiVideoProvider(cfg(), KEY, fakeFetch(() => jsonResponse({})).fn);
    // 8 s × 5792 tokens/s × $12/M ≈ $0.556, plus small input/thinking allowance
    const e = p.estimate({ kind: 'video', model: 'gemini-omni-1.2-flash', prompt: 'a cat walks' });
    expect(e.estimatedUsd).toBeGreaterThan(0.556);
    expect(e.estimatedUsd).toBeLessThan(0.6);
    const big = p.estimate({
      kind: 'video',
      model: 'gemini-omni-1.2-flash',
      prompt: 'x',
      durationSeconds: 15,
      resolution: '4k',
    });
    expect(big.estimatedUsd).toBeGreaterThan(3.1);
  });

  it('validates duration, resolution, aspect, reference count and kind', () => {
    const p = new GeminiVideoProvider(cfg(), KEY, fakeFetch(() => jsonResponse({})).fn);
    const base = { kind: 'video' as const, model: 'gemini-omni-1.2-flash', prompt: 'x' };
    expect(() => p.validate({ ...base, durationSeconds: 20 })).toThrow(/between 3 and 15/);
    expect(() => p.validate({ ...base, durationSeconds: 2.5 })).toThrow(/whole number/);
    expect(() => p.validate({ ...base, resolution: '8k' })).toThrow(/Resolution/);
    expect(() => p.validate({ ...base, aspectRatio: '1:1' })).toThrow(/Aspect/);
    expect(() => p.validate({ ...base, images: Array(7).fill(img) })).toThrow(/At most 6/);
    expect(() => p.validate({ ...base, kind: '3d' })).toThrow(/no image-to-3D/);
    expect(p.defaultModel('3d')).toBeNull();
  });

  it('submits in background mode, polls, and reads an inline video', async () => {
    let polls = 0;
    const f = fakeFetch((url, init) => {
      if (init?.method === 'POST') return jsonResponse({ id: 'v1_vid', status: 'in_progress' });
      polls++;
      return jsonResponse(polls === 1 ? { id: 'v1_vid', status: 'in_progress' } : done({ data: videoB64 }));
    });
    const p = new GeminiVideoProvider(cfg(), KEY, f.fn);
    const { remoteId, state } = await p.submit({
      kind: 'video',
      model: 'gemini-omni-1.2-flash',
      prompt: 'walk cycle',
      images: [img],
      durationSeconds: 8,
    });
    expect(remoteId).toBe('v1_vid');
    const body = JSON.parse(f.calls[0]!.init!.body as string) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body).toMatchObject({
      background: true,
      response_format: { type: 'video', duration: '8s', resolution: '720p', aspect_ratio: '16:9' },
    });
    expect(body.input.map((i: { type: string }) => i.type)).toEqual(['image', 'text']);
    expect(await p.poll(state)).toEqual({ status: 'running' });
    expect(await p.poll(state)).toEqual({ status: 'completed' });
    expect(f.calls[1]!.url).toBe(`${API}/interactions/v1_vid`);
    const out = await p.outputs(state);
    expect(out.files[0]!.ext).toBe('mp4');
    // 100 × $1.5/M + 46336 × $12/M
    expect(out.actualCostUsd).toBeCloseTo(0.55618, 4);
    const data = await p.download(out.files[0]!.url, 1_000_000);
    expect(data.toString()).toBe('fake-mp4-bytes');
    expect(f.calls).toHaveLength(3); // completed result reused, not refetched
  });

  it('falls back to a synchronous call when background mode is rejected', async () => {
    const f = fakeFetch((_u, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { background?: boolean };
      if (body.background)
        return jsonResponse({ error: { message: 'background is not supported for this model' } }, 400);
      return jsonResponse(done({ data: videoB64 }));
    });
    const p = new GeminiVideoProvider(cfg(), KEY, f.fn);
    const { state } = await p.submit({ kind: 'video', model: 'gemini-omni-1.2-flash', prompt: 'x' });
    expect(state.mode).toBe('sync');
    expect(await p.poll(state)).toEqual({ status: 'completed' });
  });

  it('downloads URI-delivered files only from the Gemini API host', async () => {
    const f = fakeFetch((url) =>
      url.includes('/interactions/')
        ? jsonResponse(done({ uri: `${API}/files/abc:download?alt=media` }))
        : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } }),
    );
    const p = new GeminiVideoProvider(cfg(), KEY, f.fn);
    const out = await p.outputs({ interactionId: 'v1_vid', model: 'gemini-omni-1.2-flash' });
    expect([...(await p.download(out.files[0]!.url, 100))]).toEqual([1, 2, 3]);
    await expect(p.download('https://evil.example.com/files/x', 100)).rejects.toThrow(/unexpected host/);
    expect(f.calls.every((c) => new URL(c.url).host === 'generativelanguage.googleapis.com')).toBe(true);
  });

  it('maps failed and cancelled interactions, and reports cancel as a request', async () => {
    let status = 'failed';
    const f = fakeFetch((url, init) => {
      if (url.endsWith('/cancel')) return jsonResponse({}, 200);
      void init;
      return jsonResponse({ id: 'v', status, error: { message: 'safety filter' } });
    });
    const p = new GeminiVideoProvider(cfg(), KEY, f.fn);
    expect(await p.poll({ interactionId: 'v' })).toEqual({
      status: 'failed',
      error: 'failed: safety filter',
    });
    status = 'cancelled';
    expect((await p.poll({ interactionId: 'v' })).status).toBe('failed');
    expect(await p.cancel({ interactionId: 'v' })).toBe('requested');
  });
});

describe('single-key wiring', () => {
  it('GEMINI_API_KEY alone enables images and video, and no 3D tool', async () => {
    const dir = tempDir();
    const pb = new PixelBridge({
      projectRoot: dir,
      config: parseConfig({}),
      env: { GEMINI_API_KEY: KEY },
      logger: silentLogger,
    });
    try {
      expect(pb.ctx.imageProvider().id).toBe('gemini');
      expect(pb.ctx.jobProvider('video').id).toBe('gemini');
      expect(pb.ctx.supportsJobKind('3d')).toBe(false);
      expect(() => pb.ctx.jobProvider('3d')).toThrow(/image-to-3D/);
      const status = await pb.status({ checkBlender: false });
      expect(status.setup).toEqual([]);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await createServer(pb).connect(st);
      const client = new Client({ name: 't', version: '0' });
      await client.connect(ct);
      const names = (await client.listTools()).tools.map((x) => x.name);
      expect(names).toContain('generate_video');
      expect(names).not.toContain('generate_3d_from_image');
      await client.close();
    } finally {
      pb.close();
      cleanup(dir);
    }
  });
});
