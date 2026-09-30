import { LocalTime } from "./LocalTime";
import { describeError, formatSpan, pluralize } from "@/lib/format";
import type { FailureRun } from "@/lib/queries";

const SHOW = 6;

function runLabel(run: FailureRun): string {
  const labels = Array.from(new Set(run.errors.map(describeError)));
  return labels.length > 0 ? labels.join(", ") : "Failed";
}

/**
 * How long the monitor was not responding: from the first failed check to
 * the first successful one after it. While the run is still going, the
 * timer counts from the first failure to now.
 */
function runExtent(run: FailureRun, now: number): string {
  const checks = pluralize(run.checks, "check");
  if (run.ongoing) return `${formatSpan(now - run.startTs)} so far, ${checks}`;
  if (run.recoveredTs === null) return checks;
  return `${formatSpan(run.recoveredTs - run.startTs)}, ${checks}`;
}

export function FailureList({
  runs,
  now,
}: {
  runs: FailureRun[];
  now: number;
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
              <LocalTime ts={run.startTs} style="dateTime" now={now} />
            </span>
            <span className="col-start-3 row-start-auto text-right text-muted sm:col-start-auto">
              {runExtent(run, now)}
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
