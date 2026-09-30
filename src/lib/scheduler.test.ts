import { describe, expect, it, vi } from "vitest";
import type { CheckOutcome } from "./checker";
import { parseConfig } from "./config";
import { autoIncidents, getState, openDb, recordHeartbeat } from "./db";
import {
  alertStillHolds,
  dueJobs,
  heartbeatOutcome,
  loadJobs,
  spreadMs,
  tick,
  type Job,
  type SchedulerDeps,
} from "./scheduler";

const CONFIG = parseConfig(`
alerts:
  smtp:
    host: h
    port: 587
    user: u
    from: f@x.com
    to: t@x.com
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    monitors:
      - name: Main site
        url: https://webhooks.cc
`);

type Outcome = Partial<CheckOutcome> & { ok: boolean };

function makeDeps(
  outcomes: Outcome[],
  config = CONFIG,
): SchedulerDeps & { alertSpy: ReturnType<typeof vi.fn> } {
  let call = 0;
  let time = 1000;
  const alertSpy = vi.fn().mockResolvedValue(undefined);
  return {
    // The test clock moves a second a call, so every job is due every tick.
    jobs: loadJobs(config).map((job) => ({ ...job, intervalSeconds: 0 })),
    db: openDb(":memory:"),
    check: vi.fn().mockImplementation(() => {
      const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
      return Promise.resolve({
        ok: outcome.ok,
        statusCode: outcome.ok ? 200 : 500,
        latencyMs: outcome.latencyMs ?? 50,
        error: outcome.ok ? null : "unexpected status 500",
      });
    }),
    alert: alertSpy,
    now: () => (time += 1000),
    alertSpy,
  };
}

const state = (deps: SchedulerDeps) =>
  getState(deps.db, "webhooks.cc", "Main site");

describe("loadJobs", () => {
  it("builds one job per monitor with the site's destinations", () => {
    const jobs = loadJobs(CONFIG);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      site: "webhooks.cc",
      monitor: "Main site",
      url: "https://webhooks.cc",
      pageUrl: "https://status.webhooks.cc",
      spec: { url: "https://webhooks.cc", method: "GET" },
      slowThresholdMs: null,
      destinations: [{ email: "t@x.com" }],
      repeatMinutes: 0,
    });
  });
});

describe("tick", () => {
  it("records a check row and an up state on success", async () => {
    const deps = makeDeps([{ ok: true }]);
    await tick(deps);
    const rows = deps.db.prepare("SELECT * FROM checks").all();
    expect(rows).toHaveLength(1);
    expect(state(deps)?.status).toBe("up");
    expect(deps.alertSpy).not.toHaveBeenCalled();
  });

  it("alerts once after two consecutive failures and opens an incident", async () => {
    const deps = makeDeps([{ ok: false }]);
    await tick(deps);
    expect(deps.alertSpy).not.toHaveBeenCalled();
    await tick(deps);
    expect(deps.alertSpy).toHaveBeenCalledOnce();
    expect(deps.alertSpy.mock.calls[0][0]).toEqual([{ email: "t@x.com" }]);
    expect(deps.alertSpy.mock.calls[0][1]).toMatchObject({
      site: "webhooks.cc",
      monitor: "Main site",
      pageUrl: "https://status.webhooks.cc",
      kind: "went-down",
      error: "unexpected status 500",
    });
    await tick(deps);
    expect(deps.alertSpy).toHaveBeenCalledOnce();
    expect(state(deps)?.status).toBe("down");
    const outages = autoIncidents(deps.db, "webhooks.cc", 0);
    expect(outages).toHaveLength(1);
    expect(outages[0]).toMatchObject({
      monitor: "Main site",
      resolvedAt: null,
      error: "unexpected status 500",
    });
  });

  it("alerts recovery with the downSince timestamp and resolves the incident", async () => {
    const deps = makeDeps([{ ok: false }, { ok: false }, { ok: true }]);
    await tick(deps);
    await tick(deps);
    const downSince = state(deps)?.since;
    await tick(deps);
    expect(deps.alertSpy).toHaveBeenCalledTimes(2);
    expect(deps.alertSpy.mock.calls[1][1]).toMatchObject({
      kind: "recovered",
      downSince,
    });
    expect(state(deps)?.status).toBe("up");
    expect(
      autoIncidents(deps.db, "webhooks.cc", 0)[0].resolvedAt,
    ).not.toBeNull();
  });

  it("repeats the alert while down at the configured interval", async () => {
    const config = parseConfig(`
alerts:
  to:
    - slack: https://hooks.slack.com/x
  repeatMinutes: 1
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    monitors:
      - name: Main site
        url: https://webhooks.cc
`);
    const deps = makeDeps([{ ok: false }], config);
    // Two readings of the clock a tick: when it starts, and the check's time.
    let time = 0;
    deps.now = () => (time += 10_000);
    await tick(deps); // 20 s: first failure
    await tick(deps); // 40 s: down, alert 1
    await tick(deps); // 60 s
    await tick(deps); // 80 s
    expect(deps.alertSpy).toHaveBeenCalledTimes(1);
    await tick(deps); // 100 s: a minute since the alert, repeat
    expect(deps.alertSpy).toHaveBeenCalledTimes(2);
    expect(deps.alertSpy.mock.calls[1][1]).toMatchObject({
      kind: "still-down",
      downSince: 40_000,
    });
    await tick(deps); // 120 s
    expect(deps.alertSpy).toHaveBeenCalledTimes(2);
    expect(state(deps)?.lastAlertAt).toBe(100_000);
  });

  it("reports slowness after two slow responses", async () => {
    const config = parseConfig(`
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    monitors:
      - name: Main site
        url: https://webhooks.cc
        slowThresholdMs: 500
`);
    const deps = makeDeps(
      [
        { ok: true, latencyMs: 900 },
        { ok: true, latencyMs: 900 },
        { ok: true },
      ],
      config,
    );
    deps.jobs[0].destinations = [{ slack: "https://hooks.slack.com/x" }];
    await tick(deps);
    expect(state(deps)?.status).toBe("up");
    await tick(deps);
    expect(state(deps)?.status).toBe("slow");
    expect(deps.alertSpy.mock.calls[0][1]).toMatchObject({
      kind: "went-slow",
      latencyMs: 900,
      thresholdMs: 500,
    });
    await tick(deps);
    expect(state(deps)?.status).toBe("up");
    expect(deps.alertSpy.mock.calls[1][1]).toMatchObject({
      kind: "back-to-normal",
    });
    expect(autoIncidents(deps.db, "webhooks.cc", 0)).toEqual([]);
  });

  it("keeps checks during maintenance but changes nothing else", async () => {
    const deps = makeDeps([{ ok: false }]);
    const job: Job = {
      ...deps.jobs[0],
      maintenance: [
        { title: "Work", start: 0, end: 10_000, monitors: undefined },
      ],
    };
    deps.jobs = [job];
    await tick(deps); // 2 s
    await tick(deps); // 3 s
    const rows = deps.db
      .prepare("SELECT ok, maintenance FROM checks ORDER BY ts")
      .all();
    expect(rows).toEqual([
      { ok: 0, maintenance: 1 },
      { ok: 0, maintenance: 1 },
    ]);
    expect(state(deps)).toBeUndefined();
    expect(deps.alertSpy).not.toHaveBeenCalled();
    expect(autoIncidents(deps.db, "webhooks.cc", 0)).toEqual([]);
  });

  it("does not alert when the site has no destinations", async () => {
    const deps = makeDeps([{ ok: false }]);
    deps.jobs[0].destinations = [];
    await tick(deps);
    await tick(deps);
    expect(deps.alertSpy).not.toHaveBeenCalled();
    expect(state(deps)?.status).toBe("down");
  });

  it("finishes the other monitors when one throws", async () => {
    const config = parseConfig(`
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    monitors:
      - name: Broken
        url: https://broken.example.com
      - name: Main site
        url: https://webhooks.cc
`);
    const deps = makeDeps([{ ok: true }], config);
    const good = deps.check;
    deps.check = vi.fn((spec: { url: string }) =>
      spec.url.includes("broken")
        ? Promise.reject(new Error("db exploded"))
        : good(spec),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(tick(deps)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "[scheduler] monitor tick failed",
      expect.any(Error),
    );
    expect(state(deps)?.status).toBe("up");
    expect(getState(deps.db, "webhooks.cc", "Broken")).toBeUndefined();
    errorSpy.mockRestore();
  });

  it("survives an alert function that rejects", async () => {
    const deps = makeDeps([{ ok: false }]);
    deps.alert = vi.fn().mockRejectedValue(new Error("smtp down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await tick(deps);
    await expect(tick(deps)).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errorSpy).toHaveBeenCalledWith(
      "[scheduler] alert failed",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("does not wait for a slow alert before finishing the tick", async () => {
    const deps = makeDeps([{ ok: false }]);
    deps.alert = vi.fn(() => new Promise<void>(() => {}));
    await tick(deps);
    await expect(tick(deps)).resolves.toBeUndefined();
    expect(deps.alert).toHaveBeenCalledOnce();
  });
});

describe("intervals", () => {
  const config = parseConfig(`
checkIntervalSeconds: 60
sites:
  - name: s
    host: h
    monitors:
      - name: Web
        url: https://example.com
      - name: Hourly
        url: https://example.com/hourly
        intervalSeconds: 300
      - name: Cert
        type: certificate
        host: example.com
      - name: Domain
        type: domain
        host: example.com
`);

  it("gives each job its own interval, never under the type's floor", () => {
    expect(loadJobs(config).map((j) => j.intervalSeconds)).toEqual([
      60, 300, 3600, 21_600,
    ]);
  });

  it("runs a job only once its interval has passed", async () => {
    let time = 0;
    const deps: SchedulerDeps = {
      jobs: loadJobs(config).slice(0, 2),
      db: openDb(":memory:"),
      check: vi
        .fn()
        .mockResolvedValue({ ok: true, statusCode: 200, latencyMs: 5 }),
      alert: vi.fn(),
      now: () => time,
    };
    const names = () => dueJobs(deps, time).map((j) => j.monitor);
    expect(names()).toEqual(["Web", "Hourly"]);
    await tick(deps);
    time = 60_000;
    expect(names()).toEqual(["Web"]);
    await tick(deps);
    time = 300_000;
    expect(names()).toEqual(["Web", "Hourly"]);
  });

  it("spreads a tick's checks over part of the interval", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const deps: SchedulerDeps = {
      jobs: loadJobs(config),
      db: openDb(":memory:"),
      check: vi
        .fn()
        .mockResolvedValue({ ok: true, statusCode: 200, latencyMs: 5 }),
      alert: vi.fn(),
      now: () => 1000,
      sleep,
      spreadMs: spreadMs(60),
    };
    await tick(deps);
    expect(spreadMs(60)).toBe(45_000);
    expect(spreadMs(10)).toBe(7_500);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([11_250, 22_500, 33_750]);
  });
});

describe("heartbeat", () => {
  const config = parseConfig(`
sites:
  - name: s
    host: h
    monitors:
      - name: Nightly job
        type: heartbeat
        token: abcdefgh1234
        intervalSeconds: 3600
`);

  it("has nothing to judge before the first ping", () => {
    expect(heartbeatOutcome(null, 3600, 5000)).toBeNull();
  });

  it("passes inside the interval and fails past it", () => {
    // An hour and its grace of six minutes.
    expect(heartbeatOutcome(0, 3600, 3_960_000)?.ok).toBe(true);
    expect(heartbeatOutcome(0, 3600, 3_960_001)).toMatchObject({
      ok: false,
      error: "no ping",
    });
  });

  it("writes no check until a ping has arrived, then goes down after two misses", async () => {
    let time = 0;
    const deps: SchedulerDeps = {
      jobs: loadJobs(config).map((job) => ({ ...job })),
      db: openDb(":memory:"),
      check: vi.fn(),
      alert: vi.fn().mockResolvedValue(undefined),
      now: () => time,
    };
    const count = () =>
      (
        deps.db.prepare("SELECT COUNT(*) AS n FROM checks").get() as {
          n: number;
        }
      ).n;
    await tick(deps);
    expect(count()).toBe(0);
    recordHeartbeat(deps.db, "s", "Nightly job", 1000);
    time = 3_600_000;
    await tick(deps);
    expect(getState(deps.db, "s", "Nightly job")?.status).toBe("up");
    time = 2 * 3_600_000;
    await tick(deps);
    time = 3 * 3_600_000;
    await tick(deps);
    expect(getState(deps.db, "s", "Nightly job")?.status).toBe("down");
    expect(deps.check).not.toHaveBeenCalled();
    const row = deps.db.prepare("SELECT latency_ms AS l FROM checks").get() as {
      l: number | null;
    };
    expect(row.l).toBeNull();
  });
});

describe("alertStillHolds", () => {
  it("drops a down alert once the monitor is back, and a recovery once it is down again", async () => {
    const deps = makeDeps([{ ok: false }, { ok: false }, { ok: true }]);
    const at = { site: "webhooks.cc", monitor: "Main site" };
    await tick(deps);
    await tick(deps);
    expect(alertStillHolds(deps.db, { ...at, kind: "went-down" })).toBe(true);
    expect(alertStillHolds(deps.db, { ...at, kind: "recovered" })).toBe(false);
    await tick(deps);
    expect(alertStillHolds(deps.db, { ...at, kind: "went-down" })).toBe(false);
    expect(alertStillHolds(deps.db, { ...at, kind: "recovered" })).toBe(true);
  });

  it("gives a down alert the time of the first failed check", async () => {
    const deps = makeDeps([{ ok: true }, { ok: false }, { ok: false }]);
    await tick(deps);
    await tick(deps);
    await tick(deps);
    const event = deps.alertSpy.mock.calls[0][1];
    expect(event.kind).toBe("went-down");
    expect(event.failingSince).toBeLessThan(event.now);
  });
});

describe("overlapping rounds", () => {
  it("starts what is due beside a round that is still waiting, but never one monitor twice", async () => {
    let release: () => void = () => {};
    const slow = new Promise<CheckOutcome>((resolve) => {
      release = () =>
        resolve({ ok: true, statusCode: 200, latencyMs: 9000, error: null });
    });
    let time = 0;
    const deps: SchedulerDeps = {
      jobs: loadJobs(CONFIG).map((job) => ({ ...job, intervalSeconds: 10 })),
      db: openDb(":memory:"),
      check: vi.fn().mockReturnValueOnce(slow),
      alert: vi.fn(),
      now: () => time,
    };
    const first = tick(deps);
    time = 10_000;
    await tick(deps);
    // Its check is still out, so the next round leaves it alone.
    expect(deps.check).toHaveBeenCalledTimes(1);
    release();
    await first;
    time = 20_000;
    expect(dueJobs(deps, time)).toHaveLength(1);
  });
});

describe("heartbeat grace", () => {
  it("allows a tenth of the interval, and a minute at least, before a miss", () => {
    const day = 86_400;
    expect(heartbeatOutcome(0, day, (day + 8_000) * 1000)?.ok).toBe(true);
    expect(heartbeatOutcome(0, day, (day + 8_641) * 1000)?.ok).toBe(false);
    expect(heartbeatOutcome(0, 60, 120_000)?.ok).toBe(true);
    expect(heartbeatOutcome(0, 60, 120_001)?.ok).toBe(false);
  });
});

describe("alerts about a spell that is over", () => {
  it("are dropped when the monitor went down again since", async () => {
    const deps = makeDeps([
      { ok: false },
      { ok: false },
      { ok: true },
      { ok: false },
      { ok: false },
    ]);
    await tick(deps);
    await tick(deps);
    const first = deps.alertSpy.mock.calls[0][1];
    expect(alertStillHolds(deps.db, first)).toBe(true);
    await tick(deps);
    await tick(deps);
    await tick(deps);
    // Down again, but in a second outage: the first one's alert is stale.
    expect(state(deps)?.status).toBe("down");
    expect(alertStillHolds(deps.db, first)).toBe(false);
    expect(alertStillHolds(deps.db, deps.alertSpy.mock.calls[2][1])).toBe(true);
  });

  it("marks a down alert that follows slowness, so a pager closes the slow one", async () => {
    const config = parseConfig(`
alerts:
  to:
    - pagerduty: R0UT1NG
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    monitors:
      - name: Main site
        url: https://webhooks.cc
        slowThresholdMs: 100
`);
    const deps = makeDeps(
      [
        { ok: true, latencyMs: 500 },
        { ok: true, latencyMs: 500 },
        { ok: false },
        { ok: false },
      ],
      config,
    );
    for (let i = 0; i < 4; i++) await tick(deps);
    const kinds = deps.alertSpy.mock.calls.map((c) => [
      c[1].kind,
      c[1].wasSlow,
    ]);
    expect(kinds).toEqual([
      ["went-slow", false],
      ["went-down", true],
    ]);
  });
});
