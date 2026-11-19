import type { CostEstimate } from '../core/budget.js';
import type { FalModelConfig, PixelBridgeConfig } from '../core/config.js';
import { PixelBridgeError } from '../core/errors.js';
import { downloadToBuffer, httpRequest, type FetchLike } from '../core/http.js';
import type {
  JobKind,
  JobOutputFile,
  JobProvider,
  JobSubmitParams,
  ProviderJobState,
  RemoteStatus,
} from './types.js';

/**
 * fal.ai queue API adapter (https://fal.ai/docs/model-apis/model-endpoints/queue).
 * One adapter covers every fal video and image-to-3D endpoint, because they share
 * the submit → status → result → cancel lifecycle. Per-model input field names
 * and prices come from configuration; PixelBridge never guesses a price.
 */

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov']);
const MODEL_EXT = new Set(['glb', 'gltf', 'obj', 'fbx', 'usdz', 'zip']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);

interface SubmitResponse {
  request_id?: string;
  status_url?: string;
  response_url?: string;
  cancel_url?: string;
}

export class FalQueueProvider implements JobProvider {
  readonly id = 'fal';
  private readonly queueHost: string;

  constructor(
    private readonly cfg: PixelBridgeConfig['providers']['fal'],
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    this.queueHost = new URL(cfg.queueUrl).host;
  }

  private model(model: string): FalModelConfig {
    const m = this.cfg.models[model];
    if (!m) {
      throw new PixelBridgeError('PROVIDER_UNSUPPORTED', `fal model "${model}" is not configured.`, {
        hint: `Add providers.fal.models["${model}"] with kind, fields and pricing to pixelbridge.config.json. Configured: ${Object.keys(this.cfg.models).join(', ') || '(none)'}.`,
      });
    }
    return m;
  }

  supports(kind: JobKind, model: string): boolean {
    return this.cfg.models[model]?.kind === kind;
  }

  describeModels() {
    return Object.entries(this.cfg.models).map(([model, m]) => ({
      model,
      kind: m.kind,
      priced: m.pricing !== undefined,
      ...(m.pricing ? { pricing: m.pricing } : {}),
    }));
  }

  validate(p: JobSubmitParams): void {
    if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,5}$/i.test(p.model)) {
      throw new PixelBridgeError('INVALID_INPUT', `Invalid fal endpoint id "${p.model}".`);
    }
    const m = this.model(p.model);
    if (m.kind !== p.kind) {
      throw new PixelBridgeError(
        'PROVIDER_UNSUPPORTED',
        `fal model "${p.model}" is configured as ${m.kind}, not ${p.kind}.`,
      );
    }
    if (p.durationSeconds !== undefined) {
      if (!m.fields.duration) {
        throw new PixelBridgeError(
          'PROVIDER_UNSUPPORTED',
          `fal model "${p.model}" has no duration field configured.`,
        );
      }
      if (m.allowedDurations && !m.allowedDurations.includes(p.durationSeconds)) {
        throw new PixelBridgeError(
          'INVALID_INPUT',
          `Duration ${p.durationSeconds}s is not allowed for ${p.model}; allowed: ${m.allowedDurations.join(', ')}.`,
        );
      }
    }
    if (p.kind === '3d' && !p.image) {
      throw new PixelBridgeError('INVALID_INPUT', 'Image-to-3D requires a source image.');
    }
  }

  estimate(p: JobSubmitParams): CostEstimate {
    const m = this.model(p.model);
    if (!m.pricing) {
      throw new PixelBridgeError(
        'PRICE_UNKNOWN',
        `No verified price configured for fal model "${p.model}".`,
        {
          hint: `Check https://fal.ai/models/${p.model} and set providers.fal.models["${p.model}"].pricing to {"perSecondUsd": n} or {"perRequestUsd": n}.`,
        },
      );
    }
    let usd: number;
    let basis: string;
    if ('perSecondUsd' in m.pricing) {
      const secs =
        p.durationSeconds ??
        m.pricing.defaultSeconds ??
        (m.allowedDurations ? Math.max(...m.allowedDurations) : 10);
      usd = m.pricing.perSecondUsd * secs;
      basis = `configured $${m.pricing.perSecondUsd}/s × ${secs}s`;
    } else {
      usd = m.pricing.perRequestUsd;
      basis = `configured $${m.pricing.perRequestUsd}/request`;
    }
    return { provider: this.id, model: p.model, operation: `${p.kind}.generate`, estimatedUsd: usd, basis };
  }

  async submit(p: JobSubmitParams): Promise<{ remoteId: string; state: ProviderJobState }> {
    const m = this.model(p.model);
    const input: Record<string, unknown> = { ...m.defaults, ...(p.extraInput ?? {}) };
    if (p.prompt !== undefined) input[m.fields.prompt] = p.prompt;
    if (p.image) input[m.fields.image] = `data:${p.image.mime};base64,${p.image.data.toString('base64')}`;
    if (p.durationSeconds !== undefined && m.fields.duration) {
      input[m.fields.duration] =
        m.durationFormat === 'number'
          ? p.durationSeconds
          : m.durationFormat === 'seconds-suffix'
            ? `${p.durationSeconds}s`
            : String(p.durationSeconds);
    }
    const res = await httpRequest(
      this.fetchFn,
      `${this.cfg.queueUrl.replace(/\/$/, '')}/${p.model}`,
      {
        method: 'POST',
        headers: { Authorization: `Key ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      this.httpOpts(false),
    );
    const json = (await res.json().catch(() => ({}))) as SubmitResponse;
    if (!json.request_id || !json.status_url || !json.response_url) {
      throw new PixelBridgeError(
        'PROVIDER_BAD_RESPONSE',
        'fal submit response is missing request_id/status_url.',
        {
          details: { mayHaveBilled: true },
        },
      );
    }
    const state: ProviderJobState = {
      requestId: json.request_id,
      statusUrl: this.checkQueueUrl(json.status_url),
      responseUrl: this.checkQueueUrl(json.response_url),
    };
    if (json.cancel_url) state.cancelUrl = this.checkQueueUrl(json.cancel_url);
    return { remoteId: json.request_id, state };
  }

  async poll(state: ProviderJobState): Promise<RemoteStatus> {
    const res = await httpRequest(
      this.fetchFn,
      this.checkQueueUrl(state.statusUrl!),
      { method: 'GET', headers: { Authorization: `Key ${this.apiKey}` } },
      this.httpOpts(true),
    );
    const json = (await res.json()) as {
      status?: string;
      queue_position?: number;
      error?: string;
      error_type?: string;
    };
    switch (json.status) {
      case 'IN_QUEUE':
        return {
          status: 'queued',
          ...(json.queue_position !== undefined ? { position: json.queue_position } : {}),
        };
      case 'IN_PROGRESS':
        return { status: 'running' };
      case 'COMPLETED':
        if (json.error) return { status: 'failed', error: `${json.error_type ?? 'error'}: ${json.error}` };
        return { status: 'completed' };
      default:
        throw new PixelBridgeError(
          'PROVIDER_BAD_RESPONSE',
          `Unexpected fal status "${String(json.status)}".`,
        );
    }
  }

  async outputs(
    state: ProviderJobState,
    kind: JobKind,
  ): Promise<{ files: JobOutputFile[]; actualCostUsd: number | null }> {
    const res = await httpRequest(
      this.fetchFn,
      this.checkQueueUrl(state.responseUrl!),
      { method: 'GET', headers: { Authorization: `Key ${this.apiKey}` } },
      this.httpOpts(true),
    );
    const json = (await res.json()) as unknown;
    const files = extractFiles(json).filter((f) =>
      kind === 'video'
        ? VIDEO_EXT.has(f.ext) || IMAGE_EXT.has(f.ext)
        : MODEL_EXT.has(f.ext) || IMAGE_EXT.has(f.ext),
    );
    const primary = files.filter((f) => (kind === 'video' ? VIDEO_EXT : MODEL_EXT).has(f.ext));
    if (primary.length === 0) {
      throw new PixelBridgeError('PROVIDER_BAD_RESPONSE', `fal result contained no ${kind} file.`, {
        hint: 'The model may use an unexpected output schema; inspect the result on the fal dashboard.',
      });
    }
    return { files, actualCostUsd: null };
  }

  /** Output files live on fal's CDN; credentials are NOT sent there. */
  download(url: string, maxBytes: number): Promise<Buffer> {
    return downloadToBuffer(this.fetchFn, url, { ...this.httpOpts(true), timeoutMs: 300_000, maxBytes });
  }

  async cancel(state: ProviderJobState): Promise<'cancelled' | 'requested' | 'too_late' | 'not_found'> {
    if (!state.cancelUrl) return 'not_found';
    const res = await this.fetchFn(this.checkQueueUrl(state.cancelUrl), {
      method: 'PUT',
      headers: { Authorization: `Key ${this.apiKey}` },
    });
    if (res.status === 200) return 'cancelled';
    if (res.status === 202) return 'requested';
    if (res.status === 400) return 'too_late';
    return 'not_found';
  }

  /** Only ever send the API key to the configured queue host. */
  private checkQueueUrl(url: string): string {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new PixelBridgeError('PROVIDER_BAD_RESPONSE', 'fal returned an invalid URL.');
    }
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
      throw new PixelBridgeError('PROVIDER_BAD_RESPONSE', 'fal returned a non-HTTPS queue URL.');
    }
    if (u.host !== this.queueHost) {
      throw new PixelBridgeError(
        'PROVIDER_BAD_RESPONSE',
        `fal returned a queue URL on unexpected host ${u.host}.`,
      );
    }
    return u.toString();
  }

  private httpOpts(idempotent: boolean) {
    return {
      timeoutMs: this.cfg.timeoutMs,
      maxRetries: this.cfg.maxRetries,
      idempotent,
      providerName: 'fal.ai',
    };
  }
}

/** Walk a fal result and collect `{url, file_name?, content_type?}` objects. */
export function extractFiles(value: unknown, keyPath: string[] = []): JobOutputFile[] {
  const out: JobOutputFile[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...extractFiles(v, [...keyPath, String(i)])));
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.url === 'string' && /^https?:\/\//.test(obj.url)) {
      out.push({ url: obj.url, ext: extOf(obj), role: keyPath.join('.') || 'output' });
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k !== 'url') out.push(...extractFiles(v, [...keyPath, k]));
    }
  }
  return out;
}

function extOf(obj: Record<string, unknown>): string {
  const fromName = typeof obj.file_name === 'string' ? /\.([a-z0-9]+)$/i.exec(obj.file_name)?.[1] : undefined;
  if (fromName) return fromName.toLowerCase();
  try {
    const p = new URL(obj.url as string).pathname;
    const m = /\.([a-z0-9]+)$/i.exec(p);
    if (m) return m[1]!.toLowerCase();
  } catch {
    /* ignore */
  }
  const ct = typeof obj.content_type === 'string' ? obj.content_type : '';
  if (ct.includes('mp4')) return 'mp4';
  if (ct.includes('gltf-binary')) return 'glb';
  if (ct.includes('png')) return 'png';
  return 'bin';
}
