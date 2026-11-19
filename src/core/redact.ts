/**
 * Credential redaction applied to anything that may leave the process:
 * logs, error messages returned to agents, and stored provider responses.
 */

const SECRET_ENV_VARS = ['OPENAI_API_KEY', 'FAL_KEY'];

const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI-style keys
  /\b(Bearer|Key)\s+[A-Za-z0-9._:\-]{8,}/gi, // Authorization header values
  /([?&](?:key|api_key|token|access_token)=)[^&\s"']+/gi, // secrets in query strings
];

const extraSecrets = new Set<string>();

/** Register an additional literal secret (e.g. a key loaded from a non-standard env var). */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) extraSecrets.add(value);
}

function knownSecrets(): string[] {
  const out = [...extraSecrets];
  for (const name of SECRET_ENV_VARS) {
    const v = process.env[name];
    if (v && v.length >= 8) out.push(v);
  }
  return out;
}

export function redact(text: string): string {
  let out = text;
  for (const secret of knownSecrets()) {
    out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(PATTERNS[0]!, '[REDACTED]');
  out = out.replace(PATTERNS[1]!, (_m, scheme: string) => `${scheme} [REDACTED]`);
  out = out.replace(PATTERNS[2]!, (_m, prefix: string) => `${prefix}[REDACTED]`);
  return out;
}

/** Deep-redact a JSON-compatible value, dropping keys that look like credentials. */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(authorization|api[_-]?key|token|secret|password|cookie)$/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactValue(v);
      }
    }
    return out;
  }
  return value;
}
