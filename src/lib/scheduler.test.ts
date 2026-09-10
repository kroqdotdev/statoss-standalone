import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config";
import { getState, openDb } from "./db";
import { skipWhileRunning, tick, type SchedulerDeps } from "./scheduler";

const CONFIG: AppConfig = {
  checkIntervalSeconds: 60,
  alerts: {
    smtp: { host: "h", port: 587, user: "u", from: "f@x.com", to: "t@x.com" },
  },
  sites: [
    {
      name: "webhooks.cc",
      host: "status.webhooks.cc",
      checkpoints: [{ name: "Main site", url: "https://webhooks.cc" }],
    },
  ],
};

function makeDeps(outcomes: Array<{ ok: boolean }>): SchedulerDeps & {
  alertSpy: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  let time = 1000;
  const alertSpy = vi.fn().mockResolvedValue(undefined);
  return {
    config: CONFIG,
    db: openDb(":memory:"),
    check: vi.fn().mockImplementation(() => {
      const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
      return Promise.resolve({
        ok: outcome.ok,
        statusCode: outcome.ok ? 200 : 500,
        latencyMs: 50,
        error: outcome.ok ? null : "unexpected status 500",
      });
    }),
    alert: alertSpy,
    now: () => (time += 1000),
    alertSpy,
  };
}

describe("tick", () => {
  it("records a check row and an up state on success", async () => {
    const deps = makeDeps([{ ok: true }]);
    await tick(deps);
    const rows = deps.db.prepare("SELECT * FROM checks").all();
    expect(rows).toHaveLength(1);
    expect(getState(deps.db, "webhooks.cc", "Main site")?.status).toBe("up");
    expect(deps.alertSpy).not.toHaveBeenCalled();
  });

  it("alerts once after two consecutive failures", async () => {
    const deps = makeDeps([{ ok: false }]);
    await tick(deps);
    expect(deps.alertSpy).not.toHaveBeenCalled();
    await tick(deps);
    expect(deps.alertSpy).toHaveBeenCalledOnce();
    expect(deps.alertSpy.mock.calls[0][0]).toMatchObject({
      site: "webhooks.cc",
      checkpoint: "Main site",
      transition: "went-down",
      error: "unexpected status 500",
    });
    await tick(deps);
    expect(deps.alertSpy).toHaveBeenCalledOnce();
    expect(getState(deps.db, "webhooks.cc", "Main site")?.status).toBe("down");
  });

  it("alerts recovery with the downSince timestamp", async () => {
    const deps = makeDeps([{ ok: false }, { ok: false }, { ok: true }]);
    await tick(deps);
    await tick(deps);
    const downSince = getState(deps.db, "webhooks.cc", "Main site")?.since;
    await tick(deps);
    expect(deps.alertSpy).toHaveBeenCalledTimes(2);
    expect(deps.alertSpy.mock.calls[1][0]).toMatchObject({
      transition: "recovered",
      downSince,
    });
    expect(getState(deps.db, "webhooks.cc", "Main site")?.status).toBe("up");
  });

  it("does not alert when config has no alerts block", async () => {
    const deps = makeDeps([{ ok: false }]);
    deps.config = { ...CONFIG, alerts: undefined };
    await tick(deps);
    await tick(deps);
    expect(deps.alertSpy).not.toHaveBeenCalled();
    expect(getState(deps.db, "webhooks.cc", "Main site")?.status).toBe("down");
  });

  it("finishes the other checkpoints when one throws", async () => {
    const deps = makeDeps([{ ok: true }]);
    deps.config = {
      ...CONFIG,
      sites: [
        {
          ...CONFIG.sites[0],
          checkpoints: [
            { name: "Broken", url: "https://broken.example.com" },
            { name: "Main site", url: "https://webhooks.cc" },
          ],
        },
      ],
    };
    const good = deps.check;
    deps.check = vi.fn((url: string) =>
      url.includes("broken")
        ? Promise.reject(new Error("db exploded"))
        : good(url),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(tick(deps)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "[scheduler] checkpoint tick failed",
      expect.any(Error),
    );
    expect(getState(deps.db, "webhooks.cc", "Main site")?.status).toBe("up");
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

describe("skipWhileRunning", () => {
  it("skips calls that arrive while the task is still running", async () => {
    let release!: () => void;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const onSkip = vi.fn();
    const run = skipWhileRunning(task, onSkip);

    const first = run();
    await run();
    expect(task).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledOnce();

    release();
    await first;
    const third = run();
    release();
    await third;
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("releases the guard when the task throws", async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const run = skipWhileRunning(task, () => {});
    await expect(run()).rejects.toThrow("boom");
    task.mockResolvedValueOnce(undefined);
    await run();
    expect(task).toHaveBeenCalledTimes(2);
  });
});
