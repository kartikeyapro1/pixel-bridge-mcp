import type { CostEstimate } from '../core/budget.js';
import type { PixelBridgeConfig } from '../core/config.js';
import { PixelBridgeError } from '../core/errors.js';
import { downloadToBuffer, httpRequest, type FetchLike } from '../core/http.js';
import {
  GEMINI_ASPECT_RATIOS,
  GEMINI_IMAGE_PRICING,
  GEMINI_PRICING_SOURCE_DATE,
  GEMINI_VIDEO_PRICING,
  IMAGE_THINKING_ALLOWANCE_TOKENS,
  INPUT_TOKENS_PER_IMAGE,
  TIER_LONG_SIDE,
  VIDEO_THINKING_ALLOWANCE_TOKENS,
  type ImageTier,
  type VideoResolution,
} from './gemini-pricing.js';
import type {
  ImageCapabilities,
  ImageEditParams,
  ImageFormat,
  ImageParams,
  ImageProvider,
  ImageResult,
  InputImage,
  JobKind,
  JobOutputFile,
  JobProvider,
  JobSubmitParams,
  ProviderJobState,
  RemoteStatus,
} from './types.js';

/**
 * Google Gemini API: one key (GEMINI_API_KEY) for image generation/editing
 * (Nano Banana models) and video generation (Gemini Omni Flash), both through
 * the Interactions API (POST /v1beta/interactions).
 */

type GeminiConfig = PixelBridgeConfig['providers']['gemini'];

const API_HOST = 'generativelanguage.googleapis.com';
const VIDEO_RESOLUTIONS: VideoResolution[] = ['360p', '720p', '1080p', '4k'];
const VIDEO_ASPECTS = ['16:9', '9:16'];

interface ContentBlock {
  type?: string;
  data?: string;
  uri?: string;
  mime_type?: string;
  text?: string;
}

interface Interaction {
  id?: string;
  status?: string;
  steps?: { type?: string; content?: ContentBlock[] }[];
  outputs?: ContentBlock[];
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    output_tokens_by_modality?: unknown;
  };
  error?: { message?: string } | string;
}

/** Shared HTTP plumbing; the key is only ever sent to the Gemini API host. */
class GeminiClient {
  constructor(
    readonly cfg: GeminiConfig,
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike,
  ) {
    const host = new URL(cfg.baseUrl).host;
    if (host !== API_HOST && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      throw new PixelBridgeError('CONFIG_INVALID', `providers.gemini.baseUrl must point at ${API_HOST}.`);
    }
  }

  private headers(json: boolean): Record<string, string> {
    return {
      'x-goog-api-key': this.apiKey,
      'Api-Revision': this.cfg.apiRevision,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async create(body: Record<string, unknown>, timeoutMs = this.cfg.timeoutMs): Promise<Interaction> {
    const res = await httpRequest(
      this.fetchFn,
      `${this.cfg.baseUrl}/interactions`,
      { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) },
      { timeoutMs, maxRetries: this.cfg.maxRetries, idempotent: false, providerName: 'Gemini API' },
    );
    return parseJson(res);
  }

  async get(id: string): Promise<Interaction> {
    const res = await httpRequest(
      this.fetchFn,
      `${this.cfg.baseUrl}/interactions/${encodeURIComponent(id)}`,
      { method: 'GET', headers: this.headers(false) },
      {
        timeoutMs: this.cfg.timeoutMs,
        maxRetries: this.cfg.maxRetries,
        idempotent: true,
        providerName: 'Gemini API',
      },
    );
    return parseJson(res);
  }

  async cancel(id: string): Promise<number> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/interactions/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: this.headers(true),
      body: '{}',
    });
    return res.status;
  }

  /** Download a Files API URI. Only Gemini API URLs receive the key. */
  download(uri: string, maxBytes: number): Promise<Buffer> {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      throw new PixelBridgeError('PROVIDER_BAD_RESPONSE', 'Gemini returned an invalid file URI.');
    }
    if (u.protocol !== 'https:' || u.host !== API_HOST) {
      throw new PixelBridgeError(
        'PROVIDER_BAD_RESPONSE',
        `Refusing to download from unexpected host ${u.host}.`,
      );
    }
    return downloadToBuffer(this.fetchFn, u.toString(), {
      timeoutMs: 300_000,
      maxRetries: this.cfg.maxRetries,
      idempotent: true,
      providerName: 'Gemini API',
      maxBytes,
      headers: { 'x-goog-api-key': this.apiKey },
    });
  }
}

async function parseJson(res: Response): Promise<Interaction> {
  try {
    return (await res.json()) as Interaction;
  } catch (e) {
    throw new PixelBridgeError('PROVIDER_BAD_RESPONSE', 'Gemini API returned a non-JSON response.', {
      cause: e,
      details: { mayHaveBilled: true },
    });
  }
}

/** Generated blocks of a given type from model_output steps (falls back to top-level outputs). */
export function outputBlocks(interaction: Interaction, type: 'image' | 'video'): ContentBlock[] {
  const fromSteps = (interaction.steps ?? [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === type && (typeof c.data === 'string' || typeof c.uri === 'string'));
  if (fromSteps.length) return fromSteps;
  return (interaction.outputs ?? []).filter(
    (c) => c.type === type && (typeof c.data === 'string' || typeof c.uri === 'string'),
  );
}

/** Output tokens for one modality, accepting either an array or a map breakdown. */
function modalityTokens(breakdown: unknown, modality: string): number | null {
  if (Array.isArray(breakdown)) {
    let total = 0;
    let found = false;
    for (const entry of breakdown as Record<string, unknown>[]) {
      if (String(entry.modality ?? '').toLowerCase() === modality) {
        total += Number(entry.tokens ?? entry.token_count ?? 0);
        found = true;
      }
    }
    return found ? total : null;
  }
  if (breakdown && typeof breakdown === 'object') {
    const v = (breakdown as Record<string, unknown>)[modality];
    return typeof v === 'number' ? v : null;
  }
  return null;
}

/**
 * Actual cost from the usage block. Without a per-modality breakdown all output is
 * billed at the (higher) media rate, so the figure is an upper bound.
 */
export function usageCost(
  usage: Interaction['usage'],
  rates: { inputPerM: number; textOutPerM: number; mediaOutPerM: number },
  modality: 'image' | 'video',
): number | null {
  if (
    !usage ||
    typeof usage.total_input_tokens !== 'number' ||
    typeof usage.total_output_tokens !== 'number'
  ) {
    return null;
  }
  const media = modalityTokens(usage.output_tokens_by_modality, modality);
  const out = usage.total_output_tokens;
  const mediaTokens = media ?? out;
  const textTokens = Math.max(0, out - mediaTokens);
  const cost =
    (usage.total_input_tokens * rates.inputPerM +
      mediaTokens * rates.mediaOutPerM +
      textTokens * rates.textOutPerM) /
    1e6;
  return Math.round(cost * 1e6) / 1e6;
}

function failureMessage(i: Interaction): string {
  if (typeof i.error === 'string') return i.error;
  return i.error?.message ?? `interaction ${i.status ?? 'ended'} without output`;
}

// ---- images -------------------------------------------------------------------

/** Map a WxH request onto the nearest supported aspect ratio. */
export function nearestAspect(size: string): string | null {
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return null;
  const target = Math.log(Number(m[1]) / Number(m[2]));
  let best = '1:1';
  let bestDist = Infinity;
  for (const ar of GEMINI_ASPECT_RATIOS) {
    const [w, h] = ar.split(':').map(Number) as [number, number];
    const d = Math.abs(Math.log(w / h) - target);
    if (d < bestDist) {
      best = ar;
      bestDist = d;
    }
  }
  return best;
}

/** Choose the size tier from the requested long side; "high" quality means at least 2K. */
export function chooseTier(size: string, quality: ImageParams['quality'], tiers: ImageTier[]): ImageTier {
  const m = /^(\d+)x(\d+)$/.exec(size);
  const longSide = m ? Math.max(Number(m[1]), Number(m[2])) : 0;
  // Allow 25% headroom before stepping up a (more expensive) tier: a 1024x1536 request
  // is served at 1K (848x1264 for 2:3) rather than 2K.
  const fits = (t: ImageTier) => longSide <= TIER_LONG_SIDE[t] * 1.25;
  let wanted: ImageTier = fits('1K') ? '1K' : fits('2K') ? '2K' : '4K';
  if (quality === 'high' && wanted === '1K') wanted = '2K';
  const order: ImageTier[] = ['0.5K', '1K', '2K', '4K'];
  const ok = tiers.filter((t) => order.indexOf(t) >= order.indexOf(wanted));
  return ok[0] ?? tiers[tiers.length - 1]!;
}

export class GeminiImageProvider implements ImageProvider {
  readonly id = 'gemini';
  private readonly client: GeminiClient;

  constructor(cfg: GeminiConfig, apiKey: string, fetchFn: FetchLike = fetch) {
    this.client = new GeminiClient(cfg, apiKey, fetchFn);
  }

  private pricing(model: string) {
    const p = GEMINI_IMAGE_PRICING[model];
    if (!p) {
      throw new PixelBridgeError('PRICE_UNKNOWN', `No price information for Gemini image model "${model}".`, {
        hint: `Use one of: ${Object.keys(GEMINI_IMAGE_PRICING).join(', ')}.`,
      });
    }
    return p;
  }

  capabilities(): ImageCapabilities {
    return {
      models: Object.keys(GEMINI_IMAGE_PRICING),
      defaultModel: this.client.cfg.imageModel,
      edit: true,
      maxReferenceImages: 14,
      transparentBackground: 'unsupported',
      sizes: ['auto', '1024x1024', '1024x1536', '1536x1024'],
      customSizes: true,
      notes: [
        `Sizes are mapped to the nearest supported aspect ratio (${GEMINI_ASPECT_RATIOS.join(', ')}) and a 1K/2K/4K tier; quality "high" uses at least 2K. Actual pixel sizes follow Google's table (e.g. 2:3 at 1K = 848x1264).`,
        'Transparent backgrounds and webp output are not supported; one image per call (n = 1).',
        "All generated images carry Google's SynthID watermark.",
        `Cost estimates use Google's published per-image prices (transcribed ${GEMINI_PRICING_SOURCE_DATE}) plus input and a thinking allowance; actual cost is computed from response usage.`,
      ],
    };
  }

  validate(p: ImageParams): void {
    const pricing = this.pricing(p.model);
    if (p.background === 'transparent') {
      throw new PixelBridgeError(
        'PROVIDER_UNSUPPORTED',
        'Gemini image models do not support transparent backgrounds.',
        {
          hint: 'Use a plain background and remove it afterwards, or use background "opaque"/"auto".',
        },
      );
    }
    if (p.outputFormat === 'webp') {
      throw new PixelBridgeError('PROVIDER_UNSUPPORTED', 'Gemini image output is png or jpeg.');
    }
    if (p.n !== 1) {
      throw new PixelBridgeError('PROVIDER_UNSUPPORTED', 'Gemini returns one image per call; use n = 1.');
    }
    if (p.size !== 'auto' && !nearestAspect(p.size)) {
      throw new PixelBridgeError('INVALID_INPUT', `Invalid size "${p.size}". Use WIDTHxHEIGHT or "auto".`);
    }
    void pricing;
  }

  estimate(p: ImageParams, operation: 'generate' | 'edit', referenceCount: number): CostEstimate {
    const pricing = this.pricing(p.model);
    const tier = chooseTier(p.size, p.quality, pricing.tiers);
    const perImage = pricing.perImage[tier]!;
    const inputTokens = Math.ceil(p.prompt.length / 3) + referenceCount * INPUT_TOKENS_PER_IMAGE;
    const total =
      perImage +
      (inputTokens * pricing.inputPerM) / 1e6 +
      (IMAGE_THINKING_ALLOWANCE_TOKENS * pricing.textOutPerM) / 1e6;
    return {
      provider: this.id,
      model: p.model,
      operation: `image.${operation}`,
      estimatedUsd: Math.round(total * 10_000) / 10_000,
      basis: `Google published per-image price (${tier}) as of ${GEMINI_PRICING_SOURCE_DATE}, plus input${referenceCount ? ` incl. ${referenceCount} reference image(s)` : ''} and a thinking allowance`,
    };
  }

  generate(p: ImageParams): Promise<ImageResult> {
    return this.run(p, []);
  }

  async edit(p: ImageEditParams): Promise<ImageResult> {
    if (p.images.length === 0)
      throw new PixelBridgeError('INVALID_INPUT', 'edit requires at least one image.');
    const max = this.pricing(p.model).maxReferenceImages;
    if (p.images.length > max) {
      throw new PixelBridgeError('INVALID_INPUT', `${p.model} accepts at most ${max} reference images.`);
    }
    if (p.mask) {
      throw new PixelBridgeError(
        'PROVIDER_UNSUPPORTED',
        'Gemini edits are prompt-driven; masks are not supported.',
        {
          hint: 'Describe the region to change in the prompt instead.',
        },
      );
    }
    return this.run(p, p.images);
  }

  private async run(p: ImageParams, images: InputImage[]): Promise<ImageResult> {
    const pricing = this.pricing(p.model);
    const responseFormat: Record<string, unknown> = {
      type: 'image',
      mime_type: p.outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
      image_size: chooseTier(p.size, p.quality, pricing.tiers),
    };
    const aspect = p.size === 'auto' ? null : nearestAspect(p.size);
    if (aspect) responseFormat.aspect_ratio = aspect;
    const body: Record<string, unknown> = {
      model: p.model,
      input: [
        { type: 'text', text: p.prompt },
        ...images.map((img) => ({ type: 'image', mime_type: img.mime, data: img.data.toString('base64') })),
      ],
      response_format: responseFormat,
      store: this.client.cfg.storeImageInteractions,
    };
    if (this.client.cfg.imageThinkingLevel) {
      body.generation_config = { thinking_level: this.client.cfg.imageThinkingLevel };
    }
    const interaction = await this.client.create(body);
    if (interaction.status && interaction.status !== 'completed') {
      throw new PixelBridgeError(
        'PROVIDER_REJECTED',
        `Gemini image request ${interaction.status}: ${failureMessage(interaction)}`,
        {
          details: { mayHaveBilled: true },
        },
      );
    }
    const blocks = outputBlocks(interaction, 'image').filter((b) => typeof b.data === 'string');
    if (blocks.length === 0) {
      const text = (interaction.steps ?? [])
        .flatMap((s) => (s.type === 'model_output' ? (s.content ?? []) : []))
        .map((c) => c.text)
        .filter(Boolean)
        .join(' ')
        .slice(0, 300);
      throw new PixelBridgeError(
        'PROVIDER_BAD_RESPONSE',
        `Gemini response contained no image${text ? ` (model said: "${text}")` : ''}.`,
        { details: { mayHaveBilled: true } },
      );
    }
    const last = blocks[blocks.length - 1]!;
    const format: ImageFormat = last.mime_type === 'image/jpeg' ? 'jpeg' : 'png';
    return {
      images: [{ data: Buffer.from(last.data!, 'base64'), format }],
      actualCostUsd: usageCost(
        interaction.usage,
        {
          inputPerM: pricing.inputPerM,
          textOutPerM: pricing.textOutPerM,
          mediaOutPerM: pricing.imageOutPerM,
        },
        'image',
      ),
      ...(interaction.usage ? { usage: interaction.usage as Record<string, unknown> } : {}),
    };
  }
}

// ---- video --------------------------------------------------------------------

export class GeminiVideoProvider implements JobProvider {
  readonly id = 'gemini';
  private readonly client: GeminiClient;
  /** Completed interactions fetched in this process, so outputs are not downloaded twice. */
  private readonly completed = new Map<string, Interaction>();

  constructor(cfg: GeminiConfig, apiKey: string, fetchFn: FetchLike = fetch) {
    this.client = new GeminiClient(cfg, apiKey, fetchFn);
  }

  private pricing(model: string) {
    const p = GEMINI_VIDEO_PRICING[model];
    if (!p) {
      throw new PixelBridgeError('PRICE_UNKNOWN', `No price information for Gemini video model "${model}".`, {
        hint: `Use one of: ${Object.keys(GEMINI_VIDEO_PRICING).join(', ')}.`,
      });
    }
    return p;
  }

  supports(kind: JobKind, model: string): boolean {
    return kind === 'video' && model in GEMINI_VIDEO_PRICING;
  }

  defaultModel(kind: JobKind): string | null {
    return kind === 'video' ? this.client.cfg.videoModel : null;
  }

  describeModels() {
    return Object.entries(GEMINI_VIDEO_PRICING).map(([model, p]) => ({
      model,
      kind: 'video' as const,
      priced: true,
      default: model === this.client.cfg.videoModel,
      pricing: {
        approxUsdPerSecond: Object.fromEntries(
          VIDEO_RESOLUTIONS.map((r) => [r, Math.round(p.tokensPerSecond[r] * p.videoOutPerM * 1e-2) / 1e4]),
        ),
        durations: `${p.minSeconds}-${p.maxSeconds}s`,
        resolutions: VIDEO_RESOLUTIONS,
        aspectRatios: VIDEO_ASPECTS,
        maxReferenceImages: p.maxReferenceImages,
      },
    }));
  }

  validate(p: JobSubmitParams): void {
    if (p.kind !== 'video') {
      throw new PixelBridgeError(
        'PROVIDER_UNSUPPORTED',
        'The Gemini API has no image-to-3D model; build 3D models with Blender instead.',
      );
    }
    const pricing = this.pricing(p.model);
    if (!p.prompt) throw new PixelBridgeError('INVALID_INPUT', 'Video generation needs a prompt.');
    if (p.durationSeconds !== undefined) {
      if (
        !Number.isInteger(p.durationSeconds) ||
        p.durationSeconds < pricing.minSeconds ||
        p.durationSeconds > pricing.maxSeconds
      ) {
        throw new PixelBridgeError(
          'INVALID_INPUT',
          `Duration must be a whole number of seconds between ${pricing.minSeconds} and ${pricing.maxSeconds}.`,
        );
      }
    }
    if (p.resolution && !VIDEO_RESOLUTIONS.includes(p.resolution as VideoResolution)) {
      throw new PixelBridgeError(
        'INVALID_INPUT',
        `Resolution must be one of ${VIDEO_RESOLUTIONS.join(', ')}.`,
      );
    }
    if (p.aspectRatio && !VIDEO_ASPECTS.includes(p.aspectRatio)) {
      throw new PixelBridgeError('INVALID_INPUT', `Aspect ratio must be one of ${VIDEO_ASPECTS.join(', ')}.`);
    }
    if ((p.images?.length ?? 0) > pricing.maxReferenceImages) {
      throw new PixelBridgeError('INVALID_INPUT', `At most ${pricing.maxReferenceImages} reference images.`);
    }
  }

  estimate(p: JobSubmitParams): CostEstimate {
    const pricing = this.pricing(p.model);
    const seconds = p.durationSeconds ?? this.client.cfg.defaultVideoSeconds;
    const resolution = (p.resolution as VideoResolution | undefined) ?? '720p';
    const videoTokens = pricing.tokensPerSecond[resolution] * seconds;
    const inputTokens =
      Math.ceil((p.prompt?.length ?? 0) / 3) + (p.images?.length ?? 0) * INPUT_TOKENS_PER_IMAGE;
    const total =
      (videoTokens * pricing.videoOutPerM +
        inputTokens * pricing.inputPerM +
        VIDEO_THINKING_ALLOWANCE_TOKENS * pricing.textOutPerM) /
      1e6;
    return {
      provider: this.id,
      model: p.model,
      operation: 'video.generate',
      estimatedUsd: Math.round(total * 10_000) / 10_000,
      basis: `Google published video token rate: ${seconds}s at ${resolution} (${pricing.tokensPerSecond[resolution]} tokens/s × $${pricing.videoOutPerM}/M) as of ${GEMINI_PRICING_SOURCE_DATE}, plus input and a thinking allowance`,
    };
  }

  async submit(p: JobSubmitParams): Promise<{ remoteId: string; state: ProviderJobState }> {
    const responseFormat: Record<string, unknown> = {
      type: 'video',
      duration: `${p.durationSeconds ?? this.client.cfg.defaultVideoSeconds}s`,
      resolution: p.resolution ?? '720p',
      aspect_ratio: p.aspectRatio ?? '16:9',
    };
    const body: Record<string, unknown> = {
      model: p.model,
      input: [
        ...(p.images ?? []).map((img) => ({
          type: 'image',
          mime_type: img.mime,
          data: img.data.toString('base64'),
        })),
        { type: 'text', text: p.prompt },
      ],
      response_format: responseFormat,
      background: true,
    };
    let interaction: Interaction;
    let mode = 'background';
    try {
      interaction = await this.client.create(body);
    } catch (e) {
      // Not every model is documented as supporting background execution. A 400 is
      // not billed, so fall back to a (slow) synchronous, stored interaction.
      const err = e as PixelBridgeError;
      if (err.code !== 'PROVIDER_REJECTED' || !/background/i.test(err.message)) throw e;
      delete body.background;
      mode = 'sync';
      interaction = await this.client.create(body, this.client.cfg.videoSyncTimeoutMs);
    }
    if (!interaction.id) {
      throw new PixelBridgeError('PROVIDER_BAD_RESPONSE', 'Gemini response has no interaction id.', {
        details: { mayHaveBilled: true },
      });
    }
    if (interaction.status === 'completed') this.completed.set(interaction.id, interaction);
    return { remoteId: interaction.id, state: { interactionId: interaction.id, model: p.model, mode } };
  }

  async poll(state: ProviderJobState): Promise<RemoteStatus> {
    const id = state.interactionId!;
    if (this.completed.has(id)) return { status: 'completed' };
    const i = await this.client.get(id);
    switch (i.status) {
      case 'in_progress':
        return { status: 'running' };
      case 'completed':
        this.completed.set(id, i);
        return { status: 'completed' };
      case 'failed':
      case 'cancelled':
      case 'incomplete':
        return { status: 'failed', error: `${i.status}: ${failureMessage(i)}` };
      default:
        return { status: 'failed', error: `unexpected interaction status "${String(i.status)}"` };
    }
  }

  async outputs(state: ProviderJobState): Promise<{ files: JobOutputFile[]; actualCostUsd: number | null }> {
    const id = state.interactionId!;
    const i = this.completed.get(id) ?? (await this.client.get(id));
    this.completed.set(id, i);
    const blocks = outputBlocks(i, 'video');
    if (blocks.length === 0) {
      throw new PixelBridgeError('PROVIDER_BAD_RESPONSE', 'Gemini interaction completed without a video.');
    }
    const pricing = this.pricing(state.model ?? this.client.cfg.videoModel);
    return {
      files: blocks.map((b, n) => ({
        url: b.uri ?? `gemini-inline:${id}/${n}`,
        ext: b.mime_type === 'video/webm' ? 'webm' : 'mp4',
        role: n === 0 ? 'video' : `video-${n}`,
      })),
      actualCostUsd: usageCost(
        i.usage,
        {
          inputPerM: pricing.inputPerM,
          textOutPerM: pricing.textOutPerM,
          mediaOutPerM: pricing.videoOutPerM,
        },
        'video',
      ),
    };
  }

  async download(url: string, maxBytes: number): Promise<Buffer> {
    const inline = /^gemini-inline:(.+)\/(\d+)$/.exec(url);
    if (!inline) return this.client.download(url, maxBytes);
    const [, id, index] = inline as unknown as [string, string, string];
    const i = this.completed.get(id) ?? (await this.client.get(id));
    const block = outputBlocks(i, 'video')[Number(index)];
    if (!block?.data) {
      if (block?.uri) return this.client.download(block.uri, maxBytes);
      throw new PixelBridgeError(
        'DOWNLOAD_FAILED',
        `Video ${index} of interaction ${id} is no longer available.`,
      );
    }
    const buf = Buffer.from(block.data, 'base64');
    if (buf.length > maxBytes)
      throw new PixelBridgeError('DOWNLOAD_FAILED', `Video exceeds the ${maxBytes} byte limit.`);
    return buf;
  }

  async cancel(state: ProviderJobState): Promise<'cancelled' | 'requested' | 'too_late' | 'not_found'> {
    const status = await this.client.cancel(state.interactionId!);
    // The API does not say whether a cancelled generation was billed, so report a
    // request rather than a clean cancellation; the reservation stays counted.
    if (status >= 200 && status < 300) return 'requested';
    if (status === 400 || status === 409) return 'too_late';
    return 'not_found';
  }
}
