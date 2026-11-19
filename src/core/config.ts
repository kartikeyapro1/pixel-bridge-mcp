import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PixelBridgeError } from './errors.js';

export const CONFIG_FILE = 'pixelbridge.config.json';

const usd = z.number().min(0).max(100_000);

const falModelSchema = z.object({
  kind: z.enum(['video', '3d']),
  /**
   * Price you have verified on the provider's model page. PixelBridge refuses to
   * submit jobs for models without a price, rather than guessing.
   */
  pricing: z
    .union([
      z.object({ perSecondUsd: usd, defaultSeconds: z.number().positive().optional() }),
      z.object({ perRequestUsd: usd }),
    ])
    .optional(),
  /** Request field names for this model (fal models do not share one schema). */
  fields: z
    .object({
      prompt: z.string().default('prompt'),
      image: z.string().default('image_url'),
      duration: z.string().optional(),
    })
    .default({ prompt: 'prompt', image: 'image_url' }),
  /** Format for the duration field: '5' (number as string), 5 (number), or '5s'. */
  durationFormat: z.enum(['string', 'number', 'seconds-suffix']).default('string'),
  allowedDurations: z.array(z.number().positive()).optional(),
  defaults: z.record(z.string(), z.unknown()).default({}),
});

export type FalModelConfig = z.infer<typeof falModelSchema>;

export const configSchema = z.object({
  projectId: z.string().min(1).max(64).optional(),
  assetsDir: z.string().default('assets'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  budget: z
    .object({
      /** Hard cap on estimated + actual spend recorded in this project's ledger. */
      projectLimitUsd: usd.default(5),
      /** Optional per-provider hard caps. */
      providerLimitsUsd: z.record(z.string(), usd).default({}),
      /** Calls estimated above this require an explicit confirmCostUsd from the caller. */
      approvalThresholdUsd: usd.default(0.25),
      /** Absolute per-call ceiling; cannot be overridden through MCP. */
      maxCostPerCallUsd: usd.default(2),
      /** Paid generations allowed per rolling 24h window. */
      maxGenerationsPerDay: z.number().int().min(0).default(100),
      /** Paid requests that may be in flight at once (across processes). */
      maxInFlight: z.number().int().min(1).max(32).default(3),
      /** Reservations older than this are treated as "outcome unknown" and still counted. */
      reservationTtlMinutes: z.number().int().min(1).default(30),
    })
    .default({
      projectLimitUsd: 5,
      providerLimitsUsd: {},
      approvalThresholdUsd: 0.25,
      maxCostPerCallUsd: 2,
      maxGenerationsPerDay: 100,
      maxInFlight: 3,
      reservationTtlMinutes: 30,
    }),
  providers: z
    .object({
      openai: z
        .object({
          enabled: z.boolean().default(true),
          baseUrl: z.string().url().default('https://api.openai.com/v1'),
          defaultModel: z.string().default('gpt-image-2'),
          timeoutMs: z.number().int().min(1000).default(240_000),
          maxRetries: z.number().int().min(0).max(5).default(2),
          moderation: z.enum(['auto', 'low']).optional(),
        })
        .default({
          enabled: true,
          baseUrl: 'https://api.openai.com/v1',
          defaultModel: 'gpt-image-2',
          timeoutMs: 240_000,
          maxRetries: 2,
        }),
      fal: z
        .object({
          enabled: z.boolean().default(true),
          queueUrl: z.string().url().default('https://queue.fal.run'),
          defaultVideoModel: z.string().optional(),
          default3dModel: z.string().optional(),
          timeoutMs: z.number().int().min(1000).default(60_000),
          maxRetries: z.number().int().min(0).max(5).default(2),
          maxDownloadBytes: z
            .number()
            .int()
            .min(1)
            .default(500 * 1024 * 1024),
          models: z.record(z.string(), falModelSchema).default({}),
        })
        .default({
          enabled: true,
          queueUrl: 'https://queue.fal.run',
          timeoutMs: 60_000,
          maxRetries: 2,
          maxDownloadBytes: 500 * 1024 * 1024,
          models: {},
        }),
      mock: z
        .object({ enabled: z.boolean().default(false), costPerCallUsd: usd.default(0.01) })
        .default({ enabled: false, costPerCallUsd: 0.01 }),
    })
    .default({
      openai: {
        enabled: true,
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-image-2',
        timeoutMs: 240_000,
        maxRetries: 2,
      },
      fal: {
        enabled: true,
        queueUrl: 'https://queue.fal.run',
        timeoutMs: 60_000,
        maxRetries: 2,
        maxDownloadBytes: 500 * 1024 * 1024,
        models: {},
      },
      mock: { enabled: false, costPerCallUsd: 0.01 },
    }),
  /** Per-image price overrides for OpenAI models, keyed by model then "quality:WxH". */
  imagePricingOverrides: z.record(z.string(), z.record(z.string(), usd)).default({}),
  blender: z
    .object({
      path: z.string().optional(),
      timeoutMs: z.number().int().min(5000).default(300_000),
    })
    .default({ timeoutMs: 300_000 }),
  pipeline: z
    .object({
      /** Max model versions per asset collection before the agent must ask a human. */
      maxModelVersions: z.number().int().min(1).max(200).default(12),
    })
    .default({ maxModelVersions: 12 }),
  roblox: z
    .object({
      maxTrianglesPerMesh: z.number().int().min(1).default(20_000),
      maxTextureSize: z.number().int().min(1).default(1024),
      maxPartSizeStuds: z.number().positive().default(2048),
      metersPerStud: z.number().positive().default(0.28),
    })
    .default({
      maxTrianglesPerMesh: 20_000,
      maxTextureSize: 1024,
      maxPartSizeStuds: 2048,
      metersPerStud: 0.28,
    }),
});

export type PixelBridgeConfig = z.infer<typeof configSchema>;

export interface LoadedConfig {
  config: PixelBridgeConfig;
  projectRoot: string;
  configPath: string | null;
}

export function resolveProjectRoot(explicit?: string): string {
  return path.resolve(explicit ?? process.env.PIXELBRIDGE_PROJECT_ROOT ?? process.cwd());
}

export function parseConfig(raw: unknown, source = 'config'): PixelBridgeConfig {
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new PixelBridgeError('CONFIG_INVALID', `Invalid ${source}: ${issues}`, {
      hint: `Fix ${CONFIG_FILE} or delete it to use defaults.`,
    });
  }
  return parsed.data;
}

export function loadConfig(projectRoot?: string): LoadedConfig {
  const root = resolveProjectRoot(projectRoot);
  const configPath = path.join(root, CONFIG_FILE);
  let raw: unknown = {};
  let found: string | null = null;
  if (existsSync(configPath)) {
    found = configPath;
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new PixelBridgeError('CONFIG_INVALID', `${CONFIG_FILE} is not valid JSON.`, { cause: e });
    }
  }
  const config = parseConfig(raw, CONFIG_FILE);
  if (process.env.PIXELBRIDGE_MOCK === '1') config.providers.mock.enabled = true;
  if (process.env.BLENDER_PATH && !config.blender.path) config.blender.path = process.env.BLENDER_PATH;
  return { config, projectRoot: root, configPath: found };
}

/** Starter config written by `pixelbridge init`. */
export const STARTER_CONFIG = {
  assetsDir: 'assets',
  budget: {
    projectLimitUsd: 5,
    approvalThresholdUsd: 0.25,
    maxCostPerCallUsd: 2,
    maxGenerationsPerDay: 100,
  },
  providers: {
    openai: { defaultModel: 'gpt-image-2' },
    fal: {
      models: {
        'fal-ai/kling-video/v2.5-turbo/pro/image-to-video': {
          kind: 'video',
          fields: { prompt: 'prompt', image: 'image_url', duration: 'duration' },
          durationFormat: 'string',
          allowedDurations: [5, 10],
          _comment:
            'Add "pricing": {"perSecondUsd": <price from https://fal.ai/models/...>} after checking the current price. Jobs are refused until a price is set.',
        },
      },
    },
  },
};
