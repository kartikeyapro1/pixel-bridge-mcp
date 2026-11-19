import { existsSync, readFileSync, rmSync } from 'node:fs';
import { sha256 } from '../core/hashing.js';
import { pngSize } from '../util/png.js';
import path from 'node:path';
import { validateForRoblox, type ValidationReport } from '../blender/roblox.js';
import {
  modelSpecSchema,
  type ExportFormat,
  type ModelSpec,
  type RenderView,
  type SceneStats,
} from '../blender/spec.js';
import { PixelBridgeError } from '../core/errors.js';
import type { AssetRecord, Category } from '../core/registry.js';
import type { AppContext } from './context.js';
import { resolveImage } from './inputs.js';

export type ReferenceView = 'front' | 'side' | 'back';

async function cleanupOnError<T>(files: string[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    for (const f of files) rmSync(f, { force: true });
    throw e;
  }
}

function pad(v: number): string {
  return `v${String(v).padStart(3, '0')}`;
}

export class ModelService {
  constructor(private readonly ctx: AppContext) {}

  parseSpec(raw: unknown): ModelSpec {
    const parsed = modelSpecSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 20)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new PixelBridgeError('INVALID_INPUT', `Invalid model spec: ${issues}`, {
        hint: 'See docs/model-spec.md for the schema and examples/specs/ for working specs.',
      });
    }
    return parsed.data;
  }

  /**
   * Build a new model version from a declarative spec. Each build writes a new
   * spec JSON and .blend (previous versions are kept) and returns scene stats
   * plus a Roblox pre-import report.
   */
  async build(r: {
    collection: string;
    category?: Category;
    spec: unknown;
    references?: { view: ReferenceView; image: string }[];
    note?: string;
  }): Promise<{
    version: number;
    blend: AssetRecord;
    spec: AssetRecord;
    stats: SceneStats;
    validation: ValidationReport;
    warnings: string[];
    durationMs: number;
  }> {
    const spec = this.parseSpec(r.spec);
    const category = r.category ?? 'characters';
    const version = this.ctx.registry.nextVersion(category, r.collection, 'blend');
    const max = this.ctx.config.pipeline.maxModelVersions;
    if (version > max) {
      throw new PixelBridgeError(
        'REFINEMENT_LIMIT',
        `Collection "${r.collection}" already has ${version - 1} model versions (limit ${max}).`,
        {
          hint: 'Stop iterating and show the user the latest renders. They can raise pipeline.maxModelVersions if more refinement is wanted.',
        },
      );
    }
    const parent = this.ctx.registry.latest(category, r.collection, 'blend');
    const refs = (r.references ?? []).map((ref) => ({
      view: ref.view,
      img: resolveImage(ref.image, this.ctx.registry, this.ctx.paths),
    }));

    const dir = this.ctx.registry.dirFor(category, r.collection, 'blend');
    const specFile = this.ctx.registry.writeNewFile(
      dir,
      `${r.collection}-spec-${pad(version)}`,
      'json',
      JSON.stringify(spec, null, 2) + '\n',
    );
    const specAsset = await this.ctx.registry.register(specFile, {
      kind: 'spec',
      category,
      collection: r.collection,
      role: 'model-spec',
      version,
      ...(parent ? { parentId: parent.id } : {}),
      ...(r.note ? { metadata: { note: r.note } } : {}),
    });
    // Reserve a unique .blend filename; Blender overwrites the placeholder.
    const blendFile = this.ctx.registry.writeNewFile(dir, `${r.collection}-${pad(version)}`, 'blend', '');
    const { result, warnings, durationMs } = await cleanupOnError([blendFile], () =>
      this.ctx.blender.run<SceneStats>('build', {
        spec,
        references: refs.map((x) => ({ view: x.view, path: x.img.absPath })),
        outputBlend: blendFile,
      }),
    );
    const blend = await this.ctx.registry.register(blendFile, {
      kind: 'blend',
      category,
      collection: r.collection,
      role: 'model',
      version,
      ...(parent ? { parentId: parent.id } : {}),
      referenceIds: refs.map((x) => x.img.assetId).filter((x): x is string => !!x),
      metadata: {
        specAssetId: specAsset.id,
        triangles: result.totals.triangles,
        meshObjects: result.totals.meshObjects,
        references: refs.map((x) => ({
          view: x.view,
          assetId: x.img.assetId,
          path: this.ctx.paths.relative(x.img.absPath),
        })),
        ...(r.note ? { note: r.note } : {}),
      },
    });
    return {
      version,
      blend,
      spec: specAsset,
      stats: result,
      validation: validateForRoblox(result, this.ctx.config.roblox),
      warnings,
      durationMs,
    };
  }

  private blendAsset(id: string): AssetRecord {
    const a = this.ctx.registry.get(id);
    if (a.kind !== 'blend')
      throw new PixelBridgeError('INVALID_INPUT', `Asset ${id} is a ${a.kind}, not a .blend model.`);
    return a;
  }

  async render(r: {
    blendAssetId: string;
    views?: RenderView[];
    resolution?: number;
    engine?: 'workbench' | 'eevee' | 'cycles';
    transparent?: boolean;
  }): Promise<{ renders: AssetRecord[]; references: AssetRecord[]; durationMs: number; warnings: string[] }> {
    const blend = this.blendAsset(r.blendAssetId);
    const views = r.views ?? ['front', 'side', 'three_quarter'];
    const base = this.ctx.registry.dirFor(blend.category, blend.collection, 'render');
    let sub = pad(blend.version ?? 0);
    for (let i = 2; existsSync(path.join(base, sub)); i++) sub = `${pad(blend.version ?? 0)}-${i}`;
    const outDir = path.join(base, sub);
    const { result, warnings, durationMs } = await this.ctx.blender.run<{
      renders: { view: string; path: string; width: number; height: number }[];
    }>('render', {
      blendPath: this.ctx.registry.absolutePath(blend),
      outDir,
      views,
      resolution: r.resolution ?? 512,
      engine: r.engine ?? 'workbench',
      transparent: r.transparent ?? false,
    });
    const renders: AssetRecord[] = [];
    for (const item of result.renders) {
      const abs = this.ctx.paths.resolve(item.path, 'render output');
      renders.push(
        await this.ctx.registry.register(abs, {
          kind: 'render',
          category: blend.category,
          collection: blend.collection,
          role: `render-${item.view}`,
          ...(blend.version !== null ? { version: blend.version } : {}),
          parentId: blend.id,
          metadata: {
            view: item.view,
            width: item.width,
            height: item.height,
            engine: r.engine ?? 'workbench',
          },
        }),
      );
    }
    const references = blend.referenceIds
      .map((id) => this.ctx.registry.tryGet(id))
      .filter((a): a is AssetRecord => !!a);
    return { renders, references, durationMs, warnings };
  }

  async inspect(target: string): Promise<{ asset: AssetRecord | null; stats: SceneStats }> {
    const { abs, asset } = this.target(target);
    const op = abs.toLowerCase().endsWith('.blend') ? 'inspect' : 'inspect_file';
    const { result } = await this.ctx.blender.run<SceneStats>(
      op,
      op === 'inspect' ? { blendPath: abs } : { path: abs },
    );
    return { asset, stats: result };
  }

  async validate(
    target: string,
    profile: 'roblox' = 'roblox',
  ): Promise<{ asset: AssetRecord | null; stats: SceneStats; report: ValidationReport }> {
    const { asset, stats } = await this.inspect(target);
    if (profile !== 'roblox')
      throw new PixelBridgeError('INVALID_INPUT', `Unknown validation profile ${String(profile)}.`);
    return { asset, stats, report: validateForRoblox(stats, this.ctx.config.roblox) };
  }

  async export(r: { blendAssetId: string; formats?: ExportFormat[]; applyModifiers?: boolean }): Promise<{
    exports: { format: ExportFormat; asset: AssetRecord; stats: SceneStats; validation: ValidationReport }[];
  }> {
    const blend = this.blendAsset(r.blendAssetId);
    const formats = [...new Set<ExportFormat>(r.formats ?? ['glb'])];
    const dir = this.ctx.registry.dirFor(blend.category, blend.collection, 'export');
    const out: {
      format: ExportFormat;
      asset: AssetRecord;
      stats: SceneStats;
      validation: ValidationReport;
    }[] = [];
    for (const format of formats) {
      const file = this.ctx.registry.writeNewFile(
        dir,
        `${blend.collection}-${pad(blend.version ?? 0)}`,
        format,
        '',
      );
      // Export, then re-import the file in a clean scene to verify it is readable.
      const { result: stats } = await cleanupOnError([file], async () => {
        await this.ctx.blender.run('export', {
          blendPath: this.ctx.registry.absolutePath(blend),
          format,
          outPath: file,
          applyModifiers: r.applyModifiers ?? true,
        });
        return this.ctx.blender.run<SceneStats>('inspect_file', { path: file });
      });
      const validation = validateForRoblox(stats, this.ctx.config.roblox);
      const asset = await this.ctx.registry.register(file, {
        kind: 'export',
        category: blend.category,
        collection: blend.collection,
        role: `export-${format}`,
        ...(blend.version !== null ? { version: blend.version } : {}),
        parentId: blend.id,
        metadata: { format, triangles: stats.totals.triangles, robloxOk: validation.ok },
      });
      out.push({ format, asset, stats, validation });
    }
    return { exports: out };
  }

  /**
   * Downscaled PNG copies of images (cached under .pixelbridge/thumbs) so images
   * returned to the agent stay small. PNGs already within maxSize are used as-is.
   */
  async thumbnails(absPaths: string[], maxSize = 512): Promise<string[]> {
    const dir = this.ctx.paths.resolve(path.join('.pixelbridge', 'thumbs'), 'thumbnail directory');
    const out: string[] = [];
    const todo: { src: string; dst: string }[] = [];
    for (const src of absPaths) {
      const data = readFileSync(src);
      const size = pngSize(data);
      if (size && size.width <= maxSize && size.height <= maxSize) {
        out.push(src);
        continue;
      }
      const dst = path.join(dir, `${sha256(data).slice(0, 24)}-${maxSize}.png`);
      if (!existsSync(dst)) todo.push({ src, dst });
      out.push(dst);
    }
    if (todo.length) await this.ctx.blender.run('thumbnail', { items: todo, maxSize });
    return out;
  }

  private target(target: string): { abs: string; asset: AssetRecord | null } {
    if (/^ast_[a-f0-9]{16}$/.test(target)) {
      const asset = this.ctx.registry.get(target);
      return { abs: this.ctx.registry.absolutePath(asset), asset };
    }
    const abs = this.ctx.paths.resolve(target, '3D file path');
    if (!existsSync(abs)) throw new PixelBridgeError('NOT_FOUND', `File not found: ${target}`);
    if (!/\.(blend|glb|gltf|fbx|obj)$/i.test(abs)) {
      throw new PixelBridgeError('INVALID_INPUT', 'Supported 3D files: .blend, .glb, .gltf, .fbx, .obj');
    }
    return { abs, asset: null };
  }
}
