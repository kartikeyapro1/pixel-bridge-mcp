import { randomUUID } from 'node:crypto';
import type { CostEstimate } from '../core/budget.js';
import { immediate, nowIso } from '../core/db.js';
import { PixelBridgeError, toPixelBridgeError } from '../core/errors.js';
import { requestFingerprint } from '../core/hashing.js';
import type { AssetRecord, Category } from '../core/registry.js';
import type { JobKind, JobProvider, ProviderJobState } from '../providers/types.js';
import type { AppContext } from './context.js';
import { resolveImage } from './inputs.js';

/**
 * Asynchronous generation jobs (video, image-to-3D). Job state — including the
 * provider URLs needed to resume — is persisted in SQLite, so restarting the MCP
 * server does not lose track of submitted (and paid-for) work.
 */

export type JobStatus =
  'submitted' | 'queued' | 'running' | 'completed' | 'downloaded' | 'failed' | 'cancelled';
const TERMINAL: JobStatus[] = ['downloaded', 'failed', 'cancelled'];

export interface JobRecord {
  id: string;
  kind: JobKind;
  provider: string;
  model: string;
  remoteId: string | null;
  status: JobStatus;
  category: string;
  collection: string;
  prompt: string | null;
  params: Record<string, unknown> | null;
  referenceIds: string[];
  estimatedCostUsd: number | null;
  ledgerId: string | null;
  error: string | null;
  resultAssetIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SubmitJobRequest {
  kind: JobKind;
  collection: string;
  category?: Category;
  prompt?: string;
  /** Asset ids or project paths: reference / start-frame images (video) or the source image (3D). */
  images?: string[];
  durationSeconds?: number;
  provider?: string;
  model?: string;
  resolution?: string;
  aspectRatio?: string;
  bypassCache?: boolean;
  dryRun?: boolean;
  confirmCostUsd?: number;
}

export class JobService {
  constructor(private readonly ctx: AppContext) {}

  async submit(r: SubmitJobRequest): Promise<{
    status: 'submitted' | 'cached' | 'dry_run';
    estimate: CostEstimate;
    job?: JobRecord;
    assets?: AssetRecord[];
  }> {
    if (r.kind === 'video' && !r.prompt)
      throw new PixelBridgeError('INVALID_INPUT', 'Video generation needs a prompt.');
    const provider = this.ctx.jobProvider(r.kind, r.provider, r.model);
    const model = r.model ?? this.ctx.defaultJobModel(r.kind, provider);
    const images = (r.images ?? []).map((ref) => resolveImage(ref, this.ctx.registry, this.ctx.paths));
    const params = {
      kind: r.kind,
      model,
      ...(r.prompt !== undefined ? { prompt: r.prompt } : {}),
      ...(images.length ? { images } : {}),
      ...(r.durationSeconds !== undefined ? { durationSeconds: r.durationSeconds } : {}),
      ...(r.resolution ? { resolution: r.resolution } : {}),
      ...(r.aspectRatio ? { aspectRatio: r.aspectRatio } : {}),
    };
    provider.validate(params);
    const estimate = provider.estimate(params);
    const fingerprint = requestFingerprint({
      provider: provider.id,
      model,
      operation: `${r.kind}.generate`,
      params: {
        prompt: r.prompt,
        durationSeconds: r.durationSeconds,
        resolution: r.resolution,
        aspectRatio: r.aspectRatio,
      },
      referenceHashes: images.map((i) => i.sha256),
    });

    if (!r.bypassCache) {
      const cached = await this.ctx.registry.cacheLookup(fingerprint);
      if (cached) return { status: 'cached', estimate, assets: cached };
    }
    if (r.dryRun) return { status: 'dry_run', estimate };

    this.ctx.budget.checkApproval(estimate, r.confirmCostUsd);
    const active = this.ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('submitted','queued','running')`)
      .get() as { n: number };
    if (active.n >= this.ctx.config.budget.maxInFlight) {
      throw new PixelBridgeError('CONCURRENCY_LIMIT', `${active.n} generation jobs are already running.`, {
        hint: 'Wait for a job to finish (get_job) or cancel one (cancel_job).',
      });
    }

    const reservation = this.ctx.budget.reserve(estimate, `${r.kind} ${r.collection}`);
    let submitted: { remoteId: string; state: ProviderJobState };
    try {
      submitted = await provider.submit(params);
    } catch (e) {
      const err = toPixelBridgeError(e);
      if (err.details?.billed === false)
        this.ctx.budget.release(reservation.id, `submit failed: ${err.code}`);
      else this.ctx.budget.markUnknown(reservation.id, `submit outcome unknown: ${err.code}`);
      throw err;
    }
    // Accepted by the provider: count it as committed spend (not "in flight") until settled.
    this.ctx.budget.convertToCommitted(reservation.id);

    const id = `job_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const ts = nowIso();
    this.ctx.db
      .prepare(
        `INSERT INTO jobs (id, kind, provider, model, remote_id, status, category, collection, prompt, params,
          reference_ids, provider_state, ledger_id, estimated_cost_usd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.kind,
        provider.id,
        model,
        submitted.remoteId,
        r.category ?? (r.kind === 'video' ? 'videos' : 'characters'),
        r.collection,
        r.prompt ?? null,
        JSON.stringify({
          durationSeconds: r.durationSeconds,
          resolution: r.resolution,
          aspectRatio: r.aspectRatio,
          fingerprint,
        }),
        JSON.stringify(images.map((i) => i.assetId).filter((x): x is string => !!x)),
        JSON.stringify(submitted.state),
        reservation.id,
        estimate.estimatedUsd,
        ts,
        ts,
      );
    return { status: 'submitted', estimate, job: this.get(id) };
  }

  get(id: string): JobRecord {
    const row = this.ctx.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new PixelBridgeError('NOT_FOUND', `No job with id "${id}".`, { hint: 'Use list_jobs.' });
    return fromRow(row);
  }

  list(filter: { status?: string; kind?: string; limit?: number } = {}): JobRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter.kind) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    args.push(Math.min(filter.limit ?? 20, 200));
    return (
      this.ctx.db
        .prepare(
          `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...args) as Record<string, unknown>[]
    ).map(fromRow);
  }

  /**
   * Poll the provider and, once complete, download outputs into the project.
   * Safe to call repeatedly; a failed download is retried on the next call.
   */
  async refresh(
    id: string,
    opts: { download?: boolean } = {},
  ): Promise<{ job: JobRecord; assets: AssetRecord[] }> {
    let job = this.get(id);
    if (TERMINAL.includes(job.status)) {
      return {
        job,
        assets: job.resultAssetIds
          .map((a) => this.ctx.registry.tryGet(a))
          .filter((a): a is AssetRecord => !!a),
      };
    }
    const provider = this.providerFor(job);
    const state = this.state(job.id);

    if (job.status !== 'completed') {
      const remote = await provider.poll(state);
      if (remote.status === 'failed') {
        this.update(job.id, { status: 'failed', error: remote.error });
        if (job.ledgerId) this.ctx.budget.markUnknown(job.ledgerId, `job failed: ${remote.error}`);
        return { job: this.get(job.id), assets: [] };
      }
      const next: JobStatus =
        remote.status === 'queued' ? 'queued' : remote.status === 'running' ? 'running' : 'completed';
      this.update(job.id, { status: next });
      job = this.get(job.id);
      if (next !== 'completed') return { job, assets: [] };
    }
    if (opts.download === false) return { job, assets: [] };

    try {
      const { files, actualCostUsd } = await provider.outputs(state, job.kind);
      const category = job.category as Category;
      const assets: AssetRecord[] = [];
      for (const [i, f] of files.entries()) {
        const data = await provider.download(f.url, this.ctx.config.maxDownloadBytes);
        const isPrimary =
          job.kind === 'video'
            ? ['mp4', 'webm', 'mov'].includes(f.ext)
            : !['png', 'jpg', 'jpeg', 'webp'].includes(f.ext);
        const kind = isPrimary ? (job.kind === 'video' ? 'video' : 'model') : 'thumbnail';
        const dir = this.ctx.registry.dirFor(category, job.collection, kind);
        const file = this.ctx.registry.writeNewFile(
          dir,
          `${job.collection}-${job.kind}${i ? `-${i}` : ''}`,
          f.ext,
          data,
        );
        assets.push(
          await this.ctx.registry.register(file, {
            kind,
            category,
            collection: job.collection,
            role: f.role,
            provider: job.provider,
            model: job.model,
            ...(job.prompt ? { prompt: job.prompt } : {}),
            params: job.params ?? {},
            referenceIds: job.referenceIds,
            jobId: job.id,
            ...(isPrimary && job.estimatedCostUsd !== null ? { estimatedCostUsd: job.estimatedCostUsd } : {}),
            actualCostUsd: isPrimary ? actualCostUsd : null,
            ...(job.provider === 'mock' ? { metadata: { mock: true } } : {}),
          }),
        );
      }
      immediate(this.ctx.db, () => {
        this.ctx.db
          .prepare(
            `UPDATE jobs SET status='downloaded', result_asset_ids=?, error=NULL, updated_at=? WHERE id=?`,
          )
          .run(JSON.stringify(assets.map((a) => a.id)), nowIso(), job.id);
      });
      if (job.ledgerId) this.ctx.budget.settle(job.ledgerId, actualCostUsd);
      const fp = job.params?.fingerprint;
      if (typeof fp === 'string')
        this.ctx.registry.cacheStore(
          fp,
          assets.filter((a) => a.kind !== 'thumbnail').map((a) => a.id),
        );
      return { job: this.get(job.id), assets };
    } catch (e) {
      const err = toPixelBridgeError(e);
      this.update(job.id, { status: 'completed', error: `download failed: ${err.message}` });
      throw new PixelBridgeError(
        'DOWNLOAD_FAILED',
        `Job ${job.id} completed but its outputs could not be downloaded: ${err.message}`,
        {
          hint: 'Call get_job again to retry the download. Provider results may expire, so retry soon.',
        },
      );
    }
  }

  async cancel(id: string): Promise<{ job: JobRecord; outcome: string }> {
    const job = this.get(id);
    if (TERMINAL.includes(job.status) || job.status === 'completed') {
      return { job, outcome: 'already_finished' };
    }
    const outcome = await this.providerFor(job).cancel(this.state(job.id));
    if (outcome === 'cancelled') {
      this.update(job.id, { status: 'cancelled' });
      // Removed from the queue before running: not billed.
      if (job.ledgerId) this.ctx.budget.release(job.ledgerId, 'cancelled before start');
    } else if (outcome === 'requested') {
      this.update(job.id, {
        error: 'cancellation requested while running; it may still complete and be billed',
      });
    }
    return { job: this.get(job.id), outcome };
  }

  private providerFor(job: JobRecord): JobProvider {
    const p = this.ctx.jobProviders.get(job.provider);
    if (!p) {
      throw new PixelBridgeError(
        'PROVIDER_NOT_CONFIGURED',
        `Job ${job.id} used provider "${job.provider}", which is not configured now.`,
      );
    }
    return p;
  }

  private state(id: string): ProviderJobState {
    const row = this.ctx.db.prepare('SELECT provider_state FROM jobs WHERE id = ?').get(id) as {
      provider_state: string;
    };
    return JSON.parse(row.provider_state) as ProviderJobState;
  }

  private update(id: string, fields: { status?: JobStatus; error?: string | null }): void {
    const sets: string[] = ['updated_at = ?'];
    const args: (string | null)[] = [nowIso()];
    if (fields.status) {
      sets.push('status = ?');
      args.push(fields.status);
    }
    if (fields.error !== undefined) {
      sets.push('error = ?');
      args.push(fields.error);
    }
    args.push(id);
    this.ctx.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }
}

function fromRow(r: Record<string, unknown>): JobRecord {
  const parse = <T>(v: unknown, d: T): T => (typeof v === 'string' ? (JSON.parse(v) as T) : d);
  return {
    id: r.id as string,
    kind: r.kind as JobKind,
    provider: r.provider as string,
    model: r.model as string,
    remoteId: (r.remote_id as string | null) ?? null,
    status: r.status as JobStatus,
    category: r.category as string,
    collection: r.collection as string,
    prompt: (r.prompt as string | null) ?? null,
    params: parse(r.params, null),
    referenceIds: parse(r.reference_ids, [] as string[]),
    estimatedCostUsd: (r.estimated_cost_usd as number | null) ?? null,
    ledgerId: (r.ledger_id as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    resultAssetIds: parse(r.result_asset_ids, [] as string[]),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
