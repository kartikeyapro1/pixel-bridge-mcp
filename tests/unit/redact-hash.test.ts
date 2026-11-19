import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, requestFingerprint } from '../../src/core/hashing.js';
import { redact, redactValue, registerSecret } from '../../src/core/redact.js';

describe('redact', () => {
  const original = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });

  it('removes env-var secrets, sk- keys and auth headers', () => {
    process.env.OPENAI_API_KEY = 'test-key-value-123456';
    const text =
      'key=test-key-value-123456 sk-abcdefghijklmnop Authorization: Bearer abc.def.ghi123 Key fal_abcdef123456';
    const out = redact(text);
    expect(out).not.toContain('test-key-value-123456');
    expect(out).not.toContain('sk-abcdefghijklmnop');
    expect(out).not.toContain('abc.def.ghi123');
    expect(out).not.toContain('fal_abcdef123456');
  });

  it('redacts registered secrets and secret-looking keys in objects', () => {
    registerSecret('custom-secret-value-xyz');
    const v = redactValue({
      msg: 'got custom-secret-value-xyz',
      authorization: 'anything',
      nested: [{ api_key: 'k' }],
    }) as Record<string, unknown>;
    expect(JSON.stringify(v)).not.toContain('custom-secret-value-xyz');
    expect(v.authorization).toBe('[REDACTED]');
    expect(JSON.stringify(v)).not.toContain('"k"');
  });

  it('redacts secrets in query strings', () => {
    expect(redact('https://x.test/a?api_key=SECRET123&b=1')).toBe('https://x.test/a?api_key=[REDACTED]&b=1');
  });
});

describe('fingerprints', () => {
  it('are independent of key order and undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
    const a = requestFingerprint({
      provider: 'p',
      model: 'm',
      operation: 'o',
      params: { x: 1, y: 2 },
      referenceHashes: [],
    });
    const b = requestFingerprint({
      provider: 'p',
      model: 'm',
      operation: 'o',
      params: { y: 2, x: 1 },
      referenceHashes: [],
    });
    expect(a).toBe(b);
  });

  it('change when any input changes, including reference content hashes', () => {
    const base = { provider: 'p', model: 'm', operation: 'o', params: { x: 1 }, referenceHashes: ['h1'] };
    const fp = requestFingerprint(base);
    expect(requestFingerprint({ ...base, model: 'm2' })).not.toBe(fp);
    expect(requestFingerprint({ ...base, params: { x: 2 } })).not.toBe(fp);
    expect(requestFingerprint({ ...base, referenceHashes: ['h2'] })).not.toBe(fp);
  });
});
