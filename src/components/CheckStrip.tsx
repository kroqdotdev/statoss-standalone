"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  failureSummary,
  formatCount,
  formatUtcClock,
  formatUtcDay,
  formatUtcWeekdayClock,
  pluralize,
} from "@/lib/format";
import type { Bucket, WindowSummary } from "@/lib/queries";
import { RANGES, type RangeKey } from "@/lib/ranges";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const H = 100;
/** Bars for successful checks never drop below this, so they stay visible. */
const MIN_BAR = 4;
/** Smallest failure mark, so one timeout among 1,440 checks is still seen. */
const MIN_MARK = 9;
const CAP = 2.5;

interface Props {
  buckets: Bucket[];
  range: RangeKey;
  summary: WindowSummary;
  /** The monitor name, for assistive technology. */
  name: string;
  /** Draws the slow line and colours buckets over it. */
  slowThresholdMs?: number | null;
}

function bucketLabel(ts: number, range: RangeKey): string {
  const { bucketMs } = RANGES[range];
  if (range === "90d") return formatUtcDay(ts);
  const end = formatUtcClock(ts + bucketMs);
  return range === "7d"
    ? `${formatUtcWeekdayClock(ts)} to ${end}`
    : `${formatUtcClock(ts)} to ${end}`;
}

function describeCounts(s: {
  total: number;
  up: number;
  timeouts: number;
  slow: number;
  maintenance: number;
  latencyMs: number | null;
}): string {
  const parts = [pluralize(s.total, "check")];
  if (s.latencyMs !== null)
    parts.push(`average ${formatCount(s.latencyMs)} ms`);
  const failed = failureSummary(s.total - s.up, s.timeouts);
  parts.push(failed ?? "all passed");
  if (s.slow > 0) parts.push(`${formatCount(s.slow)} slow`);
  if (s.maintenance > 0)
    parts.push(`${formatCount(s.maintenance)} during maintenance`);
  return parts.join(", ");
}

function describeBucket(b: Bucket, range: RangeKey): string {
  const when = bucketLabel(b.ts, range);
  if (b.total === 0 && b.maintenance === 0) return `${when}: no checks`;
  if (b.total === 0)
    return `${when}: ${pluralize(b.maintenance, "check")} during maintenance, not counted`;
  return `${when}: ${describeCounts(b)}`;
}

function describeWindow(s: WindowSummary): string {
  if (s.total === 0 && s.maintenance === 0)
    return "No checks in this window yet";
  if (s.total === 0)
    return `${pluralize(s.maintenance, "check")} during maintenance, not counted`;
  return describeCounts(s);
}

/** Which buckets get an axis label, and what it says. */
function axisTicks(
  buckets: Bucket[],
  range: RangeKey,
): Array<{ index: number; label: string }> {
  const ticks: Array<{ index: number; label: string }> = [];
  buckets.forEach((b, index) => {
    const d = new Date(b.ts);
    if (range === "24h" && b.ts % (6 * HOUR_MS) === 0) {
      ticks.push({ index, label: formatUtcClock(b.ts) });
    } else if (range === "7d" && b.ts % DAY_MS === 0) {
      ticks.push({ index, label: formatUtcWeekdayClock(b.ts).slice(0, 3) });
    } else if (range === "90d" && d.getUTCDate() === 1) {
      ticks.push({ index, label: formatUtcDay(b.ts).slice(2) });
    }
  });
  // A label near the right edge would overflow the strip.
  return ticks.filter((t) => t.index / buckets.length < 0.93);
}

export function CheckStrip({
  buckets,
  range,
  summary,
  name,
  slowThresholdMs = null,
}: Props) {
  const [active, setActive] = useState<number | null>(null);
  const readoutId = useId();
  const n = buckets.length;
  const scaleMax = Math.max(...buckets.map((b) => b.latencyMs ?? 0), 1);
  const ticks = axisTicks(buckets, range);
  // The slow line, as a share of the strip's height from the top.
  const thresholdTop =
    slowThresholdMs !== null && slowThresholdMs < scaleMax
      ? H - (slowThresholdMs / scaleMax) * H
      : null;

  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left) / rect.width) * n);
    setActive(Math.min(n - 1, Math.max(0, i)));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : null;
    if (step !== null) {
      e.preventDefault();
      setActive((cur) => Math.min(n - 1, Math.max(0, (cur ?? n - 1) + step)));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : n - 1);
    } else if (e.key === "Escape") {
      setActive(null);
    }
  };

  const activeBucket = active === null ? null : buckets[active];
  const readout =
    activeBucket === null
      ? describeWindow(summary)
      : describeBucket(activeBucket, range);

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-4 text-[13px] leading-snug">
        <p
          id={readoutId}
          aria-live="polite"
          className={activeBucket === null ? "text-muted" : "text-ink"}
        >
          {readout}
        </p>
        {summary.latencyMs !== null && (
          <p className="shrink-0 text-muted">
            up to {formatCount(Math.round(scaleMax))} ms
          </p>
        )}
      </div>

      <div
        role="img"
        aria-label={`Checks for ${name}, ${RANGES[range].phrase}: ${describeWindow(summary)}. Use the arrow keys to read one bucket at a time.`}
        aria-describedby={readoutId}
        tabIndex={0}
        className="relative select-none rounded-[2px]"
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        <svg
          viewBox={`0 0 ${n} ${H}`}
          preserveAspectRatio="none"
          shapeRendering="crispEdges"
          className="block h-[72px] w-full"
          aria-hidden="true"
        >
          {buckets.map((b, i) => {
            if (b.total === 0) {
              // Maintenance only: a quiet grey stub, nothing counted.
              if (b.maintenance === 0) return null;
              return (
                <rect
                  key={b.ts}
                  x={i + 0.1}
                  width={0.8}
                  y={H - MIN_BAR * 2}
                  height={MIN_BAR * 2}
                  fill="var(--rule-strong)"
                />
              );
            }
            const failed = b.total - b.up;
            const share = failed / b.total;
            const slow =
              slowThresholdMs !== null &&
              b.latencyMs !== null &&
              b.latencyMs > slowThresholdMs;
            const h =
              b.latencyMs === null
                ? 0
                : Math.max(MIN_BAR, (b.latencyMs / scaleMax) * H);
            // Failed checks hang from the top rail, sized by their share of
            // the bucket but never smaller than a visible tick. A bucket with
            // no successful check fills the whole column.
            const mark =
              failed === 0 ? 0 : b.up === 0 ? H : Math.max(MIN_MARK, share * H);
            return (
              <g key={b.ts}>
                {h > 0 && (
                  <>
                    <rect
                      x={i + 0.1}
                      width={0.8}
                      y={H - h}
                      height={h}
                      fill={slow ? "var(--slow-tint)" : "var(--up-soft)"}
                    />
                    <rect
                      x={i + 0.1}
                      width={0.8}
                      y={H - h}
                      height={CAP}
                      fill={slow ? "var(--slow)" : "var(--up)"}
                    />
                  </>
                )}
                {mark > 0 && (
                  <rect
                    x={i + 0.1}
                    width={0.8}
                    y={0}
                    height={mark}
                    fill={
                      b.timeouts === failed ? "var(--timeout)" : "var(--fail)"
                    }
                  />
                )}
              </g>
            );
          })}
          {active !== null && (
            <rect x={active} width={1} y={0} height={H} fill="var(--hover)" />
          )}
        </svg>
        {thresholdTop !== null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-slow opacity-70"
            style={{ top: `${(thresholdTop / H) * 72}px` }}
          />
        )}
        <div className="h-px w-full bg-rule-strong" />
        <div className="relative h-5 text-[11px] leading-none text-muted">
          {ticks.map((t) => (
            <span
              key={t.index}
              className="absolute top-0 border-l border-rule-strong pt-1.5 pl-1"
              style={{ left: `${(t.index / n) * 100}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
