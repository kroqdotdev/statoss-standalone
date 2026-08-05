import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config";
import { getState, openDb } from "./db";
import { tick, type SchedulerDeps } from "./scheduler";

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

  it("survives an alert function that rejects", async () => {
    const deps = makeDeps([{ ok: false }]);
    deps.alert = vi.fn().mockRejectedValue(new Error("smtp down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await tick(deps);
    await expect(tick(deps)).resolves.toBeUndefined();
    errorSpy.mockRestore();
  });
});
