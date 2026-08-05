import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_site_cp_ts ON checks(site, checkpoint, ts);
CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts);
CREATE TABLE IF NOT EXISTS checkpoint_state (
  site TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  status TEXT NOT NULL,
  consecutive_fails INTEGER NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (site, checkpoint)
);
`;

export interface CheckRow {
  site: string;
  checkpoint: string;
  ts: number;
  ok: 0 | 1;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface StateRow {
  site: string;
  checkpoint: string;
  status: "up" | "down";
  consecutiveFails: number;
  since: number;
}

export function openDb(
  path = process.env.DB_PATH ?? "./data/status.db",
): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

const globals = globalThis as { __statusDb?: Database.Database };

export function getDb(): Database.Database {
  globals.__statusDb ??= openDb();
  return globals.__statusDb;
}

export function insertCheck(db: Database.Database, row: CheckRow): void {
  db.prepare(
    `INSERT INTO checks (site, checkpoint, ts, ok, status_code, latency_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.site,
    row.checkpoint,
    row.ts,
    row.ok,
    row.statusCode,
    row.latencyMs,
    row.error,
  );
}

export function getState(
  db: Database.Database,
  site: string,
  checkpoint: string,
): StateRow | undefined {
  return db
    .prepare(
      `SELECT site, checkpoint, status, consecutive_fails AS consecutiveFails, since
       FROM checkpoint_state WHERE site = ? AND checkpoint = ?`,
    )
    .get(site, checkpoint) as StateRow | undefined;
}

export function setState(db: Database.Database, state: StateRow): void {
  db.prepare(
    `INSERT INTO checkpoint_state (site, checkpoint, status, consecutive_fails, since)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(site, checkpoint) DO UPDATE SET
       status = excluded.status,
       consecutive_fails = excluded.consecutive_fails,
       since = excluded.since`,
  ).run(
    state.site,
    state.checkpoint,
    state.status,
    state.consecutiveFails,
    state.since,
  );
}

export function pruneOldChecks(db: Database.Database, before: number): number {
  return db.prepare("DELETE FROM checks WHERE ts < ?").run(before).changes;
}
