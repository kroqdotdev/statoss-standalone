import { AutoRefresh } from "./AutoRefresh";
import type { StripMark } from "./CheckStrip";
import { ComponentRow } from "./ComponentRow";
import { VendorSection } from "./VendorSection";
import { MonitorSection, type MonitorView } from "./MonitorSection";
import { CurrentIncidents, PastIncidents } from "./IncidentList";
import { RangeSwitch } from "./RangeSwitch";
import { StatusHeadline } from "./StatusHeadline";
import { LocalTime, ZoneName } from "./LocalTime";
import { withBase } from "@/lib/base-path";
import { formatInterval } from "@/lib/format";
import {
  openImpacts,
  PAGE_INCIDENT_DAYS,
  type SiteIncidents,
} from "@/lib/incidents";
import { describeBudget, type ErrorBudget } from "@/lib/budget";
import { RANGES, type RangeKey } from "@/lib/ranges";
import { overallStatus, pageOverall, type MonitorStatus } from "@/lib/state";
import { componentStatus, type Stated } from "@/lib/stated";
import type { ComponentView } from "@/lib/status-data";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A row of the page: a monitor with its strip, or a component without one. */
export type Row =
  | { kind: "monitor"; view: MonitorView }
  | { kind: "component"; view: ComponentView };

export interface RowGroup {
  name: string | null;
  rows: Row[];
}

/** Rows in page order, gathered by group name as each first appears. */
export function groupRows(rows: Row[]): RowGroup[] {
  const groups: RowGroup[] = [];
  for (const row of rows) {
    const name = row.view.group?.trim() ? row.view.group.trim() : null;
    const group = groups.find((g) => g.name === name);
    if (group) group.rows.push(row);
    else groups.push({ name, rows: [row] });
  }
  return groups;
}

function rowStatus(row: Row): MonitorStatus {
  return row.kind === "monitor"
    ? row.view.status
    : componentStatus(row.view.state);
}

function groupLine(statuses: MonitorStatus[]): string {
  const down = statuses.filter((s) => s === "down").length;
  const slow = statuses.filter((s) => s === "slow").length;
  const n = statuses.length;
  if (down > 0) return `${down} of ${n} down`;
  if (slow > 0) return `${slow} of ${n} slow`;
  if (statuses.every((s) => s === "unknown")) return "Waiting";
  if (statuses.some((s) => s === "unknown"))
    return `${statuses.filter((s) => s === "up").length} of ${n} up`;
  return n === 1 ? "Up" : `All ${n} up`;
}

const GROUP_TONE: Record<ReturnType<typeof overallStatus>, string> = {
  operational: "text-up",
  degraded: "text-slow",
  partial: "text-fail",
  major: "text-fail",
  unknown: "text-muted",
};

/** What the colours mean, as colours. */
function Legend({
  slow,
  checks,
  deploys,
}: {
  slow: boolean;
  checks: boolean;
  deploys: boolean;
}) {
  const items: Array<[string, string]> = checks
    ? [
        ["bg-up-soft", "response time"],
        ["bg-timeout", "timeout"],
        ["bg-fail", "failed"],
      ]
    : [
        ["bg-up-soft", "operational"],
        ["bg-fail", "outage"],
      ];
  if (slow) items.push(["bg-slow", checks ? "slow" : "degraded"]);
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
      {deploys && (
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="block h-3 border-l border-dashed border-muted"
          />
          deploy
        </span>
      )}
    </div>
  );
}

const FEEDS: Array<[string, string]> = [
  ["status.json", "/status.json"],
  ["badge.svg", "/badge.svg"],
  ["widget.js", "/widget.js"],
];

export function SitePage({
  name,
  monitors,
  components = [],
  stated = new Map(),
  incidents,
  range,
  now,
  intervalSeconds,
  budget = null,
  retentionDays = 90,
  logo = null,
  description = null,
  supportUrl = null,
  foldGroups = false,
  defaultRange,
  deploys = [],
  calendar = withBase("/maintenance.ics"),
}: {
  /** Where a calendar app subscribes to the site's maintenance. */
  calendar?: string;
  /** Deploy markers inside the range, for the strips. */
  deploys?: StripMark[];
  name: string;
  /** Where the logo is, or null for none. */
  logo?: string | null;
  /** A sentence or two under the headline. */
  description?: string | null;
  /** Where "Contact support" goes. */
  supportUrl?: string | null;
  /** Folds away the groups in which everything is up. */
  foldGroups?: boolean;
  /** The range the page opens on. */
  defaultRange?: RangeKey;
  monitors: MonitorView[];
  components?: ComponentView[];
  /** What open incidents and maintenance say about each row, by name. */
  stated?: Map<string, Stated>;
  incidents: SiteIncidents;
  range: RangeKey;
  now: number;
  intervalSeconds: number;
  /** The month's error budget, when the site has an uptime target. */
  budget?: ErrorBudget | null;
  /** Days single checks are kept, which is how far back failed runs go. */
  retentionDays?: number;
}) {
  // A component that follows a vendor has its own section further down.
  const vendors = components.filter((c) => c.vendor);
  const rows: Row[] = [
    ...monitors.map((view) => ({ kind: "monitor" as const, view })),
    ...components
      .filter((c) => !c.vendor)
      .map((view) => ({ kind: "component" as const, view })),
  ];
  const groups = groupRows(rows);
  const grouped = groups.some((g) => g.name !== null);
  const row = (r: Row, as: "h2" | "h3") =>
    r.kind === "monitor" ? (
      <MonitorSection
        key={r.view.name}
        monitor={r.view}
        range={range}
        now={now}
        stated={stated.get(r.view.name)}
        marks={deploys}
        as={as}
      />
    ) : (
      <ComponentRow
        key={r.view.name}
        component={r.view}
        stated={stated.get(r.view.name)}
        range={range}
        as={as}
      />
    );
  return (
    <main className="mx-auto w-full max-w-[46rem] px-5 py-12 sm:py-20">
      <AutoRefresh intervalMs={Math.min(intervalSeconds, 60) * 1000} />
      {logo !== null && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt={`${name} logo`}
          className="mb-8 max-h-10 w-auto max-w-[14rem]"
        />
      )}
      <StatusHeadline
        site={name}
        overall={pageOverall(
          rows.map(rowStatus),
          openImpacts(incidents.current),
        )}
        monitors={monitors}
        components={components.filter((c) => !c.vendor)}
        now={now}
        incidents={incidents.current.filter(
          (i) => i.kind === "incident" && i.impact !== "none",
        )}
      />
      {description !== null && (
        <p className="mt-4 max-w-[36rem] text-[15px] leading-relaxed">
          {description}
        </p>
      )}
      <p className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[14px] text-muted">
        <span>
          Updated <LocalTime ts={now} style="clock" />
        </span>
        <a href="#updates" className="page-link">
          Get updates
        </a>
        {supportUrl !== null && (
          <a href={supportUrl} className="page-link">
            Contact support
          </a>
        )}
      </p>
      <CurrentIncidents incidents={incidents.current} now={now} />

      {rows.length > 0 && (
        <div className="mt-12 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3 pb-5 sm:mt-16">
          <RangeSwitch current={range} fallback={defaultRange} />
          <Legend
            deploys={monitors.length > 0 && deploys.length > 0}
            checks={monitors.length > 0}
            slow={
              monitors.length > 0
                ? monitors.some((cp) => cp.slowThresholdMs !== null)
                : true
            }
          />
        </div>
      )}

      <div className={rows.length > 0 ? "" : "mt-12 sm:mt-16"}>
        {grouped
          ? groups.map((group) => {
              const statuses = group.rows.map(rowStatus);
              const heading = (
                <>
                  <h2 className="page-group text-[15px] font-medium uppercase tracking-wide">
                    {group.name ?? "Other"}
                  </h2>
                  <span
                    className={`text-[14px] ${GROUP_TONE[overallStatus(statuses)]}`}
                  >
                    {groupLine(statuses)}
                  </span>
                </>
              );
              // A group with nothing to look at folds away, when asked to.
              // A row an incident or a window says something about stays open.
              const quiet =
                foldGroups &&
                statuses.every((s) => s === "up") &&
                group.rows.every((r) => !stated.has(r.view.name));
              return quiet ? (
                <details
                  key={group.name ?? "\0"}
                  className="group/fold border-t border-rule-strong pt-6"
                >
                  <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pb-6 [&::-webkit-details-marker]:hidden">
                    {heading}
                  </summary>
                  {group.rows.map((r) => row(r, "h3"))}
                </details>
              ) : (
                <section
                  key={group.name ?? "\0"}
                  aria-label={group.name ?? "Other monitors"}
                  className="border-t border-rule-strong pt-6"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pb-2">
                    {heading}
                  </div>
                  {group.rows.map((r) => row(r, "h3"))}
                </section>
              );
            })
          : rows.map((r) => row(r, "h2"))}
      </div>

      <VendorSection vendors={vendors} />

      <PastIncidents
        incidents={incidents.past}
        now={now}
        days={PAGE_INCIDENT_DAYS}
      />

      <footer className="border-t border-rule pt-6 text-[13px] leading-relaxed text-muted">
        {budget !== null && (
          <p className="mb-2">{describeBudget(budget, now)}</p>
        )}
        {monitors.length > 0 &&
          RANGES[range].buckets * RANGES[range].bucketMs >
            retentionDays * DAY_MS && (
            <p className="mb-2">
              Failed checks are listed for the last {retentionDays} days. The
              bars and the figures cover {RANGES[range].phrase}.
            </p>
          )}
        <p>
          {monitors.length > 0
            ? `Checks run ${formatInterval(intervalSeconds)}. `
            : ""}
          Times are in your time zone, <ZoneName />
          {monitors.length > 0
            ? "; a day on the longer views is a UTC day"
            : ""}
          . This page refreshes on its own.
        </p>
        <p
          id="updates"
          className="mt-2 flex scroll-mt-6 flex-wrap gap-x-4 gap-y-1"
        >
          <span>Get updates:</span>
          <a href={withBase("/feed.xml")} className="page-link">
            RSS
          </a>
          <a href={withBase("/feed.atom")} className="page-link">
            Atom
          </a>
          <a href={calendar} className="page-link">
            Calendar
          </a>
        </p>
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {FEEDS.map(([label, href]) => (
            <a key={href} href={withBase(href)} className="hover:text-ink">
              {label}
            </a>
          ))}
        </p>
      </footer>
    </main>
  );
}
