import type { CostEstimate } from '../core/budget.js';
import { PixelBridgeError } from '../core/errors.js';
import { requestFingerprint } from '../core/hashing.js';
import path from 'node:path';
import { slugify } from '../core/paths.js';
import type { AssetRecord, Category } from '../core/registry.js';
import {
  decodeImage,
  encodePngRaster,
  removeBackground,
  type RemoveBackgroundOptions,
} from '../util/raster.js';
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
  /** Project-relative directory to write into instead of assets/<category>/<collection>/references. */
  outputDir?: string;
  /** File name without extension (an extension is added; "-2" etc. on collision). */
  fileName?: string;
  /** With a transparent background: crop to the subject. */
  trim?: boolean;
}

/** Appended to the prompt when transparency is produced locally from a flat background. */
export const CUTOUT_PROMPT_SUFFIX =
  ' Isolated subject centred on a perfectly flat, uniform, solid magenta (#FF00FF) background that fills the entire image edge to edge.' +
  ' No shadows, gradients, vignette, texture, border or frame on the background. Do not use magenta or pink in the subject.';

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

  /**
   * Request parameters for the provider. A transparent background on a provider that
   * cannot produce one is generated on a flat magenta background and cut out locally.
   */
  private params(
    provider: ImageProvider,
    r: ImageRequestBase,
  ): { params: ImageParams; localCutout: boolean } {
    const params: ImageParams = {
      model: r.model ?? provider.capabilities().defaultModel,
      prompt: r.prompt,
      size: r.size ?? '1024x1024',
      quality: r.quality ?? 'medium',
      background: r.background ?? 'auto',
      outputFormat: r.outputFormat ?? 'png',
      n: r.n ?? 1,
    };
    const localCutout =
      params.background === 'transparent' && provider.capabilities().transparentBackground === 'unsupported';
    if (localCutout) {
      params.background = 'auto';
      params.prompt = params.prompt.trimEnd() + CUTOUT_PROMPT_SUFFIX;
    }
    return { params, localCutout };
  }

  /** Where to write: an explicit project directory, or the collection's references folder. */
  private outputDirFor(r: { outputDir?: string; category?: Category; collection: string }): string {
    return r.outputDir
      ? this.ctx.paths.resolve(r.outputDir, 'output directory')
      : this.ctx.registry.dirFor(r.category ?? 'characters', r.collection, 'image');
  }

  quote(r: ImageRequestBase, operation: 'generate' | 'edit', referenceCount = 0): CostEstimate {
    const provider = this.ctx.imageProvider(r.provider);
    const { params } = this.params(provider, r);
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
    const { params, localCutout } = this.params(provider, r);
    provider.validate(params, operation);
    // Validate the destination before spending anything.
    const outDir = this.outputDirFor(r);
    const estimate = provider.estimate(params, operation, refs.length);
    const warnings: string[] = [];
    if (localCutout) {
      warnings.push(
        `${provider.id} cannot output transparency; the image is generated on a flat background and cut out locally. Check the edges, especially on fine detail.`,
      );
    }
    if (estimate.basis.startsWith('extrapolated')) {
      warnings.push(`Cost estimate is extrapolated (${estimate.basis}); treat it as a rough upper bound.`);
    }

    const fingerprint = requestFingerprint({
      provider: provider.id,
      model: params.model,
      operation: `image.${operation}`,
      params: { ...params, inputFidelity: r.inputFidelity, localCutout, trim: localCutout && !!r.trim },
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
    const assets: AssetRecord[] = [];
    const perImageCost = costUsd / value.images.length;
    const baseStem = r.fileName
      ? stripExtension(r.fileName)
      : `${slugify(r.collection)}-${slugify(r.role ?? 'image')}`;
    const mockMeta = provider.id === 'mock' ? { mock: true } : {};
    for (const [i, img] of value.images.entries()) {
      const stem = `${baseStem}${value.images.length > 1 ? `-${i + 1}` : ''}`;
      const ext = img.format === 'jpeg' ? 'jpg' : img.format;
      const record = {
        kind: 'image' as const,
        category,
        collection: r.collection,
        provider: provider.id,
        model: params.model,
        prompt: params.prompt,
        params: {
          size: params.size,
          quality: params.quality,
          background: r.background ?? params.background,
          outputFormat: params.outputFormat,
          operation,
        },
        referenceIds: refs.map((x) => x.assetId).filter((x): x is string => !!x),
        estimatedCostUsd: estimate.estimatedUsd / value.images.length,
        actualCostUsd: costIsActual ? perImageCost : null,
        fingerprint,
      };

      if (localCutout) {
        // Keep the flat-background original in the collection, then write the cut-out.
        const srcDir = this.ctx.registry.dirFor(category, r.collection, 'image');
        const srcFile = this.ctx.registry.writeNewFile(srcDir, `${stem}-source`, ext, img.data);
        const source = await this.ctx.registry.register(srcFile, {
          ...record,
          role: `${r.role ?? 'image'}-source`,
          ...(r.parentId ? { parentId: r.parentId } : {}),
          metadata: { ...mockMeta, note: 'flat-background original used for the local cut-out' },
        });
        try {
          const cut = removeBackground(decodeImage(img.data), { trim: !!r.trim, padding: r.trim ? 8 : 0 });
          const file = this.ctx.registry.writeNewFile(outDir, stem, 'png', encodePngRaster(cut.raster));
          assets.push(
            await this.ctx.registry.register(file, {
              ...record,
              ...(r.role ? { role: r.role } : {}),
              parentId: source.id,
              estimatedCostUsd: 0,
              actualCostUsd: 0,
              metadata: {
                ...mockMeta,
                transparent: true,
                cutout: {
                  background: cut.background,
                  transparentShare: Math.round(cut.transparentShare * 1000) / 1000,
                },
                width: cut.raster.width,
                height: cut.raster.height,
              },
            }),
          );
        } catch (e) {
          warnings.push(
            `Background removal failed (${e instanceof Error ? e.message : String(e)}); returning the original. Try remove_background with a higher tolerance.`,
          );
          assets.push(source);
        }
        continue;
      }

      const file = this.ctx.registry.writeNewFile(outDir, stem, ext, img.data);
      assets.push(
        await this.ctx.registry.register(file, {
          ...record,
          ...(r.role ? { role: r.role } : {}),
          ...(r.parentId ? { parentId: r.parentId } : {}),
          ...(provider.id === 'mock' ? { metadata: mockMeta } : {}),
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
   * Make an existing image's flat background transparent (local, free). Writes a new
   * PNG next to the source (or into outputDir) and records it as a child of the source.
   */
  async removeBackground(
    r: {
      image: string;
      collection?: string;
      category?: Category;
      outputDir?: string;
      fileName?: string;
    } & Pick<RemoveBackgroundOptions, 'tolerance' | 'softness' | 'trim' | 'padding' | 'removeEnclosed'>,
  ): Promise<{
    asset: AssetRecord;
    background: [number, number, number];
    transparentShare: number;
    width: number;
    height: number;
  }> {
    const src = resolveImage(r.image, this.ctx.registry, this.ctx.paths);
    const source = src.assetId ? this.ctx.registry.get(src.assetId) : null;
    const collection = r.collection ?? source?.collection ?? 'cutouts';
    const category = r.category ?? source?.category ?? 'misc';
    const outDir = r.outputDir
      ? this.ctx.paths.resolve(r.outputDir, 'output directory')
      : source
        ? path.dirname(src.absPath)
        : this.ctx.registry.dirFor(category, collection, 'image');
    const cut = removeBackground(decodeImage(src.data), {
      ...(r.tolerance !== undefined ? { tolerance: r.tolerance } : {}),
      ...(r.softness !== undefined ? { softness: r.softness } : {}),
      ...(r.removeEnclosed !== undefined ? { removeEnclosed: r.removeEnclosed } : {}),
      trim: !!r.trim,
      padding: r.padding ?? (r.trim ? 8 : 0),
    });
    const stem = r.fileName
      ? stripExtension(r.fileName)
      : `${stripExtension(path.basename(src.absPath))}-cutout`;
    const file = this.ctx.registry.writeNewFile(outDir, stem, 'png', encodePngRaster(cut.raster));
    const asset = await this.ctx.registry.register(file, {
      kind: 'image',
      category,
      collection,
      role: 'cutout',
      provider: 'local',
      ...(source ? { parentId: source.id, referenceIds: [source.id] } : {}),
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      params: {
        operation: 'remove_background',
        tolerance: r.tolerance ?? 40,
        softness: r.softness ?? 40,
        trim: !!r.trim,
      },
      metadata: {
        transparent: true,
        sourcePath: this.ctx.paths.relative(src.absPath),
        width: cut.raster.width,
        height: cut.raster.height,
      },
    });
    return {
      asset,
      background: cut.background,
      transparentShare: Math.round(cut.transparentShare * 1000) / 1000,
      width: cut.raster.width,
      height: cut.raster.height,
    };
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

function stripExtension(name: string): string {
  return name.replace(/[.](png|jpe?g|webp|gif|mp4|webm)$/i, '');
}
