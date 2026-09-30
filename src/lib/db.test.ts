import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  autoIncidents,
  getState,
  insertCheck,
  listDeploys,
  recordDeploy,
  openAutoIncident,
  openDb,
  pruneOldChecks,
  resolveAutoIncident,
  setState,
  type StateRow,
} from "./db";

function memDb() {
  return openDb(":memory:");
}

describe("checks", () => {
  it("inserts and stores check rows", () => {
    const db = memDb();
    insertCheck(db, {
      site: "webhooks.cc",
      monitor: "Main site",
      ts: 1000,
      ok: 1,
      statusCode: 200,
      latencyMs: 123,
      error: null,
    });
    insertCheck(db, {
      site: "webhooks.cc",
      monitor: "Main site",
      ts: 2000,
      ok: 0,
      statusCode: null,
      latencyMs: 10000,
      error: "timeout",
      maintenance: 1,
    });
    const rows = db.prepare("SELECT * FROM checks ORDER BY ts").all() as Array<{
      ok: number;
      status_code: number | null;
      error: string | null;
      maintenance: number;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].ok).toBe(1);
    expect(rows[0].status_code).toBe(200);
    expect(rows[0].maintenance).toBe(0);
    expect(rows[1].ok).toBe(0);
    expect(rows[1].error).toBe("timeout");
    expect(rows[1].maintenance).toBe(1);
  });

  it("prunes only rows older than the cutoff", () => {
    const db = memDb();
    for (const ts of [100, 200, 300]) {
      insertCheck(db, {
        site: "s",
        monitor: "c",
        ts,
        ok: 1,
        statusCode: 200,
        latencyMs: 1,
        error: null,
      });
    }
    const deleted = pruneOldChecks(db, 250, 0);
    expect(deleted).toBe(2);
    // The hour's totals outlive the rows they were counted from.
    expect(
      db.prepare("SELECT total, up, latency_sum AS sum FROM check_hour").all(),
    ).toEqual([{ total: 3, up: 3, sum: 3 }]);
    expect(pruneOldChecks(db, 250, 1)).toBe(1);
    const remaining = db.prepare("SELECT ts FROM checks").all() as Array<{
      ts: number;
    }>;
    expect(remaining.map((r) => r.ts)).toEqual([300]);
  });
});

describe("migration", () => {
  it("renames and adds to a database from the first release", () => {
    const dir = mkdtempSync(join(tmpdir(), "statoss-"));
    const path = join(dir, "old.db");
    const old = new Database(path);
    // The first release called monitors checkpoints.
    old.exec(`
      CREATE TABLE checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL,
        checkpoint TEXT NOT NULL, ts INTEGER NOT NULL, ok INTEGER NOT NULL,
        status_code INTEGER, latency_ms INTEGER, error TEXT);
      CREATE INDEX idx_checks_site_cp_ts ON checks(site, checkpoint, ts);
      CREATE TABLE checkpoint_state (
        site TEXT NOT NULL, checkpoint TEXT NOT NULL, status TEXT NOT NULL,
        consecutive_fails INTEGER NOT NULL, since INTEGER NOT NULL,
        PRIMARY KEY (site, checkpoint));
      INSERT INTO checks (site, checkpoint, ts, ok) VALUES ('s', 'c', 1, 1);
      INSERT INTO checkpoint_state VALUES ('s', 'c', 'up', 0, 1);
    `);
    old.close();
    const migrated = openDb(path);
    expect(getState(migrated, "s", "c")).toEqual({
      site: "s",
      monitor: "c",
      status: "up",
      consecutiveFails: 0,
      consecutiveSlow: 0,
      since: 1,
      lastAlertAt: null,
      checkedAt: null,
      expiresAt: null,
    });
    const row = migrated.prepare("SELECT maintenance FROM checks").get() as {
      maintenance: number;
    };
    expect(row.maintenance).toBe(0);
    const checks = migrated.prepare("SELECT monitor FROM checks").get() as {
      monitor: string;
    };
    expect(checks.monitor).toBe("c");
    // Opening it again must not try to rename or add anything twice.
    openDb(path).close();
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("renames a 0.1 database's outages too, and keeps them", () => {
    const dir = mkdtempSync(join(tmpdir(), "statoss-"));
    const path = join(dir, "old.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE auto_incident (
        id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL,
        checkpoint TEXT NOT NULL, started_at INTEGER NOT NULL,
        resolved_at INTEGER, error TEXT);
      INSERT INTO auto_incident (site, checkpoint, started_at, error)
        VALUES ('s', 'c', 5, 'timeout');
    `);
    old.close();
    const migrated = openDb(path);
    expect(autoIncidents(migrated, "s", 0)).toEqual([
      expect.objectContaining({ monitor: "c", startedAt: 5 }),
    ]);
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("monitor_state", () => {
  const up: StateRow = {
    site: "s",
    monitor: "c",
    status: "up",
    consecutiveFails: 0,
    consecutiveSlow: 0,
    since: 500,
    lastAlertAt: null,
    checkedAt: null,
    expiresAt: null,
  };

  it("returns undefined for unknown monitors", () => {
    expect(getState(memDb(), "s", "c")).toBeUndefined();
  });

  it("round-trips and upserts state", () => {
    const db = memDb();
    setState(db, up);
    expect(getState(db, "s", "c")).toEqual(up);
    const down: StateRow = {
      ...up,
      status: "down",
      consecutiveFails: 2,
      since: 900,
      lastAlertAt: 900,
    };
    setState(db, down);
    expect(getState(db, "s", "c")).toEqual(down);
    expect(db.prepare("SELECT COUNT(*) AS n FROM monitor_state").get()).toEqual(
      { n: 1 },
    );
  });
});

describe("auto incidents", () => {
  it("opens one outage per monitor and resolves it", () => {
    const db = memDb();
    const opened = openAutoIncident(db, "s", "c", 1000, "timeout");
    expect(opened).toMatchObject({ startedAt: 1000, resolvedAt: null });
    expect(openAutoIncident(db, "s", "c", 2000, "timeout")).toBeNull();
    expect(resolveAutoIncident(db, "s", "other", 3000)).toBeNull();
    const resolved = resolveAutoIncident(db, "s", "c", 3000);
    expect(resolved).toMatchObject({ id: opened?.id, resolvedAt: 3000 });
    expect(resolveAutoIncident(db, "s", "c", 4000)).toBeNull();
    expect(autoIncidents(db, "s", 0)).toHaveLength(1);
  });

  it("lists open outages whatever their age, and closed ones since a time", () => {
    const db = memDb();
    openAutoIncident(db, "s", "old", 100, null);
    resolveAutoIncident(db, "s", "old", 200);
    openAutoIncident(db, "s", "ancient", 50, null);
    openAutoIncident(db, "s", "new", 5000, null);
    resolveAutoIncident(db, "s", "new", 6000);
    expect(autoIncidents(db, "s", 1000).map((r) => r.monitor)).toEqual([
      "new",
      "ancient",
    ]);
  });

  it("prunes resolved outages with the history", () => {
    const db = memDb();
    openAutoIncident(db, "s", "c", 100, null);
    resolveAutoIncident(db, "s", "c", 200);
    openAutoIncident(db, "s", "d", 100, null);
    expect(pruneOldChecks(db, 0, 500)).toBe(1);
    expect(autoIncidents(db, "s", 0).map((r) => r.monitor)).toEqual(["d"]);
  });
});

describe("hourly totals", () => {
  const HOUR = 60 * 60 * 1000;
  const base = { site: "s", monitor: "c", statusCode: null } as const;

  it("counts each check into its hour as it is stored", () => {
    const db = memDb();
    insertCheck(db, {
      ...base,
      ts: HOUR + 1,
      ok: 1,
      latencyMs: 100,
      error: null,
    });
    insertCheck(db, {
      ...base,
      ts: HOUR + 2,
      ok: 1,
      latencyMs: 900,
      error: null,
      slow: true,
    });
    insertCheck(db, {
      ...base,
      ts: HOUR + 3,
      ok: 0,
      latencyMs: 5,
      error: "timeout",
    });
    insertCheck(db, {
      ...base,
      ts: HOUR + 4,
      ok: 0,
      latencyMs: 5,
      error: "timeout",
      maintenance: 1,
    });
    insertCheck(db, {
      ...base,
      ts: 2 * HOUR,
      ok: 1,
      latencyMs: null,
      error: null,
    });
    expect(db.prepare("SELECT * FROM check_hour ORDER BY ts").all()).toEqual([
      {
        site: "s",
        monitor: "c",
        ts: HOUR,
        total: 3,
        up: 2,
        timeouts: 1,
        slow: 1,
        maintenance: 1,
        latency_sum: 1000,
        latency_n: 2,
      },
      {
        site: "s",
        monitor: "c",
        ts: 2 * HOUR,
        total: 1,
        up: 1,
        timeouts: 0,
        slow: 0,
        maintenance: 0,
        latency_sum: 0,
        latency_n: 0,
      },
    ]);
  });

  it("fills them in once for a database that has checks and no totals", () => {
    const dir = mkdtempSync(join(tmpdir(), "status-hours-"));
    const path = join(dir, "status.db");
    const first = openDb(path);
    insertCheck(first, {
      ...base,
      ts: HOUR + 1,
      ok: 1,
      latencyMs: 40,
      error: null,
    });
    insertCheck(first, {
      ...base,
      ts: HOUR + 2,
      ok: 0,
      latencyMs: 9,
      error: "timeout",
    });
    first.exec("DELETE FROM check_hour");
    first.close();
    const second = openDb(path);
    expect(
      second
        .prepare(
          "SELECT ts, total, up, timeouts, latency_sum, latency_n FROM check_hour",
        )
        .all(),
    ).toEqual([
      { ts: HOUR, total: 2, up: 1, timeouts: 1, latency_sum: 40, latency_n: 1 },
    ]);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("deploys", () => {
  it("keeps a site's markers and lists those of a window, newest first", () => {
    const db = memDb();
    recordDeploy(db, "s", { version: "v1", note: null, url: null, at: 1000 });
    recordDeploy(db, "s", {
      version: "v2",
      note: "Hotfix",
      url: "https://example.com/r/2",
      at: 2000,
    });
    recordDeploy(db, "other", {
      version: "x",
      note: null,
      url: null,
      at: 1500,
    });
    expect(listDeploys(db, "s", 0, 3000).map((d) => d.version)).toEqual([
      "v2",
      "v1",
    ]);
    expect(listDeploys(db, "s", 1500, 3000)).toEqual([
      {
        id: 2,
        version: "v2",
        note: "Hotfix",
        url: "https://example.com/r/2",
        at: 2000,
      },
    ]);
    expect(listDeploys(db, "s", 0, 3000, 1)).toHaveLength(1);
    pruneOldChecks(db, 0, 1500);
    expect(listDeploys(db, "s", 0, 3000).map((d) => d.version)).toEqual(["v2"]);
  });
});
