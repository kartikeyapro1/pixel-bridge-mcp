import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, type PixelBridgeConfig } from '../src/core/config.js';
import { silentLogger } from '../src/core/logger.js';
import { MockImageProvider, MockJobProvider } from '../src/providers/mock.js';
import type { ImageProvider, JobProvider } from '../src/providers/types.js';
import { PixelBridge } from '../src/services/pixelbridge.js';

export function tempDir(prefix = 'pb-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

export function testConfig(overrides: Record<string, unknown> = {}): PixelBridgeConfig {
  return parseConfig({ providers: { mock: { enabled: true } }, ...overrides });
}

export interface TestBridge {
  pb: PixelBridge;
  dir: string;
  images: MockImageProvider;
  jobs: MockJobProvider;
  done: () => void;
}

export function makeBridge(
  opts: {
    config?: Record<string, unknown>;
    dir?: string;
    imageProviders?: ImageProvider[];
    jobProviders?: JobProvider[];
    pollsUntilDone?: number;
  } = {},
): TestBridge {
  const dir = opts.dir ?? tempDir();
  const config = testConfig(opts.config);
  const images = new MockImageProvider(config.providers.mock.costPerCallUsd);
  const jobs = new MockJobProvider(config.providers.mock.costPerCallUsd, opts.pollsUntilDone ?? 2);
  const pb = new PixelBridge({
    projectRoot: dir,
    config,
    logger: silentLogger,
    imageProviders: opts.imageProviders ?? [images],
    jobProviders: opts.jobProviders ?? [jobs],
    secretStore: null,
  });
  return {
    pb,
    dir,
    images,
    jobs,
    done: () => {
      pb.close();
      if (!opts.dir) cleanup(dir);
    },
  };
}

/** Build a fetch stub from a list of handlers, recording calls. */
export function fakeFetch(
  handler: (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>,
) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return handler(url, init, calls.length);
  };
  return { fn, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
