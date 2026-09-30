import Link from "next/link";
import { CheckStrip } from "./CheckStrip";
import { FailureList } from "./FailureList";
import { LocalTime } from "./LocalTime";
import type { MonitorType } from "@/lib/config";
import {
  formatDuration,
  formatPercent,
  formatUtcDate,
  rowId,
} from "@/lib/format";
import type { Bucket, FailureRun, WindowSummary } from "@/lib/queries";
import type { RangeKey } from "@/lib/ranges";
import type { MonitorStatus } from "@/lib/state";
import { IMPACT_LABELS, shownState, type Stated } from "@/lib/stated";

export interface MonitorView {
  name: string;
  type: MonitorType;
  /** Whether its checks have a response time to draw. */
  timed: boolean;
  /** Certificate and domain monitors: the expiry date last read. */
  expiresAt: number | null;
  /** Monitors with the same group are shown together. */
  group: string | null;
  slowThresholdMs: number | null;
  status: MonitorStatus;
  /** True when the checks have stopped arriving and the status is unknown for it. */
  stale: boolean;
  /** When the last check ran. */
  checkedAt: number | null;
  /** When the current status began, or null before the first check. */
  since: number | null;
  buckets: Bucket[];
  summary: WindowSummary;
  runs: FailureRun[];
  /** Totals for the fixed last-24-hours window, used by the headline. */
  last24h: WindowSummary;
}

function statusLine(cp: MonitorView, now: number): string {
  if (cp.stale && cp.checkedAt !== null)
    return `Last checked ${formatDuration(now - cp.checkedAt)} ago`;
  if (cp.status === "unknown" || cp.since === null)
    return cp.type === "heartbeat"
      ? "Waiting for the first ping"
      : "Waiting for the first check";
  const duration = formatDuration(now - cp.since);
  if (cp.status === "up") return `Up for ${duration}`;
  if (cp.status === "slow") return `Slow for ${duration}`;
  return `Down for ${duration}`;
}

const STATED_TONE = {
  degraded: "font-medium text-slow",
  partial: "font-medium text-timeout",
  major: "font-medium text-fail",
} as const;

export function MonitorSection({
  monitor,
  range,
  now,
  stated,
  as: Heading = "h2",
}: {
  monitor: MonitorView;
  range: RangeKey;
  now: number;
  /** What open incidents and maintenance say about this monitor. */
  stated?: Stated;
  /** Inside a group the monitor heading sits one level down. */
  as?: "h2" | "h3";
}) {
  const tone =
    monitor.status === "down"
      ? "font-medium text-fail"
      : monitor.status === "slow"
        ? "font-medium text-slow"
        : "text-muted";
  const pct = formatPercent(monitor.summary.up, monitor.summary.total);
  const shown = shownState(monitor.status, stated);
  const incidentHref = stated?.incident
    ? `/incidents/${encodeURIComponent(stated.incident.id)}`
    : null;
  return (
    <section
      id={rowId(monitor.name)}
      className="scroll-mt-6 border-t border-rule py-8"
    >
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <Heading className="page-heading text-[17px] font-medium leading-tight">
          {monitor.name}
        </Heading>
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[15px]">
          {shown === "stated" && stated?.impact && incidentHref ? (
            <Link
              href={incidentHref}
              title={stated.incident?.title}
              className={`${STATED_TONE[stated.impact]} hover:underline`}
            >
              {IMPACT_LABELS[stated.impact]}
            </Link>
          ) : shown === "maintenance" ? (
            <span className="text-muted">Under maintenance</span>
          ) : (
            <>
              {incidentHref !== null && (
                <Link
                  href={incidentHref}
                  title={stated?.incident?.title}
                  className="text-[13.5px] text-fail hover:underline"
                >
                  Incident open
                </Link>
              )}
              <span className={tone}>
                {statusLine(monitor, now)}
                {monitor.status === "down" && monitor.since !== null && (
                  <>
                    , since{" "}
                    <LocalTime ts={monitor.since} style="dateTime" now={now} />
                  </>
                )}
              </span>
            </>
          )}
          {monitor.expiresAt !== null && (
            <span className="text-muted">
              Expires {formatUtcDate(monitor.expiresAt)}
            </span>
          )}
          {pct !== "" && (
            <span className="text-ink" title="Checks passed in this window">
              {pct}
            </span>
          )}
        </p>
      </div>
      <CheckStrip
        buckets={monitor.buckets}
        range={range}
        summary={monitor.summary}
        name={monitor.name}
        slowThresholdMs={monitor.slowThresholdMs}
        timed={monitor.timed}
      />
      <FailureList runs={monitor.runs} now={now} />
    </section>
  );
}
