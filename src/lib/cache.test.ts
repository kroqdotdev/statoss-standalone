import { beforeEach, describe, expect, it, vi } from "vitest";
import { cached, clearCache } from "./cache";
import { bumpDataVersion, getDataVersion } from "./data-version";

describe("cached", () => {
  beforeEach(() => clearCache());

  it("computes once per key while the version is unchanged", () => {
    const compute = vi.fn(() => ({ n: 1 }));
    const first = cached("k", compute, 7);
    const second = cached("k", compute, 7);
    expect(second).toBe(first);
    expect(compute).toHaveBeenCalledOnce();
  });

  it("recomputes when the version moves and replaces the entry", () => {
    const compute = vi.fn(() => Math.random());
    cached("k", compute, 1);
    cached("k", compute, 2);
    cached("k", compute, 2);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keeps keys apart", () => {
    expect(cached("a", () => "a", 1)).toBe("a");
    expect(cached("b", () => "b", 1)).toBe("b");
  });

  it("follows the global data version by default", () => {
    const compute = vi.fn(() => getDataVersion());
    const before = cached("v", compute);
    bumpDataVersion();
    const after = cached("v", compute);
    expect(after).toBe(before + 1);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
