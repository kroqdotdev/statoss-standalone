import type {
  VendorComponent,
  VendorIncident,
  VendorReading,
  VendorState,
} from "./vendors";

/**
 * The status page platforms read beside Atlassian Statuspage and StatOSS.
 * Each parser takes what the platform's public JSON says and answers in
 * one shape, or throws when the body is not that platform's. Value lists
 * are from each platform's documentation where it has one, checked against
 * live pages on 2 October 2026 (fixtures in vendor-formats.test.ts).
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const RANK: Record<VendorState, number> = {
  up: 0,
  unknown: 0,
  slow: 1,
  down: 2,
};
const worst = (states: VendorState[]): VendorState =>
  states.reduce<VendorState>((a, b) => (RANK[b] > RANK[a] ? b : a), "up");

/** A link out of a vendor's JSON, kept only when it is a web address. */
function webUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** The parts that have a name. */
function named(components: VendorComponent[]): VendorComponent[] {
  return components.filter((c) => c.name !== "");
}

// ---------------------------------------------------------------------------
// Instatus: /summary.json (also served at /api/v2/summary.json) and
// /v2/components.json. https://instatus.com/help/api

const INSTATUS_COMPONENT: Record<string, VendorState> = {
  OPERATIONAL: "up",
  UNDERMAINTENANCE: "up",
  DEGRADEDPERFORMANCE: "slow",
  PARTIALOUTAGE: "slow",
  MINOROUTAGE: "slow",
  MAJOROUTAGE: "down",
};

/** Whether a summary.json answer is Instatus's rather than Statuspage's. */
export function isInstatusSummary(body: unknown): boolean {
  return (
    isObject(body) &&
    isObject(body.page) &&
    ["UP", "HASISSUES", "UNDERMAINTENANCE"].includes(text(body.page.status)) &&
    !isObject(body.status)
  );
}

export function parseInstatus(
  summary: unknown,
  components: unknown,
  pageUrl: string,
): VendorReading {
  if (!isInstatusSummary(summary) || !isObject(summary))
    throw new Error("not an Instatus page");
  const page = summary.page as Json;
  const rows = list(isObject(components) ? components.components : []).filter(
    isObject,
  );
  // A group is listed as a row of its own too; its members say more.
  const groupIds = new Set(
    rows
      .map((r) => (isObject(r.group) ? text(r.group.id) : ""))
      .filter((id) => id !== ""),
  );
  const parts = named(
    rows
      .filter((r) => !groupIds.has(text(r.id)))
      .map((r) => ({
        name: text(r.name),
        state: INSTATUS_COMPONENT[text(r.status)] ?? "up",
      })),
  );
  const incidents: VendorIncident[] = list(summary.activeIncidents)
    .filter(isObject)
    .filter((i) => text(i.status) !== "RESOLVED")
    .map((i) => ({
      name: text(i.name),
      url: webUrl(i.url) ?? pageUrl,
      components: rows
        .filter((r) =>
          list(r.activeIncidents).some(
            (a) => isObject(a) && text(a.id) === text(i.id),
          ),
        )
        .map((r) => text(r.name)),
    }))
    .filter((i) => i.name !== "");
  const status = text(page.status);
  return {
    name: text(page.name) || null,
    state:
      status === "HASISSUES"
        ? parts.length > 0 && parts.some((c) => c.state !== "up")
          ? worst(parts.map((c) => c.state))
          : "slow"
        : "up",
    components: parts,
    incidents,
  };
}

// ---------------------------------------------------------------------------
// Better Stack: /index.json, JSON:API.
// https://betterstack.com/docs/uptime/api/status-pages-api-response-params/

const BETTER_STACK: Record<string, VendorState> = {
  operational: "up",
  maintenance: "up",
  not_monitored: "up",
  degraded: "slow",
  downtime: "down",
};

export function isBetterStack(body: unknown): boolean {
  return (
    isObject(body) &&
    isObject(body.data) &&
    text(body.data.type) === "status_page" &&
    isObject(body.data.attributes) &&
    "aggregate_state" in body.data.attributes
  );
}

export function parseBetterStack(
  body: unknown,
  pageUrl: string,
): VendorReading {
  if (!isBetterStack(body) || !isObject(body))
    throw new Error("not a Better Stack page");
  const data = body.data as Json;
  const attributes = data.attributes as Json;
  const included = list(body.included).filter(isObject);
  const of = (type: string) => included.filter((i) => text(i.type) === type);
  const attrs = (i: Json): Json => (isObject(i.attributes) ? i.attributes : {});
  const resources = of("status_page_resource");
  const nameOf = new Map(
    resources.map((r) => [text(r.id), text(attrs(r).public_name)]),
  );
  const parts = named(
    resources.map((r) => {
      const a = attrs(r);
      return {
        name: text(a.public_name),
        state: BETTER_STACK[text(a.status)] ?? "up",
      };
    }),
  );
  const incidents = of("status_report")
    .filter((r) => {
      const a = attrs(r);
      return (
        text(a.aggregate_state) !== "resolved" &&
        text(a.report_type) !== "maintenance"
      );
    })
    .map((r) => {
      const a = attrs(r);
      return {
        name: text(a.title),
        url: `${pageUrl.replace(/\/$/, "")}/incident/${encodeURIComponent(text(r.id))}`,
        components: list(a.affected_resources)
          .filter(isObject)
          .filter((x) => text(x.status) !== "resolved")
          .map((x) => nameOf.get(String(x.status_page_resource_id ?? "")) ?? "")
          .filter((n) => n !== ""),
      };
    })
    .filter((i) => i.name !== "");
  return {
    name: text(attributes.company_name) || null,
    state: BETTER_STACK[text(attributes.aggregate_state)] ?? "up",
    components: parts,
    incidents,
  };
}

// ---------------------------------------------------------------------------
// Sorry (Postmark's page): /api/v1/status, /api/v1/components and the
// present notices, each notice read for the components it touches. The
// public API is undocumented; its objects are those of
// https://docs.sorryapp.com/v1/components and /v1/notices.

const SORRY_COMPONENT: Record<string, VendorState> = {
  operational: "up",
  "under-maintenance": "up",
  "partially-degraded": "slow",
  degraded: "slow",
};
const SORRY_OPEN = new Set(["investigating", "identified", "recovering"]);

export function isSorryStatus(body: unknown): boolean {
  return (
    isObject(body) &&
    isObject(body.page) &&
    typeof body.page.state === "string" &&
    isObject(body.page.links) &&
    "components" in body.page.links
  );
}

/** The open, unplanned notices to read in full, by id. */
export function sorryOpenNotices(notices: unknown): string[] {
  return list(isObject(notices) ? notices.notices : [])
    .filter(isObject)
    .filter(
      (n) => text(n.type) === "unplanned" && SORRY_OPEN.has(text(n.state)),
    )
    .map((n) => String(n.id ?? ""))
    .filter((id) => /^\d+$/.test(id));
}

export function parseSorry(
  status: unknown,
  components: unknown,
  notices: unknown[],
  pageUrl: string,
): VendorReading {
  if (!isSorryStatus(status) || !isObject(status))
    throw new Error("not a Sorry page");
  const page = status.page as Json;
  const rows = list(isObject(components) ? components.components : []).filter(
    isObject,
  );
  const parts = named(
    rows.map((r) => ({
      name: text(r.name),
      state: SORRY_COMPONENT[text(r.state)] ?? "up",
    })),
  );
  const incidents = notices
    .map((n) => (isObject(n) && isObject(n.notice) ? n.notice : null))
    .filter((n): n is Json => n !== null)
    .filter(
      (n) => text(n.type) === "unplanned" && SORRY_OPEN.has(text(n.state)),
    )
    .map((n) => ({
      name: text(n.subject),
      url: webUrl(n.url) ?? pageUrl,
      components: list(n.components)
        .filter(isObject)
        .map((c) => text(c.name))
        .filter((x) => x !== ""),
    }))
    .filter((i) => i.name !== "");
  // Sorry has no severity: the worst it says is degraded.
  return {
    name: text(page.name) || null,
    state: SORRY_COMPONENT[text(page.state)] ?? "up",
    components: parts,
    incidents,
  };
}

// ---------------------------------------------------------------------------
// status.io (GitLab, Neon): the page answers with its id in the header
// x-status-page-id, and https://api.status.io/1.0/status/<id> has the rest.
// https://kb.status.io/developers/public-status-api/

const STATUS_IO: Record<number, VendorState> = {
  100: "up",
  200: "up",
  300: "slow",
  400: "slow",
  500: "down",
  600: "slow",
};
const STATUS_IO_RESOLVED = 400;

export const STATUS_IO_API = "https://api.status.io/1.0/status";

/** The page's id, when the header names one. */
export function statusIoId(header: string | null): string | null {
  const id = header?.trim() ?? "";
  return /^[0-9a-f]{24}$/i.test(id) ? id : null;
}

/** "GitLab System Status" is GitLab's page. */
export function statusIoName(html: string): string | null {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
  const name = title
    .replace(/&amp;/g, "&")
    .replace(/\s+(system\s+)?status(\s+page)?\s*$/i, "")
    .trim();
  return name === "" ? null : name.slice(0, 80);
}

export function parseStatusIo(
  body: unknown,
  pageUrl: string,
  pageId: string,
  name: string | null,
): VendorReading {
  if (
    !isObject(body) ||
    !isObject(body.result) ||
    !isObject(body.result.status_overall)
  )
    throw new Error("not a status.io page");
  const result = body.result as Json;
  const overall = result.status_overall as Json;
  const code = (v: unknown) => STATUS_IO[Number(v)] ?? "up";
  const parts: VendorComponent[] = [];
  for (const c of list(result.status).filter(isObject)) {
    parts.push({ name: text(c.name), state: code(c.status_code) });
    // Containers are where a component runs, e.g. Neon's regions.
    const inside = list(c.containers).filter(isObject);
    if (inside.length > 1)
      for (const k of inside)
        parts.push({
          name: `${text(c.name)} (${text(k.name)})`,
          state: code(k.status_code),
        });
  }
  const incidents = list(result.incidents)
    .filter(isObject)
    .filter((i) => {
      const messages = list(i.messages).filter(isObject);
      const latest = messages.reduce<Json | null>(
        (a, m) => (a === null || text(m.datetime) > text(a.datetime) ? m : a),
        null,
      );
      return Number(latest?.state) !== STATUS_IO_RESOLVED;
    })
    .map((i) => ({
      name: text(i.name),
      url: `${pageUrl.replace(/\/$/, "")}/pages/incident/${pageId}/${encodeURIComponent(text(i._id))}`,
      components: list(i.components_affected)
        .filter(isObject)
        .map((c) => text(c.name))
        .filter((n) => n !== ""),
    }))
    .filter((i) => i.name !== "");
  return {
    name,
    state: code(overall.status_code),
    components: named(parts),
    incidents,
  };
}

// ---------------------------------------------------------------------------
// Heroku: /api/v4/current-status. https://devcenter.heroku.com/articles/heroku-status
// Colours from the page's own code; `resolved` is false even on resolved
// incidents, so `state` decides, and `scheduled` keeps finished work.

const HEROKU: Record<string, VendorState> = {
  green: "up",
  blue: "up",
  yellow: "slow",
  red: "down",
};

export function isHeroku(body: unknown): boolean {
  return (
    isObject(body) &&
    Array.isArray(body.status) &&
    body.status.length > 0 &&
    body.status.every(
      (s) =>
        isObject(s) &&
        typeof s.system === "string" &&
        typeof s.status === "string",
    )
  );
}

export function parseHeroku(body: unknown, pageUrl: string): VendorReading {
  if (!isHeroku(body) || !isObject(body))
    throw new Error("not Heroku's status");
  const parts = named(
    list(body.status)
      .filter(isObject)
      .map((s) => ({
        name: text(s.system),
        state: HEROKU[text(s.status)] ?? "up",
      })),
  );
  const incidents = list(body.incidents)
    .filter(isObject)
    .filter((i) => text(i.state) === "open")
    .map((i) => ({
      name: text(i.title),
      url: webUrl(i.full_url) ?? pageUrl,
      components: list(i.systems)
        .filter(isObject)
        .map((s) => text(s.name))
        .filter((n) => n !== ""),
    }))
    .filter((i) => i.name !== "");
  return {
    name: "Heroku",
    state: worst(parts.map((c) => c.state)),
    components: parts,
    incidents,
  };
}

// ---------------------------------------------------------------------------
// Slack: /api/v2.0.0/current (moved to slack-status.com). The JSON names
// no components, only the services an incident touches; the list is the
// page's own. https://docs.slack.dev/reference/slack-status-api

export const SLACK_SERVICES = [
  "Login/SSO",
  "Connectivity",
  "Messaging",
  "Files",
  "Notifications",
  "Huddles",
  "Search",
  "Apps/Integrations/APIs",
  "Workspace/Org Administration",
  "Workflows",
  "Canvases",
];

const SLACK: Record<string, VendorState> = {
  outage: "down",
  incident: "slow",
  notice: "slow",
};

export function isSlack(body: unknown): boolean {
  return (
    isObject(body) &&
    ["ok", "active", "broken"].includes(text(body.status)) &&
    Array.isArray(body.active_incidents)
  );
}

export function parseSlack(body: unknown, pageUrl: string): VendorReading {
  if (!isSlack(body) || !isObject(body)) throw new Error("not Slack's status");
  const open = list(body.active_incidents)
    .filter(isObject)
    .filter((i) => text(i.status) === "active");
  const stateOf = (i: Json): VendorState => SLACK[text(i.type)] ?? "up";
  const names = [
    ...new Set([
      ...SLACK_SERVICES,
      ...open.flatMap((i) => list(i.services).map(text)),
    ]),
  ].filter((n) => n !== "");
  const parts = names.map((name) => ({
    name,
    state: worst(
      open
        .filter((i) => list(i.services).map(text).includes(name))
        .map(stateOf),
    ),
  }));
  return {
    name: "Slack",
    state: worst(open.map(stateOf)),
    components: parts,
    incidents: open
      .map((i) => ({
        name: text(i.title),
        url: webUrl(i.url) ?? pageUrl,
        components: list(i.services)
          .map(text)
          .filter((n) => n !== ""),
      }))
      .filter((i) => i.name !== ""),
  };
}
