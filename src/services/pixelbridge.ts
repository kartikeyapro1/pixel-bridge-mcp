import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AssetRecord } from '../core/registry.js';
import { AppContext, type AppContextOptions } from './context.js';
import { ImageService } from './image-service.js';
import { JobService } from './job-service.js';
import { ModelService } from './model-service.js';

/** Application facade shared by the MCP server and the CLI. */
export class PixelBridge {
  readonly ctx: AppContext;
  readonly images: ImageService;
  readonly jobs: JobService;
  readonly models: ModelService;

  constructor(opts: AppContextOptions = {}) {
    this.ctx = new AppContext(opts);
    this.images = new ImageService(this.ctx);
    this.jobs = new JobService(this.ctx);
    this.models = new ModelService(this.ctx);
  }

  async status(opts: { checkBlender?: boolean } = {}) {
    const ctx = this.ctx;
    const imageProviders = [...ctx.imageProviders.values()].map((p) => ({ id: p.id, ...p.capabilities() }));
    const jobProviders = [...ctx.jobProviders.values()].map((p) => ({
      id: p.id,
      models: p.describeModels(),
    }));
    const setup: string[] = [];
    if (!ctx.imageProviders.has('gemini') && !ctx.imageProviders.has('openai')) {
      setup.push(
        'Images and video: set GEMINI_API_KEY (Google AI Studio) for the MCP server process. One key covers both.',
      );
    } else if (!ctx.jobProviders.has('gemini')) {
      setup.push('Video: set GEMINI_API_KEY (the OpenAI key covers images only).');
    }
    const blender = opts.checkBlender === false ? null : await ctx.blender.detect();
    if (blender && !blender.found) setup.push(blender.message);
    return {
      version: VERSION,
      projectRoot: ctx.projectRoot,
      projectId: ctx.projectId,
      configFile: ctx.configPath,
      assetsDir: ctx.config.assetsDir,
      imageProviders,
      jobProviders,
      blender,
      budget: ctx.budget.summary(),
      setup,
    };
  }

  /** Make sure the assets directory exists (used by init). */
  ensureDirs(): void {
    mkdirSync(path.join(this.ctx.projectRoot, this.ctx.config.assetsDir), { recursive: true });
  }

  close(): void {
    this.ctx.close();
  }
}

export const VERSION = '0.1.0';

/** Compact asset view for agent-facing output. */
export function assetSummary(a: AssetRecord) {
  return {
    id: a.id,
    kind: a.kind,
    category: a.category,
    collection: a.collection,
    role: a.role,
    path: a.path,
    version: a.version,
    bytes: a.bytes,
    provider: a.provider,
    model: a.model,
    parentId: a.parentId,
    costUsd: a.actualCostUsd ?? a.estimatedCostUsd,
    createdAt: a.createdAt,
    ...(a.metadata?.mock ? { mock: true } : {}),
  };
}
