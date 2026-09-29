import { describe, expect, it } from "vitest";
import {
  applyResult,
  overallStatus,
  pageOverall,
  type MonitorState,
} from "./state";

const UP: MonitorState = {
  status: "up",
  consecutiveFails: 0,
  consecutiveSlow: 0,
  since: 100,
};
const DOWN: MonitorState = {
  status: "down",
  consecutiveFails: 2,
  consecutiveSlow: 0,
  since: 3000,
};

describe("applyResult", () => {
  it("starts unknown monitors as up without a transition", () => {
    const { next, transition } = applyResult(undefined, true, 1000);
    expect(next).toEqual({ ...UP, since: 1000 });
    expect(transition).toBeNull();
  });

  it("keeps status up after a single failure", () => {
    const { next, transition } = applyResult(UP, false, 2000);
    expect(next).toEqual({ ...UP, consecutiveFails: 1 });
    expect(transition).toBeNull();
  });

  it("goes down on the second consecutive failure", () => {
    const afterOne = applyResult(UP, false, 2000).next;
    const { next, transition } = applyResult(afterOne, false, 3000);
    expect(next).toEqual(DOWN);
    expect(transition).toBe("went-down");
  });

  it("stays down without re-firing the transition", () => {
    const { next, transition } = applyResult(DOWN, false, 4000);
    expect(next).toEqual({ ...DOWN, consecutiveFails: 3 });
    expect(transition).toBeNull();
  });

  it("recovers on the first success", () => {
    const { next, transition } = applyResult(
      { ...DOWN, consecutiveFails: 5 },
      true,
      9000,
    );
    expect(next).toEqual({ ...UP, since: 9000 });
    expect(transition).toBe("recovered");
  });

  it("resets the fail counter on success while up", () => {
    const { next, transition } = applyResult(
      { ...UP, consecutiveFails: 1 },
      true,
      5000,
    );
    expect(next).toEqual(UP);
    expect(transition).toBeNull();
  });

  it("first-ever check failing does not immediately alert", () => {
    const { next, transition } = applyResult(undefined, false, 1000);
    expect(next).toEqual({ ...UP, consecutiveFails: 1, since: 1000 });
    expect(transition).toBeNull();
  });

  it("goes slow on the second slow success and back on one fast one", () => {
    const slow = { ok: true, slow: true };
    const one = applyResult(UP, slow, 2000);
    expect(one.next.status).toBe("up");
    expect(one.transition).toBeNull();
    const two = applyResult(one.next, slow, 3000);
    expect(two.next).toEqual({
      status: "slow",
      consecutiveFails: 0,
      consecutiveSlow: 2,
      since: 3000,
    });
    expect(two.transition).toBe("went-slow");
    const back = applyResult(two.next, { ok: true, slow: false }, 4000);
    expect(back.next).toEqual({ ...UP, since: 4000 });
    expect(back.transition).toBe("back-to-normal");
  });

  it("reports a recovery before a slowness when it comes back slow", () => {
    const { next, transition } = applyResult(
      DOWN,
      { ok: true, slow: true },
      9000,
    );
    expect(transition).toBe("recovered");
    expect(next).toEqual({ ...UP, consecutiveSlow: 1, since: 9000 });
  });

  it("goes down from slow after two failures", () => {
    const slow: MonitorState = { ...UP, status: "slow", consecutiveSlow: 2 };
    const one = applyResult(slow, false, 2000);
    expect(one.next.status).toBe("slow");
    const two = applyResult(one.next, false, 3000);
    expect(two.next.status).toBe("down");
    expect(two.transition).toBe("went-down");
  });
});

describe("overallStatus", () => {
  it("is operational when every monitor is up (or there are none)", () => {
    expect(overallStatus(["up", "up"])).toBe("operational");
    expect(overallStatus([])).toBe("operational");
  });

  it("is partial when some are down", () => {
    expect(overallStatus(["up", "down"])).toBe("partial");
  });

  it("is major when all are down", () => {
    expect(overallStatus(["down", "down"])).toBe("major");
  });

  it("is degraded when some are slow and none down", () => {
    expect(overallStatus(["up", "slow"])).toBe("degraded");
    expect(overallStatus(["slow", "down"])).toBe("partial");
  });

  it("is unknown until any monitor has been checked", () => {
    expect(overallStatus(["unknown", "unknown"])).toBe("unknown");
  });

  it("ignores unchecked monitors once others are known", () => {
    expect(overallStatus(["up", "unknown"])).toBe("operational");
    expect(overallStatus(["down", "unknown"])).toBe("major");
    expect(overallStatus(["down", "up", "unknown"])).toBe("partial");
  });
});

describe("pageOverall", () => {
  it("lets an open incident's impact raise the headline", () => {
    expect(pageOverall(["up"], ["partial"])).toBe("partial");
    expect(pageOverall(["unknown"], ["major"])).toBe("major");
  });

  it("never lowers what the checks say", () => {
    expect(pageOverall(["down", "down"], ["degraded"])).toBe("major");
    expect(pageOverall(["up"], ["none"])).toBe("operational");
  });
});
