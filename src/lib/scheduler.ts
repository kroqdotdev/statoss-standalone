import type Database from "better-sqlite3";
import {
  sendAlerts,
  smtpSend,
  type AlertDeps,
  type AlertEvent,
} from "./alerts";
import { monitorSpec, runCheck } from "./checker";
import type { CheckOutcome, CheckSpec } from "./checker";
import {
  getConfig,
  LATENCY_TYPES,
  monitorIntervalSeconds,
  monitorTarget,
  siteDestinations,
  siteRepeatMinutes,
  siteUrl,
  type AppConfig,
  type Destination,
  type MaintenanceConfig,
  type MonitorType,
} from "./config";
import {
  getDb,
  getState,
  insertCheck,
  lastHeartbeat,
  openAutoIncident,
  pruneOldChecks,
  resolveAutoIncident,
  setState,
  touchChecked,
} from "./db";
import { bumpDataVersion } from "./data-version";
import { inMaintenance } from "./incidents";
import { applyResult, type CheckVerdict } from "./state";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

/** Everything one tick needs to know about a monitor. */
export interface Job {
  site: string;
  monitor: string;
  type: MonitorType;
  /** What the check points at, in words, for alerts. */
  url: string;
  pageUrl: string;
  spec: CheckSpec;
  /** Seconds between this monitor's checks. */
  intervalSeconds: number;
  /** A successful check slower than this is slow. Null turns it off. */
  slowThresholdMs: number | null;
  destinations: Destination[];
  /** Minutes between "still down" notices. 0 is off. */
  repeatMinutes: number;
  /** The site's maintenance windows. */
  maintenance: MaintenanceConfig[];
}

export function loadJobs(config: AppConfig): Job[] {
  return config.sites.flatMap((site) => {
    const destinations = siteDestinations(config, site);
    const repeatMinutes = siteRepeatMinutes(config, site);
    const pageUrl = siteUrl(site);
    return site.monitors.map((cp) => ({
      site: site.name,
      monitor: cp.name,
      type: cp.type,
      url: monitorTarget(cp),
      pageUrl,
      spec: monitorSpec(cp),
      intervalSeconds: monitorIntervalSeconds(cp, config.checkIntervalSeconds),
      slowThresholdMs: cp.slowThresholdMs ?? null,
      destinations,
      repeatMinutes,
      maintenance: site.maintenance,
    }));
  });
}

export interface SchedulerDeps {
  jobs: Job[];
  db: Database.Database;
  check: (spec: CheckSpec) => Promise<CheckOutcome>;
  alert: (destinations: Destination[], event: AlertEvent) => Promise<unknown>;
  now: () => number;
  /** Waits between the checks of one tick. Tests leave it out. */
  sleep?: (ms: number) => Promise<void>;
  /** The longest a tick spreads its checks over, in ms. */
  spreadMs?: number;
  /** When each job last ran, kept between ticks. */
  lastRun?: Map<string, number>;
}

function isSlow(job: Job, outcome: CheckOutcome): boolean {
  return (
    outcome.ok &&
    job.slowThresholdMs !== null &&
    outcome.latencyMs > job.slowThresholdMs
  );
}

function fire(deps: SchedulerDeps, job: Job, event: AlertEvent): void {
  if (job.destinations.length === 0) return;
  // Not awaited: a slow SMTP server must not hold up the next tick.
  deps.alert(job.destinations, event).catch((err: unknown) => {
    console.error("[scheduler] alert failed", err);
  });
}

/**
 * A heartbeat's check: whether its job pinged within the monitor's
 * interval. Null before the first ping ever, when there is nothing to judge.
 */
export function heartbeatOutcome(
  lastPingAt: number | null,
  intervalSeconds: number,
  now: number,
): CheckOutcome | null {
  if (lastPingAt === null) return null;
  const ok = now - lastPingAt <= intervalSeconds * 1000;
  return { ok, statusCode: null, latencyMs: 0, error: ok ? null : "no ping" };
}

/** Runs one job end to end: check, record, update state, alert, incidents. */
export async function runJob(deps: SchedulerDeps, job: Job): Promise<void> {
  const { db } = deps;
  const outcome =
    job.type === "heartbeat"
      ? heartbeatOutcome(
          lastHeartbeat(db, job.site, job.monitor),
          job.intervalSeconds,
          deps.now(),
        )
      : await deps.check(job.spec);
  if (outcome === null) return;
  const ts = deps.now();
  const row = {
    site: job.site,
    monitor: job.monitor,
    ts,
    ok: outcome.ok ? 1 : 0,
    statusCode: outcome.statusCode,
    // A handshake with a certificate or a registry's answer is not the
    // monitored thing's response time, and a heartbeat has none.
    latencyMs: LATENCY_TYPES.has(job.type) ? outcome.latencyMs : null,
    error: outcome.error,
  } as const;
  if (inMaintenance(job.maintenance, job.monitor, ts)) {
    insertCheck(db, { ...row, maintenance: 1 });
    touchChecked(db, job.site, job.monitor, ts);
    return;
  }
  insertCheck(db, row);

  const verdict: CheckVerdict = { ok: outcome.ok, slow: isSlow(job, outcome) };
  const prev = getState(db, job.site, job.monitor);
  const { next, transition } = applyResult(prev, verdict, ts);
  let lastAlertAt = prev?.lastAlertAt ?? null;
  const base = {
    site: job.site,
    monitor: job.monitor,
    url: job.url,
    pageUrl: job.pageUrl,
    now: ts,
  };
  if (transition !== null) {
    lastAlertAt = ts;
    fire(deps, job, {
      ...base,
      kind: transition,
      error: outcome.error,
      downSince: prev?.since,
      latencyMs: outcome.latencyMs,
      thresholdMs: job.slowThresholdMs,
    });
  } else if (
    next.status === "down" &&
    job.repeatMinutes > 0 &&
    ts - (lastAlertAt ?? next.since) >= job.repeatMinutes * MINUTE_MS
  ) {
    lastAlertAt = ts;
    fire(deps, job, {
      ...base,
      kind: "still-down",
      error: outcome.error,
      downSince: next.since,
    });
  }
  setState(db, {
    site: job.site,
    monitor: job.monitor,
    ...next,
    lastAlertAt,
    checkedAt: ts,
    expiresAt: outcome.expiresAt ?? prev?.expiresAt ?? null,
  });

  if (transition === "went-down") {
    openAutoIncident(db, job.site, job.monitor, ts, outcome.error);
  } else if (transition === "recovered") {
    resolveAutoIncident(db, job.site, job.monitor, ts);
  }
}

/** The jobs whose interval has passed since they last ran. */
export function dueJobs(deps: SchedulerDeps, now: number): Job[] {
  const lastRun = (deps.lastRun ??= new Map());
  return deps.jobs.filter((job) => {
    const last = lastRun.get(`${job.site}\0${job.monitor}`);
    // A second of slack, so a timer that fires a moment early still counts.
    return (
      last === undefined || now - last >= job.intervalSeconds * 1000 - 1000
    );
  });
}

/**
 * One tick: every job that is due, spread over the first part of the
 * interval. Fired together, each check's clock would count the others'
 * TLS handshakes, and response times would read higher than they are.
 */
export async function tick(deps: SchedulerDeps): Promise<void> {
  const started = deps.now();
  const jobs = dueJobs(deps, started);
  const gap =
    deps.sleep && jobs.length > 1 ? (deps.spreadMs ?? 0) / jobs.length : 0;
  // allSettled, not all: one monitor failing to record its result must not
  // abandon the others mid-flight or release the overlap guard early.
  const results = await Promise.allSettled(
    jobs.map(async (job, i) => {
      deps.lastRun?.set(`${job.site}\0${job.monitor}`, started);
      if (gap > 0 && i > 0) await deps.sleep?.(Math.round(i * gap));
      await runJob(deps, job);
      // Per job, not per tick: the page should not wait out the spread.
      bumpDataVersion();
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[scheduler] monitor tick failed", result.reason);
    }
  }
  bumpDataVersion();
}

/**
 * Wraps `task` so that a call made while a previous call is still running is
 * skipped instead of overlapping. A tick can take as long as the check
 * timeout, and two overlapping ticks would race on monitor_state and
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

/** The live alert sender: SMTP from the config, fetch for the rest. */
export function liveAlertDeps(config: AppConfig): AlertDeps {
  const smtp = config.alerts?.smtp;
  return {
    send: smtp ? smtpSend(smtp) : null,
    from: smtp?.from ?? "",
    fetch,
  };
}

/**
 * How long a tick spreads its checks over: three quarters of the interval,
 * 45 seconds at most, so the last check and its timeout end before the next
 * tick at the default of a minute.
 */
export function spreadMs(checkIntervalSeconds: number): number {
  return Math.min(45_000, checkIntervalSeconds * 750);
}

const globals = globalThis as { __statusSchedulerStarted?: boolean };

export function startScheduler(): void {
  if (globals.__statusSchedulerStarted) return;
  globals.__statusSchedulerStarted = true;

  const config = getConfig();
  const db = getDb();
  const jobs = loadJobs(config);

  if (config.alerts?.smtp && !process.env.SMTP_PASS) {
    console.warn(
      "[scheduler] alerts.smtp is configured but SMTP_PASS is not set, so alert emails will fail",
    );
  }
  const alertDeps = liveAlertDeps(config);
  const deps: SchedulerDeps = {
    jobs,
    db,
    check: runCheck,
    alert: (destinations, event) => sendAlerts(destinations, event, alertDeps),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    spreadMs: spreadMs(config.checkIntervalSeconds),
  };

  let lastPruneDay = "";
  const run = skipWhileRunning(async () => {
    try {
      await tick(deps);
      const day = new Date().toISOString().slice(0, 10);
      if (day !== lastPruneDay) {
        lastPruneDay = day;
        const deleted = pruneOldChecks(db, Date.now() - RETENTION_MS);
        if (deleted > 0) console.log(`[scheduler] pruned ${deleted} old rows`);
      }
    } catch (err) {
      console.error("[scheduler] tick failed", err);
    }
  });

  console.log(
    `[scheduler] started: ${config.sites.length} site(s), ${jobs.length} monitor(s), every ${config.checkIntervalSeconds}s`,
  );
  void run();
  setInterval(run, config.checkIntervalSeconds * 1000);
}
