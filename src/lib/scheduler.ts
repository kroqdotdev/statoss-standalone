import type Database from "better-sqlite3";
import { sendAlert, type AlertEvent } from "./alerts";
import { runCheck, type CheckOutcome } from "./checker";
import { getConfig, type AppConfig } from "./config";
import { getDb, getState, insertCheck, pruneOldChecks, setState } from "./db";
import { bumpDataVersion } from "./data-version";
import { applyResult } from "./state";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface SchedulerDeps {
  config: AppConfig;
  db: Database.Database;
  check: (url: string, expectStatus?: number) => Promise<CheckOutcome>;
  alert: (event: AlertEvent) => Promise<void>;
  now: () => number;
}

export async function tick(deps: SchedulerDeps): Promise<void> {
  const { config, db, check, alert, now } = deps;
  // allSettled, not all: one checkpoint failing to record its result must not
  // abandon the others mid-flight or release the overlap guard early.
  const results = await Promise.allSettled(
    config.sites.flatMap((site) =>
      site.checkpoints.map(async (cp) => {
        const outcome = await check(cp.url, cp.expectStatus);
        const ts = now();
        insertCheck(db, {
          site: site.name,
          checkpoint: cp.name,
          ts,
          ok: outcome.ok ? 1 : 0,
          statusCode: outcome.statusCode,
          latencyMs: outcome.latencyMs,
          error: outcome.error,
        });
        const prev = getState(db, site.name, cp.name);
        const { next, transition } = applyResult(prev, outcome.ok, ts);
        setState(db, { site: site.name, checkpoint: cp.name, ...next });
        if (transition !== null && config.alerts) {
          // Not awaited: a slow SMTP server must not hold up the next tick.
          alert({
            site: site.name,
            checkpoint: cp.name,
            url: cp.url,
            transition,
            error: outcome.error,
            downSince: transition === "recovered" ? prev?.since : undefined,
            now: ts,
          }).catch((err: unknown) => {
            console.error("[scheduler] alert failed", err);
          });
        }
      }),
    ),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[scheduler] checkpoint tick failed", result.reason);
    }
  }
  bumpDataVersion();
}

/**
 * Wraps `task` so that a call made while a previous call is still running is
 * skipped instead of overlapping. A tick can take as long as the check
 * timeout, and two overlapping ticks would race on checkpoint_state and
 * could alert twice.
 */
export function skipWhileRunning(
  task: () => Promise<void>,
  onSkip: () => void = () =>
    console.warn("[scheduler] previous tick still running, skipping"),
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      onSkip();
      return;
    }
    running = true;
    try {
      await task();
    } finally {
      running = false;
    }
  };
}

const globals = globalThis as { __statusSchedulerStarted?: boolean };

export function startScheduler(): void {
  if (globals.__statusSchedulerStarted) return;
  globals.__statusSchedulerStarted = true;

  const config = getConfig();
  const db = getDb();

  if (config.alerts && !process.env.SMTP_PASS) {
    console.warn(
      "[scheduler] alerts are configured but SMTP_PASS is not set — alert emails will fail",
    );
  }
  const deps: SchedulerDeps = {
    config,
    db,
    check: runCheck,
    alert: (event) =>
      config.alerts ? sendAlert(config.alerts.smtp, event) : Promise.resolve(),
    now: Date.now,
  };

  let lastPruneDay = "";
  const run = skipWhileRunning(async () => {
    try {
      await tick(deps);
      const day = new Date().toISOString().slice(0, 10);
      if (day !== lastPruneDay) {
        lastPruneDay = day;
        const deleted = pruneOldChecks(db, Date.now() - RETENTION_MS);
        if (deleted > 0)
          console.log(`[scheduler] pruned ${deleted} old check rows`);
      }
    } catch (err) {
      console.error("[scheduler] tick failed", err);
    }
  });

  console.log(
    `[scheduler] started: ${config.sites.length} site(s), every ${config.checkIntervalSeconds}s`,
  );
  void run();
  setInterval(run, config.checkIntervalSeconds * 1000);
}
