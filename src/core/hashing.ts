import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Canonical JSON: object keys sorted recursively, `undefined` members dropped.
 * Used for request fingerprints so semantically identical requests hash equally.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export interface FingerprintInput {
  provider: string;
  model: string;
  operation: string;
  params: Record<string, unknown>;
  referenceHashes: string[];
}

export const FINGERPRINT_VERSION = 1;

export function requestFingerprint(input: FingerprintInput): string {
  return sha256(canonicalJson({ v: FINGERPRINT_VERSION, ...input }));
}
