// Child process for the cross-process budget race test.
// usage: node budget-worker.mjs <dist/core/budget.js> <db file> <attempts>
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [budgetModule, dbFile, attempts] = process.argv.slice(2);
const { BudgetLedger } = await import(pathToFileURL(budgetModule).href);
const { openDatabase } = await import(pathToFileURL(path.join(path.dirname(budgetModule), 'db.js')).href);

const db = openDatabase(dbFile);
const ledger = new BudgetLedger(db, {
  projectLimitUsd: 1,
  providerLimitsUsd: {},
  approvalThresholdUsd: 100,
  maxCostPerCallUsd: 100,
  maxGenerationsPerDay: 100000,
  maxInFlight: 1000,
  reservationTtlMinutes: 30,
});
let ok = 0;
let denied = 0;
for (let i = 0; i < Number(attempts); i++) {
  try {
    const r = ledger.reserve({
      provider: 'openai',
      model: 'm',
      operation: 'race',
      estimatedUsd: 0.03,
      basis: 'race',
    });
    ledger.settle(r.id);
    ok++;
  } catch (e) {
    if (e?.code === 'BUDGET_EXCEEDED') denied++;
    else throw e;
  }
}
db.close();
process.stdout.write(JSON.stringify({ ok, denied }));
