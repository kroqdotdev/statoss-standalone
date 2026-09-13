import { CheckStrip } from "./CheckStrip";
import { FailureList } from "./FailureList";
import { formatDuration, formatPercent, formatUtcDateTime } from "@/lib/format";
import type { Bucket, FailureRun, WindowSummary } from "@/lib/queries";
import type { RangeKey } from "@/lib/ranges";
import type { CheckpointStatus } from "@/lib/state";

export interface CheckpointView {
  name: string;
  /** Checkpoints with the same group are shown together. */
  group: string | null;
  slowThresholdMs: number | null;
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
  if (cp.status === "up") return `Up for ${duration}`;
  if (cp.status === "slow") return `Slow for ${duration}`;
  return `Down for ${duration}, since ${formatUtcDateTime(cp.since, now)}`;
}

export function CheckpointSection({
  checkpoint,
  range,
  now,
  incident = null,
  as: Heading = "h2",
}: {
  checkpoint: CheckpointView;
  range: RangeKey;
  now: number;
  /** The title of an open incident that names this checkpoint, if any. */
  incident?: string | null;
  /** Inside a group the checkpoint heading sits one level down. */
  as?: "h2" | "h3";
}) {
  const tone =
    checkpoint.status === "down"
      ? "font-medium text-fail"
      : checkpoint.status === "slow"
        ? "font-medium text-slow"
        : "text-muted";
  const pct = formatPercent(checkpoint.summary.up, checkpoint.summary.total);
  return (
    <section className="border-t border-rule py-8">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <Heading className="text-[17px] font-medium leading-tight">
          {checkpoint.name}
        </Heading>
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[15px]">
          {incident !== null && (
            <span className="text-[13.5px] text-fail" title={incident}>
              Incident open
            </span>
          )}
          <span className={tone}>{statusLine(checkpoint, now)}</span>
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
        slowThresholdMs={checkpoint.slowThresholdMs}
      />
      <FailureList runs={checkpoint.runs} now={now} />
    </section>
  );
}
