import { AutoRefresh } from "./AutoRefresh";
import { CheckpointSection, type CheckpointView } from "./CheckpointSection";
import { CurrentIncidents, PastIncidents } from "./IncidentList";
import { RangeSwitch } from "./RangeSwitch";
import { StatusHeadline } from "./StatusHeadline";
import { formatInterval, formatUtcClock } from "@/lib/format";
import {
  INCIDENT_HISTORY_DAYS,
  openImpacts,
  type SiteIncidents,
} from "@/lib/incidents";
import type { RangeKey } from "@/lib/ranges";
import { overallStatus, pageOverall, type CheckpointStatus } from "@/lib/state";

export interface CheckpointGroup {
  name: string | null;
  checkpoints: CheckpointView[];
}

/** Checkpoints in page order, gathered by group name as each first appears. */
export function groupCheckpoints(
  checkpoints: CheckpointView[],
): CheckpointGroup[] {
  const groups: CheckpointGroup[] = [];
  for (const cp of checkpoints) {
    const name = cp.group?.trim() ? cp.group.trim() : null;
    const group = groups.find((g) => g.name === name);
    if (group) group.checkpoints.push(cp);
    else groups.push({ name, checkpoints: [cp] });
  }
  return groups;
}

function groupLine(statuses: CheckpointStatus[]): string {
  const down = statuses.filter((s) => s === "down").length;
  const slow = statuses.filter((s) => s === "slow").length;
  const n = statuses.length;
  if (down > 0) return `${down} of ${n} down`;
  if (slow > 0) return `${slow} of ${n} slow`;
  if (statuses.every((s) => s === "unknown")) return "Waiting";
  return n === 1 ? "Responding" : `All ${n} responding`;
}

const GROUP_TONE: Record<ReturnType<typeof overallStatus>, string> = {
  operational: "text-up",
  degraded: "text-slow",
  partial: "text-fail",
  major: "text-fail",
  unknown: "text-muted",
};

/** What the colours mean, as colours. */
function Legend({ slow }: { slow: boolean }) {
  const items: Array<[string, string]> = [
    ["bg-up-soft", "response time"],
    ["bg-timeout", "timeout"],
    ["bg-fail", "failed"],
  ];
  if (slow) items.push(["bg-slow", "slow"]);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] leading-snug text-muted">
      {items.map(([color, label]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`block h-3 w-1.5 rounded-[1px] ${color}`}
          />
          {label}
        </span>
      ))}
    </div>
  );
}

const FEEDS: Array<[string, string]> = [
  ["status.json", "/status.json"],
  ["badge.svg", "/badge.svg"],
  ["feed.xml", "/feed.xml"],
  ["widget.js", "/widget.js"],
];

export function SitePage({
  name,
  checkpoints,
  incidents,
  range,
  now,
  intervalSeconds,
}: {
  name: string;
  checkpoints: CheckpointView[];
  incidents: SiteIncidents;
  range: RangeKey;
  now: number;
  intervalSeconds: number;
}) {
  const groups = groupCheckpoints(checkpoints);
  const grouped = groups.some((g) => g.name !== null);
  // Which checkpoints an open incident names, so their rows say so.
  const affected = new Map<string, string>();
  for (const view of incidents.current) {
    if (view.kind !== "incident" || view.impact === "none") continue;
    for (const cp of view.checkpoints)
      if (!affected.has(cp)) affected.set(cp, view.title);
  }
  return (
    <main className="mx-auto w-full max-w-[46rem] px-5 py-12 sm:py-20">
      <AutoRefresh intervalMs={Math.min(intervalSeconds, 60) * 1000} />
      <StatusHeadline
        site={name}
        overall={pageOverall(
          checkpoints.map((cp) => cp.status),
          openImpacts(incidents.current),
        )}
        checkpoints={checkpoints}
        now={now}
        incidents={incidents.current.filter(
          (i) => i.kind === "incident" && i.impact !== "none",
        )}
      />
      <CurrentIncidents incidents={incidents.current} now={now} />

      <div className="mt-12 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3 pb-5 sm:mt-16">
        <RangeSwitch current={range} />
        <Legend slow={checkpoints.some((cp) => cp.slowThresholdMs !== null)} />
      </div>

      {grouped
        ? groups.map((group) => {
            const statuses = group.checkpoints.map((cp) => cp.status);
            return (
              <section
                key={group.name ?? "\0"}
                aria-label={group.name ?? "Other checkpoints"}
                className="border-t border-rule-strong pt-6"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pb-2">
                  <h2 className="text-[15px] font-medium uppercase tracking-wide">
                    {group.name ?? "Other"}
                  </h2>
                  <span
                    className={`text-[14px] ${GROUP_TONE[overallStatus(statuses)]}`}
                  >
                    {groupLine(statuses)}
                  </span>
                </div>
                {group.checkpoints.map((cp) => (
                  <CheckpointSection
                    key={cp.name}
                    checkpoint={cp}
                    range={range}
                    now={now}
                    incident={affected.get(cp.name) ?? null}
                    as="h3"
                  />
                ))}
              </section>
            );
          })
        : checkpoints.map((cp) => (
            <CheckpointSection
              key={cp.name}
              checkpoint={cp}
              range={range}
              now={now}
              incident={affected.get(cp.name) ?? null}
            />
          ))}

      <PastIncidents
        incidents={incidents.past}
        now={now}
        days={INCIDENT_HISTORY_DAYS}
      />

      <footer className="border-t border-rule pt-6 text-[13px] leading-relaxed text-muted">
        <p>
          Checks run {formatInterval(intervalSeconds)}. Times are UTC. Updated{" "}
          {formatUtcClock(now)}, and this page refreshes on its own.
        </p>
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {FEEDS.map(([label, href]) => (
            <a key={href} href={href} className="hover:text-ink">
              {label}
            </a>
          ))}
        </p>
      </footer>
    </main>
  );
}
