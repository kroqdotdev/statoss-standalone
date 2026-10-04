import { describe, expect, it } from "vitest";
import { EMPTY_BUCKET, type Bucket } from "./queries";
import { FLAT_STRIP, stripLayers } from "./strip-shapes";

const bucket = (ts: number, over: Partial<Bucket>): Bucket => ({
  ts,
  ...EMPTY_BUCKET,
  ...over,
});

describe("stripLayers", () => {
  it("draws a bar and its cap for a bucket that passed, by its response time", () => {
    const layers = stripLayers(
      [bucket(0, { total: 2, up: 2, latencyMs: 50 })],
      100,
      null,
    );
    expect(layers.bars).toBe("M.12 50h.76v50h-.76z");
    expect(layers.caps).toBe("M.12 50h.76v2.5h-.76z");
    expect(layers.fails).toBe("");
  });

  it("colours a bucket over the threshold slow, and hangs failures from the top", () => {
    const layers = stripLayers(
      [
        bucket(0, { total: 10, up: 9, timeouts: 1, latencyMs: 900 }),
        bucket(1, { total: 4, up: 0 }),
        bucket(2, { total: 1440, up: 1439, latencyMs: 100 }),
      ],
      1000,
      800,
    );
    expect(layers.slowBars).toContain("M.12 10");
    // One timeout in ten: a tenth of the height, from the top rail.
    expect(layers.timeouts).toBe("M.12 0h.76v10h-.76z");
    // Nothing passed: the whole column. One failure in 1,440: still a mark.
    expect(layers.fails).toBe("M1.12 0h.76v100h-.76zm1 0h.76v9h-.76z");
  });

  it("colours a bucket slow when half its checks were, though its median is under the line", () => {
    const layers = stripLayers(
      [
        bucket(0, { total: 5, up: 5, slow: 3, latencyMs: 200 }),
        bucket(1, { total: 5, up: 5, slow: 2, latencyMs: 200 }),
      ],
      1000,
      300,
    );
    expect(layers.slowBars).toBe("M.12 80h.76v20h-.76z");
    expect(layers.bars).toBe("M1.12 80h.76v20h-.76z");
  });

  it("marks a bucket of maintenance checks only, and leaves an empty one out", () => {
    const layers = stripLayers(
      [bucket(0, {}), bucket(1, { maintenance: 3 })],
      1,
      null,
    );
    expect(layers.maintenance).toBe("M1.12 92h.76v8h-.76z");
    expect(layers.bars).toBe("");
  });

  it("draws checks without a response time at one height", () => {
    const layers = stripLayers(
      [bucket(0, { total: 1, up: 1 }), bucket(1, { total: 1, up: 1, slow: 1 })],
      1,
      null,
      FLAT_STRIP,
    );
    expect(layers.bars).toBe("M.12 45h.76v55h-.76z");
    // A component's degraded spell: slow without a response time.
    expect(layers.slowBars).toBe("M1.12 45h.76v55h-.76z");
  });
});
