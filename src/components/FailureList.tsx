import {
  describeError,
  formatDuration,
  formatUtcDateTime,
  pluralize,
} from "@/lib/format";
import type { FailureRun } from "@/lib/queries";

const SHOW = 6;

function runLabel(run: FailureRun): string {
  const labels = Array.from(new Set(run.errors.map(describeError)));
  return labels.length > 0 ? labels.join(", ") : "Failed";
}

function runExtent(run: FailureRun, now: number, intervalMs: number): string {
  if (run.ongoing) {
    return `ongoing, ${formatDuration(now - run.startTs)}`;
  }
  if (run.checks === 1) return "1 check";
  const span = run.endTs - run.startTs + intervalMs;
  return `${pluralize(run.checks, "check")}, ${formatDuration(span)}`;
}

export function FailureList({
  runs,
  now,
  intervalMs,
}: {
  runs: FailureRun[];
  now: number;
  intervalMs: number;
}) {
  if (runs.length === 0) return null;
  const shown = runs.slice(0, SHOW);
  const rest = runs.length - shown.length;
  return (
    <div className="mt-4 text-[13px] leading-snug">
      <ul className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1.5 sm:grid-cols-[auto_9rem_1fr_auto]">
        {shown.map((run) => (
          <li key={run.startTs} className="contents">
            <span
              aria-hidden="true"
              className={`mt-[5px] size-2 rounded-full ${
                run.timeouts === run.checks ? "bg-timeout" : "bg-fail"
              }`}
            />
            <span className="text-ink">{runLabel(run)}</span>
            <span className="col-start-2 text-muted sm:col-start-auto">
              {formatUtcDateTime(run.startTs, now)}
            </span>
            <span className="col-start-3 row-start-auto text-right text-muted sm:col-start-auto">
              {runExtent(run, now, intervalMs)}
            </span>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <p className="mt-2 text-muted">
          and {pluralize(rest, "earlier failed run")} in this window
        </p>
      )}
    </div>
  );
}
