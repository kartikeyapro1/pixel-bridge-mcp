import type { CostEstimate } from '../core/budget.js';
import { PixelBridgeError } from '../core/errors.js';
import { requestFingerprint } from '../core/hashing.js';
import type { AssetRecord, Category } from '../core/registry.js';
import type {
  ImageBackground,
  ImageFormat,
  ImageParams,
  ImageProvider,
  ImageQuality,
  ImageResult,
} from '../providers/types.js';
import type { AppContext } from './context.js';
import { resolveImage, type ResolvedImage } from './inputs.js';
import { runPaid } from './paid-call.js';
import { TURNAROUND_VIEWS, turnaroundPrompt, type TurnaroundView } from './prompts.js';

export interface ImageRequestBase {
  prompt: string;
  collection: string;
  category?: Category;
  role?: string;
  provider?: string;
  model?: string;
  size?: string;
  quality?: ImageQuality;
  background?: ImageBackground;
  outputFormat?: ImageFormat;
  n?: number;
  bypassCache?: boolean;
  dryRun?: boolean;
  confirmCostUsd?: number;
}

export interface EditRequest extends ImageRequestBase {
  /** Asset ids or project paths. The first image is the one being edited. */
  images: string[];
  mask?: string;
  inputFidelity?: 'high' | 'low';
  parentId?: string;
}

export interface ImageOutcome {
  status: 'generated' | 'cached' | 'dry_run';
  estimate: CostEstimate;
  costUsd: number;
  costIsActual: boolean;
  assets: AssetRecord[];
  warnings: string[];
}

export class ImageService {
  constructor(private readonly ctx: AppContext) {}

  private params(provider: ImageProvider, r: ImageRequestBase): ImageParams {
    return {
      model: r.model ?? provider.capabilities().defaultModel,
      prompt: r.prompt,
      size: r.size ?? '1024x1024',
      quality: r.quality ?? 'medium',
      background: r.background ?? 'auto',
      outputFormat: r.outputFormat ?? 'png',
      n: r.n ?? 1,
    };
  }

  quote(r: ImageRequestBase, operation: 'generate' | 'edit', referenceCount = 0): CostEstimate {
    const provider = this.ctx.imageProvider(r.provider);
    const params = this.params(provider, r);
    provider.validate(params, operation);
    return provider.estimate(params, operation, referenceCount);
  }

  async generate(r: ImageRequestBase): Promise<ImageOutcome> {
    return this.run(r, 'generate', []);
  }

  async edit(r: EditRequest): Promise<ImageOutcome> {
    if (r.images.length === 0)
      throw new PixelBridgeError('INVALID_INPUT', 'edit_image needs at least one image.');
    const refs = r.images.map((ref) => resolveImage(ref, this.ctx.registry, this.ctx.paths));
    const mask = r.mask ? resolveImage(r.mask, this.ctx.registry, this.ctx.paths) : undefined;
    return this.run(r, 'edit', refs, mask);
  }

  private async run(
    r: ImageRequestBase & { inputFidelity?: 'high' | 'low'; parentId?: string },
    operation: 'generate' | 'edit',
    refs: ResolvedImage[],
    mask?: ResolvedImage,
  ): Promise<ImageOutcome> {
    const provider = this.ctx.imageProvider(r.provider);
    const params = this.params(provider, r);
    provider.validate(params, operation);
    const estimate = provider.estimate(params, operation, refs.length);
    const warnings: string[] = [];
    if (estimate.basis.startsWith('extrapolated')) {
      warnings.push(`Cost estimate is extrapolated (${estimate.basis}); treat it as a rough upper bound.`);
    }

    const fingerprint = requestFingerprint({
      provider: provider.id,
      model: params.model,
      operation: `image.${operation}`,
      params: { ...params, inputFidelity: r.inputFidelity },
      referenceHashes: [...refs.map((x) => x.sha256), ...(mask ? [`mask:${mask.sha256}`] : [])],
    });

    if (!r.bypassCache) {
      const cached = await this.ctx.registry.cacheLookup(fingerprint);
      if (cached) {
        return { status: 'cached', estimate, costUsd: 0, costIsActual: true, assets: cached, warnings };
      }
    }
    if (r.dryRun)
      return { status: 'dry_run', estimate, costUsd: 0, costIsActual: false, assets: [], warnings };

    this.ctx.budget.checkApproval(estimate, r.confirmCostUsd);
    const { value, costUsd, costIsActual } = await runPaid<ImageResult>(
      this.ctx.budget,
      estimate,
      `${operation} ${r.collection}`,
      async () => {
        const res =
          operation === 'generate'
            ? await provider.generate(params)
            : await provider.edit({
                ...params,
                images: refs,
                ...(mask ? { mask } : {}),
                ...(r.inputFidelity ? { inputFidelity: r.inputFidelity } : {}),
              });
        return { value: res, actualCostUsd: res.actualCostUsd };
      },
    );

    const category = r.category ?? 'characters';
    const dir = this.ctx.registry.dirFor(category, r.collection, 'image');
    const assets: AssetRecord[] = [];
    const perImageCost = costUsd / value.images.length;
    for (const [i, img] of value.images.entries()) {
      const stem = `${r.collection}-${r.role ?? 'image'}${value.images.length > 1 ? `-${i + 1}` : ''}`;
      const file = this.ctx.registry.writeNewFile(
        dir,
        stem,
        img.format === 'jpeg' ? 'jpg' : img.format,
        img.data,
      );
      assets.push(
        await this.ctx.registry.register(file, {
          kind: 'image',
          category,
          collection: r.collection,
          ...(r.role ? { role: r.role } : {}),
          provider: provider.id,
          model: params.model,
          prompt: params.prompt,
          params: {
            size: params.size,
            quality: params.quality,
            background: params.background,
            outputFormat: params.outputFormat,
            operation,
          },
          referenceIds: refs.map((x) => x.assetId).filter((x): x is string => !!x),
          ...(r.parentId ? { parentId: r.parentId } : {}),
          estimatedCostUsd: estimate.estimatedUsd / value.images.length,
          actualCostUsd: costIsActual ? perImageCost : null,
          fingerprint,
          ...(provider.id === 'mock' ? { metadata: { mock: true } } : {}),
        }),
      );
    }
    this.ctx.registry.cacheStore(
      fingerprint,
      assets.map((a) => a.id),
    );
    return { status: 'generated', estimate, costUsd, costIsActual, assets, warnings };
  }

  /**
   * Character reference sheet: a front view (generated, or derived from an approved
   * concept image), then each other view generated as an edit that conditions on the
   * front view. Views are visual references, not measured orthographic projections.
   */
  async turnaround(r: {
    collection: string;
    description: string;
    style?: string;
    views?: TurnaroundView[];
    conceptImage?: string;
    provider?: string;
    model?: string;
    quality?: ImageQuality;
    size?: string;
    background?: ImageBackground;
    bypassCache?: boolean;
    dryRun?: boolean;
    confirmCostUsd?: number;
  }): Promise<{
    status: 'generated' | 'dry_run' | 'partial';
    totalEstimateUsd: number;
    costUsd: number;
    views: { view: TurnaroundView; outcome?: ImageOutcome; error?: unknown }[];
    warnings: string[];
  }> {
    const views: TurnaroundView[] = [...new Set<TurnaroundView>(r.views ?? ['front', 'side', 'back'])];
    for (const v of views)
      if (!TURNAROUND_VIEWS.includes(v)) throw new PixelBridgeError('INVALID_INPUT', `Unknown view ${v}`);
    if (!views.includes('front')) views.unshift('front');
    const base = {
      collection: r.collection,
      category: 'characters' as const,
      size: r.size ?? '1024x1536',
      quality: r.quality ?? 'medium',
      background: r.background ?? 'opaque',
      ...(r.provider ? { provider: r.provider } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.bypassCache ? { bypassCache: true } : {}),
    };

    // Quote the whole sheet up front so the user approves one number.
    let total = 0;
    for (const v of views) {
      const refs = v === 'front' ? (r.conceptImage ? 1 : 0) : r.conceptImage ? 2 : 1;
      total += this.quote(
        { ...base, prompt: turnaroundPrompt(v, r.description, r.style) },
        refs ? 'edit' : 'generate',
        refs,
      ).estimatedUsd;
    }
    total = Math.round(total * 10_000) / 10_000;
    const warnings = [
      'Separately generated views are not guaranteed to be geometrically consistent. Review them before modelling.',
    ];
    if (r.dryRun)
      return {
        status: 'dry_run',
        totalEstimateUsd: total,
        costUsd: 0,
        views: views.map((view) => ({ view })),
        warnings,
      };

    // Approval is for the whole sheet; per-call checks then see an explicit confirmation.
    this.ctx.budget.checkApproval(
      {
        provider: 'multiple',
        model: r.model ?? 'default',
        operation: 'image.turnaround',
        estimatedUsd: total,
        basis: 'sum of per-view estimates',
      },
      r.confirmCostUsd,
    );
    const confirm = r.confirmCostUsd ?? total;

    const results: { view: TurnaroundView; outcome?: ImageOutcome; error?: unknown }[] = [];
    let front: AssetRecord | undefined;
    let spent = 0;
    for (const view of views) {
      const prompt = turnaroundPrompt(view, r.description, r.style);
      try {
        let outcome: ImageOutcome;
        if (view === 'front') {
          outcome = r.conceptImage
            ? await this.edit({
                ...base,
                prompt,
                role: 'front',
                images: [r.conceptImage],
                confirmCostUsd: confirm,
              })
            : await this.generate({ ...base, prompt, role: 'front', confirmCostUsd: confirm });
          front = outcome.assets[0];
        } else {
          if (!front)
            throw new PixelBridgeError('INVALID_INPUT', 'Front view failed; cannot derive other views.');
          const images = [front.id, ...(r.conceptImage ? [r.conceptImage] : [])];
          outcome = await this.edit({
            ...base,
            prompt,
            role: view,
            images,
            parentId: front.id,
            confirmCostUsd: confirm,
          });
        }
        spent += outcome.costUsd;
        warnings.push(...outcome.warnings.filter((w) => !warnings.includes(w)));
        results.push({ view, outcome });
      } catch (e) {
        results.push({ view, error: e });
        if (view === 'front') break;
      }
    }
    const failed = results.some((x) => x.error) || results.length < views.length;
    return {
      status: failed ? 'partial' : 'generated',
      totalEstimateUsd: total,
      costUsd: spent,
      views: results,
      warnings,
    };
  }
}
