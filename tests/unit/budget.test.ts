import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetLedger, type CostEstimate } from '../../src/core/budget.js';
import { parseConfig } from '../../src/core/config.js';
import { openDatabase, type Database } from '../../src/core/db.js';
import { cleanup, tempDir } from '../helpers.js';

const est = (usd: number, provider = 'openai'): CostEstimate => ({
  provider,
  model: 'm',
  operation: 'image.generate',
  estimatedUsd: usd,
  basis: 'test',
});

describe('BudgetLedger', () => {
  let db: Database;
  let dir: string;
  const ledger = (budget: Record<string, unknown> = {}) => {
    dir = tempDir();
    db = openDatabase(path.join(dir, 'b.db'));
    return new BudgetLedger(db, parseConfig({ budget }).budget);
  };
  afterEach(() => {
    db?.close();
    if (dir) cleanup(dir);
  });

  it('reserves, settles with actual cost, and enforces the project cap', () => {
    const b = ledger({ projectLimitUsd: 1 });
    const r = b.reserve(est(0.6));
    b.settle(r.id, 0.5);
    expect(b.summary().committedUsd).toBe(0.5);
    expect(() => b.reserve(est(0.6))).toThrow(/budget would be exceeded/);
    b.reserve(est(0.5)); // exactly reaches the cap
    expect(b.summary().remainingUsd).toBe(0);
  });

  it('counts reserved and unknown outcomes; only release frees budget', () => {
    const b = ledger({ projectLimitUsd: 1, maxInFlight: 10 });
    const a = b.reserve(est(0.4));
    const c = b.reserve(est(0.4));
    b.markUnknown(c.id, 'timeout');
    expect(() => b.reserve(est(0.4))).toThrow(/BUDGET|exceeded/);
    b.release(a.id, 'rejected');
    expect(() => b.reserve(est(0.4))).not.toThrow();
    const s = b.summary();
    expect(s.unknownUsd).toBe(0.4);
  });

  it('enforces per-provider limits', () => {
    const b = ledger({ projectLimitUsd: 10, providerLimitsUsd: { fal: 0.5 } });
    b.settle(b.reserve(est(0.4, 'fal')).id);
    expect(() => b.reserve(est(0.2, 'fal'))).toThrow(/Provider "fal"/);
    expect(() => b.reserve(est(0.2, 'openai'))).not.toThrow();
  });

  it('requires explicit confirmation above the approval threshold and caps per call', () => {
    const b = ledger({ approvalThresholdUsd: 0.1, maxCostPerCallUsd: 1 });
    expect(() => b.checkApproval(est(0.05), undefined)).not.toThrow();
    expect(() => b.checkApproval(est(0.2), undefined)).toThrow(/approval threshold/);
    expect(() => b.checkApproval(est(0.2), 0.1)).toThrow(/approval threshold/);
    expect(() => b.checkApproval(est(0.2), 0.2)).not.toThrow();
    expect(() => b.checkApproval(est(1.5), 99)).toThrow(/per-call ceiling/);
  });

  it('limits in-flight requests and daily generation count', () => {
    const b = ledger({ maxInFlight: 2, maxGenerationsPerDay: 3, projectLimitUsd: 10 });
    const r1 = b.reserve(est(0.01));
    const r2 = b.reserve(est(0.01));
    expect(() => b.reserve(est(0.01))).toThrow(/in flight/);
    b.settle(r1.id);
    b.settle(r2.id);
    b.settle(b.reserve(est(0.01)).id);
    expect(() => b.reserve(est(0.01))).toThrow(/Daily generation limit/);
  });
});

describe('BudgetLedger across processes', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distBudget = path.resolve(here, '../../dist/core/budget.js');
  const worker = path.resolve(here, '../fixtures/budget-worker.mjs');

  it.skipIf(!existsSync(distBudget))(
    'never lets concurrent processes exceed the cap (requires `npm run build`)',
    async () => {
      const dir = tempDir();
      const dbFile = path.join(dir, 'race.db');
      openDatabase(dbFile).close(); // run migrations once
      const procs = 8;
      const attemptsEach = 10;
      const runs = Array.from(
        { length: procs },
        () =>
          new Promise<{ ok: number; denied: number }>((resolve, reject) => {
            const child = spawn(process.execPath, [worker, distBudget, dbFile, String(attemptsEach)], {
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            let err = '';
            child.stdout.on('data', (d: Buffer) => (out += d));
            child.stderr.on('data', (d: Buffer) => (err += d));
            child.on('exit', (code) =>
              code === 0
                ? resolve(JSON.parse(out) as { ok: number; denied: number })
                : reject(new Error(err)),
            );
          }),
      );
      const results = await Promise.all(runs);
      const granted = results.reduce((s, r) => s + r.ok, 0);
      // limit $1.00, each reservation $0.03 → at most 33 can ever be granted
      expect(granted).toBe(33);
      const db = openDatabase(dbFile);
      const total = (
        db.prepare(`SELECT SUM(estimated_usd) AS t FROM ledger WHERE status != 'released'`).get() as {
          t: number;
        }
      ).t;
      db.close();
      expect(total).toBeLessThanOrEqual(1 + 1e-9);
      cleanup(dir);
    },
    60_000,
  );
});
