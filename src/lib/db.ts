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
  error TEXT,
  maintenance INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checks_site_cp_ts ON checks(site, checkpoint, ts);
CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts);
CREATE TABLE IF NOT EXISTS checkpoint_state (
  site TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  status TEXT NOT NULL,
  consecutive_fails INTEGER NOT NULL,
  consecutive_slow INTEGER NOT NULL DEFAULT 0,
  since INTEGER NOT NULL,
  last_alert_at INTEGER,
  PRIMARY KEY (site, checkpoint)
);
CREATE TABLE IF NOT EXISTS auto_incident (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_auto_incident_site ON auto_incident(site, started_at);
`;

/**
 * Columns added after the first release. A database from an older version
 * gets them on the next start; SQLite's ADD COLUMN is instant.
 */
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ["checks", "maintenance", "INTEGER NOT NULL DEFAULT 0"],
  ["checkpoint_state", "consecutive_slow", "INTEGER NOT NULL DEFAULT 0"],
  ["checkpoint_state", "last_alert_at", "INTEGER"],
];

function migrate(db: Database.Database): void {
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((c) => c.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export interface CheckRow {
  site: string;
  checkpoint: string;
  ts: number;
  ok: 0 | 1;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
  /** 1 when the check ran inside a maintenance window: shown, not counted. */
  maintenance?: 0 | 1;
}

export interface StateRow {
  site: string;
  checkpoint: string;
  status: "up" | "slow" | "down";
  consecutiveFails: number;
  consecutiveSlow: number;
  since: number;
  /** When the last alert for the current status went out, for repeats. */
  lastAlertAt: number | null;
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
  migrate(db);
  return db;
}

const globals = globalThis as { __statusDb?: Database.Database };

export function getDb(): Database.Database {
  globals.__statusDb ??= openDb();
  return globals.__statusDb;
}

export function insertCheck(db: Database.Database, row: CheckRow): void {
  db.prepare(
    `INSERT INTO checks (site, checkpoint, ts, ok, status_code, latency_ms, error, maintenance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.site,
    row.checkpoint,
    row.ts,
    row.ok,
    row.statusCode,
    row.latencyMs,
    row.error,
    row.maintenance ?? 0,
  );
}

export function getState(
  db: Database.Database,
  site: string,
  checkpoint: string,
): StateRow | undefined {
  return db
    .prepare(
      `SELECT site, checkpoint, status,
              consecutive_fails AS consecutiveFails,
              consecutive_slow AS consecutiveSlow,
              since,
              last_alert_at AS lastAlertAt
       FROM checkpoint_state WHERE site = ? AND checkpoint = ?`,
    )
    .get(site, checkpoint) as StateRow | undefined;
}

export function setState(db: Database.Database, state: StateRow): void {
  db.prepare(
    `INSERT INTO checkpoint_state
       (site, checkpoint, status, consecutive_fails, consecutive_slow, since, last_alert_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site, checkpoint) DO UPDATE SET
       status = excluded.status,
       consecutive_fails = excluded.consecutive_fails,
       consecutive_slow = excluded.consecutive_slow,
       since = excluded.since,
       last_alert_at = excluded.last_alert_at`,
  ).run(
    state.site,
    state.checkpoint,
    state.status,
    state.consecutiveFails,
    state.consecutiveSlow,
    state.since,
    state.lastAlertAt,
  );
}

export function pruneOldChecks(db: Database.Database, before: number): number {
  const checks = db.prepare("DELETE FROM checks WHERE ts < ?").run(before);
  const incidents = db
    .prepare(
      "DELETE FROM auto_incident WHERE resolved_at IS NOT NULL AND resolved_at < ?",
    )
    .run(before);
  return checks.changes + incidents.changes;
}

// ---------------------------------------------------------------------------
// Automatic incidents: one row per outage the checker saw.

export interface AutoIncidentRow {
  id: number;
  site: string;
  checkpoint: string;
  startedAt: number;
  resolvedAt: number | null;
  error: string | null;
}

const AUTO_COLUMNS = `id, site, checkpoint, started_at AS startedAt, resolved_at AS resolvedAt, error`;

export function openAutoIncident(
  db: Database.Database,
  site: string,
  checkpoint: string,
  now: number,
  error: string | null,
): AutoIncidentRow | null {
  const open = db
    .prepare(
      `SELECT ${AUTO_COLUMNS} FROM auto_incident
       WHERE site = ? AND checkpoint = ? AND resolved_at IS NULL`,
    )
    .get(site, checkpoint) as AutoIncidentRow | undefined;
  if (open) return null;
  const result = db
    .prepare(
      `INSERT INTO auto_incident (site, checkpoint, started_at, error)
       VALUES (?, ?, ?, ?)`,
    )
    .run(site, checkpoint, now, error);
  return {
    id: Number(result.lastInsertRowid),
    site,
    checkpoint,
    startedAt: now,
    resolvedAt: null,
    error,
  };
}

export function resolveAutoIncident(
  db: Database.Database,
  site: string,
  checkpoint: string,
  now: number,
): AutoIncidentRow | null {
  const open = db
    .prepare(
      `SELECT ${AUTO_COLUMNS} FROM auto_incident
       WHERE site = ? AND checkpoint = ? AND resolved_at IS NULL`,
    )
    .get(site, checkpoint) as AutoIncidentRow | undefined;
  if (!open) return null;
  db.prepare("UPDATE auto_incident SET resolved_at = ? WHERE id = ?").run(
    now,
    open.id,
  );
  return { ...open, resolvedAt: now };
}

/** Outages on a site that are open or started after `since`, newest first. */
export function autoIncidents(
  db: Database.Database,
  site: string,
  since: number,
): AutoIncidentRow[] {
  return db
    .prepare(
      `SELECT ${AUTO_COLUMNS} FROM auto_incident
       WHERE site = ? AND (resolved_at IS NULL OR started_at > ?)
       ORDER BY started_at DESC`,
    )
    .all(site, since) as AutoIncidentRow[];
}
