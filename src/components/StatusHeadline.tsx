import type { MonitorView } from "./MonitorSection";
import { failureSummary, formatDuration, pluralize } from "@/lib/format";
import type { IncidentView } from "@/lib/incidents";
import type { Overall } from "@/lib/state";
import { COMPONENT_LABELS } from "@/lib/stated";
import type { ComponentView } from "@/lib/status-data";

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

/** What the components that are not operational are, in one sentence. */
function componentDetail(components: ComponentView[]): string {
  const off = components.filter((c) => c.state !== "operational");
  if (off.length === 0) return "";
  return off
    .map((c) => `${c.name}: ${COMPONENT_LABELS[c.state].toLowerCase()}.`)
    .join(" ");
}

function detail(
  monitors: MonitorView[],
  components: ComponentView[],
  now: number,
): string {
  if (monitors.length === 0) {
    if (components.length === 0) return "No monitors are set up for this page.";
    return components.every((c) => c.state === "operational")
      ? components.length === 1
        ? `${components[0].name} is operational.`
        : `All ${components.length} components are operational.`
      : "";
  }
  const stale = monitors.filter((cp) => cp.stale);
  if (stale.length > 0)
    return stale.length === monitors.length
      ? "The checks have stopped arriving, so the state of things is not known."
      : `Checks for ${joinNames(stale.map((cp) => cp.name))} have stopped arriving.`;
  const down = monitors.filter((cp) => cp.status === "down");
  const slow = monitors.filter((cp) => cp.status === "slow");
  const unknown = monitors.filter((cp) => cp.status === "unknown").length;
  const up = monitors.length - down.length - unknown;
  if (unknown === monitors.length) {
    return "The first checks have not finished yet. This page updates on its own.";
  }
  if (down.length === 0) {
    const pending =
      unknown === 0 ? "" : ` ${pluralize(unknown, "monitor")} not checked yet.`;
    if (slow.length > 0) {
      const longest = Math.max(...slow.map((cp) => now - (cp.since ?? now)));
      const rest = up - slow.length;
      return `${joinNames(slow.map((cp) => cp.name))} ${slow.length === 1 ? "has" : "have"} been responding slowly for ${formatDuration(longest)}.${
        rest === 0
          ? ""
          : rest === 1
            ? " The other monitor is responding at normal speed."
            : ` The other ${rest} monitors are responding at normal speed.`
      }${pending}`;
    }
    if (monitors.length === 1) return `${monitors[0].name} is responding.`;
    if (unknown === 0 && monitors.length === 2)
      return "Both monitors are responding.";
    if (unknown === 0) return `All ${monitors.length} monitors are responding.`;
    return `${pluralize(up, "monitor")} responding.${pending}`;
  }
  const longest = Math.max(...down.map((cp) => now - (cp.since ?? now)));
  const who = joinNames(down.map((cp) => cp.name));
  const verb = down.length === 1 ? "has" : "have";
  const rest =
    up === 0
      ? ""
      : up === 1
        ? " The other monitor is responding."
        : ` The other ${up} monitors are responding.`;
  return `${who} ${verb} been down for ${formatDuration(longest)}.${rest}`;
}

function recent(monitors: MonitorView[]): string {
  if (monitors.length === 0) return "";
  const failed = monitors.reduce(
    (sum, cp) => sum + (cp.last24h.total - cp.last24h.up),
    0,
  );
  const timeouts = monitors.reduce((sum, cp) => sum + cp.last24h.timeouts, 0);
  const summary = failureSummary(failed, timeouts);
  if (summary === null) return "No failed checks in the last 24 hours.";
  return `${summary[0].toUpperCase()}${summary.slice(1)} in the last 24 hours.`;
}

export function StatusHeadline({
  site,
  overall,
  monitors,
  components = [],
  now,
  incidents = [],
}: {
  site: string;
  overall: Overall;
  monitors: MonitorView[];
  components?: ComponentView[];
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
        <span>
          {monitors.length + components.length === 0
            ? `Nothing on ${site} is checked yet.`
            : headline(site, overall, monitors.length + components.length)}
        </span>
      </h1>
      <p className="mt-5 max-w-[36rem] text-[15px] leading-relaxed text-muted sm:text-[17px]">
        {[
          incidents.length > 0
            ? incidentDetail(incidents, now)
            : detail(monitors, components, now),
          incidents.length > 0 ? "" : componentDetail(components),
          recent(monitors),
        ]
          .filter((part) => part !== "")
          .join(" ")}
      </p>
    </header>
  );
}
