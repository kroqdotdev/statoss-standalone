"use client";

import {
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { CheckPanel } from "./CheckPanel";
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
import {
  FLAT_STRIP,
  STRIP_H,
  stripLayers,
  TIMED_STRIP,
} from "@/lib/strip-shapes";
import { useViewerZone } from "@/lib/viewer-zone";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const H = STRIP_H;

/** An incident or a maintenance window that touches this strip's row. */
export interface StripSpan {
  title: string;
  maintenance: boolean;
  from: number;
  /** Null while it is open. */
  to: number | null;
}

/** A deploy: a version and the moment it went out. */
export interface StripMark {
  at: number;
  label: string;
}

interface Props {
  buckets: Bucket[];
  range: RangeKey;
  summary: WindowSummary;
  /** The monitor or component name, for assistive technology and the panel. */
  name: string;
  /** Draws the slow line and colours buckets over it. */
  slowThresholdMs?: number | null;
  /** False for checks with no response time: every passed bar is one height. */
  timed?: boolean;
  /**
   * checks: a monitor's strip, whose bars open the checks behind them.
   * states: a component's, whose bars are the state it was in.
   */
  kind?: "checks" | "states";
  /** Incidents and windows to name on the bars they touched. */
  spans?: StripSpan[];
  /** Deploys, drawn as dashed lines and named on their bars. */
  marks?: StripMark[];
}

/**
 * When a bucket is, in the visitor's zone. A day's bucket is a UTC day
 * whoever looks at it, so it is named by its UTC date.
 */
function bucketLabel(ts: number, range: RangeKey, zone: string): string {
  const { bucketMs } = RANGES[range];
  if (bucketMs === DAY_MS) return formatUtcDay(ts);
  const end = formatUtcClock(ts + bucketMs, zone);
  return range === "7d"
    ? `${formatUtcWeekdayClock(ts, zone)} to ${end}`
    : `${formatUtcClock(ts, zone)} to ${end}`;
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

/** What a component was, in the bar's span. */
function describeState(b: Bucket): string {
  if (b.total === 0) return "no record";
  if (b.up === 0) return "outage";
  return b.slow > 0 ? "degraded" : "operational";
}

/** The incidents and windows that touched a bucket, as the end of its line. */
function touching(spans: StripSpan[], b: Bucket, bucketMs: number): string {
  const hit = spans.filter(
    (s) => s.from < b.ts + bucketMs && (s.to === null || s.to > b.ts),
  );
  if (hit.length === 0) return "";
  return ` ${hit
    .map((s) => `${s.maintenance ? "Maintenance" : "Incident"}: ${s.title}.`)
    .join(" ")}`;
}

/** The deploys that went out inside a bucket, as the end of its line. */
function deployed(marks: StripMark[], b: Bucket, bucketMs: number): string {
  const hit = marks.filter((m) => m.at >= b.ts && m.at < b.ts + bucketMs);
  if (hit.length === 0) return "";
  return ` Deploy: ${hit.map((m) => m.label).join(", ")}.`;
}

function describeBucket(
  b: Bucket,
  range: RangeKey,
  zone: string,
  kind: "checks" | "states",
): string {
  const when = bucketLabel(b.ts, range, zone);
  if (kind === "states") return `${when}: ${describeState(b)}`;
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

const SLOT_WORDS: Record<RangeKey, string> = {
  "24h": "5-minute slots",
  "7d": "hours",
  "90d": "days",
  "1y": "days",
};

/** A component's window in a sentence, from its bars. */
function describeStates(buckets: Bucket[], range: RangeKey): string {
  const known = buckets.filter((b) => b.total > 0);
  if (known.length === 0) return "No record in this window yet";
  const off = known.filter((b) => b.up === 0 || b.slow > 0).length;
  return off === 0
    ? "Operational throughout"
    : `Not operational in ${formatCount(off)} of ${formatCount(known.length)} ${SLOT_WORDS[range]}`;
}

/**
 * Which buckets get an axis label, and what it says: every six hours on
 * the clock and every midnight, as the visitor's zone has them, and the
 * first of each UTC month on the day views.
 */
function axisTicks(
  buckets: Bucket[],
  range: RangeKey,
  zone: string,
): Array<{ index: number; label: string }> {
  const ticks: Array<{ index: number; label: string }> = [];
  buckets.forEach((b, index) => {
    if (range === "24h") {
      const clock = formatUtcClock(b.ts, zone);
      if (/^(00|06|12|18):00$/.test(clock)) ticks.push({ index, label: clock });
    } else if (range === "7d") {
      const day = formatUtcWeekdayClock(b.ts, zone).slice(0, 3);
      if (
        index > 0 &&
        day !== formatUtcWeekdayClock(buckets[index - 1].ts, zone).slice(0, 3)
      )
        ticks.push({ index, label: day });
    } else if (new Date(b.ts).getUTCDate() === 1) {
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
  timed = true,
  kind = "checks",
  spans = [],
  marks = [],
}: Props) {
  const [active, setActive] = useState<number | null>(null);
  /** The bucket whose checks are open in the panel, by its start. */
  const [opened, setOpened] = useState<number | null>(null);
  const readoutId = useId();
  const zone = useViewerZone();
  const n = buckets.length;
  const { bucketMs } = RANGES[range];
  const scaleMax = Math.max(...buckets.map((b) => b.latencyMs ?? 0), 1);
  const ticks = axisTicks(buckets, range, zone);
  const layers = useMemo(
    () =>
      stripLayers(
        buckets,
        scaleMax,
        slowThresholdMs,
        timed ? TIMED_STRIP : FLAT_STRIP,
      ),
    [buckets, scaleMax, slowThresholdMs, timed],
  );
  const pixels = timed ? 72 : 32;
  // The slow line, as a share of the strip's height from the top.
  const thresholdTop =
    timed && slowThresholdMs !== null && slowThresholdMs < scaleMax
      ? H - (slowThresholdMs / scaleMax) * H
      : null;
  const opens = kind === "checks";

  const indexAt = (e: { clientX: number; currentTarget: HTMLDivElement }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left) / rect.width) * n);
    return Math.min(n - 1, Math.max(0, i));
  };

  const onPointer = (e: PointerEvent<HTMLDivElement>) => setActive(indexAt(e));

  const open = (index: number) => {
    const b = buckets[index];
    if (!opens || (b.total === 0 && b.maintenance === 0)) return;
    setOpened((cur) => (cur === b.ts ? null : b.ts));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : null;
    if (step !== null) {
      e.preventDefault();
      setActive((cur) => Math.min(n - 1, Math.max(0, (cur ?? n - 1) + step)));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : n - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(active ?? n - 1);
    } else if (e.key === "Escape") {
      setActive(null);
      setOpened(null);
    }
  };

  const activeBucket = active === null ? null : buckets[active];
  const windowLine =
    kind === "states"
      ? describeStates(buckets, range)
      : describeWindow(summary);
  const readout =
    activeBucket === null
      ? windowLine
      : `${describeBucket(activeBucket, range, zone, kind)}${
          activeBucket.total > 0 || activeBucket.maintenance > 0 ? "." : ""
        }${touching(spans, activeBucket, bucketMs)}${deployed(marks, activeBucket, bucketMs)}`;
  const openedIndex =
    opened === null ? -1 : buckets.findIndex((b) => b.ts === opened);

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-4 text-[13px] leading-snug">
        <p
          id={readoutId}
          aria-live="polite"
          suppressHydrationWarning
          className={activeBucket === null ? "text-muted" : "text-ink"}
        >
          {readout}
        </p>
        {timed && summary.latencyMs !== null && (
          <p className="shrink-0 text-muted">
            up to {formatCount(Math.round(scaleMax))} ms
          </p>
        )}
      </div>

      <div
        role="img"
        aria-label={`${kind === "states" ? "States of" : "Checks for"} ${name}, ${RANGES[range].phrase}: ${windowLine}. Use the arrow keys to read one bar at a time${
          opens ? ", and Enter to list its checks" : ""
        }.`}
        aria-describedby={readoutId}
        tabIndex={0}
        className={`relative select-none rounded-[2px] ${opens ? "cursor-pointer" : ""}`}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setActive(null)}
        onClick={(e) => open(indexAt(e))}
        onBlur={(e) => {
          // Into the panel of checks, the bar stays read out: dropping the
          // readout would shorten it, move the panel up under a finger
          // half way through a tap, and land the tap on another bar.
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget))
            setActive(null);
        }}
        onKeyDown={onKey}
      >
        <svg
          viewBox={`0 0 ${n} ${H}`}
          preserveAspectRatio="none"
          className="block w-full"
          style={{ height: pixels }}
          aria-hidden="true"
        >
          <path d={layers.maintenance} fill="var(--rule-strong)" />
          <path d={layers.bars} fill="var(--up-soft)" />
          <path d={layers.slowBars} fill="var(--slow-tint)" />
          <path d={layers.caps} fill="var(--up)" />
          <path d={layers.slowCaps} fill="var(--slow)" />
          <path d={layers.timeouts} fill="var(--timeout)" />
          <path d={layers.fails} fill="var(--fail)" />
          {openedIndex >= 0 && (
            <rect
              x={openedIndex}
              width={1}
              y={0}
              height={H}
              fill="var(--hover)"
            />
          )}
          {active !== null && (
            <rect x={active} width={1} y={0} height={H} fill="var(--hover)" />
          )}
        </svg>
        {thresholdTop !== null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-slow opacity-70"
            style={{ top: `${(thresholdTop / H) * pixels}px` }}
          />
        )}
        {marks
          .filter(
            (m) => m.at >= buckets[0].ts && m.at < buckets[0].ts + n * bucketMs,
          )
          .map((m) => (
            <div
              key={`${m.at}-${m.label}`}
              aria-hidden="true"
              className="pointer-events-none absolute top-0 border-l border-dashed border-muted opacity-80"
              style={{
                left: `${((m.at - buckets[0].ts) / (n * bucketMs)) * 100}%`,
                height: pixels,
              }}
            />
          ))}
        <div className="h-px w-full bg-rule-strong" />
        <div className="relative h-5 text-[11px] leading-none text-muted">
          {ticks.map((t) => (
            <span
              key={t.index}
              suppressHydrationWarning
              className="absolute top-0 border-l border-rule-strong pt-1.5 pl-1"
              style={{ left: `${(t.index / n) * 100}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>
      {opens && opened !== null && openedIndex >= 0 && (
        <CheckPanel
          key={opened}
          monitor={name}
          from={opened}
          to={opened + bucketMs}
          label={bucketLabel(opened, range, zone)}
          dayLong={bucketMs >= DAY_MS}
          timed={timed}
          onClose={() => setOpened(null)}
        />
      )}
    </div>
  );
}
