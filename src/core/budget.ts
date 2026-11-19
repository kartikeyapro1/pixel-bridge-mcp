import { randomUUID } from 'node:crypto';
import type { PixelBridgeConfig } from './config.js';
import { immediate, nowIso, type Database } from './db.js';
import { PixelBridgeError } from './errors.js';

/**
 * Spend control based on a reservation ledger.
 *
 *  - Before a paid request, `reserve()` atomically checks every limit and inserts
 *    a `reserved` row for the estimated cost. Concurrent processes serialise on
 *    SQLite's write lock, so they cannot both squeeze under the cap.
 *  - On success, `settle()` records the actual cost (or keeps the estimate).
 *  - `release()` is only for failures where the provider certainly did not bill
 *    (e.g. request rejected with 4xx before generation).
 *  - `markUnknown()` is for timeouts / dropped connections: the charge may have
 *    happened, so the estimate keeps counting against the budget.
 *
 * Local limits cannot cap provider-side billing in every failure mode; configure
 * provider-side spend limits as well.
 */

export type LedgerStatus = 'reserved' | 'settled' | 'released' | 'unknown';

export interface CostEstimate {
  provider: string;
  model: string;
  operation: string;
  estimatedUsd: number;
  /** How the number was derived, shown to the agent/human. */
  basis: string;
}

export interface Reservation {
  id: string;
  estimate: CostEstimate;
}

export interface BudgetSummary {
  projectLimitUsd: number;
  committedUsd: number;
  reservedUsd: number;
  unknownUsd: number;
  remainingUsd: number;
  byProvider: Record<string, { committedUsd: number; limitUsd: number | null }>;
  generationsLast24h: number;
  maxGenerationsPerDay: number;
  inFlight: number;
  approvalThresholdUsd: number;
  maxCostPerCallUsd: number;
  note: string;
}

interface Sums {
  settled: number;
  reserved: number;
  unknown: number;
}

export class BudgetLedger {
  constructor(
    private readonly db: Database,
    private readonly cfg: PixelBridgeConfig['budget'],
  ) {}

  /**
   * Enforce the approval threshold and per-call ceiling. Called before reserve()
   * so the agent gets the quote without anything being recorded.
   */
  checkApproval(estimate: CostEstimate, confirmCostUsd: number | undefined): void {
    if (estimate.estimatedUsd > this.cfg.maxCostPerCallUsd) {
      throw new PixelBridgeError(
        'BUDGET_EXCEEDED',
        `Estimated cost $${estimate.estimatedUsd.toFixed(3)} exceeds the per-call ceiling of $${this.cfg.maxCostPerCallUsd.toFixed(2)}.`,
        {
          hint: 'Reduce quality/size/duration, or ask the user to raise budget.maxCostPerCallUsd in pixelbridge.config.json.',
          details: { estimate },
        },
      );
    }
    if (estimate.estimatedUsd > this.cfg.approvalThresholdUsd) {
      if (confirmCostUsd === undefined || confirmCostUsd + 1e-9 < estimate.estimatedUsd) {
        throw new PixelBridgeError(
          'APPROVAL_REQUIRED',
          `This request is estimated at $${estimate.estimatedUsd.toFixed(3)} (${estimate.basis}), above the approval threshold of $${this.cfg.approvalThresholdUsd.toFixed(2)}.`,
          {
            hint: `Show the user this estimate and ask for approval. If they approve, call again with confirmCostUsd: ${Math.ceil(estimate.estimatedUsd * 1000) / 1000}.`,
            details: { estimate },
          },
        );
      }
    }
  }

  reserve(estimate: CostEstimate, note?: string): Reservation {
    return immediate(this.db, () => {
      const ttlCutoff = new Date(Date.now() - this.cfg.reservationTtlMinutes * 60_000).toISOString();
      // Expired reservations become "unknown": we never learned the outcome, so keep counting them.
      this.db
        .prepare(
          `UPDATE ledger SET status='unknown', updated_at=? WHERE status='reserved' AND created_at < ?`,
        )
        .run(nowIso(), ttlCutoff);

      const total = this.sums();
      const spent = total.settled + total.reserved + total.unknown;
      if (spent + estimate.estimatedUsd > this.cfg.projectLimitUsd + 1e-9) {
        throw new PixelBridgeError(
          'BUDGET_EXCEEDED',
          `Project budget would be exceeded: $${spent.toFixed(3)} used or reserved of $${this.cfg.projectLimitUsd.toFixed(2)}; this request needs ~$${estimate.estimatedUsd.toFixed(3)}.`,
          { hint: 'Ask the user to raise budget.projectLimitUsd, or reuse existing assets.' },
        );
      }
      const providerLimit = this.cfg.providerLimitsUsd[estimate.provider];
      if (providerLimit !== undefined) {
        const p = this.sums(estimate.provider);
        const pSpent = p.settled + p.reserved + p.unknown;
        if (pSpent + estimate.estimatedUsd > providerLimit + 1e-9) {
          throw new PixelBridgeError(
            'BUDGET_EXCEEDED',
            `Provider "${estimate.provider}" budget would be exceeded: $${pSpent.toFixed(3)} of $${providerLimit.toFixed(2)}.`,
          );
        }
      }
      const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
      const count = this.db
        .prepare(`SELECT COUNT(*) AS n FROM ledger WHERE status != 'released' AND created_at >= ?`)
        .get(dayAgo) as { n: number };
      if (count.n >= this.cfg.maxGenerationsPerDay) {
        throw new PixelBridgeError(
          'RATE_LIMIT_LOCAL',
          `Daily generation limit reached (${this.cfg.maxGenerationsPerDay} per 24h).`,
        );
      }
      const inFlight = this.db
        .prepare(`SELECT COUNT(*) AS n FROM ledger WHERE status = 'reserved'`)
        .get() as {
        n: number;
      };
      if (inFlight.n >= this.cfg.maxInFlight) {
        throw new PixelBridgeError(
          'CONCURRENCY_LIMIT',
          `${inFlight.n} paid requests are already in flight (limit ${this.cfg.maxInFlight}).`,
          { hint: 'Wait for running requests to finish, then retry.' },
        );
      }
      const id = `led_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO ledger (id, provider, model, operation, status, estimated_usd, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
        )
        .run(
          id,
          estimate.provider,
          estimate.model,
          estimate.operation,
          estimate.estimatedUsd,
          note ?? null,
          ts,
          ts,
        );
      return { id, estimate };
    });
  }

  settle(id: string, actualUsd?: number | null): void {
    this.db
      .prepare(`UPDATE ledger SET status='settled', actual_usd=?, updated_at=? WHERE id=?`)
      .run(actualUsd ?? null, nowIso(), id);
  }

  release(id: string, note?: string): void {
    this.db
      .prepare(
        `UPDATE ledger SET status='released', note=COALESCE(?, note), updated_at=? WHERE id=? AND status IN ('reserved','unknown','settled')`,
      )
      .run(note ?? null, nowIso(), id);
  }

  markUnknown(id: string, note?: string): void {
    this.db
      .prepare(`UPDATE ledger SET status='unknown', note=COALESCE(?, note), updated_at=? WHERE id=?`)
      .run(note ?? null, nowIso(), id);
  }

  /** Long-running jobs keep their reservation "reserved" without counting against maxInFlight forever. */
  convertToCommitted(id: string): void {
    this.db
      .prepare(`UPDATE ledger SET status='settled', updated_at=? WHERE id=? AND status='reserved'`)
      .run(nowIso(), id);
  }

  private sums(provider?: string): Sums {
    const rows = this.db
      .prepare(
        `SELECT status, SUM(COALESCE(actual_usd, estimated_usd)) AS total FROM ledger
         WHERE status != 'released' ${provider ? 'AND provider = ?' : ''} GROUP BY status`,
      )
      .all(...(provider ? [provider] : [])) as { status: LedgerStatus; total: number }[];
    const out: Sums = { settled: 0, reserved: 0, unknown: 0 };
    for (const r of rows) {
      if (r.status === 'settled' || r.status === 'reserved' || r.status === 'unknown')
        out[r.status] = r.total;
    }
    return out;
  }

  summary(): BudgetSummary {
    const s = this.sums();
    const providers = this.db.prepare(`SELECT DISTINCT provider FROM ledger`).all() as { provider: string }[];
    const names = new Set([...providers.map((p) => p.provider), ...Object.keys(this.cfg.providerLimitsUsd)]);
    const byProvider: BudgetSummary['byProvider'] = {};
    for (const name of names) {
      const p = this.sums(name);
      byProvider[name] = {
        committedUsd: round(p.settled + p.reserved + p.unknown),
        limitUsd: this.cfg.providerLimitsUsd[name] ?? null,
      };
    }
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const gens = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ledger WHERE status != 'released' AND created_at >= ?`)
      .get(dayAgo) as { n: number };
    const inFlight = this.db.prepare(`SELECT COUNT(*) AS n FROM ledger WHERE status='reserved'`).get() as {
      n: number;
    };
    const used = s.settled + s.reserved + s.unknown;
    return {
      projectLimitUsd: this.cfg.projectLimitUsd,
      committedUsd: round(s.settled),
      reservedUsd: round(s.reserved),
      unknownUsd: round(s.unknown),
      remainingUsd: round(Math.max(0, this.cfg.projectLimitUsd - used)),
      byProvider,
      generationsLast24h: gens.n,
      maxGenerationsPerDay: this.cfg.maxGenerationsPerDay,
      inFlight: inFlight.n,
      approvalThresholdUsd: this.cfg.approvalThresholdUsd,
      maxCostPerCallUsd: this.cfg.maxCostPerCallUsd,
      note: 'Figures are local estimates (actual cost where the provider reports usage). Check your provider dashboard for billed amounts.',
    };
  }

  recent(limit = 20): unknown[] {
    return this.db
      .prepare(
        `SELECT id, provider, model, operation, status, estimated_usd, actual_usd, note, created_at FROM ledger ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit);
  }
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
