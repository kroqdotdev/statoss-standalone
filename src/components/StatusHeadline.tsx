import type { CheckpointView } from "./CheckpointSection";
import { failureSummary, formatDuration, pluralize } from "@/lib/format";
import type { IncidentView } from "@/lib/incidents";
import type { Overall } from "@/lib/state";

const DOT: Record<Overall, string> = {
  operational: "text-up",
  degraded: "text-slow",
  partial: "text-timeout",
  major: "text-fail",
  unknown: "text-rule-strong",
};

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function headline(site: string, overall: Overall, count: number): string {
  if (overall === "operational") return `${site} is up.`;
  if (overall === "major") return `${site} is down.`;
  if (overall === "unknown") return `Checking ${site}.`;
  if (overall === "degraded")
    return count === 1 ? `${site} is slow.` : `Part of ${site} is slow.`;
  return `Part of ${site} is down.`;
}

/** When an open incident sets the headline, the detail names it. */
function incidentDetail(incidents: IncidentView[], now: number): string {
  const worst = incidents[0];
  const others = incidents.length - 1;
  return `${worst.title}, open for ${formatDuration(now - worst.startedAt)}${
    others === 0 ? "" : `, and ${pluralize(others, "other incident")}`
  }. Updates are below.`;
}

function detail(checkpoints: CheckpointView[], now: number): string {
  const down = checkpoints.filter((cp) => cp.status === "down");
  const slow = checkpoints.filter((cp) => cp.status === "slow");
  const unknown = checkpoints.filter((cp) => cp.status === "unknown").length;
  const up = checkpoints.length - down.length - unknown;
  if (unknown === checkpoints.length) {
    return "The first checks have not finished yet. This page updates on its own.";
  }
  if (down.length === 0) {
    const pending =
      unknown === 0
        ? ""
        : ` ${pluralize(unknown, "checkpoint")} not checked yet.`;
    if (slow.length > 0) {
      const longest = Math.max(...slow.map((cp) => now - (cp.since ?? now)));
      const rest = up - slow.length;
      return `${joinNames(slow.map((cp) => cp.name))} ${slow.length === 1 ? "has" : "have"} been responding slowly for ${formatDuration(longest)}.${
        rest === 0
          ? ""
          : rest === 1
            ? " The other checkpoint is responding at normal speed."
            : ` The other ${rest} checkpoints are responding at normal speed.`
      }${pending}`;
    }
    if (checkpoints.length === 1)
      return `${checkpoints[0].name} is responding.`;
    if (unknown === 0 && checkpoints.length === 2)
      return "Both checkpoints are responding.";
    if (unknown === 0)
      return `All ${checkpoints.length} checkpoints are responding.`;
    return `${pluralize(up, "checkpoint")} responding.${pending}`;
  }
  const longest = Math.max(...down.map((cp) => now - (cp.since ?? now)));
  const who = joinNames(down.map((cp) => cp.name));
  const verb = down.length === 1 ? "has" : "have";
  const rest =
    up === 0
      ? ""
      : up === 1
        ? " The other checkpoint is responding."
        : ` The other ${up} checkpoints are responding.`;
  return `${who} ${verb} been down for ${formatDuration(longest)}.${rest}`;
}

function recent(checkpoints: CheckpointView[]): string {
  const failed = checkpoints.reduce(
    (sum, cp) => sum + (cp.last24h.total - cp.last24h.up),
    0,
  );
  const timeouts = checkpoints.reduce(
    (sum, cp) => sum + cp.last24h.timeouts,
    0,
  );
  const summary = failureSummary(failed, timeouts);
  if (summary === null) return "No failed checks in the last 24 hours.";
  return `${summary[0].toUpperCase()}${summary.slice(1)} in the last 24 hours.`;
}

export function StatusHeadline({
  site,
  overall,
  checkpoints,
  now,
  incidents = [],
}: {
  site: string;
  overall: Overall;
  checkpoints: CheckpointView[];
  now: number;
  /** Open incidents with an impact, worst first, that shape the headline. */
  incidents?: IncidentView[];
}) {
  return (
    <header>
      <h1 className="page-headline flex items-center gap-4 text-[2rem] font-semibold leading-none tracking-[-0.02em] sm:text-[2.75rem]">
        <span
          aria-hidden="true"
          className={`block size-3 shrink-0 rounded-full bg-current sm:size-3.5 ${DOT[overall]}`}
        />
        <span>{headline(site, overall, checkpoints.length)}</span>
      </h1>
      <p className="mt-5 max-w-[36rem] text-[15px] leading-relaxed text-muted sm:text-[17px]">
        {incidents.length > 0
          ? incidentDetail(incidents, now)
          : detail(checkpoints, now)}{" "}
        {recent(checkpoints)}
      </p>
    </header>
  );
}
