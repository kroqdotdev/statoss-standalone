import type Database from "better-sqlite3";
import {
  sendAlerts,
  sendNotice,
  sendVendorAlert,
  smtpSend,
  type AlertDeps,
  type AlertEvent,
  type AlertKind,
  type NoticeEvent,
  type VendorEvent,
} from "./alerts";
import { monitorSpec, runCheck } from "./checker";
import type { CheckOutcome, CheckSpec } from "./checker";
import {
  getConfig,
  heartbeatDeadlineSeconds,
  HISTORY_DAYS,
  LATENCY_TYPES,
  monitorIntervalSeconds,
  monitorTarget,
  siteDestinations,
  siteRepeatMinutes,
  siteSendsUpdates,
  siteUrl,
  type AppConfig,
  type Destination,
  type MaintenanceConfig,
  type MonitorType,
} from "./config";
import {
  failingSince,
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
import {
  pruneComponentStates,
  recordComponentStates,
} from "./component-history";
import { bumpDataVersion } from "./data-version";
import { readIncidentFiles } from "./incident-files";
import { inMaintenance, maintenanceView } from "./incidents";
import { dueNotices } from "./notices";
import { applyResult, lateAfterMs, type CheckVerdict } from "./state";
import {
  forgetUnfollowedVendors,
  vendorAlertHolds,
  vendorAlerts,
} from "./vendor-alerts";
import { refreshVendors } from "./vendors";

const DAY_MS = 24 * 60 * 60 * 1000;
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
  /** A heartbeat: how often its pings are due. */
  pingIntervalSeconds?: number;
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
      ...(cp.type === "heartbeat"
        ? {
            pingIntervalSeconds:
              cp.intervalSeconds ?? config.checkIntervalSeconds,
          }
        : {}),
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
  /** The jobs running now, so a slow one is not started again beside itself. */
  running?: Set<string>;
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
 * interval and a little grace. Null before the first ping ever, when there
 * is nothing to judge.
 */
export function heartbeatOutcome(
  lastPingAt: number | null,
  intervalSeconds: number,
  now: number,
): CheckOutcome | null {
  if (lastPingAt === null) return null;
  const ok =
    now - lastPingAt <= heartbeatDeadlineSeconds(intervalSeconds) * 1000;
  return { ok, statusCode: null, latencyMs: 0, error: ok ? null : "no ping" };
}

/** Runs one job end to end: check, record, update state, alert, incidents. */
export async function runJob(deps: SchedulerDeps, job: Job): Promise<void> {
  const { db } = deps;
  const outcome =
    job.type === "heartbeat"
      ? heartbeatOutcome(
          lastHeartbeat(db, job.site, job.monitor),
          job.pingIntervalSeconds ?? job.intervalSeconds,
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
  const slow = isSlow(job, outcome);
  insertCheck(db, { ...row, slow });

  const verdict: CheckVerdict = { ok: outcome.ok, slow };
  const prev = getState(db, job.site, job.monitor);
  const { next, transition } = applyResult(prev, verdict, ts);
  // Down since the first failed check, as the list of failures has it, not
  // the second, which is when it could be called.
  if (transition === "went-down")
    next.since =
      failingSince(
        db,
        job.site,
        job.monitor,
        lateAfterMs(job.intervalSeconds),
      ) ?? next.since;
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
      // On the way down the outage's start; after it, when the state that
      // ended began.
      downSince: transition === "went-down" ? next.since : prev?.since,
      failingSince: transition === "went-down" ? next.since : null,
      wasSlow: transition === "went-down" && prev?.status === "slow",
      stateSince: next.since,
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
      stateSince: next.since,
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
    openAutoIncident(db, job.site, job.monitor, next.since, outcome.error);
  } else if (transition === "recovered") {
    resolveAutoIncident(db, job.site, job.monitor, ts);
  }
}

const jobKey = (job: Job) => `${job.site}\0${job.monitor}`;

/**
 * The jobs whose interval has passed since they last ran, and that are not
 * still running from an earlier round: two checks of one monitor at once
 * would race on its state and could alert twice.
 */
export function dueJobs(deps: SchedulerDeps, now: number): Job[] {
  const lastRun = (deps.lastRun ??= new Map());
  const running = (deps.running ??= new Set());
  return deps.jobs.filter((job) => {
    if (running.has(jobKey(job))) return false;
    const last = lastRun.get(jobKey(job));
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
      deps.lastRun?.set(jobKey(job), started);
      if (gap > 0 && i > 0) await deps.sleep?.(Math.round(i * gap));
      // Marked as running only once it runs: waiting for its place in the
      // spread, a heartbeat can still be judged at once after a ping.
      deps.running?.add(jobKey(job));
      try {
        await runJob(deps, job);
      } finally {
        deps.running?.delete(jobKey(job));
      }
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

/** The live alert sender: SMTP from the config, fetch for the rest. */
export function liveAlertDeps(config: AppConfig): AlertDeps {
  const smtp = config.alerts?.smtp;
  return {
    send: smtp ? smtpSend(smtp) : null,
    from: smtp?.from ?? "",
    fetch,
    // unref: a pending retry must not keep a stopping process alive.
    schedule: (task, delayMs) => void setTimeout(task, delayMs).unref(),
  };
}

/**
 * Whether an alert is still true of its monitor, asked before a retry. A
 * "went down" for a monitor that has recovered since, or that has gone
 * down again since, would only confuse.
 */
export function alertStillHolds(
  db: Database.Database,
  event: Pick<AlertEvent, "site" | "monitor" | "kind" | "stateSince">,
): boolean {
  const state = getState(db, event.site, event.monitor);
  // Another spell in the same state since, such as a second outage: the
  // alert was about the first one.
  if (event.stateSince !== undefined && state?.since !== event.stateSince)
    return false;
  const status = state?.status;
  const expected: Record<AlertKind, boolean> = {
    "went-down": status === "down",
    "still-down": status === "down",
    recovered: status !== "down",
    "went-slow": status === "slow",
    "back-to-normal": status === "up",
  };
  return expected[event.kind];
}

/**
 * Sends the incident updates and maintenance notices that are due, to each
 * site's destinations. Marks them as sent first, so a slow destination
 * cannot make a notice go twice.
 */
export function sendDueNotices(
  config: AppConfig,
  db: Database.Database,
  send: (destinations: Destination[], event: NoticeEvent) => Promise<unknown>,
  now: number,
): void {
  const files = readIncidentFiles(config);
  for (const site of config.sites) {
    const views = [
      ...(files.get(site.name) ?? []),
      ...site.maintenance.map((window) => maintenanceView(window)),
    ];
    const due = dueNotices(db, site, views, now);
    if (!siteSendsUpdates(config, site)) continue;
    const destinations = siteDestinations(config, site);
    if (destinations.length === 0) continue;
    for (const event of due)
      send(destinations, event).catch((err: unknown) => {
        console.error("[scheduler] notice failed", err);
      });
  }
}

/**
 * Tells each site's destinations when a vendor one of its components
 * follows has changed state. Called after vendor pages have been read.
 */
export function sendVendorAlerts(
  config: AppConfig,
  db: Database.Database,
  send: (destinations: Destination[], event: VendorEvent) => Promise<unknown>,
  now: number,
): void {
  for (const { destinations, event } of vendorAlerts(config, db, now))
    send(destinations, event).catch((err: unknown) => {
      console.error("[scheduler] vendor alert failed", err);
    });
}

/**
 * How long a tick spreads its checks over: three quarters of the interval,
 * 45 seconds at most, so the last check and its timeout end before the next
 * tick at the default of a minute.
 */
export function spreadMs(checkIntervalSeconds: number): number {
  return Math.min(45_000, checkIntervalSeconds * 750);
}

const globals = globalThis as {
  __statusSchedulerStarted?: boolean;
  __statusSchedulerDeps?: SchedulerDeps;
};

/**
 * Judges a heartbeat monitor at once, after a ping, rather than at its next
 * turn: a daily job's recovery should not wait a day to be seen. Only a
 * monitor that is not up is judged early; an up one has nothing to gain.
 */
export async function judgeHeartbeat(site: string, monitor: string) {
  const deps = globals.__statusSchedulerDeps;
  const job = deps?.jobs.find((j) => j.site === site && j.monitor === monitor);
  if (!deps || !job || job.type !== "heartbeat") return;
  if (getState(deps.db, site, monitor)?.status === "up") return;
  const running = (deps.running ??= new Set());
  const key = `${site}\0${monitor}`;
  if (running.has(key)) return;
  running.add(key);
  try {
    await runJob(deps, job);
  } finally {
    running.delete(key);
  }
  bumpDataVersion();
}

export function startScheduler(): void {
  if (globals.__statusSchedulerStarted) return;
  globals.__statusSchedulerStarted = true;

  const config = getConfig();
  const db = getDb();
  const jobs = loadJobs(config);
  recordComponentStates(db, config.sites, Date.now());
  // No round of vendor alerts runs once no component follows a vendor.
  forgetUnfollowedVendors(config, db);

  if (config.alerts?.smtp && !process.env.SMTP_PASS) {
    console.warn(
      "[scheduler] alerts.smtp is configured but SMTP_PASS is not set, so alert emails will fail",
    );
  }
  const alertDeps = liveAlertDeps(config);
  // When each monitor last ran, from the database: a restart does not run
  // everything at once again, which for domains and certificates would
  // ask the registries more often than their floor.
  const lastRun = new Map<string, number>();
  for (const job of jobs) {
    const checkedAt = getState(db, job.site, job.monitor)?.checkedAt;
    if (checkedAt) lastRun.set(`${job.site}\0${job.monitor}`, checkedAt);
  }
  const deps: SchedulerDeps = {
    lastRun,
    jobs,
    db,
    check: runCheck,
    alert: (destinations, event) =>
      sendAlerts(destinations, event, alertDeps, () =>
        alertStillHolds(db, event),
      ),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    spreadMs: spreadMs(config.checkIntervalSeconds),
  };

  let lastPruneDay = "";
  // Rounds may overlap: a round whose last checks are still waiting on a
  // timeout does not hold up the next, which starts what is due and not
  // running (see dueJobs).
  const run = async () => {
    try {
      // Not awaited: a slow vendor must not hold up the checks.
      void refreshVendors(config, Date.now())
        .then((read) => {
          if (!read) return;
          bumpDataVersion();
          sendVendorAlerts(
            config,
            db,
            (destinations, event) =>
              sendVendorAlert(destinations, event, alertDeps, () =>
                vendorAlertHolds(db, event),
              ),
            Date.now(),
          );
        })
        .catch((err: unknown) =>
          console.error("[vendors] refresh failed", err),
        );
      await tick(deps);
      sendDueNotices(
        config,
        db,
        (destinations, event) => sendNotice(destinations, event, alertDeps),
        Date.now(),
      );
      const day = new Date().toISOString().slice(0, 10);
      if (day !== lastPruneDay) {
        lastPruneDay = day;
        const deleted = pruneOldChecks(
          db,
          Date.now() - config.retentionDays * DAY_MS,
          Date.now() - HISTORY_DAYS * DAY_MS,
        );
        pruneComponentStates(db, Date.now() - HISTORY_DAYS * DAY_MS);
        if (deleted > 0) console.log(`[scheduler] pruned ${deleted} old rows`);
      }
    } catch (err) {
      console.error("[scheduler] tick failed", err);
    }
  };
  globals.__statusSchedulerDeps = deps;

  console.log(
    `[scheduler] started: ${config.sites.length} site(s), ${jobs.length} monitor(s), every ${config.checkIntervalSeconds}s`,
  );
  void run();
  setInterval(run, config.checkIntervalSeconds * 1000);
}
