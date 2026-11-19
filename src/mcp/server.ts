import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { EXPORT_FORMATS, RENDER_VIEWS } from '../blender/spec.js';
import { toPixelBridgeError } from '../core/errors.js';
import { redactValue } from '../core/redact.js';
import { ASSET_KINDS, CATEGORIES } from '../core/registry.js';
import { assetSummary, VERSION, type PixelBridge } from '../services/pixelbridge.js';
import { TURNAROUND_VIEWS } from '../services/prompts.js';
import { MODEL_SPEC_GUIDE } from './spec-guide.js';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

interface ToolResult {
  [key: string]: unknown;
  content: Content[];
  isError?: boolean;
}

function ok(value: unknown, extra: Content[] = []): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(redactValue(value), null, 2) }, ...extra] };
}

function fail(e: unknown): ToolResult {
  const err = toPixelBridgeError(e);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(redactValue({ error: err.toJSON() }), null, 2) }],
  };
}

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

// ---- shared input fields ----------------------------------------------------

const collection = z
  .string()
  .min(1)
  .max(64)
  .describe('Asset collection name, e.g. "pip-the-cat". Files go to assets/<category>/<collection>/.');
const category = z
  .enum(CATEGORIES)
  .optional()
  .describe('Asset category directory (default depends on tool).');
const dryRun = z.boolean().optional().describe('Return the cost estimate without generating anything.');
const confirmCostUsd = z
  .number()
  .min(0)
  .optional()
  .describe(
    'Required when the estimate exceeds the approval threshold. Only pass after the user approved this amount.',
  );
const bypassCache = z.boolean().optional().describe('Generate even if an identical request is cached.');
const imageQuality = z.enum(['low', 'medium', 'high', 'auto']).optional().describe('Default medium.');
const imageSize = z
  .string()
  .regex(/^(auto|\d{2,4}x\d{2,4})$/)
  .optional()
  .describe('"1024x1024" (default), "1536x1024", "1024x1536", "auto", or custom WxH on supported models.');
const background = z.enum(['transparent', 'opaque', 'auto']).optional();
const imageRef = z.string().min(1).describe('Asset id (ast_…) or a path inside the project.');

const PAID_NOTE =
  "Billable: uses the configured provider with the user's API key. Estimates cost first; respects project budget. Use dryRun to quote.";

export function createServer(pb: PixelBridge): McpServer {
  const server = new McpServer(
    { name: 'pixelbridge', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'PixelBridge generates and manages creative assets inside the current project. Call get_status first. ' +
        'Paid tools return APPROVAL_REQUIRED with an estimate when a call is expensive: show the user the estimate and only retry with confirmCostUsd after they agree. ' +
        'Character workflow: generate_character_turnaround → get_model_spec_guide → build_blender_model (with references) → render_model_previews → compare renders with references and rebuild with a revised spec → export_3d_asset. ' +
        'Renders and references are returned as images so you can compare them yourself.',
    },
  );

  // ---- status / budget ------------------------------------------------------

  server.registerTool(
    'get_status',
    {
      title: 'PixelBridge status',
      description:
        'Project root, configured providers and their capabilities, Blender detection, budget summary and setup steps still needed. Call this first.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(async () => ok(await pb.status())),
  );

  server.registerTool(
    'get_budget',
    {
      title: 'Budget and usage',
      description:
        'Spend summary (committed, reserved, unknown-outcome) against limits, plus recent ledger entries. Amounts are local estimates unless the provider reported usage.',
      inputSchema: z.object({ recent: z.number().int().min(0).max(100).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ recent }) =>
      guard(async () => ok({ summary: pb.ctx.budget.summary(), recent: pb.ctx.budget.recent(recent ?? 10) })),
  );

  // ---- images -----------------------------------------------------------------

  server.registerTool(
    'generate_image',
    {
      title: 'Generate image',
      description: `Text-to-image. Saves to assets/<category>/<collection>/references/ and registers metadata. Identical requests are served from cache at no cost. ${PAID_NOTE}`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(32_000),
        collection,
        category,
        role: z.string().max(32).optional().describe('Short label used in the filename, e.g. "concept".'),
        model: z.string().optional(),
        provider: z.string().optional().describe('Image provider id (see get_status). Default: openai.'),
        size: imageSize,
        quality: imageQuality,
        background,
        outputFormat: z.enum(['png', 'webp', 'jpeg']).optional(),
        n: z.number().int().min(1).max(4).optional(),
        bypassCache,
        dryRun,
        confirmCostUsd,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const r = await pb.images.generate(args);
        return ok({ ...r, assets: r.assets.map(assetSummary) });
      }),
  );

  server.registerTool(
    'edit_image',
    {
      title: 'Edit image / generate from references',
      description: `Image edit or reference-conditioned generation: the first image is edited; additional images act as references (Gemini: up to 14; OpenAI: up to 16). Optional mask (OpenAI only). ${PAID_NOTE}`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(32_000),
        images: z.array(imageRef).min(1).max(16),
        mask: imageRef.optional(),
        collection,
        category,
        role: z.string().max(32).optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        size: imageSize,
        quality: imageQuality,
        background,
        outputFormat: z.enum(['png', 'webp', 'jpeg']).optional(),
        inputFidelity: z
          .enum(['high', 'low'])
          .optional()
          .describe('Only on models that support it (e.g. gpt-image-1.5).'),
        n: z.number().int().min(1).max(4).optional(),
        bypassCache,
        dryRun,
        confirmCostUsd,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const r = await pb.images.edit(args);
        return ok({ ...r, assets: r.assets.map(assetSummary) });
      }),
  );

  server.registerTool(
    'generate_character_turnaround',
    {
      title: 'Character reference turnaround',
      description:
        'Generates character reference views for 3D modelling: a front view (from text, or derived from an approved conceptImage), then side/back/three-quarter views conditioned on the front view. ' +
        'Quotes the whole sheet up front. Views are visual references and are not guaranteed to be geometrically consistent; review them. ' +
        PAID_NOTE,
      inputSchema: z.object({
        collection,
        description: z
          .string()
          .min(3)
          .max(4000)
          .describe('What the character looks like. Describe an original character.'),
        style: z.string().max(500).optional().describe('e.g. "stylised low-poly cartoon, soft colours".'),
        views: z
          .array(z.enum(TURNAROUND_VIEWS))
          .min(1)
          .max(4)
          .optional()
          .describe('Default front, side, back.'),
        conceptImage: imageRef.optional().describe('Approved concept to stay consistent with.'),
        model: z.string().optional(),
        provider: z.string().optional(),
        quality: imageQuality,
        size: imageSize.describe('Default 1024x1536 (portrait, full body).'),
        background,
        bypassCache,
        dryRun,
        confirmCostUsd: confirmCostUsd.describe('Approval for the TOTAL sheet estimate.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const r = await pb.images.turnaround(args);
        return ok({
          ...r,
          views: r.views.map((v) => ({
            view: v.view,
            ...(v.outcome
              ? {
                  status: v.outcome.status,
                  costUsd: v.outcome.costUsd,
                  assets: v.outcome.assets.map(assetSummary),
                }
              : {}),
            ...(v.error ? { error: toPixelBridgeError(v.error).toJSON() } : {}),
          })),
        });
      }),
  );

  // ---- assets -------------------------------------------------------------------

  server.registerTool(
    'list_assets',
    {
      title: 'List assets',
      description:
        'List registered assets, newest first, optionally filtered by category, collection or kind.',
      inputSchema: z.object({
        category,
        collection: collection.optional(),
        kind: z.enum(ASSET_KINDS).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok({ assets: pb.ctx.registry.list(args).map(assetSummary) })),
  );

  server.registerTool(
    'get_asset',
    {
      title: 'Get asset metadata',
      description:
        'Full metadata for one asset: prompt, parameters, provider, cost, hash, lineage. Set includeImage to view an image asset.',
      inputSchema: z.object({ assetId: z.string(), includeImage: z.boolean().optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ assetId, includeImage }) =>
      guard(async () => {
        const a = pb.ctx.registry.get(assetId);
        const extra: Content[] = [];
        if (includeImage && a.mime?.startsWith('image/')) {
          const [thumb] = await pb.models.thumbnails([pb.ctx.registry.absolutePath(a)], 768);
          extra.push({ type: 'image', data: readFileSync(thumb!).toString('base64'), mimeType: 'image/png' });
        }
        return ok(a, extra);
      }),
  );

  // ---- async jobs ------------------------------------------------------------------

  const jobSummary = (r: Awaited<ReturnType<typeof pb.jobs.submit>>) => ({
    status: r.status,
    estimate: r.estimate,
    ...(r.job ? { job: r.job } : {}),
    ...(r.assets ? { assets: r.assets.map(assetSummary) } : {}),
    ...(r.job
      ? { next: `Poll with get_job {"jobId": "${r.job.id}"}; video jobs typically take minutes.` }
      : {}),
  });

  server.registerTool(
    'generate_video',
    {
      title: 'Generate video (async)',
      description:
        'Submits a text- or image-to-video job (default: Gemini Omni Flash, 3-15 s, 360p/720p/1080p/4k, 16:9 or 9:16, up to 6 reference images) and returns a job id immediately; poll get_job. ' +
        'Job state persists across server restarts. Generated video is a motion reference, not a skeletal animation. ' +
        PAID_NOTE,
      inputSchema: z.object({
        prompt: z.string().min(1).max(10_000),
        collection,
        category,
        images: z
          .array(imageRef)
          .max(6)
          .optional()
          .describe('Reference or start-frame images (character consistency, image-to-video).'),
        durationSeconds: z.number().int().min(1).max(60).optional().describe('Default 8.'),
        resolution: z.enum(['360p', '720p', '1080p', '4k']).optional().describe('Default 720p.'),
        aspectRatio: z.enum(['16:9', '9:16']).optional().describe('Default 16:9.'),
        model: z.string().optional().describe('See get_status for available video models.'),
        provider: z.string().optional(),
        bypassCache,
        dryRun,
        confirmCostUsd,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => guard(async () => ok(jobSummary(await pb.jobs.submit({ ...args, kind: 'video' })))),
  );

  // Only offered when a configured provider can actually do it (the Gemini API cannot).
  if (pb.ctx.supportsJobKind('3d')) {
    server.registerTool(
      'generate_3d_from_image',
      {
        title: 'Image-to-3D (async)',
        description:
          'Submits an image-to-3D reconstruction job and returns a job id; poll get_job. ' +
          'Results usually need cleanup (retopology, decimation, UVs) before game use; run validate_3d_asset on the output. ' +
          PAID_NOTE,
        inputSchema: z.object({
          image: imageRef,
          collection,
          category,
          prompt: z.string().max(4000).optional(),
          model: z.string().optional(),
          provider: z.string().optional(),
          bypassCache,
          dryRun,
          confirmCostUsd,
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async ({ image, ...rest }) =>
        guard(async () => ok(jobSummary(await pb.jobs.submit({ ...rest, images: [image], kind: '3d' })))),
    );
  }

  server.registerTool(
    'get_job',
    {
      title: 'Get job status / download result',
      description:
        'Polls the provider for a video or 3D job. When complete, downloads outputs into the project and registers them (download: false to only check status).',
      inputSchema: z.object({ jobId: z.string(), download: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ jobId, download }) =>
      guard(async () => {
        const r = await pb.jobs.refresh(jobId, download === undefined ? {} : { download });
        return ok({ job: r.job, assets: r.assets.map(assetSummary) });
      }),
  );

  server.registerTool(
    'cancel_job',
    {
      title: 'Cancel job',
      description:
        'Cancels a queued job (not billed). A job that is already running may only receive a cancellation request and can still complete and be billed.',
      inputSchema: z.object({ jobId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ jobId }) => guard(async () => ok(await pb.jobs.cancel(jobId))),
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description: 'Recent video / 3D jobs with their status.',
      inputSchema: z.object({
        status: z
          .enum(['submitted', 'queued', 'running', 'completed', 'downloaded', 'failed', 'cancelled'])
          .optional(),
        kind: z.enum(['video', '3d']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok({ jobs: pb.jobs.list(args) })),
  );

  // ---- Blender ------------------------------------------------------------------------

  server.registerTool(
    'get_model_spec_guide',
    {
      title: 'Model spec guide',
      description:
        'Schema, conventions and a worked example for the declarative model spec used by build_blender_model. Read this before writing a spec.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(async () => ({ content: [{ type: 'text', text: MODEL_SPEC_GUIDE }] })),
  );

  server.registerTool(
    'build_blender_model',
    {
      title: 'Build Blender model from spec',
      description:
        'Builds a new model version in headless Blender from a declarative JSON spec (primitives, transforms, modifiers, materials; no Python). ' +
        'Optionally places reference images as planes (front/side/back) for later manual work. Saves a versioned spec + .blend, keeps previous versions, and returns scene stats and a Roblox pre-import report. ' +
        'Call get_model_spec_guide first. Free (local), but each call creates a version and versions per collection are capped.',
      inputSchema: z.object({
        collection,
        category,
        spec: z.record(z.string(), z.unknown()).describe('Model spec object (see get_model_spec_guide).'),
        references: z
          .array(z.object({ view: z.enum(['front', 'side', 'back']), image: imageRef }))
          .max(3)
          .optional(),
        note: z.string().max(500).optional().describe('What changed in this version and why.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const r = await pb.models.build(args);
        return ok({
          version: r.version,
          blend: assetSummary(r.blend),
          spec: assetSummary(r.spec),
          totals: r.stats.totals,
          bounds: r.stats.bounds,
          issues: r.stats.issues,
          validation: r.validation,
          warnings: r.warnings,
          durationMs: r.durationMs,
          next: `render_model_previews {"blendAssetId": "${r.blend.id}"}`,
        });
      }),
  );

  server.registerTool(
    'render_model_previews',
    {
      title: 'Render model previews',
      description:
        'Renders preview images of a built model (default front, side, three_quarter at 512px, Workbench engine) and returns them as images, together with downscaled reference images when the model has references, so you can compare them and refine the spec.',
      inputSchema: z.object({
        blendAssetId: z.string(),
        views: z.array(z.enum(RENDER_VIEWS)).min(1).max(5).optional(),
        resolution: z.number().int().min(64).max(2048).optional(),
        engine: z.enum(['workbench', 'eevee', 'cycles']).optional(),
        transparent: z.boolean().optional(),
        includeReferences: z.boolean().optional().describe('Default true.'),
        returnImages: z.boolean().optional().describe('Default true. Set false to only save files.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const r = await pb.models.render(args);
        const extra: Content[] = [];
        if (args.returnImages !== false) {
          for (const a of r.renders) {
            extra.push({ type: 'text', text: `Render: ${a.role} (${a.path})` });
            extra.push({
              type: 'image',
              data: readFileSync(pb.ctx.registry.absolutePath(a)).toString('base64'),
              mimeType: 'image/png',
            });
          }
          if (args.includeReferences !== false && r.references.length) {
            const thumbs = await pb.models.thumbnails(
              r.references.map((ref) => pb.ctx.registry.absolutePath(ref)),
              512,
            );
            r.references.forEach((ref, i) => {
              extra.push({ type: 'text', text: `Reference: ${ref.role ?? ref.id} (${ref.path})` });
              extra.push({
                type: 'image',
                data: readFileSync(thumbs[i]!).toString('base64'),
                mimeType: 'image/png',
              });
            });
          }
        }
        return ok(
          {
            renders: r.renders.map(assetSummary),
            references: r.references.map(assetSummary),
            durationMs: r.durationMs,
            warnings: r.warnings,
          },
          extra,
        );
      }),
  );

  server.registerTool(
    'inspect_3d_asset',
    {
      title: 'Inspect 3D asset',
      description:
        'Scene statistics for a .blend, .glb, .gltf, .fbx or .obj (asset id or project path): objects, triangle counts after modifiers, materials, bounds, UVs, non-manifold edges, armatures.',
      inputSchema: z.object({ target: z.string().describe('Asset id or project path.') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ target }) => guard(async () => ok(await pb.models.inspect(target))),
  );

  server.registerTool(
    'validate_3d_asset',
    {
      title: 'Validate 3D asset for an engine',
      description:
        'Checks a 3D file against an engine profile (currently "roblox": per-mesh triangle cap, size in studs, materials, UVs, rig). Passing does not guarantee a clean import; verify in Studio.',
      inputSchema: z.object({ target: z.string(), profile: z.enum(['roblox']).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ target, profile }) =>
      guard(async () => {
        const r = await pb.models.validate(target, profile ?? 'roblox');
        return ok({
          asset: r.asset ? assetSummary(r.asset) : null,
          totals: r.stats.totals,
          report: r.report,
        });
      }),
  );

  server.registerTool(
    'export_3d_asset',
    {
      title: 'Export 3D asset',
      description:
        'Exports a built model (.blend asset) to glb/gltf/fbx/obj, re-imports each file in a clean Blender scene to verify it, and returns a Roblox pre-import report. Does not upload or publish anything.',
      inputSchema: z.object({
        blendAssetId: z.string(),
        formats: z.array(z.enum(EXPORT_FORMATS)).min(1).max(4).optional().describe('Default ["glb"].'),
        applyModifiers: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const r = await pb.models.export(args);
        return ok({
          exports: r.exports.map((x) => ({
            format: x.format,
            asset: assetSummary(x.asset),
            totals: x.stats.totals,
            validation: x.validation,
          })),
        });
      }),
  );

  return server;
}
