import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PixelBridgeError } from './errors.js';

export const CONFIG_FILE = 'pixelbridge.config.json';

const usd = z.number().min(0).max(100_000);

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
      /** Optional alternative image provider (OPENAI_API_KEY). Gemini is preferred when both are set. */
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
      gemini: z
        .object({
          enabled: z.boolean().default(true),
          baseUrl: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
          apiRevision: z.string().default('2026-05-20'),
          imageModel: z.string().default('gemini-nano-banana-2.1'),
          videoModel: z.string().default('gemini-omni-1.2-flash'),
          /** Thinking is billed; "minimal" keeps image calls cheap and estimates tight. */
          imageThinkingLevel: z.enum(['minimal', 'medium', 'high']).optional().default('minimal'),
          /** Image interactions are not stored server-side unless enabled. */
          storeImageInteractions: z.boolean().default(false),
          defaultVideoSeconds: z.number().int().min(3).max(15).default(8),
          timeoutMs: z.number().int().min(1000).default(240_000),
          /** Used only if background execution is unavailable and the video call runs synchronously. */
          videoSyncTimeoutMs: z.number().int().min(1000).default(900_000),
          maxRetries: z.number().int().min(0).max(5).default(2),
        })
        .prefault({}),
      mock: z
        .object({ enabled: z.boolean().default(false), costPerCallUsd: usd.default(0.01) })
        .default({ enabled: false, costPerCallUsd: 0.01 }),
    })
    .prefault({}),
  /** Largest provider output PixelBridge will download. */
  maxDownloadBytes: z
    .number()
    .int()
    .min(1)
    .default(500 * 1024 * 1024),
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
    gemini: {
      imageModel: 'gemini-nano-banana-2.1',
      videoModel: 'gemini-omni-1.2-flash',
      defaultVideoSeconds: 8,
    },
  },
};
