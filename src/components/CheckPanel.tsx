"use client";

import { useEffect, useState } from "react";
import type { CheckDetail } from "@/lib/check-detail";
import {
  failureSummary,
  formatCount,
  formatUtcClockSeconds,
  formatUtcDay,
  pluralize,
} from "@/lib/format";
import { useViewerZone } from "@/lib/viewer-zone";

/**
 * The checks behind one bar, listed under the strip: when each ran, what
 * it found, its status code and its response time.
 */
export function CheckPanel({
  monitor,
  from,
  to,
  label,
  dayLong,
  timed,
  now,
  onClose,
}: {
  monitor: string;
  from: number;
  to: number;
  /** The bar's span in words. */
  label: string;
  /** A bar of a day: its checks may fall on two dates where the visitor is. */
  dayLong: boolean;
  timed: boolean;
  /** What a check's year is compared with: one from another year says it. */
  now: number;
  onClose: () => void;
}) {
  const zone = useViewerZone();
  const [detail, setDetail] = useState<CheckDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      monitor,
      from: String(from),
      to: String(to),
    });
    fetch(`/checks?${params}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<CheckDetail>;
      })
      .then(setDetail)
      .catch((err: unknown) => {
        if (!(err instanceof Error && err.name === "AbortError"))
          setFailed(true);
      });
    return () => controller.abort();
  }, [monitor, from, to]);

  const totals = detail
    ? [
        pluralize(detail.total, "check"),
        failureSummary(detail.total - detail.passed, detail.timeouts) ??
          "all passed",
        ...(detail.slow > 0 ? [`${formatCount(detail.slow)} slow`] : []),
        ...(detail.maintenance > 0
          ? [`${formatCount(detail.maintenance)} during maintenance`]
          : []),
        ...(detail.latency && timed
          ? [
              detail.latency.min !== null && detail.latency.max !== null
                ? `${formatCount(detail.latency.min)} to ${formatCount(detail.latency.max)} ms, average ${formatCount(detail.latency.mean)} ms`
                : `average ${formatCount(detail.latency.mean)} ms`,
            ]
          : []),
      ].join(", ")
    : null;

  return (
    <section
      aria-label={`Checks for ${monitor}, ${label}`}
      className="mt-3 rounded-xl border border-rule bg-none px-4 py-3 text-[13px] leading-snug"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h4 className="font-medium">Checks, {label}</h4>
        <button
          type="button"
          onClick={onClose}
          className="page-link shrink-0 cursor-pointer"
        >
          Close
        </button>
      </div>
      {failed ? (
        <p className="mt-2 text-muted">The checks could not be read.</p>
      ) : detail === null ? (
        <p className="mt-2 text-muted">Reading the checks.</p>
      ) : (
        <>
          <p className="mt-1 text-muted">{totals}</p>
          {detail.listed === "none" && (
            <p className="mt-2 text-muted">
              The single checks of this time are no longer kept. The figures are
              the hours&apos; totals.
            </p>
          )}
          {detail.listed === "partial" && (
            <p className="mt-2 text-muted">
              Some of the single checks of this time are no longer kept. The
              figures are the hours&apos; totals, and the list holds what is
              left.
            </p>
          )}
          {detail.listed === "trouble" && (
            <p className="mt-2 text-muted">
              {detail.checks.length === 0
                ? "Every check passed, so there is nothing to single out."
                : "Too many to list them all: these are the ones that failed, were slow or ran during maintenance."}
            </p>
          )}
          {detail.checks.length > 0 && (
            <ol className="mt-2 max-h-72 space-y-1 overflow-y-auto pr-1">
              {detail.checks.map((c) => (
                <li
                  key={c.ts}
                  className="grid grid-cols-[auto_auto_1fr_auto] items-baseline gap-x-3"
                >
                  <span
                    aria-hidden="true"
                    className={`size-2 self-center rounded-full ${
                      c.maintenance
                        ? "bg-rule-strong"
                        : !c.ok
                          ? c.problem === "Timed out"
                            ? "bg-timeout"
                            : "bg-fail"
                          : c.slow
                            ? "bg-slow"
                            : "bg-up"
                    }`}
                  />
                  <time
                    dateTime={new Date(c.ts).toISOString()}
                    className="text-muted"
                  >
                    {dayLong ? `${formatUtcDay(c.ts, zone, now)} ` : ""}
                    {formatUtcClockSeconds(c.ts, zone)}
                  </time>
                  <span>
                    {c.ok ? (c.slow ? "Passed, slow" : "Passed") : c.problem}
                    {c.maintenance ? ", during maintenance" : ""}
                  </span>
                  <span className="text-right text-muted">
                    {c.latencyMs !== null && timed
                      ? `${formatCount(c.latencyMs)} ms`
                      : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
