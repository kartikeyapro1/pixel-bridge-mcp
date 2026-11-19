import { PixelBridgeError, type ErrorCode } from './errors.js';
import { redact } from './redact.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  timeoutMs: number;
  maxRetries: number;
  /**
   * Idempotent requests (GET status/result/download) may be retried after timeouts.
   * Non-idempotent requests (paid generation POSTs) are retried only when the server
   * explicitly answered 429/5xx, or the connection was refused before anything was sent,
   * because a timed-out generation may still have been billed.
   */
  idempotent: boolean;
  providerName: string;
  sleep?: (ms: number) => Promise<void>;
}

const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errnoOf(e: unknown): string | undefined {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return cause?.code ?? (e as { code?: string })?.code;
}

function backoff(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  }
  return Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 250), 30_000);
}

/**
 * fetch with timeout, bounded retries and error classification. Returns only 2xx
 * responses; everything else becomes a PixelBridgeError with a redacted message.
 */
export async function httpRequest(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  opts: HttpOptions,
): Promise<Response> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: PixelBridgeError | undefined;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      const code = errnoOf(e);
      const aborted = controller.signal.aborted;
      if (aborted) {
        lastError = new PixelBridgeError(
          'PROVIDER_TIMEOUT',
          `${opts.providerName} did not respond within ${Math.round(opts.timeoutMs / 1000)}s.`,
          {
            hint: opts.idempotent
              ? 'Try again later.'
              : 'The request may still have been processed and billed. Check the provider dashboard before retrying.',
            details: { mayHaveBilled: !opts.idempotent },
          },
        );
        if (!opts.idempotent) throw lastError;
      } else {
        const neverSent = code !== undefined && NEVER_SENT.has(code);
        lastError = new PixelBridgeError(
          'PROVIDER_UNAVAILABLE',
          `Could not reach ${opts.providerName}: ${redact(e instanceof Error ? e.message : String(e))}${code ? ` (${code})` : ''}.`,
          { hint: 'Check network connectivity.', details: { mayHaveBilled: !neverSent && !opts.idempotent } },
        );
        if (!neverSent && !opts.idempotent) throw lastError;
      }
      if (attempt < opts.maxRetries) await sleep(backoff(attempt, null));
      continue;
    }
    clearTimeout(timer);
    if (res.ok) return res;

    const bodyText = redact(await safeText(res));
    lastError = classifyHttpError(res.status, bodyText, opts.providerName);
    if (RETRY_STATUS.has(res.status) && attempt < opts.maxRetries) {
      await sleep(backoff(attempt, res.headers.get('retry-after')));
      continue;
    }
    throw lastError;
  }
  throw lastError ?? new PixelBridgeError('INTERNAL', 'Request failed without an error.');
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.length > 2000 ? t.slice(0, 2000) + '…' : t;
  } catch {
    return '';
  }
}

function providerMessage(body: string): string {
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string } | string;
      detail?: unknown;
      message?: string;
    };
    if (typeof j.error === 'string') return j.error;
    if (j.error?.message) return j.error.message;
    if (typeof j.message === 'string') return j.message;
    if (j.detail) return typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail).slice(0, 500);
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

export function classifyHttpError(status: number, body: string, provider: string): PixelBridgeError {
  const msg = providerMessage(body);
  let code: ErrorCode;
  let hint: string | undefined;
  if (status === 401 || status === 403) {
    code = 'PROVIDER_AUTH';
    hint = `Check the ${provider} API key / account permissions. (Some models require organisation verification.)`;
  } else if (status === 429) {
    code = 'PROVIDER_RATE_LIMITED';
    hint = 'Rate limited or out of quota. Wait, or check provider billing.';
  } else if (status >= 500) {
    code = 'PROVIDER_UNAVAILABLE';
    hint = 'Provider error; try again later.';
  } else {
    code = 'PROVIDER_REJECTED';
    hint = 'The provider rejected the request parameters or content. Adjust and retry.';
  }
  return new PixelBridgeError(code, `${provider} returned HTTP ${status}: ${msg}`, {
    hint,
    details: { status, billed: false },
  });
}

/**
 * Stream a download to `dest` with a size cap; caller handles temp/rename.
 */
export async function downloadToBuffer(
  fetchFn: FetchLike,
  url: string,
  opts: HttpOptions & { maxBytes: number; headers?: Record<string, string> },
): Promise<Buffer> {
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(url)) {
    throw new PixelBridgeError('DOWNLOAD_FAILED', 'Refusing to download from a non-HTTPS URL.');
  }
  const res = await httpRequest(fetchFn, url, { method: 'GET', headers: opts.headers ?? {} }, opts);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > opts.maxBytes) {
    throw new PixelBridgeError(
      'DOWNLOAD_FAILED',
      `Download is ${declared} bytes, above the ${opts.maxBytes} limit.`,
    );
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > opts.maxBytes) {
      await reader.cancel();
      throw new PixelBridgeError('DOWNLOAD_FAILED', `Download exceeded the ${opts.maxBytes} byte limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  if (declared && total !== declared) {
    throw new PixelBridgeError('DOWNLOAD_FAILED', `Download truncated: got ${total} of ${declared} bytes.`, {
      hint: 'Fetch the job again; PixelBridge will retry the download.',
    });
  }
  return Buffer.concat(chunks);
}
