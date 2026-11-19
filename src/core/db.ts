import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import type * as Sqlite from 'node:sqlite';

/**
 * Project-local state (asset registry, budget ledger, request cache, jobs) lives in
 * one SQLite file under `.pixelbridge/`. SQLite gives us cross-process locking, which
 * is what stops two concurrent agents from both passing a budget check.
 */

export type Database = DatabaseSyncType;

const require = createRequire(import.meta.url);

function loadSqlite(): typeof Sqlite {
  // node:sqlite prints an ExperimentalWarning on first load in some Node versions.
  // It goes to stderr (safe for stdio MCP) but is noise; suppress that one warning only.
  const originalEmit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(msg)) return;
    return (originalEmit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require('node:sqlite') as typeof Sqlite;
  } finally {
    process.emitWarning = originalEmit;
  }
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    category TEXT NOT NULL,
    collection TEXT NOT NULL,
    role TEXT,
    path TEXT NOT NULL,
    mime TEXT,
    bytes INTEGER,
    sha256 TEXT,
    provider TEXT,
    model TEXT,
    prompt TEXT,
    params TEXT,
    reference_ids TEXT,
    parent_id TEXT,
    version INTEGER,
    job_id TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    fingerprint TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX assets_collection ON assets(category, collection);
  CREATE INDEX assets_fingerprint ON assets(fingerprint);

  CREATE TABLE ledger (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT,
    operation TEXT NOT NULL,
    status TEXT NOT NULL,           -- reserved | settled | released | unknown
    estimated_usd REAL NOT NULL,
    actual_usd REAL,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX ledger_status ON ledger(status);

  CREATE TABLE cache (
    fingerprint TEXT PRIMARY KEY,
    asset_ids TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,             -- video | 3d
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    remote_id TEXT,
    status TEXT NOT NULL,           -- submitted | queued | running | completed | downloaded | failed | cancelled
    category TEXT NOT NULL,
    collection TEXT NOT NULL,
    prompt TEXT,
    params TEXT,
    reference_ids TEXT,
    provider_state TEXT,            -- URLs etc. needed to resume after restart (no credentials)
    ledger_id TEXT,
    estimated_cost_usd REAL,
    error TEXT,
    result_asset_ids TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX jobs_status ON jobs(status);
  `,
];

export function openDatabase(file: string): Database {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    immediate(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
    });
    version++;
  }
}

/**
 * Run `fn` inside BEGIN IMMEDIATE, which takes the write lock up front so a
 * read-check-write sequence cannot interleave with another process.
 */
export function immediate<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
