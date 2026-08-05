import { describe, expect, it } from "vitest";
import { getState, insertCheck, openDb, pruneOldChecks, setState } from "./db";

function memDb() {
  return openDb(":memory:");
}

describe("checks", () => {
  it("inserts and stores check rows", () => {
    const db = memDb();
    insertCheck(db, {
      site: "webhooks.cc",
      checkpoint: "Main site",
      ts: 1000,
      ok: 1,
      statusCode: 200,
      latencyMs: 123,
      error: null,
    });
    insertCheck(db, {
      site: "webhooks.cc",
      checkpoint: "Main site",
      ts: 2000,
      ok: 0,
      statusCode: null,
      latencyMs: 10000,
      error: "timeout",
    });
    const rows = db.prepare("SELECT * FROM checks ORDER BY ts").all() as Array<{
      ok: number;
      status_code: number | null;
      error: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].ok).toBe(1);
    expect(rows[0].status_code).toBe(200);
    expect(rows[1].ok).toBe(0);
    expect(rows[1].error).toBe("timeout");
  });

  it("prunes only rows older than the cutoff", () => {
    const db = memDb();
    for (const ts of [100, 200, 300]) {
      insertCheck(db, {
        site: "s",
        checkpoint: "c",
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

describe("checkpoint_state", () => {
  it("returns undefined for unknown checkpoints", () => {
    expect(getState(memDb(), "s", "c")).toBeUndefined();
  });

  it("round-trips and upserts state", () => {
    const db = memDb();
    setState(db, {
      site: "s",
      checkpoint: "c",
      status: "up",
      consecutiveFails: 0,
      since: 500,
    });
    expect(getState(db, "s", "c")).toEqual({
      site: "s",
      checkpoint: "c",
      status: "up",
      consecutiveFails: 0,
      since: 500,
    });
    setState(db, {
      site: "s",
      checkpoint: "c",
      status: "down",
      consecutiveFails: 2,
      since: 900,
    });
    expect(getState(db, "s", "c")).toEqual({
      site: "s",
      checkpoint: "c",
      status: "down",
      consecutiveFails: 2,
      since: 900,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM checkpoint_state").get(),
    ).toEqual({ n: 1 });
  });
});
