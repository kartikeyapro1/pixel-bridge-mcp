import path from 'node:path';
import { BudgetLedger } from '../core/budget.js';
import { loadConfig, type PixelBridgeConfig } from '../core/config.js';
import { openDatabase, type Database } from '../core/db.js';
import { PixelBridgeError } from '../core/errors.js';
import type { FetchLike } from '../core/http.js';
import { createLogger, type Logger } from '../core/logger.js';
import { ProjectPaths, slugify } from '../core/paths.js';
import { registerSecret } from '../core/redact.js';
import { AssetRegistry } from '../core/registry.js';
import { GeminiImageProvider, GeminiVideoProvider } from '../providers/gemini.js';
import { MockImageProvider, MockJobProvider } from '../providers/mock.js';
import { OpenAIImageProvider } from '../providers/openai-image.js';
import type { ImageProvider, JobKind, JobProvider } from '../providers/types.js';
import { BlenderService } from './blender-service.js';

export interface AppContextOptions {
  projectRoot?: string;
  /** Replace the loaded config entirely (tests). */
  config?: PixelBridgeConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  logger?: Logger;
  imageProviders?: ImageProvider[];
  jobProviders?: JobProvider[];
}

/**
 * Wires configuration, storage and providers for one project. Both the MCP server
 * and the CLI build one of these and call the same services.
 */
export class AppContext {
  readonly config: PixelBridgeConfig;
  readonly projectRoot: string;
  readonly configPath: string | null;
  readonly paths: ProjectPaths;
  readonly db: Database;
  readonly registry: AssetRegistry;
  readonly budget: BudgetLedger;
  readonly logger: Logger;
  readonly imageProviders = new Map<string, ImageProvider>();
  readonly jobProviders = new Map<string, JobProvider>();
  readonly blender: BlenderService;
  readonly projectId: string;

  constructor(opts: AppContextOptions = {}) {
    const loaded = opts.config
      ? {
          config: opts.config,
          projectRoot: path.resolve(opts.projectRoot ?? process.cwd()),
          configPath: null,
        }
      : loadConfig(opts.projectRoot);
    this.config = loaded.config;
    this.projectRoot = loaded.projectRoot;
    this.configPath = loaded.configPath;
    this.logger = opts.logger ?? createLogger(this.config.logLevel);
    this.paths = new ProjectPaths(this.projectRoot);
    this.projectId = this.config.projectId ?? slugify(path.basename(this.projectRoot), 'project');

    const assetsDir = path.normalize(this.config.assetsDir);
    this.paths.resolve(assetsDir, 'assetsDir'); // must be inside the project
    const dataDir = this.paths.resolve('.pixelbridge', 'data directory');
    this.db = openDatabase(path.join(dataDir, 'pixelbridge.db'));
    this.registry = new AssetRegistry(this.db, this.paths, assetsDir, this.projectId);
    this.budget = new BudgetLedger(this.db, this.config.budget);

    const env = opts.env ?? process.env;
    const fetchFn = opts.fetch ?? fetch;
    const p = this.config.providers;

    // One key covers images and video: GEMINI_API_KEY (GOOGLE_API_KEY accepted as an alias).
    const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    registerSecret(geminiKey);
    const geminiOn = p.gemini.enabled && !!geminiKey;

    if (opts.imageProviders) {
      for (const ip of opts.imageProviders) this.imageProviders.set(ip.id, ip);
    } else {
      if (geminiOn) this.imageProviders.set('gemini', new GeminiImageProvider(p.gemini, geminiKey!, fetchFn));
      const openaiKey = env.OPENAI_API_KEY;
      registerSecret(openaiKey);
      if (p.openai.enabled && openaiKey) {
        this.imageProviders.set(
          'openai',
          new OpenAIImageProvider(p.openai, this.config.imagePricingOverrides, openaiKey, fetchFn),
        );
      }
      if (p.mock.enabled) this.imageProviders.set('mock', new MockImageProvider(p.mock.costPerCallUsd));
    }
    if (opts.jobProviders) {
      for (const jp of opts.jobProviders) this.jobProviders.set(jp.id, jp);
    } else {
      if (geminiOn) this.jobProviders.set('gemini', new GeminiVideoProvider(p.gemini, geminiKey!, fetchFn));
      if (p.mock.enabled) this.jobProviders.set('mock', new MockJobProvider(p.mock.costPerCallUsd));
    }

    this.blender = new BlenderService(this.config.blender, this.paths, this.logger);
  }

  imageProvider(name?: string): ImageProvider {
    if (name) {
      const p = this.imageProviders.get(name);
      if (!p) throw notConfigured(name);
      return p;
    }
    const first =
      this.imageProviders.get('gemini') ??
      this.imageProviders.get('openai') ??
      this.imageProviders.get('mock');
    if (!first) throw notConfigured('gemini');
    return first;
  }

  jobProvider(kind: JobKind, name?: string, model?: string): JobProvider {
    if (name) {
      const p = this.jobProviders.get(name);
      if (!p) throw notConfigured(name);
      return p;
    }
    for (const p of this.jobProviders.values()) {
      if (model ? p.supports(kind, model) : p.defaultModel(kind) !== null) return p;
    }
    if (kind === '3d') {
      throw new PixelBridgeError(
        'PROVIDER_UNSUPPORTED',
        'No configured provider offers image-to-3D generation.',
        {
          hint: 'Build 3D models locally with build_blender_model (free, no API key).',
        },
      );
    }
    throw notConfigured('gemini');
  }

  defaultJobModel(kind: JobKind, provider: JobProvider): string {
    const model = provider.defaultModel(kind);
    if (!model) {
      throw new PixelBridgeError(
        'PROVIDER_UNSUPPORTED',
        `Provider "${provider.id}" does not support ${kind} generation.`,
      );
    }
    return model;
  }

  /** Whether any configured job provider supports a kind (used to hide unusable tools). */
  supportsJobKind(kind: JobKind): boolean {
    return [...this.jobProviders.values()].some((p) => p.defaultModel(kind) !== null);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

function notConfigured(name: string): PixelBridgeError {
  const hints: Record<string, string> = {
    openai:
      'Set OPENAI_API_KEY in the environment of the MCP server (or enable the mock provider for offline testing).',
    gemini:
      'Set GEMINI_API_KEY (from Google AI Studio) in the environment of the MCP server. One key covers images and video. For offline testing set PIXELBRIDGE_MOCK=1.',
    mock: 'Enable providers.mock in pixelbridge.config.json or set PIXELBRIDGE_MOCK=1.',
  };
  return new PixelBridgeError('PROVIDER_NOT_CONFIGURED', `Provider "${name}" is not configured.`, {
    hint: hints[name] ?? 'Check pixelbridge.config.json.',
  });
}
