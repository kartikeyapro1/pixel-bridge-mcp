import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config.js';
import { actualCost, OpenAIImageProvider } from '../../src/providers/openai-image.js';
import type { ImageParams } from '../../src/providers/types.js';
import { encodePng } from '../../src/util/png.js';
import { fakeFetch, jsonResponse } from '../helpers.js';

const KEY = 'sk-test-0123456789abcdef';
const png = encodePng(4, 4, () => [255, 0, 0, 255]);
const okBody = {
  data: [{ b64_json: png.toString('base64') }],
  output_format: 'png',
  usage: {
    input_tokens: 50,
    output_tokens: 1000,
    input_tokens_details: { text_tokens: 50, image_tokens: 0 },
  },
};

function provider(
  fetchFn: (u: string, i?: RequestInit) => Promise<Response>,
  cfg: Record<string, unknown> = {},
) {
  const c = parseConfig({ providers: { openai: { maxRetries: 2, timeoutMs: 1000, ...cfg } } });
  return new OpenAIImageProvider(c.providers.openai, c.imagePricingOverrides, KEY, fetchFn);
}

const params = (over: Partial<ImageParams> = {}): ImageParams => ({
  model: 'gpt-image-2',
  prompt: 'a cat',
  size: '1024x1024',
  quality: 'medium',
  background: 'auto',
  outputFormat: 'png',
  n: 1,
  ...over,
});

describe('OpenAIImageProvider', () => {
  it('generates, decodes base64 and computes actual cost from usage', async () => {
    const f = fakeFetch(() => jsonResponse(okBody));
    const res = await provider(f.fn).generate(params());
    expect(res.images[0]!.data.equals(png)).toBe(true);
    expect(f.calls[0]!.url).toBe('https://api.openai.com/v1/images/generations');
    const body = JSON.parse(f.calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-image-2',
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    });
    expect((f.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    // 50 text tokens * $5/M + 1000 image out * $30/M
    expect(res.actualCostUsd).toBeCloseTo(0.03025, 6);
  });

  it('sends edits as multipart with image[] parts and omits input_fidelity for gpt-image-2', async () => {
    const f = fakeFetch(() => jsonResponse(okBody));
    const img = { data: png, filename: 'a.png', mime: 'image/png' };
    await provider(f.fn).edit({ ...params(), images: [img, img], inputFidelity: 'high' });
    const form = f.calls[0]!.init!.body as FormData;
    expect(f.calls[0]!.url).toMatch(/\/images\/edits$/);
    expect(form.getAll('image[]')).toHaveLength(2);
    expect(form.get('input_fidelity')).toBeNull();
    const f2 = fakeFetch(() => jsonResponse(okBody));
    await provider(f2.fn).edit({
      ...params({ model: 'gpt-image-1.5' }),
      images: [img],
      inputFidelity: 'high',
    });
    expect((f2.calls[0]!.init!.body as FormData).get('input_fidelity')).toBe('high');
  });

  it('maps 401 to PROVIDER_AUTH without retrying and never leaks the key', async () => {
    const f = fakeFetch(() =>
      jsonResponse({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401),
    );
    const err = (await provider(f.fn)
      .generate(params())
      .catch((e: unknown) => e)) as { code: string; message: string; details: unknown };
    expect(err.code).toBe('PROVIDER_AUTH');
    expect(err.message).not.toContain(KEY);
    expect(f.calls).toHaveLength(1);
    expect(err.details).toMatchObject({ billed: false });
  });

  it('retries 429 with Retry-After and then succeeds', async () => {
    const f = fakeFetch((_u, _i, n) =>
      n === 1
        ? jsonResponse({ error: { message: 'slow down' } }, 429, { 'retry-after': '0' })
        : jsonResponse(okBody),
    );
    const res = await provider(f.fn).generate(params());
    expect(res.images).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
  });

  it('gives up after maxRetries on persistent 5xx', async () => {
    const f = fakeFetch(() => new Response('oops', { status: 503, headers: { 'retry-after': '0' } }));
    await expect(provider(f.fn, { maxRetries: 1 }).generate(params())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(f.calls).toHaveLength(2);
  });

  it('does NOT retry a generation that timed out (it may have been billed)', async () => {
    const f = fakeFetch(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () =>
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const err = (await provider(f.fn, { timeoutMs: 1000 })
      .generate(params())
      .catch((e: unknown) => e)) as { code: string; details: Record<string, unknown> };
    expect(err.code).toBe('PROVIDER_TIMEOUT');
    expect(err.details.mayHaveBilled).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it('rejects responses without images', async () => {
    const f = fakeFetch(() => jsonResponse({ data: [] }));
    await expect(provider(f.fn).generate(params())).rejects.toMatchObject({ code: 'PROVIDER_BAD_RESPONSE' });
  });

  it('validates parameters before any request', () => {
    const p = provider(fakeFetch(() => jsonResponse(okBody)).fn);
    expect(() => p.validate(params({ background: 'transparent', outputFormat: 'jpeg' }), 'generate')).toThrow(
      /png or webp/,
    );
    expect(() => p.validate(params({ size: '1000x1000' }), 'generate')).toThrow(/multiples of 16/);
    expect(() => p.validate(params({ size: '4000x400' }), 'generate')).toThrow();
    expect(() => p.validate(params({ model: 'gpt-image-1.5', size: '2048x2048' }), 'generate')).toThrow(
      /only supports/,
    );
    expect(() => p.validate(params({ size: '2048x1152' }), 'generate')).not.toThrow();
  });

  describe('estimate', () => {
    const p = provider(fakeFetch(() => jsonResponse(okBody)).fn);
    it('uses the published table', () => {
      const e = p.estimate(params({ quality: 'high' }), 'generate', 0);
      expect(e.estimatedUsd).toBeCloseTo(0.211, 3);
      expect(e.basis).toMatch(/published/);
    });
    it('is conservative for auto quality/size', () => {
      expect(
        p.estimate(params({ quality: 'auto', size: 'auto' }), 'generate', 0).estimatedUsd,
      ).toBeGreaterThanOrEqual(0.211);
    });
    it('scales custom sizes by area and multiplies by n', () => {
      const big = p.estimate(params({ size: '2048x2048', n: 2 }), 'generate', 0).estimatedUsd;
      expect(big).toBeCloseTo(0.053 * 4 * 2, 2);
    });
    it('extrapolates for models without a table and says so', () => {
      const e = p.estimate(params({ model: 'gpt-image-2.5-flare' }), 'generate', 0);
      expect(e.basis).toMatch(/extrapolated/);
      expect(e.estimatedUsd).toBeGreaterThan(0.053);
    });
    it('adds input-image cost for edits', () => {
      const gen = p.estimate(params(), 'generate', 0).estimatedUsd;
      expect(p.estimate(params(), 'edit', 3).estimatedUsd).toBeGreaterThan(gen);
    });
    it('refuses unknown models instead of guessing', () => {
      expect(() => p.estimate(params({ model: 'some-future-model' }), 'generate', 0)).toThrow(/No price/);
    });
    it('honours config overrides', () => {
      const c = parseConfig({ imagePricingOverrides: { 'some-future-model': { 'medium:1024x1024': 0.5 } } });
      const p2 = new OpenAIImageProvider(c.providers.openai, c.imagePricingOverrides, KEY, fetch);
      expect(p2.estimate(params({ model: 'some-future-model' }), 'generate', 0).estimatedUsd).toBeCloseTo(
        0.5,
        2,
      );
    });
  });

  it('actualCost returns null without usage or for unknown models', () => {
    expect(actualCost('gpt-image-2', undefined)).toBeNull();
    expect(actualCost('mystery', { output_tokens: 10 })).toBeNull();
  });
});
