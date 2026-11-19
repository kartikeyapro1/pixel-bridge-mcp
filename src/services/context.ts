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
import { FalQueueProvider } from '../providers/fal-queue.js';
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

    if (opts.imageProviders) {
      for (const ip of opts.imageProviders) this.imageProviders.set(ip.id, ip);
    } else {
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
      const falKey = env.FAL_KEY;
      registerSecret(falKey);
      if (p.fal.enabled && falKey) this.jobProviders.set('fal', new FalQueueProvider(p.fal, falKey, fetchFn));
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
    const first = this.imageProviders.get('openai') ?? this.imageProviders.get('mock');
    if (!first) throw notConfigured('openai');
    return first;
  }

  jobProvider(kind: JobKind, name?: string, model?: string): JobProvider {
    if (name) {
      const p = this.jobProviders.get(name);
      if (!p) throw notConfigured(name);
      return p;
    }
    for (const p of this.jobProviders.values()) {
      if (!model || p.supports(kind, model)) return p;
    }
    throw notConfigured('fal');
  }

  defaultJobModel(kind: JobKind, provider: JobProvider): string {
    if (provider.id === 'mock') return kind === 'video' ? 'mock-video' : 'mock-3d';
    const fal = this.config.providers.fal;
    const configured = kind === 'video' ? fal.defaultVideoModel : fal.default3dModel;
    if (configured) return configured;
    const first = Object.entries(fal.models).find(([, m]) => m.kind === kind);
    if (first) return first[0];
    throw new PixelBridgeError('PROVIDER_NOT_CONFIGURED', `No ${kind} model configured for fal.`, {
      hint: `Add a providers.fal.models entry with kind "${kind}" to pixelbridge.config.json (see docs/providers.md).`,
    });
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

function notConfigured(name: string): PixelBridgeError {
  const hints: Record<string, string> = {
    openai:
      'Set OPENAI_API_KEY in the environment of the MCP server (or enable the mock provider for offline testing).',
    fal: 'Set FAL_KEY in the environment of the MCP server and configure providers.fal.models.',
    mock: 'Enable providers.mock in pixelbridge.config.json or set PIXELBRIDGE_MOCK=1.',
  };
  return new PixelBridgeError('PROVIDER_NOT_CONFIGURED', `Provider "${name}" is not configured.`, {
    hint: hints[name] ?? 'Check pixelbridge.config.json.',
  });
}
