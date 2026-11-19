import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config.js';
import {
  checkKeyShape,
  resolveSecret,
  WindowsDpapiStore,
  type SecretName,
  type SecretStore,
} from '../../src/core/credentials.js';
import { silentLogger } from '../../src/core/logger.js';
import { PixelBridge } from '../../src/services/pixelbridge.js';
import { cleanup, tempDir } from '../helpers.js';

class MemoryStore implements SecretStore {
  readonly name = 'memory';
  data = new Map<SecretName, string>();
  available() {
    return true;
  }
  location() {
    return 'memory';
  }
  get(n: SecretName) {
    return this.data.get(n) ?? null;
  }
  set(n: SecretName, v: string) {
    this.data.set(n, v);
  }
  delete(n: SecretName) {
    return this.data.delete(n);
  }
}

const KEY = 'AQ.test-key-0123456789abcdefghij';

describe('resolveSecret', () => {
  it('prefers the environment, then the OS store', () => {
    const store = new MemoryStore();
    store.set('GEMINI_API_KEY', 'from-store-0123456789');
    expect(
      resolveSecret(['GEMINI_API_KEY'], { GEMINI_API_KEY: 'from-env' }, store, 'GEMINI_API_KEY'),
    ).toEqual({
      value: 'from-env',
      source: 'environment',
    });
    expect(
      resolveSecret(
        ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
        { GOOGLE_API_KEY: 'alias' },
        store,
        'GEMINI_API_KEY',
      ).source,
    ).toBe('environment');
    expect(resolveSecret(['GEMINI_API_KEY'], {}, store, 'GEMINI_API_KEY')).toEqual({
      value: 'from-store-0123456789',
      source: 'os-store',
    });
    expect(resolveSecret(['GEMINI_API_KEY'], {}, null, 'GEMINI_API_KEY').source).toBe('missing');
  });

  it('treats an unreadable store entry as missing', () => {
    const broken = new MemoryStore();
    broken.get = () => {
      throw new Error('cannot decrypt');
    };
    expect(resolveSecret(['GEMINI_API_KEY'], {}, broken, 'GEMINI_API_KEY').source).toBe('missing');
  });
});

describe('checkKeyShape', () => {
  it.each(['', 'short', 'has space in the middle of it 123', 'x'.repeat(400)])('rejects %j', (v) => {
    expect(() => checkKeyShape(v)).toThrow(/does not look like an API key/);
  });
  it('accepts plausible keys', () => {
    expect(() => checkKeyShape(KEY)).not.toThrow();
    expect(() => checkKeyShape('AIzaSyA0123456789abcdefghijklmnopqrstu')).not.toThrow();
  });
});

describe('AppContext key resolution', () => {
  it('uses a key from the OS store and reports its source without the value', async () => {
    const dir = tempDir();
    const store = new MemoryStore();
    store.set('GEMINI_API_KEY', KEY);
    const pb = new PixelBridge({
      projectRoot: dir,
      config: parseConfig({}),
      env: {},
      secretStore: store,
      logger: silentLogger,
    });
    try {
      expect(pb.ctx.imageProvider().id).toBe('gemini');
      const status = await pb.status({ checkBlender: false });
      expect(status.credentials).toEqual({ gemini: 'os-store', openai: 'missing' });
      expect(JSON.stringify(status)).not.toContain(KEY);
    } finally {
      pb.close();
      cleanup(dir);
    }
  });
});

describe.skipIf(process.platform !== 'win32')('WindowsDpapiStore (real DPAPI)', () => {
  it('encrypts at rest and round-trips', () => {
    const dir = tempDir('pb-cred-');
    try {
      const store = new WindowsDpapiStore(dir);
      store.set('GEMINI_API_KEY', KEY);
      const blob = readFileSync(path.join(dir, 'GEMINI_API_KEY.dpapi'), 'utf8');
      expect(blob).not.toContain('test-key');
      expect(blob.trim()).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(store.get('GEMINI_API_KEY')).toBe(KEY);
      expect(store.get('OPENAI_API_KEY')).toBeNull();
      expect(store.delete('GEMINI_API_KEY')).toBe(true);
      expect(store.get('GEMINI_API_KEY')).toBeNull();
    } finally {
      cleanup(dir);
    }
  }, 30_000);
});
