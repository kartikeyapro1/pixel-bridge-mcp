import type { CostEstimate } from '../core/budget.js';
import type { PixelBridgeConfig } from '../core/config.js';
import { PixelBridgeError } from '../core/errors.js';
import { httpRequest, type FetchLike } from '../core/http.js';
import {
  ASSUMED_INPUT_IMAGE_TOKENS,
  baseModel,
  CUSTOM_SIZE_PREFIXES,
  EXTRAPOLATE_FROM,
  INPUT_FIDELITY_MODELS,
  PER_IMAGE_USD,
  PRICING_SOURCE_DATE,
  TOKEN_RATES_PER_M,
} from './openai-pricing.js';
import type {
  ImageCapabilities,
  ImageEditParams,
  ImageParams,
  ImageProvider,
  ImageResult,
  ImageFormat,
} from './types.js';

const STANDARD_SIZES = ['1024x1024', '1536x1024', '1024x1536'];

export const OPENAI_IMAGE_MODELS = [
  'gpt-image-2',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare',
  'gpt-image-2.6-sunburst',
  'gpt-image-2.6-flare',
  'gpt-image-1.5',
  'gpt-image-1-mini',
  'chatgpt-image-latest',
];

interface OpenAIImageResponse {
  data?: { b64_json?: string }[];
  output_format?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { image_tokens?: number; text_tokens?: number };
    output_tokens_details?: { image_tokens?: number; text_tokens?: number };
  };
}

export class OpenAIImageProvider implements ImageProvider {
  readonly id = 'openai';

  constructor(
    private readonly cfg: PixelBridgeConfig['providers']['openai'],
    private readonly pricingOverrides: PixelBridgeConfig['imagePricingOverrides'],
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  capabilities(): ImageCapabilities {
    return {
      models: OPENAI_IMAGE_MODELS,
      defaultModel: this.cfg.defaultModel,
      edit: true,
      maxReferenceImages: 16,
      transparentBackground: 'model-dependent',
      sizes: ['auto', ...STANDARD_SIZES],
      customSizes: true,
      notes: [
        'Transparent backgrounds: supported on gpt-image-2.5 models, preview on gpt-image-2; require png or webp output.',
        'Custom WxH sizes (multiples of 16, aspect 1:3–3:1, max 3840x2160) are accepted by gpt-image-2 family models.',
        'gpt-image-1 was retired by OpenAI on 2026-10-23 and is not offered.',
        `Cost estimates use OpenAI's published per-image table (transcribed ${PRICING_SOURCE_DATE}); actual cost is computed from response usage.`,
      ],
    };
  }

  validate(p: ImageParams, operation: 'generate' | 'edit'): void {
    const model = baseModel(p.model);
    if (p.background === 'transparent' && p.outputFormat === 'jpeg') {
      throw new PixelBridgeError('INVALID_INPUT', 'Transparent backgrounds require png or webp output.');
    }
    if (p.size !== 'auto' && !STANDARD_SIZES.includes(p.size)) {
      const m = /^(\d{2,4})x(\d{2,4})$/.exec(p.size);
      if (!m)
        throw new PixelBridgeError('INVALID_INPUT', `Invalid size "${p.size}". Use WIDTHxHEIGHT or "auto".`);
      if (!CUSTOM_SIZE_PREFIXES.some((pre) => model.startsWith(pre))) {
        throw new PixelBridgeError(
          'PROVIDER_UNSUPPORTED',
          `${p.model} only supports ${STANDARD_SIZES.join(', ')} or auto.`,
        );
      }
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (w % 16 || h % 16)
        throw new PixelBridgeError('INVALID_INPUT', 'Custom sizes must be multiples of 16.');
      if (w > 3840 || h > 3840 || w * h > 3840 * 2160)
        throw new PixelBridgeError('INVALID_INPUT', 'Maximum custom size is 3840x2160.');
      const ratio = w / h;
      if (ratio > 3 || ratio < 1 / 3)
        throw new PixelBridgeError('INVALID_INPUT', 'Aspect ratio must be within 1:3 and 3:1.');
    }
    if (p.n < 1 || p.n > 10) throw new PixelBridgeError('INVALID_INPUT', 'n must be between 1 and 10.');
    if (operation === 'edit' && model === 'dall-e-2') {
      throw new PixelBridgeError('PROVIDER_UNSUPPORTED', 'dall-e models are not supported.');
    }
  }

  estimate(p: ImageParams, operation: 'generate' | 'edit', referenceCount: number): CostEstimate {
    const model = baseModel(p.model);
    const quality = p.quality === 'auto' ? 'high' : p.quality;
    const override = this.pricingOverrides[model] ?? this.pricingOverrides[p.model];
    let perImage: number | undefined;
    let basis: string;

    const lookup = (table: Record<string, number>): number | undefined => {
      if (p.size === 'auto') {
        const candidates = STANDARD_SIZES.map((s) => table[`${quality}:${s}`]).filter(
          (v): v is number => v !== undefined,
        );
        return candidates.length ? Math.max(...candidates) : undefined;
      }
      const direct = table[`${quality}:${p.size}`];
      if (direct !== undefined) return direct;
      const square = table[`${quality}:1024x1024`];
      if (square === undefined) return undefined;
      const [w, h] = p.size.split('x').map(Number) as [number, number];
      return square * Math.max(1, (w * h) / (1024 * 1024));
    };

    if (override && (perImage = lookup(override)) !== undefined) {
      basis = 'per-image price from imagePricingOverrides';
    } else if (PER_IMAGE_USD[model] && (perImage = lookup(PER_IMAGE_USD[model]!)) !== undefined) {
      basis = `OpenAI published per-image price (${quality}, ${p.size}) as of ${PRICING_SOURCE_DATE}`;
    } else if (EXTRAPOLATE_FROM[model]) {
      const { base, multiplier } = EXTRAPOLATE_FROM[model]!;
      const b = lookup(PER_IMAGE_USD[base]!);
      if (b !== undefined) perImage = b * multiplier;
      basis = `extrapolated: ${base} per-image price ×${multiplier} (no published table for ${model})`;
    } else {
      throw new PixelBridgeError('PRICE_UNKNOWN', `No price information for OpenAI model "${p.model}".`, {
        hint: `Add imagePricingOverrides["${p.model}"] = {"${quality}:1024x1024": <usd>, ...} to pixelbridge.config.json, or use one of: ${Object.keys(PER_IMAGE_USD).join(', ')}.`,
      });
    }
    if (perImage === undefined) {
      throw new PixelBridgeError('PRICE_UNKNOWN', `No price for ${p.model} at ${quality} ${p.size}.`);
    }
    const rates = TOKEN_RATES_PER_M[model] ?? TOKEN_RATES_PER_M['gpt-image-2']!;
    const textTokens = Math.ceil(p.prompt.length / 3);
    let total = perImage * p.n + (textTokens * rates.textIn) / 1e6;
    if (operation === 'edit') {
      total += (referenceCount * ASSUMED_INPUT_IMAGE_TOKENS * rates.imageIn) / 1e6;
      basis += `; +~${ASSUMED_INPUT_IMAGE_TOKENS} input tokens per reference image (assumed)`;
    }
    return {
      provider: this.id,
      model: p.model,
      operation: `image.${operation}`,
      estimatedUsd: Math.round(total * 10_000) / 10_000,
      basis,
    };
  }

  async generate(p: ImageParams): Promise<ImageResult> {
    const body: Record<string, unknown> = {
      model: p.model,
      prompt: p.prompt,
      n: p.n,
      size: p.size,
      quality: p.quality,
      background: p.background,
      output_format: p.outputFormat,
    };
    if (this.cfg.moderation) body.moderation = this.cfg.moderation;
    const res = await httpRequest(
      this.fetchFn,
      `${this.cfg.baseUrl}/images/generations`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      this.httpOpts(),
    );
    return this.parse(res, p);
  }

  async edit(p: ImageEditParams): Promise<ImageResult> {
    if (p.images.length === 0)
      throw new PixelBridgeError('INVALID_INPUT', 'edit requires at least one image.');
    if (p.images.length > 16) throw new PixelBridgeError('INVALID_INPUT', 'At most 16 reference images.');
    const form = new FormData();
    form.append('model', p.model);
    form.append('prompt', p.prompt);
    form.append('n', String(p.n));
    form.append('size', p.size);
    form.append('quality', p.quality);
    form.append('background', p.background);
    form.append('output_format', p.outputFormat);
    if (this.cfg.moderation) form.append('moderation', this.cfg.moderation);
    if (p.inputFidelity && INPUT_FIDELITY_MODELS.has(baseModel(p.model))) {
      form.append('input_fidelity', p.inputFidelity);
    }
    for (const img of p.images) {
      form.append('image[]', new Blob([new Uint8Array(img.data)], { type: img.mime }), img.filename);
    }
    if (p.mask)
      form.append('mask', new Blob([new Uint8Array(p.mask.data)], { type: 'image/png' }), p.mask.filename);
    const res = await httpRequest(
      this.fetchFn,
      `${this.cfg.baseUrl}/images/edits`,
      { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body: form },
      this.httpOpts(),
    );
    return this.parse(res, p);
  }

  private httpOpts() {
    return {
      timeoutMs: this.cfg.timeoutMs,
      maxRetries: this.cfg.maxRetries,
      idempotent: false,
      providerName: 'OpenAI',
    };
  }

  private async parse(res: Response, p: ImageParams): Promise<ImageResult> {
    let json: OpenAIImageResponse;
    try {
      json = (await res.json()) as OpenAIImageResponse;
    } catch (e) {
      throw new PixelBridgeError('PROVIDER_BAD_RESPONSE', 'OpenAI returned a non-JSON response.', {
        cause: e,
        details: { mayHaveBilled: true },
      });
    }
    const images = (json.data ?? [])
      .filter((d) => typeof d.b64_json === 'string')
      .map((d) => ({
        data: Buffer.from(d.b64_json!, 'base64'),
        format: (json.output_format as ImageFormat | undefined) ?? p.outputFormat,
      }));
    if (images.length === 0) {
      throw new PixelBridgeError('PROVIDER_BAD_RESPONSE', 'OpenAI response contained no images.', {
        details: { mayHaveBilled: true },
      });
    }
    return {
      images,
      actualCostUsd: actualCost(p.model, json.usage),
      ...(json.usage ? { usage: json.usage } : {}),
    };
  }
}

export function actualCost(model: string, usage: OpenAIImageResponse['usage']): number | null {
  if (!usage) return null;
  const rates = TOKEN_RATES_PER_M[baseModel(model)];
  if (!rates) return null;
  const imgIn = usage.input_tokens_details?.image_tokens ?? 0;
  const txtIn = usage.input_tokens_details?.text_tokens ?? Math.max(0, (usage.input_tokens ?? 0) - imgIn);
  const imgOut = usage.output_tokens_details?.image_tokens ?? usage.output_tokens ?? 0;
  const cost = (imgIn * rates.imageIn + txtIn * rates.textIn + imgOut * rates.imageOut) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}
