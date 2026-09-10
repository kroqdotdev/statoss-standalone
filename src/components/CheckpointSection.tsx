import { CheckStrip } from "./CheckStrip";
import { FailureList } from "./FailureList";
import { formatDuration, formatPercent, formatUtcDateTime } from "@/lib/format";
import type { Bucket, FailureRun, WindowSummary } from "@/lib/queries";
import type { RangeKey } from "@/lib/ranges";
import type { CheckpointStatus } from "@/lib/state";

export interface CheckpointView {
  name: string;
  status: CheckpointStatus;
  /** When the current status began, or null before the first check. */
  since: number | null;
  buckets: Bucket[];
  summary: WindowSummary;
  runs: FailureRun[];
  /** Totals for the fixed last-24-hours window, used by the headline. */
  last24h: WindowSummary;
}

function statusLine(cp: CheckpointView, now: number): string {
  if (cp.status === "unknown" || cp.since === null)
    return "Waiting for the first check";
  const duration = formatDuration(now - cp.since);
  return cp.status === "up"
    ? `Up for ${duration}`
    : `Down for ${duration}, since ${formatUtcDateTime(cp.since, now)}`;
}

export function CheckpointSection({
  checkpoint,
  range,
  now,
}: {
  checkpoint: CheckpointView;
  range: RangeKey;
  now: number;
}) {
  const down = checkpoint.status === "down";
  const pct = formatPercent(checkpoint.summary.up, checkpoint.summary.total);
  return (
    <section className="border-t border-rule py-8">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-[17px] font-medium leading-tight">
          {checkpoint.name}
        </h2>
        <p className="flex items-baseline gap-4 text-[15px]">
          <span className={down ? "font-medium text-fail" : "text-muted"}>
            {statusLine(checkpoint, now)}
          </span>
          {pct !== "" && (
            <span className="text-ink" title="Checks passed in this window">
              {pct}
            </span>
          )}
        </p>
      </div>
      <CheckStrip
        buckets={checkpoint.buckets}
        range={range}
        summary={checkpoint.summary}
        name={checkpoint.name}
      />
      <FailureList runs={checkpoint.runs} now={now} />
    </section>
  );
}
