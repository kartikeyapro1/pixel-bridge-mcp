import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { immediate, nowIso, type Database } from './db.js';
import { PixelBridgeError } from './errors.js';
import { sha256File } from './hashing.js';
import { slugify, type ProjectPaths } from './paths.js';

export const ASSET_KINDS = [
  'image',
  'video',
  'model',
  'blend',
  'spec',
  'render',
  'export',
  'thumbnail',
  'other',
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const CATEGORIES = [
  'characters',
  'environments',
  'props',
  'textures',
  'videos',
  'ui',
  'misc',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Subdirectory inside a collection for each asset kind. */
const KIND_DIR: Record<AssetKind, string> = {
  image: 'references',
  video: 'videos',
  model: 'models',
  blend: 'blender',
  spec: 'blender',
  render: 'renders',
  export: 'exports',
  thumbnail: 'renders',
  other: 'misc',
};

export interface AssetRecord {
  id: string;
  projectId: string;
  kind: AssetKind;
  category: Category;
  collection: string;
  role: string | null;
  path: string;
  mime: string | null;
  bytes: number | null;
  sha256: string | null;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  params: Record<string, unknown> | null;
  referenceIds: string[];
  parentId: string | null;
  version: number | null;
  jobId: string | null;
  status: string;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  fingerprint: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface NewAsset {
  kind: AssetKind;
  category: Category;
  collection: string;
  role?: string;
  mime?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  params?: Record<string, unknown>;
  referenceIds?: string[];
  parentId?: string;
  version?: number;
  jobId?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number | null;
  fingerprint?: string;
  metadata?: Record<string, unknown>;
}

interface Row {
  [key: string]: unknown;
}

export class AssetRegistry {
  constructor(
    private readonly db: Database,
    private readonly paths: ProjectPaths,
    private readonly assetsDir: string,
    readonly projectId: string,
  ) {}

  /** Absolute directory for a collection's assets of a given kind. */
  dirFor(category: Category, collection: string, kind: AssetKind, sub?: string): string {
    const rel = path.join(
      this.assetsDir,
      category,
      slugify(collection),
      KIND_DIR[kind],
      ...(sub ? [sub] : []),
    );
    return this.paths.resolve(rel, 'asset directory');
  }

  /**
   * Write bytes to a new, never-overwritten file named `<stem>.<ext>` (or
   * `<stem>-2.<ext>` ...). Uses exclusive create so concurrent writers cannot clobber.
   * The data is written to a temp file and renamed into place to avoid partial files.
   */
  writeNewFile(dir: string, stem: string, ext: string, data: Uint8Array | string): string {
    mkdirSync(dir, { recursive: true });
    const safeStem = slugify(stem);
    const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    for (let i = 1; i < 10_000; i++) {
      const name = i === 1 ? `${safeStem}.${safeExt}` : `${safeStem}-${i}.${safeExt}`;
      const target = path.join(dir, name);
      let fd: number;
      try {
        fd = openSync(target, 'wx');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw e;
      }
      // Placeholder claimed; write real content via temp + rename.
      closeSync(fd);
      const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      const tfd = openSync(tmp, 'w');
      try {
        writeSync(tfd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
      } finally {
        closeSync(tfd);
      }
      renameSync(tmp, target);
      return target;
    }
    throw new PixelBridgeError('INTERNAL', `Could not allocate a filename for ${stem}.${ext} in ${dir}`);
  }

  /** Register a file that already exists inside the project. */
  async register(absPath: string, input: NewAsset): Promise<AssetRecord> {
    const resolved = this.paths.resolve(absPath, 'asset path');
    if (!existsSync(resolved)) throw new PixelBridgeError('NOT_FOUND', `File not found: ${absPath}`);
    const st = statSync(resolved);
    const hash = st.isFile() ? await sha256File(resolved) : null;
    const id = `ast_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const record: AssetRecord = {
      id,
      projectId: this.projectId,
      kind: input.kind,
      category: input.category,
      collection: slugify(input.collection),
      role: input.role ?? null,
      path: this.paths.relative(resolved),
      mime: input.mime ?? guessMime(resolved),
      bytes: st.isFile() ? st.size : null,
      sha256: hash,
      provider: input.provider ?? null,
      model: input.model ?? null,
      prompt: input.prompt ?? null,
      params: input.params ?? null,
      referenceIds: input.referenceIds ?? [],
      parentId: input.parentId ?? null,
      version: input.version ?? null,
      jobId: input.jobId ?? null,
      status: 'ready',
      estimatedCostUsd: input.estimatedCostUsd ?? null,
      actualCostUsd: input.actualCostUsd ?? null,
      fingerprint: input.fingerprint ?? null,
      metadata: input.metadata ?? null,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO assets (id, project_id, kind, category, collection, role, path, mime, bytes, sha256, provider, model,
          prompt, params, reference_ids, parent_id, version, job_id, status, estimated_cost_usd, actual_cost_usd,
          fingerprint, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectId,
        record.kind,
        record.category,
        record.collection,
        record.role,
        record.path,
        record.mime,
        record.bytes,
        record.sha256,
        record.provider,
        record.model,
        record.prompt,
        json(record.params),
        JSON.stringify(record.referenceIds),
        record.parentId,
        record.version,
        record.jobId,
        record.status,
        record.estimatedCostUsd,
        record.actualCostUsd,
        record.fingerprint,
        json(record.metadata),
        record.createdAt,
      );
    this.writeManifest(record.category, record.collection);
    return record;
  }

  get(id: string): AssetRecord {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row | undefined;
    if (!row) {
      throw new PixelBridgeError('NOT_FOUND', `No asset with id "${id}".`, {
        hint: 'Use list_assets to find asset ids.',
      });
    }
    return fromRow(row);
  }

  tryGet(id: string): AssetRecord | null {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  absolutePath(asset: AssetRecord): string {
    return this.paths.resolve(asset.path, 'asset path');
  }

  list(
    filter: { category?: string; collection?: string; kind?: string; limit?: number; offset?: number } = {},
  ): AssetRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.category) {
      where.push('category = ?');
      args.push(filter.category);
    }
    if (filter.collection) {
      where.push('collection = ?');
      args.push(slugify(filter.collection));
    }
    if (filter.kind) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    const sql = `SELECT * FROM assets ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
    args.push(Math.min(filter.limit ?? 50, 500), filter.offset ?? 0);
    return (this.db.prepare(sql).all(...args) as Row[]).map(fromRow);
  }

  /** Next version number for a role within a collection (e.g. model specs). */
  nextVersion(category: Category, collection: string, kind: AssetKind): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM assets WHERE category = ? AND collection = ? AND kind = ?')
      .get(category, slugify(collection), kind) as { v: number | null };
    return (row.v ?? 0) + 1;
  }

  latest(category: Category, collection: string, kind: AssetKind): AssetRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM assets WHERE category = ? AND collection = ? AND kind = ? ORDER BY version DESC, created_at DESC LIMIT 1',
      )
      .get(category, slugify(collection), kind) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  // ---- cache -------------------------------------------------------------

  /** Return cached assets for a fingerprint if every file still exists with the recorded hash. */
  async cacheLookup(fingerprint: string): Promise<AssetRecord[] | null> {
    const row = this.db.prepare('SELECT asset_ids FROM cache WHERE fingerprint = ?').get(fingerprint) as
      { asset_ids: string } | undefined;
    if (!row) return null;
    const ids = JSON.parse(row.asset_ids) as string[];
    const assets: AssetRecord[] = [];
    for (const id of ids) {
      const a = this.tryGet(id);
      if (!a) return this.cacheInvalidate(fingerprint);
      const abs = this.paths.resolve(a.path);
      if (!existsSync(abs) || (a.sha256 && (await sha256File(abs)) !== a.sha256)) {
        return this.cacheInvalidate(fingerprint);
      }
      assets.push(a);
    }
    return assets;
  }

  cacheStore(fingerprint: string, assetIds: string[]): void {
    this.db
      .prepare('INSERT OR REPLACE INTO cache (fingerprint, asset_ids, created_at) VALUES (?, ?, ?)')
      .run(fingerprint, JSON.stringify(assetIds), nowIso());
  }

  cacheInvalidate(fingerprint: string): null {
    this.db.prepare('DELETE FROM cache WHERE fingerprint = ?').run(fingerprint);
    return null;
  }

  cacheClear(): number {
    const r = this.db.prepare('DELETE FROM cache').run();
    return Number(r.changes);
  }

  // ---- manifests ---------------------------------------------------------

  /** Human-readable manifest.json per collection, regenerated from the registry. */
  writeManifest(category: Category, collection: string): void {
    immediate(this.db, () => {
      const rows = (
        this.db
          .prepare(
            'SELECT * FROM assets WHERE category = ? AND collection = ? ORDER BY created_at ASC, rowid ASC',
          )
          .all(category, collection) as Row[]
      ).map(fromRow);
      const dir = this.paths.resolve(path.join(this.assetsDir, category, collection), 'manifest directory');
      mkdirSync(dir, { recursive: true });
      const manifest = {
        schema: 'pixelbridge.manifest/v1',
        projectId: this.projectId,
        category,
        collection,
        updatedAt: nowIso(),
        assets: rows.map((a) => ({
          id: a.id,
          kind: a.kind,
          role: a.role,
          path: path.posix.relative(
            path.posix.join(this.assetsDir.split(path.sep).join('/'), category, collection),
            a.path,
          ),
          sha256: a.sha256,
          bytes: a.bytes,
          provider: a.provider,
          model: a.model,
          prompt: a.prompt,
          version: a.version,
          parentId: a.parentId,
          referenceIds: a.referenceIds,
          estimatedCostUsd: a.estimatedCostUsd,
          actualCostUsd: a.actualCostUsd,
          createdAt: a.createdAt,
        })),
      };
      const target = path.join(dir, 'manifest.json');
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
      renameSync(tmp, target);
    });
  }
}

function json(v: unknown): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

function parse<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function fromRow(r: Row): AssetRecord {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    kind: r.kind as AssetKind,
    category: r.category as Category,
    collection: r.collection as string,
    role: (r.role as string | null) ?? null,
    path: r.path as string,
    mime: (r.mime as string | null) ?? null,
    bytes: (r.bytes as number | null) ?? null,
    sha256: (r.sha256 as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    prompt: (r.prompt as string | null) ?? null,
    params: parse(r.params, null),
    referenceIds: parse(r.reference_ids, [] as string[]),
    parentId: (r.parent_id as string | null) ?? null,
    version: (r.version as number | null) ?? null,
    jobId: (r.job_id as string | null) ?? null,
    status: r.status as string,
    estimatedCostUsd: (r.estimated_cost_usd as number | null) ?? null,
    actualCostUsd: (r.actual_cost_usd as number | null) ?? null,
    fingerprint: (r.fingerprint as string | null) ?? null,
    metadata: parse(r.metadata, null),
    createdAt: r.created_at as string,
  };
}

export function guessMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.glb': 'model/gltf-binary',
      '.gltf': 'model/gltf+json',
      '.fbx': 'application/octet-stream',
      '.obj': 'model/obj',
      '.blend': 'application/x-blender',
      '.json': 'application/json',
    }[ext] ?? 'application/octet-stream'
  );
}
