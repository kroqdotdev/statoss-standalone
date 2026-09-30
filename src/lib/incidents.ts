import { parse } from "yaml";
import { z } from "zod";
import {
  monitorsFromCheckpoints,
  timestampSchema,
  type AppConfig,
  type MaintenanceConfig,
  type SiteConfig,
} from "./config";
import type { AutoIncidentRow } from "./db";
import { formatDuration } from "./format";
import type { IncidentImpact } from "./state";

/**
 * Incidents and maintenance windows. An incident is a titled record on a
 * site with a status and a list of dated updates. The scheduler opens one
 * when a monitor goes down and closes it when the monitor recovers;
 * the operator writes the rest as files in the incidents folder. A
 * maintenance window is a planned start and end in the configuration,
 * during which checks are kept but not counted and no alert goes out.
 */

export const INCIDENT_STATUSES = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

export const IMPACTS = ["none", "degraded", "partial", "major"] as const;

export interface IncidentUpdate {
  status: IncidentStatus;
  body: string;
  createdAt: number;
}

export interface IncidentView {
  id: string;
  kind: "incident" | "maintenance";
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  startedAt: number;
  /** Maintenance only: when the window closes. */
  endsAt: number | null;
  resolvedAt: number | null;
  /** Opened by the checker rather than written by hand. */
  auto: boolean;
  postmortem: string | null;
  /** Names of the monitors and components it covers. Empty means the whole site. */
  monitors: string[];
  /**
   * The state an incident gives a row it names while it is open, by name.
   * A name without one only carries the "Incident open" mark.
   */
  states: Record<string, IncidentImpact>;
  /** Newest first. */
  updates: IncidentUpdate[];
}

// ---------------------------------------------------------------------------
// Incident files.

const updateSchema = z.object({
  at: timestampSchema,
  status: z.enum(INCIDENT_STATUSES).default("investigating"),
  body: z.string().min(1),
});

const fileSchema = z.preprocess(
  monitorsFromCheckpoints,
  z.object({
    title: z.string().min(1),
    /** The site's name or host. Optional when there is only one site. */
    site: z.string().min(1).optional(),
    started: timestampSchema,
    resolved: timestampSchema.optional(),
    impact: z.enum(IMPACTS).default("none"),
    /** A name, or a name with the state the incident puts it in. */
    monitors: z
      .array(
        z.union([
          z.string().min(1),
          z.object({ name: z.string().min(1), state: z.enum(IMPACTS) }),
        ]),
      )
      .default([]),
    updates: z.array(updateSchema).default([]),
    postmortem: z.string().optional(),
  }),
);

/**
 * Post-mortems are plain text: blank lines separate paragraphs, and a line
 * break inside a paragraph is only the file's wrapping, so it becomes a space.
 * A line that starts with # is a heading.
 */
export function joinLines(text: string): string {
  return (
    text
      .trim()
      // A heading is a paragraph of its own, blank line after it or not.
      .replace(/^(#{1,6}[ \t].*)$/gm, "\n$1\n")
      .split(/\n[ \t]*\n/)
      .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
      .filter((paragraph) => paragraph !== "")
      .join("\n\n")
  );
}

/** Splits a Markdown file into its YAML front matter and the text below. */
export function splitFrontMatter(text: string): {
  front: string;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { front: text, body: "" };
  return { front: match[1], body: match[2] };
}

/**
 * Reads one incident file. `.md` files carry YAML front matter and the
 * post-mortem as the text below it; `.yaml` files hold the same fields with
 * an optional `postmortem` key. Returns the incident and which site it is
 * for. Throws with a readable message on a bad file.
 */
export function parseIncidentFile(
  id: string,
  text: string,
  config: Pick<AppConfig, "sites">,
): { site: SiteConfig; view: IncidentView } {
  const isMarkdown = /\.(md|markdown)$/i.test(id);
  const { front, body } = isMarkdown
    ? splitFrontMatter(text)
    : { front: text, body: "" };
  const result = fileSchema.safeParse(parse(front));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ");
    throw new Error(`Invalid incident file ${id}: ${details}`);
  }
  const data = result.data;
  const site = data.site
    ? config.sites.find(
        (s) =>
          s.name === data.site ||
          s.host.toLowerCase() === data.site?.toLowerCase(),
      )
    : config.sites.length === 1
      ? config.sites[0]
      : undefined;
  if (!site)
    throw new Error(
      data.site
        ? `Invalid incident file ${id}: no site named "${data.site}"`
        : `Invalid incident file ${id}: name the site, since there is more than one`,
    );
  const names: string[] = [];
  const states: Record<string, IncidentImpact> = {};
  for (const entry of data.monitors) {
    const name = typeof entry === "string" ? entry : entry.name;
    if (
      !site.monitors.some((cp) => cp.name === name) &&
      !site.components.some((c) => c.name === name)
    )
      throw new Error(
        `Invalid incident file ${id}: "${name}" is not a monitor or component of ${site.name}`,
      );
    names.push(name);
    if (typeof entry !== "string") states[name] = entry.state;
  }
  const updates = data.updates
    .map((u) => ({ status: u.status, body: u.body.trim(), createdAt: u.at }))
    .sort((a, b) => b.createdAt - a.createdAt);
  const resolvedUpdate = updates.find((u) => u.status === "resolved");
  const resolvedAt = data.resolved ?? resolvedUpdate?.createdAt ?? null;
  const status: IncidentStatus =
    resolvedAt !== null ? "resolved" : (updates[0]?.status ?? "investigating");
  const postmortem = joinLines(data.postmortem ?? body);
  return {
    site,
    view: {
      id: id.replace(/\.(md|markdown|ya?ml)$/i, ""),
      kind: "incident",
      title: data.title,
      status,
      impact: data.impact,
      startedAt: data.started,
      endsAt: null,
      resolvedAt,
      auto: false,
      postmortem: postmortem === "" ? null : postmortem,
      monitors: names,
      states,
      updates,
    },
  };
}

// ---------------------------------------------------------------------------
// Maintenance windows, from the configuration.

/**
 * A window's id, from when it starts and what it is called, so it stays the
 * same when the list around it changes: "maintenance-2026-09-20-0100-database-upgrade".
 */
export function maintenanceId(window: MaintenanceConfig): string {
  const stamp = new Date(window.start)
    .toISOString()
    .slice(0, 16)
    .replace("T", "-")
    .replace(":", "");
  const slug = window.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `maintenance-${stamp}${slug ? `-${slug}` : ""}`;
}

export function maintenanceView(window: MaintenanceConfig): IncidentView {
  const notes = window.notes?.trim();
  return {
    id: maintenanceId(window),
    kind: "maintenance",
    title: window.title,
    status: "monitoring",
    impact: "none",
    startedAt: window.start,
    endsAt: window.end,
    resolvedAt: null,
    auto: false,
    postmortem: null,
    monitors: window.monitors ?? [],
    states: {},
    updates: notes
      ? [{ status: "monitoring", body: notes, createdAt: window.start }]
      : [],
  };
}

/** Whether a monitor is inside one of its site's maintenance windows. */
export function inMaintenance(
  windows: MaintenanceConfig[],
  monitor: string,
  now: number,
): boolean {
  return windows.some(
    (w) =>
      w.start <= now &&
      now < w.end &&
      (w.monitors === undefined || w.monitors.includes(monitor)),
  );
}

/** Whether a maintenance window has ended. */
export function maintenanceOver(view: IncidentView, now: number): boolean {
  return (
    view.resolvedAt !== null || (view.endsAt !== null && view.endsAt <= now)
  );
}

export function maintenancePhase(
  view: IncidentView,
  now: number,
): "scheduled" | "in-progress" | "completed" {
  if (maintenanceOver(view, now)) return "completed";
  return view.startedAt <= now ? "in-progress" : "scheduled";
}

// ---------------------------------------------------------------------------
// Automatic incidents, from the checker.

export function autoIncidentView(row: AutoIncidentRow): IncidentView {
  const updates: IncidentUpdate[] = [
    {
      status: "investigating",
      body: `${row.monitor} stopped responding to checks${
        row.error ? ` (${row.error})` : ""
      }. Opened automatically.`,
      createdAt: row.startedAt,
    },
  ];
  if (row.resolvedAt !== null)
    updates.unshift({
      status: "resolved",
      body: `Recovered after ${formatDuration(row.resolvedAt - row.startedAt)}. Resolved automatically.`,
      createdAt: row.resolvedAt,
    });
  return {
    id: `auto-${row.id}`,
    kind: "incident",
    title: `${row.monitor} is down`,
    status: row.resolvedAt === null ? "investigating" : "resolved",
    impact: "none",
    startedAt: row.startedAt,
    endsAt: null,
    resolvedAt: row.resolvedAt,
    auto: true,
    postmortem: null,
    monitors: [row.monitor],
    states: {},
    updates,
  };
}

// ---------------------------------------------------------------------------
// What the page shows.

export interface SiteIncidents {
  /** Open incidents, maintenance in progress, and maintenance planned soon. */
  current: IncidentView[];
  /** Resolved incidents and finished maintenance, newest first. */
  past: IncidentView[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the status page itself lists past incidents. */
export const PAGE_INCIDENT_DAYS = 7;
/** How far back the feeds go. */
export const FEED_DAYS = 30;
/** How far ahead planned maintenance is announced. */
const LOOKAHEAD_MS = 7 * DAY_MS;

const IMPACT_RANK: Record<IncidentImpact, number> = {
  none: 0,
  degraded: 1,
  partial: 2,
  major: 3,
};

/**
 * Sorts every incident and window of a site into current and past. Current:
 * what somebody wrote before what a check opened, the worst first, then
 * maintenance in progress, then what is planned. Past: the last `days`.
 */
export function splitIncidents(
  views: IncidentView[],
  now: number,
  days = PAGE_INCIDENT_DAYS,
  limit = 100,
): SiteIncidents {
  const since = now - days * DAY_MS;
  const rank = (v: IncidentView) =>
    v.kind === "incident" ? (v.auto ? 1 : 0) : v.startedAt <= now ? 2 : 3;
  const current = views
    .filter((v) =>
      v.kind === "incident"
        ? v.resolvedAt === null && v.startedAt <= now
        : !maintenanceOver(v, now) && v.startedAt <= now + LOOKAHEAD_MS,
    )
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact] ||
        (a.kind === "maintenance"
          ? a.startedAt - b.startedAt
          : b.startedAt - a.startedAt),
    );
  const past = views
    .filter(
      (v) =>
        v.startedAt > since &&
        (v.kind === "incident"
          ? v.resolvedAt !== null
          : maintenanceOver(v, now)),
    )
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
  return { current, past };
}

/**
 * The open outages the checker opened, as one view when there are several:
 * a wide outage is one event on the page, not a card per monitor.
 */
export function foldAutomatic(current: IncidentView[]): IncidentView[] {
  const auto = current.filter((v) => v.auto);
  if (auto.length < 2) return current;
  const oldest = auto.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
  const folded: IncidentView = {
    ...oldest,
    id: oldest.id,
    title: `${auto.length} monitors are down`,
    monitors: auto.flatMap((v) => v.monitors),
    updates: auto
      .flatMap((v) => v.updates)
      .sort((a, b) => b.createdAt - a.createdAt),
  };
  const out: IncidentView[] = [];
  let placed = false;
  for (const view of current) {
    if (!view.auto) out.push(view);
    else if (!placed) {
      out.push(folded);
      placed = true;
    }
  }
  return out;
}

/** A post-mortem as headings and paragraphs, from its text. */
export function postmortemBlocks(
  text: string,
): Array<{ heading: boolean; text: string }> {
  return text
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => {
      const heading = /^#{1,6}[ \t]+(.*)$/.exec(block);
      return heading
        ? { heading: true, text: heading[1].trim() }
        : { heading: false, text: block };
    });
}

/** Impacts of the incidents that are open right now, for the headline. */
export function openImpacts(views: IncidentView[]): IncidentImpact[] {
  return views
    .filter((v) => v.kind === "incident" && v.resolvedAt === null)
    .map((v) => v.impact);
}
