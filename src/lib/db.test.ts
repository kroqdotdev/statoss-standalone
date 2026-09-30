import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  autoIncidents,
  getState,
  insertCheck,
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
    const deleted = pruneOldChecks(db, 250);
    expect(deleted).toBe(2);
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

  it("prunes resolved outages with the checks", () => {
    const db = memDb();
    openAutoIncident(db, "s", "c", 100, null);
    resolveAutoIncident(db, "s", "c", 200);
    openAutoIncident(db, "s", "d", 100, null);
    expect(pruneOldChecks(db, 500)).toBe(1);
    expect(autoIncidents(db, "s", 0).map((r) => r.monitor)).toEqual(["d"]);
  });
});
