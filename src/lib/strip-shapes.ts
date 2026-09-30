import type { Bucket } from "./queries";

/**
 * The bars of a check strip, drawn as one path per colour rather than two
 * or three rectangles per bucket. A day of one-minute buckets was about 860
 * SVG elements; as paths it is a few strings with coordinates to two
 * decimals, the same picture in a quarter of the markup. The strip's
 * pointer and keyboard handling work from the pointer's position, not the
 * shapes, so nothing else changes.
 */

/** The strip's height in its own units. */
export const STRIP_H = 100;
/** Bars for successful checks never drop below this, so they stay visible. */
export const MIN_BAR = 4;
/** Smallest failure mark, so one timeout among 1,440 checks is still seen. */
export const MIN_MARK = 9;
/** The darker top edge of a bar. */
export const CAP = 2.5;
/** Each bucket's column is one unit wide; its bar leaves a gap either side. */
const BAR_X = 0.12;
const BAR_W = 0.76;

/** One path per fill, drawn in this order: later ones sit over earlier ones. */
export interface StripLayers {
  maintenance: string;
  bars: string;
  slowBars: string;
  caps: string;
  slowCaps: string;
  timeouts: string;
  fails: string;
}

/** "0.76" as ".76", "-0.5" as "-.5", at most two decimals, never "-0". */
function num(v: number): string {
  const r = Math.round(v * 100) / 100;
  if (r === 0) return "0";
  const s = String(r);
  return s.startsWith("0.")
    ? s.slice(1)
    : s.startsWith("-0.")
      ? `-${s.slice(2)}`
      : s;
}

/**
 * Rectangles written as one path. Each one starts with a move relative to
 * the previous one's corner (a closed subpath leaves the pen there), which
 * keeps the numbers short.
 */
class Rects {
  private d = "";
  private at: [number, number] | null = null;

  add(x: number, y: number, w: number, h: number): void {
    if (h <= 0 || w <= 0) return;
    const move = this.at
      ? `m${num(x - this.at[0])} ${num(y - this.at[1])}`
      : `M${num(x)} ${num(y)}`;
    this.d += `${move}h${num(w)}v${num(h)}h${num(-w)}z`;
    // The corner as the path will have it, so rounding does not drift.
    this.at = [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  }

  toString(): string {
    return this.d;
  }
}

/** The sizes a strip draws with, in its own units out of STRIP_H. */
export interface StripSizes {
  /** The shortest bar for checks with a response time. */
  minBar: number;
  /** The bar for passing checks without one (heartbeats, certificates). */
  flatBar: number;
  minMark: number;
  cap: number;
}

/** A strip of checks with response times. */
export const TIMED_STRIP: StripSizes = {
  minBar: MIN_BAR,
  flatBar: MIN_BAR * 2,
  minMark: MIN_MARK,
  cap: CAP,
};

/**
 * A strip without response times, which is drawn less than half as tall:
 * every passed bar is one height, and the marks and caps are scaled up so
 * they are as thick on the screen as on a timed strip.
 */
export const FLAT_STRIP: StripSizes = {
  minBar: 55,
  flatBar: 55,
  minMark: 20,
  cap: 5.5,
};

/**
 * The strip's shapes for these buckets on a latency scale topping out at
 * `scaleMax`.
 */
export function stripLayers(
  buckets: Bucket[],
  scaleMax: number,
  slowThresholdMs: number | null,
  sizes: StripSizes = TIMED_STRIP,
): StripLayers {
  const H = STRIP_H;
  const out = {
    maintenance: new Rects(),
    bars: new Rects(),
    slowBars: new Rects(),
    caps: new Rects(),
    slowCaps: new Rects(),
    timeouts: new Rects(),
    fails: new Rects(),
  };
  buckets.forEach((b, i) => {
    const x = i + BAR_X;
    if (b.total === 0) {
      // Maintenance only: a quiet grey stub, nothing counted.
      if (b.maintenance > 0)
        out.maintenance.add(x, H - sizes.flatBar, BAR_W, sizes.flatBar);
      return;
    }
    const failed = b.total - b.up;
    // Over the threshold, or, without a response time (a component's
    // degraded spell), marked slow outright.
    const slow =
      (slowThresholdMs !== null &&
        b.latencyMs !== null &&
        b.latencyMs > slowThresholdMs) ||
      (b.latencyMs === null && b.slow > 0 && b.up > 0);
    // A check without a response time (a heartbeat) draws a flat bar, so a
    // quiet day still reads as checks that passed.
    const h =
      b.latencyMs === null
        ? b.up > 0
          ? sizes.flatBar
          : 0
        : Math.max(sizes.minBar, (b.latencyMs / scaleMax) * H);
    if (h > 0) {
      (slow ? out.slowBars : out.bars).add(x, H - h, BAR_W, h);
      (slow ? out.slowCaps : out.caps).add(x, H - h, BAR_W, sizes.cap);
    }
    // Failed checks hang from the top rail, sized by their share of the
    // bucket but never smaller than a visible tick. A bucket with no
    // successful check fills the whole column.
    const mark =
      failed === 0
        ? 0
        : b.up === 0
          ? H
          : Math.max(sizes.minMark, (failed / b.total) * H);
    if (mark > 0)
      (b.timeouts === failed ? out.timeouts : out.fails).add(x, 0, BAR_W, mark);
  });
  return {
    maintenance: String(out.maintenance),
    bars: String(out.bars),
    slowBars: String(out.slowBars),
    caps: String(out.caps),
    slowCaps: String(out.slowCaps),
    timeouts: String(out.timeouts),
    fails: String(out.fails),
  };
}
