import { describe, expect, it } from "vitest";
import { applyResult, overallStatus, type CheckpointState } from "./state";

const UP: CheckpointState = { status: "up", consecutiveFails: 0, since: 100 };

describe("applyResult", () => {
  it("starts unknown checkpoints as up without a transition", () => {
    const { next, transition } = applyResult(undefined, true, 1000);
    expect(next).toEqual({ status: "up", consecutiveFails: 0, since: 1000 });
    expect(transition).toBeNull();
  });

  it("keeps status up after a single failure", () => {
    const { next, transition } = applyResult(UP, false, 2000);
    expect(next).toEqual({ status: "up", consecutiveFails: 1, since: 100 });
    expect(transition).toBeNull();
  });

  it("goes down on the second consecutive failure", () => {
    const afterOne = applyResult(UP, false, 2000).next;
    const { next, transition } = applyResult(afterOne, false, 3000);
    expect(next).toEqual({ status: "down", consecutiveFails: 2, since: 3000 });
    expect(transition).toBe("went-down");
  });

  it("stays down without re-firing the transition", () => {
    const down: CheckpointState = {
      status: "down",
      consecutiveFails: 2,
      since: 3000,
    };
    const { next, transition } = applyResult(down, false, 4000);
    expect(next).toEqual({ status: "down", consecutiveFails: 3, since: 3000 });
    expect(transition).toBeNull();
  });

  it("recovers on the first success", () => {
    const down: CheckpointState = {
      status: "down",
      consecutiveFails: 5,
      since: 3000,
    };
    const { next, transition } = applyResult(down, true, 9000);
    expect(next).toEqual({ status: "up", consecutiveFails: 0, since: 9000 });
    expect(transition).toBe("recovered");
  });

  it("resets the fail counter on success while up", () => {
    const flaky: CheckpointState = {
      status: "up",
      consecutiveFails: 1,
      since: 100,
    };
    const { next, transition } = applyResult(flaky, true, 5000);
    expect(next).toEqual({ status: "up", consecutiveFails: 0, since: 100 });
    expect(transition).toBeNull();
  });

  it("first-ever check failing does not immediately alert", () => {
    const { next, transition } = applyResult(undefined, false, 1000);
    expect(next).toEqual({ status: "up", consecutiveFails: 1, since: 1000 });
    expect(transition).toBeNull();
  });
});

describe("overallStatus", () => {
  it("is operational when every checkpoint is up (or there are none)", () => {
    expect(overallStatus(["up", "up"])).toBe("operational");
    expect(overallStatus([])).toBe("operational");
  });

  it("is partial when some are down", () => {
    expect(overallStatus(["up", "down"])).toBe("partial");
  });

  it("is major when all are down", () => {
    expect(overallStatus(["down", "down"])).toBe("major");
  });
});
