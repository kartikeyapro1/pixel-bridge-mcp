/**
 * Every failure PixelBridge reports to an agent carries a stable code and, where
 * possible, a hint telling the agent (or human) what to do next.
 */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'PATH_OUTSIDE_PROJECT'
  | 'NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_UNSUPPORTED'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_BAD_RESPONSE'
  | 'DOWNLOAD_FAILED'
  | 'PRICE_UNKNOWN'
  | 'BUDGET_EXCEEDED'
  | 'APPROVAL_REQUIRED'
  | 'CONCURRENCY_LIMIT'
  | 'RATE_LIMIT_LOCAL'
  | 'JOB_FAILED'
  | 'JOB_NOT_READY'
  | 'BLENDER_NOT_FOUND'
  | 'BLENDER_FAILED'
  | 'BLENDER_TIMEOUT'
  | 'REFINEMENT_LIMIT'
  | 'VALIDATION_FAILED'
  | 'INTERNAL';

export class PixelBridgeError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'PixelBridgeError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isPixelBridgeError(e: unknown): e is PixelBridgeError {
  return e instanceof PixelBridgeError;
}

export function toPixelBridgeError(e: unknown): PixelBridgeError {
  if (e instanceof PixelBridgeError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new PixelBridgeError('INTERNAL', message, { cause: e });
}
