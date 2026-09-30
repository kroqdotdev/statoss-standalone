import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,
  monitor TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT,
  maintenance INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checks_site_cp_ts ON checks(site, monitor, ts);
CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts);
CREATE TABLE IF NOT EXISTS monitor_state (
  site TEXT NOT NULL,
  monitor TEXT NOT NULL,
  status TEXT NOT NULL,
  consecutive_fails INTEGER NOT NULL,
  consecutive_slow INTEGER NOT NULL DEFAULT 0,
  since INTEGER NOT NULL,
  last_alert_at INTEGER,
  checked_at INTEGER,
  expires_at INTEGER,
  PRIMARY KEY (site, monitor)
);
CREATE TABLE IF NOT EXISTS check_hour (
  site TEXT NOT NULL,
  monitor TEXT NOT NULL,
  ts INTEGER NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  up INTEGER NOT NULL DEFAULT 0,
  timeouts INTEGER NOT NULL DEFAULT 0,
  slow INTEGER NOT NULL DEFAULT 0,
  maintenance INTEGER NOT NULL DEFAULT 0,
  latency_sum INTEGER NOT NULL DEFAULT 0,
  latency_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site, monitor, ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS notified (
  site TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (site, key)
);
CREATE TABLE IF NOT EXISTS heartbeat (
  site TEXT NOT NULL,
  monitor TEXT NOT NULL,
  last_ping_at INTEGER NOT NULL,
  PRIMARY KEY (site, monitor)
);
CREATE TABLE IF NOT EXISTS auto_incident (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,
  monitor TEXT NOT NULL,
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
  ["monitor_state", "consecutive_slow", "INTEGER NOT NULL DEFAULT 0"],
  ["monitor_state", "last_alert_at", "INTEGER"],
  ["monitor_state", "checked_at", "INTEGER"],
  ["monitor_state", "expires_at", "INTEGER"],
];

/**
 * What the first releases called monitors was "checkpoint", in a table
 * name and three columns. A database from then is renamed in place on the
 * next start, before anything else reads it; SQLite's RENAME is instant.
 */
function renameCheckpoints(db: Database.Database): void {
  const tables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((t) => t.name),
  );
  if (tables.has("checkpoint_state") && !tables.has("monitor_state")) {
    db.exec("ALTER TABLE checkpoint_state RENAME TO monitor_state");
    tables.add("monitor_state");
  }
  for (const table of ["checks", "monitor_state", "auto_incident"]) {
    if (!tables.has(table)) continue;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (columns.some((c) => c.name === "checkpoint"))
      db.exec(`ALTER TABLE ${table} RENAME COLUMN checkpoint TO monitor`);
  }
}

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
  monitor: string;
  ts: number;
  ok: 0 | 1;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
  /** 1 when the check ran inside a maintenance window: shown, not counted. */
  maintenance?: 0 | 1;
  /** A successful check over the monitor's slow threshold at the time. */
  slow?: boolean;
}

export interface StateRow {
  site: string;
  monitor: string;
  status: "up" | "slow" | "down";
  consecutiveFails: number;
  consecutiveSlow: number;
  since: number;
  /** When the last alert for the current status went out, for repeats. */
  lastAlertAt: number | null;
  /** When the last check ran, whatever it found. */
  checkedAt?: number | null;
  /** Certificate and domain monitors: the expiry date last read. */
  expiresAt?: number | null;
}

export function openDb(
  path = process.env.DB_PATH ?? "./data/status.db",
): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  renameCheckpoints(db);
  db.exec(SCHEMA);
  migrate(db);
  backfillHours(db);
  return db;
}

const globals = globalThis as { __statusDb?: Database.Database };

export function getDb(): Database.Database {
  globals.__statusDb ??= openDb();
  return globals.__statusDb;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The hourly totals of a database that has checks but no totals yet: one
 * from before 0.3, on its first start. Slow counts start at zero, since the
 * threshold of the time is not known; the strips judge slowness by the
 * hour's mean response time anyway.
 */
function backfillHours(db: Database.Database): void {
  if (db.prepare("SELECT 1 FROM check_hour LIMIT 1").get() !== undefined)
    return;
  if (db.prepare("SELECT 1 FROM checks LIMIT 1").get() === undefined) return;
  db.exec(
    `INSERT INTO check_hour
       (site, monitor, ts, total, up, timeouts, slow, maintenance, latency_sum, latency_n)
     SELECT site, monitor, (ts / ${HOUR_MS}) * ${HOUR_MS},
            SUM(maintenance = 0),
            SUM(ok = 1 AND maintenance = 0),
            SUM(ok = 0 AND maintenance = 0 AND error = 'timeout'),
            0,
            SUM(maintenance = 1),
            COALESCE(SUM(CASE WHEN ok = 1 AND maintenance = 0 THEN latency_ms END), 0),
            SUM(ok = 1 AND maintenance = 0 AND latency_ms IS NOT NULL)
     FROM checks
     GROUP BY site, monitor, (ts / ${HOUR_MS}) * ${HOUR_MS}`,
  );
}

/**
 * Stores one check and adds it to its hour's totals, together. The totals
 * are what the longer views and the error budget read, and they outlive
 * the rows themselves.
 */
export function insertCheck(db: Database.Database, row: CheckRow): void {
  const maintenance = row.maintenance ?? 0;
  const counted = maintenance === 0 ? 1 : 0;
  const passed = counted && row.ok ? 1 : 0;
  const timed = passed && row.latencyMs !== null ? 1 : 0;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO checks (site, monitor, ts, ok, status_code, latency_ms, error, maintenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.site,
      row.monitor,
      row.ts,
      row.ok,
      row.statusCode,
      row.latencyMs,
      row.error,
      maintenance,
    );
    db.prepare(
      `INSERT INTO check_hour
         (site, monitor, ts, total, up, timeouts, slow, maintenance, latency_sum, latency_n)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site, monitor, ts) DO UPDATE SET
         total = total + excluded.total,
         up = up + excluded.up,
         timeouts = timeouts + excluded.timeouts,
         slow = slow + excluded.slow,
         maintenance = maintenance + excluded.maintenance,
         latency_sum = latency_sum + excluded.latency_sum,
         latency_n = latency_n + excluded.latency_n`,
    ).run(
      row.site,
      row.monitor,
      Math.floor(row.ts / HOUR_MS) * HOUR_MS,
      counted,
      passed,
      counted && !row.ok && row.error === "timeout" ? 1 : 0,
      passed && row.slow ? 1 : 0,
      maintenance,
      timed ? (row.latencyMs ?? 0) : 0,
      timed,
    );
  })();
}

export function getState(
  db: Database.Database,
  site: string,
  monitor: string,
): StateRow | undefined {
  return db
    .prepare(
      `SELECT site, monitor, status,
              consecutive_fails AS consecutiveFails,
              consecutive_slow AS consecutiveSlow,
              since,
              last_alert_at AS lastAlertAt,
              checked_at AS checkedAt,
              expires_at AS expiresAt
       FROM monitor_state WHERE site = ? AND monitor = ?`,
    )
    .get(site, monitor) as StateRow | undefined;
}

export function setState(db: Database.Database, state: StateRow): void {
  db.prepare(
    `INSERT INTO monitor_state
       (site, monitor, status, consecutive_fails, consecutive_slow, since, last_alert_at, checked_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site, monitor) DO UPDATE SET
       status = excluded.status,
       consecutive_fails = excluded.consecutive_fails,
       consecutive_slow = excluded.consecutive_slow,
       since = excluded.since,
       last_alert_at = excluded.last_alert_at,
       checked_at = excluded.checked_at,
       expires_at = excluded.expires_at`,
  ).run(
    state.site,
    state.monitor,
    state.status,
    state.consecutiveFails,
    state.consecutiveSlow,
    state.since,
    state.lastAlertAt,
    state.checkedAt ?? null,
    state.expiresAt ?? null,
  );
}

/**
 * Notes that a check ran without touching the state, for checks made
 * inside a maintenance window. Does nothing before the first counted check.
 */
export function touchChecked(
  db: Database.Database,
  site: string,
  monitor: string,
  now: number,
): void {
  db.prepare(
    "UPDATE monitor_state SET checked_at = ? WHERE site = ? AND monitor = ?",
  ).run(now, site, monitor);
}

// ---------------------------------------------------------------------------
// Heartbeats: when each heartbeat monitor was last pinged.

export function recordHeartbeat(
  db: Database.Database,
  site: string,
  monitor: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO heartbeat (site, monitor, last_ping_at) VALUES (?, ?, ?)
     ON CONFLICT(site, monitor) DO UPDATE SET last_ping_at = excluded.last_ping_at`,
  ).run(site, monitor, now);
}

export function lastHeartbeat(
  db: Database.Database,
  site: string,
  monitor: string,
): number | null {
  const row = db
    .prepare(
      "SELECT last_ping_at AS at FROM heartbeat WHERE site = ? AND monitor = ?",
    )
    .get(site, monitor) as { at: number } | undefined;
  return row?.at ?? null;
}

/**
 * The daily tidy. Checks older than `checksBefore` go; their hourly totals,
 * resolved outages and the record of notices stay until `historyBefore`.
 */
export function pruneOldChecks(
  db: Database.Database,
  checksBefore: number,
  historyBefore: number,
): number {
  const checks = db
    .prepare("DELETE FROM checks WHERE ts < ?")
    .run(checksBefore);
  const hours = db
    .prepare("DELETE FROM check_hour WHERE ts < ?")
    .run(historyBefore);
  const incidents = db
    .prepare(
      "DELETE FROM auto_incident WHERE resolved_at IS NOT NULL AND resolved_at < ?",
    )
    .run(historyBefore);
  db.prepare("DELETE FROM notified WHERE at < ?").run(historyBefore);
  return checks.changes + hours.changes + incidents.changes;
}

/** Whether a monitor's most recent counted check passed, or null without one. */
export function lastCheckOk(
  db: Database.Database,
  site: string,
  monitor: string,
): boolean | null {
  const row = db
    .prepare(
      `SELECT ok FROM checks WHERE site = ? AND monitor = ? AND maintenance = 0
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(site, monitor) as { ok: number } | undefined;
  return row === undefined ? null : row.ok === 1;
}

// ---------------------------------------------------------------------------
// Automatic incidents: one row per outage the checker saw.

export interface AutoIncidentRow {
  id: number;
  site: string;
  monitor: string;
  startedAt: number;
  resolvedAt: number | null;
  error: string | null;
}

const AUTO_COLUMNS = `id, site, monitor, started_at AS startedAt, resolved_at AS resolvedAt, error`;

export function openAutoIncident(
  db: Database.Database,
  site: string,
  monitor: string,
  now: number,
  error: string | null,
): AutoIncidentRow | null {
  const open = db
    .prepare(
      `SELECT ${AUTO_COLUMNS} FROM auto_incident
       WHERE site = ? AND monitor = ? AND resolved_at IS NULL`,
    )
    .get(site, monitor) as AutoIncidentRow | undefined;
  if (open) return null;
  const result = db
    .prepare(
      `INSERT INTO auto_incident (site, monitor, started_at, error)
       VALUES (?, ?, ?, ?)`,
    )
    .run(site, monitor, now, error);
  return {
    id: Number(result.lastInsertRowid),
    site,
    monitor,
    startedAt: now,
    resolvedAt: null,
    error,
  };
}

export function resolveAutoIncident(
  db: Database.Database,
  site: string,
  monitor: string,
  now: number,
): AutoIncidentRow | null {
  const open = db
    .prepare(
      `SELECT ${AUTO_COLUMNS} FROM auto_incident
       WHERE site = ? AND monitor = ? AND resolved_at IS NULL`,
    )
    .get(site, monitor) as AutoIncidentRow | undefined;
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

// ---------------------------------------------------------------------------
// Notices: which incident updates and maintenance stages have been sent.

export function wasNotified(
  db: Database.Database,
  site: string,
  key: string,
): boolean {
  return (
    db
      .prepare("SELECT 1 FROM notified WHERE site = ? AND key = ?")
      .get(site, key) !== undefined
  );
}

export function markNotified(
  db: Database.Database,
  site: string,
  key: string,
  now: number,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO notified (site, key, at) VALUES (?, ?, ?)",
  ).run(site, key, now);
}

/** The time of the first failed check since the monitor last passed one. */
export function failingSince(
  db: Database.Database,
  site: string,
  monitor: string,
): number | null {
  const row = db
    .prepare(
      `SELECT MIN(ts) AS ts FROM checks
       WHERE site = ? AND monitor = ? AND ok = 0 AND maintenance = 0
         AND ts > COALESCE(
           (SELECT MAX(ts) FROM checks
            WHERE site = ? AND monitor = ? AND ok = 1 AND maintenance = 0), 0)`,
    )
    .get(site, monitor, site, monitor) as { ts: number | null };
  return row.ts;
}
