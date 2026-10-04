import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { isTimeZone, localDate, rowId } from "./format";
import { longestWindow, REPEATS } from "./repeats";
import { normalizeVendorUrl } from "./vendors";

/** The request methods a monitor can use. */
export const METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;
export type Method = (typeof METHODS)[number];

/**
 * A moment in time from YAML. Accepts an ISO 8601 string, a date and time
 * without a zone (read as UTC), or a Date if the YAML parser made one.
 */
export function parseTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  const bare = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(
    text,
  );
  const iso = bare
    ? `${bare[1]}T${bare[2] ?? "00:00"}:${bare[3] ?? "00"}Z`
    : text;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export const timestampSchema = z.unknown().transform((value, ctx) => {
  const ms = parseTimestamp(value);
  if (ms === null) {
    ctx.addIssue({
      code: "custom",
      message: `"${String(value)}" is not a date and time. Write it like 2026-09-20T01:00:00Z.`,
    });
    return z.NEVER;
  }
  return ms;
});

/** The kinds of monitor. http is the default. */
export const MONITOR_TYPES = [
  "http",
  "tcp",
  "dns",
  "ping",
  "certificate",
  "domain",
  "heartbeat",
] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];

export const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"] as const;

/** Types whose response time means something and can be slow. */
export const LATENCY_TYPES: ReadonlySet<MonitorType> = new Set([
  "http",
  "tcp",
  "dns",
  "ping",
]);

/**
 * How often a type runs at most, whatever checkIntervalSeconds says. A
 * registry or a certificate does not change by the minute, and RDAP servers
 * rate limit callers who ask as if it did.
 */
export const TYPE_MIN_INTERVAL_SECONDS: Partial<Record<MonitorType, number>> = {
  certificate: 60 * 60,
  domain: 6 * 60 * 60,
};

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_CERTIFICATE_WARN_DAYS = 14;
export const DEFAULT_DOMAIN_WARN_DAYS = 30;
/**
 * The highest slow threshold a monitor can have. A check that takes longer
 * than the timeout is a failure, not a slow success.
 */
export const MAX_SLOW_THRESHOLD_MS = DEFAULT_TIMEOUT_MS - 1;

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^[0-9A-Fa-f:]+$/;

/** Whether a header name can be sent: letters, digits and dashes. */
export function isHeaderName(name: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(name);
}

/**
 * Whether a header value can be sent: tabs and bytes up to 255, no other
 * controls. fetch refuses a character above U+00FF, such as a curly quote,
 * and a line break would start a second header.
 */
export function isHeaderValue(value: string): boolean {
  return /^[\t\x20-\x7e\x80-\xff]*$/.test(value);
}

/** Which fields each type reads, besides name, type, group and intervalSeconds. */
const TYPE_FIELDS: Record<MonitorType, string[]> = {
  http: [
    "url",
    "method",
    "headers",
    "body",
    "expectStatus",
    "keyword",
    "keywordMode",
    "slowThresholdMs",
  ],
  tcp: ["host", "port", "slowThresholdMs"],
  dns: ["host", "record", "expect", "slowThresholdMs"],
  ping: ["host", "slowThresholdMs"],
  certificate: ["host", "port", "warnDays"],
  domain: ["host", "warnDays"],
  heartbeat: ["token"],
};

const monitorSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(MONITOR_TYPES).default("http"),
    /** http: the URL to request. */
    url: z.url().optional(),
    /** Every other type but heartbeat: the hostname, or the domain. */
    host: z.string().regex(HOSTNAME, "must be a hostname").optional(),
    /** tcp, and certificate (default 443). */
    port: z.number().int().min(1).max(65535).optional(),
    /** dns: the record type to ask for. */
    record: z.enum(DNS_TYPES).optional(),
    /** dns: text one of the answers must contain. */
    expect: z.string().min(1).optional(),
    /** certificate and domain: fail this many days before expiry. */
    warnDays: z.number().int().min(0).max(365).optional(),
    /** heartbeat: the secret in the URL the job pings. */
    token: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,}$/, {
        message: "must be at least 8 letters, digits, dashes or underscores",
      })
      .optional(),
    /** Seconds between this monitor's checks, when longer than the default. */
    intervalSeconds: z.number().int().min(10).optional(),
    /** Monitors with the same group are shown together on the page. */
    group: z.string().min(1).optional(),
    method: z.enum(METHODS).optional(),
    // Trimmed as fetch would trim it: a value written as a YAML block
    // ends in a line break.
    headers: z.record(z.string().min(1), z.string().trim()).optional(),
    body: z.string().optional(),
    expectStatus: z.number().int().min(100).max(599).optional(),
    /** Text the response body must contain, or must not (keywordMode). */
    keyword: z.string().min(1).optional(),
    keywordMode: z.enum(["present", "absent"]).optional(),
    /** A successful check slower than this counts as slow. */
    slowThresholdMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_SLOW_THRESHOLD_MS)
      .optional(),
  })
  .superRefine((m, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const allowed = TYPE_FIELDS[m.type];
    for (const field of new Set(Object.values(TYPE_FIELDS).flat())) {
      if (
        !allowed.includes(field) &&
        (m as Record<string, unknown>)[field] !== undefined
      )
        fail(field, `a ${m.type} monitor takes no ${field}`);
    }
    if (m.type === "http" && m.url === undefined)
      fail("url", "an http monitor needs a url");
    if (allowed.includes("host") && m.host === undefined)
      fail("host", `a ${m.type} monitor needs a host`);
    if (m.type === "tcp" && m.port === undefined)
      fail("port", "a tcp monitor needs a port");
    if (m.type === "heartbeat" && m.token === undefined)
      fail("token", "a heartbeat monitor needs a token");
    for (const [header, value] of Object.entries(m.headers ?? {})) {
      if (!isHeaderName(header))
        fail(
          "headers",
          `the header name "${header}" of monitor "${m.name}" can only have letters, digits and dashes`,
        );
      else if (!isHeaderValue(value))
        fail(
          "headers",
          `the ${header} header of monitor "${m.name}" has a character a request cannot carry, such as a curly quote or a line break`,
        );
    }
  })
  .transform((m) => ({
    ...m,
    method: m.method ?? "GET",
    keywordMode: m.keywordMode ?? "present",
  }));

/**
 * How long a heartbeat may go without a ping: its interval, and a tenth of
 * that (a minute at least) of grace, since a job does not finish at the
 * same second every time.
 */
export function heartbeatDeadlineSeconds(intervalSeconds: number): number {
  return intervalSeconds + Math.max(60, intervalSeconds / 10);
}

/** What a monitor points at, in words: the URL, "host:port", "A example.com". */
export function monitorTarget(m: {
  type: MonitorType;
  url?: string;
  host?: string;
  port?: number;
  record?: string;
}): string {
  switch (m.type) {
    case "http":
      return m.url ?? "";
    case "tcp":
      return `${m.host}:${m.port}`;
    case "dns":
      return `${m.record ?? "A"} ${m.host}`;
    case "certificate":
      return m.port && m.port !== 443 ? `${m.host}:${m.port}` : (m.host ?? "");
    case "heartbeat":
      return "expects a ping";
    default:
      return m.host ?? "";
  }
}

/**
 * Seconds between a monitor's checks: the default, the type's floor, or the
 * monitor's own when that is longer. A heartbeat is judged every round,
 * so that it goes down as soon as a ping is overdue; its own interval is
 * how often the pings are due (see heartbeatDeadlineSeconds).
 */
export function monitorIntervalSeconds(
  m: { type: MonitorType; intervalSeconds?: number },
  defaultSeconds: number,
): number {
  if (m.type === "heartbeat") return defaultSeconds;
  return Math.max(
    defaultSeconds,
    TYPE_MIN_INTERVAL_SECONDS[m.type] ?? 0,
    m.intervalSeconds ?? 0,
  );
}

const smtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  from: z.string().min(1),
  /** A shorthand for one email destination in `alerts.to`. */
  to: z.string().min(1).optional(),
});

/** Where an alert goes. One of these per list entry. */
export type Destination =
  | { email: string }
  | { slack: string }
  | { discord: string }
  | { webhook: string; secret: string }
  | { pagerduty: string }
  | { opsgenie: string; region?: "us" | "eu" }
  | { ntfy: string; token?: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DESTINATION_HELP =
  "A destination is one of: email: <address>, slack: <webhook url>, discord: <webhook url>, webhook: <url> with secret: <text>, pagerduty: <integration key>, opsgenie: <api key>, or ntfy: <topic url>.";

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const destinationSchema = z.unknown().transform((value, ctx): Destination => {
  const fail = (message: string) => {
    ctx.addIssue({ code: "custom", message });
    return z.NEVER;
  };
  if (!isPlainObject(value)) return fail(DESTINATION_HELP);
  const keys = Object.keys(value);
  if ("email" in value) {
    if (
      keys.length !== 1 ||
      typeof value.email !== "string" ||
      value.email.trim() === ""
    )
      return fail("email must be an address and nothing else.");
    return { email: value.email.trim() };
  }
  if ("slack" in value) {
    if (keys.length !== 1 || !isHttpUrl(value.slack))
      return fail(
        "slack must be a Slack incoming webhook URL and nothing else.",
      );
    return { slack: value.slack };
  }
  if ("discord" in value) {
    if (keys.length !== 1 || !isHttpUrl(value.discord))
      return fail("discord must be a Discord webhook URL and nothing else.");
    return { discord: value.discord };
  }
  if ("webhook" in value) {
    if (!isHttpUrl(value.webhook))
      return fail("webhook must be an http or https URL.");
    if (typeof value.secret !== "string" || value.secret === "")
      return fail(
        "webhook needs a secret, the text used to sign each delivery.",
      );
    if (keys.length !== 2) return fail(DESTINATION_HELP);
    return { webhook: value.webhook, secret: value.secret };
  }
  if ("pagerduty" in value) {
    if (
      keys.length !== 1 ||
      typeof value.pagerduty !== "string" ||
      value.pagerduty.trim() === ""
    )
      return fail(
        "pagerduty must be an Events API v2 integration key and nothing else.",
      );
    return { pagerduty: value.pagerduty.trim() };
  }
  if ("opsgenie" in value) {
    if (typeof value.opsgenie !== "string" || value.opsgenie.trim() === "")
      return fail("opsgenie must be an API key.");
    const region = value.region ?? "us";
    if (
      (region !== "us" && region !== "eu") ||
      keys.some((k) => k !== "opsgenie" && k !== "region")
    )
      return fail("opsgenie takes an API key and, optionally, region: eu.");
    return { opsgenie: value.opsgenie.trim(), region };
  }
  if ("ntfy" in value) {
    if (!isHttpUrl(value.ntfy))
      return fail(
        "ntfy must be the topic's URL, like https://ntfy.sh/mytopic.",
      );
    const token = value.token;
    if (
      (token !== undefined && (typeof token !== "string" || token === "")) ||
      keys.some((k) => k !== "ntfy" && k !== "token")
    )
      return fail("ntfy takes a topic URL and, optionally, token: <text>.");
    return token === undefined
      ? { ntfy: value.ntfy }
      : { ntfy: value.ntfy, token };
  }
  return fail(DESTINATION_HELP);
});

const alertsSchema = z.object({
  smtp: smtpSchema.optional(),
  /** Destinations for every site that has no list of its own. */
  to: z.array(destinationSchema).default([]),
  /** Minutes between repeat notices while a monitor stays down. 0 is off. */
  repeatMinutes: z.number().int().min(0).default(0),
  /** false keeps incident updates and maintenance notices to the page. */
  updates: z.boolean().default(true),
  /** false sends nothing when a vendor a component follows changes state. */
  vendors: z.boolean().default(true),
});

const siteAlertsSchema = z.object({
  to: z.array(destinationSchema).optional(),
  repeatMinutes: z.number().int().min(0).optional(),
  updates: z.boolean().optional(),
  vendors: z.boolean().optional(),
});

/**
 * "checkpoints" is what the first releases called monitors. A configuration
 * or an incident file that still says it reads the same.
 */
export function monitorsFromCheckpoints(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "checkpoints" in value &&
    !("monitors" in value)
  ) {
    const { checkpoints, ...rest } = value as Record<string, unknown>;
    return { ...rest, monitors: checkpoints };
  }
  return value;
}

/** A day on the calendar, like 2027-03-31, kept as written. */
const dateSchema = z.unknown().transform((value, ctx) => {
  const text =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : typeof value === "string"
        ? value.trim()
        : "";
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? Date.parse(`${text}T00:00:00Z`)
    : NaN;
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== text
  ) {
    ctx.addIssue({
      code: "custom",
      message: `"${String(value)}" is not a date. Write it like 2027-03-31.`,
    });
    return z.NEVER;
  }
  return text;
});

const maintenanceWindowSchema = z
  .object({
    title: z.string().min(1),
    start: timestampSchema,
    end: timestampSchema,
    /** Monitor names the window covers. Omit it for the whole site. */
    monitors: z.array(z.string().min(1)).min(1).optional(),
    notes: z.string().optional(),
    /**
     * Repeats at the first window's time of day in the site's zone: every
     * week on its weekday, every month on its date, or every month on its
     * weekday (the second Tuesday, the last Friday).
     */
    repeat: z
      .enum(REPEATS, { error: "must be weekly, monthly or monthly-weekday" })
      .optional(),
    /** The last day a repeat may start on, in the site's zone. */
    until: dateSchema.optional(),
  })
  .superRefine((window, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (window.end <= window.start) fail("end", "end must be after start");
    if (window.until !== undefined && window.repeat === undefined)
      fail("until", "until is for a window that repeats; add repeat");
    if (
      window.repeat !== undefined &&
      window.end - window.start >= longestWindow(window.repeat)
    )
      fail(
        "end",
        window.repeat === "weekly"
          ? "a window that repeats every week has to be shorter than a week"
          : "a window that repeats every month has to be shorter than four weeks",
      );
  });

const maintenanceSchema = z.preprocess(
  monitorsFromCheckpoints,
  maintenanceWindowSchema,
);

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

export const COMPONENT_STATES = [
  "operational",
  "degraded",
  "partial",
  "major",
] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];

/**
 * A part of the product with no check, such as a mobile app. Its state is
 * what the file says, or what an open incident that names it says.
 */
const componentSchema = z
  .object({
    name: z.string().min(1),
    group: z.string().min(1).optional(),
    /** A line under the name. */
    description: z.string().min(1).optional(),
    state: z.enum(COMPONENT_STATES).default("operational"),
    /**
     * A vendor's public status page to follow (see vendors.ts for the
     * platforms read). The component's state is then the vendor's, and
     * `state` only what it shows while the vendor cannot be read.
     */
    vendor: z
      .url({ protocol: /^https?$/ })
      .transform((url) => normalizeVendorUrl(url))
      .optional(),
    /** One part of the vendor's page to follow, by its name there. */
    part: z.string().min(1).optional(),
  })
  .refine((c) => c.part === undefined || c.vendor !== undefined, {
    message: "part needs a vendor",
    path: ["part"],
  });

/** Days the hourly totals, resolved outages and sent notices are kept. */
export const HISTORY_DAYS = 400;

const siteObjectSchema = z
  .object({
    name: z.string().min(1),
    host: z.string().min(1),
    /** Where the page lives, for links in alerts. Default: https://<host>. */
    url: z.url().optional(),
    /** A sentence or two under the headline. */
    description: z.string().min(1).max(400).optional(),
    /**
     * An image above the headline: a file next to the configuration (PNG,
     * JPEG, GIF, WebP or SVG), or an http(s) address.
     */
    logo: z.string().min(1).optional(),
    /** The browser tab's icon, given the same way. */
    favicon: z.string().min(1).optional(),
    /** The colour of links, focus rings and buttons, as #rrggbb. */
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "must be a colour like #7a3cff")
      .optional(),
    /** auto follows the visitor's system. */
    theme: z.enum(["auto", "light", "dark"]).default("auto"),
    /** Where "Contact support" goes: an https address or a mailto. */
    supportUrl: z
      .string()
      .regex(
        /^(https?:\/\/|mailto:)\S+$/,
        "must be an http(s) or mailto address",
      )
      .optional(),
    /**
     * The zone times are written in until the visitor's browser says its
     * own, and the one the history's months follow.
     */
    timezone: z
      .string()
      .refine(isTimeZone, {
        message: "is not a time zone, like Europe/Copenhagen",
      })
      .default("UTC"),
    /** true asks search engines to leave the page out. */
    noindex: z.boolean().default(false),
    /** The view the page opens on. */
    defaultRange: z.enum(["24h", "7d", "90d", "1y"]).default("24h"),
    /** false keeps deploy markers off the strips. */
    showDeploys: z.boolean().default(true),
    /** true folds away the groups in which everything is up. */
    foldGroups: z.boolean().default(false),
    /** With a password, the page and its endpoints are locked. */
    password: z.string().min(1).optional(),
    /** Lets embeds past the password: ?key=<embedKey> on the endpoints. */
    embedKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,}$/, {
        message: "must be at least 8 letters, digits, dashes or underscores",
      })
      .optional(),
    /** Uptime to hold each month, in percent. Shows the error budget. */
    uptimeTarget: z.number().min(50).lt(100).optional(),
    monitors: z.array(monitorSchema).default([]),
    components: z.array(componentSchema).default([]),
    /** false turns alerts off for this site. */
    alerts: z.union([z.literal(false), siteAlertsSchema]).optional(),
    maintenance: z.array(maintenanceSchema).default([]),
  })
  .superRefine((site, ctx) => {
    const names = [
      ...site.monitors.map((cp) => cp.name),
      ...site.components.map((c) => c.name),
    ];
    for (const name of duplicates(names)) {
      ctx.addIssue({
        code: "custom",
        path: ["monitors"],
        message: `monitor name "${name}" is used more than once`,
      });
    }
    // Names that make the same anchor on the page, like "API v2" and
    // "API-v2", would link one row's incidents to the other.
    const anchors = names.map((n) => rowId(n));
    for (const anchor of duplicates(anchors)) {
      const alike = names.filter((n) => rowId(n) === anchor);
      if (new Set(alike).size > 1)
        ctx.addIssue({
          code: "custom",
          path: ["monitors"],
          message: `names ${alike.map((n) => `"${n}"`).join(" and ")} are too alike; change one`,
        });
    }
    // A window is known by its start, to the minute, and its title.
    const windows = site.maintenance.map(
      (w) => `${Math.floor(w.start / 60_000)}\0${w.title}`,
    );
    if (duplicates(windows).length > 0)
      ctx.addIssue({
        code: "custom",
        path: ["maintenance"],
        message:
          "two maintenance windows have the same title and start in the same minute",
      });
    site.maintenance.forEach((window, i) => {
      // A zone that is not one is refused on its own.
      if (
        window.until !== undefined &&
        isTimeZone(site.timezone) &&
        window.until < localDate(window.start, site.timezone)
      )
        ctx.addIssue({
          code: "custom",
          path: ["maintenance", i, "until"],
          message: `until is before the first window, which starts on ${localDate(window.start, site.timezone)}`,
        });
      for (const name of window.monitors ?? []) {
        if (!names.includes(name))
          ctx.addIssue({
            code: "custom",
            path: ["maintenance", i, "monitors"],
            message: `"${name}" is not a monitor or component of this site`,
          });
      }
    });
  });

const siteSchema = z.preprocess(monitorsFromCheckpoints, siteObjectSchema);

const configSchema = z
  .object({
    checkIntervalSeconds: z.number().int().min(10).default(60),
    /**
     * Days every single check is kept. The hourly totals behind the 7-day,
     * 90-day and 1-year views are kept for 400 days whatever this says.
     */
    retentionDays: z.number().int().min(2).max(HISTORY_DAYS).default(90),
    alerts: alertsSchema.optional(),
    sites: z.array(siteSchema).min(1),
  })
  .superRefine((config, ctx) => {
    const hosts = config.sites.map((site) => site.host.toLowerCase());
    for (const host of duplicates(hosts)) {
      ctx.addIssue({
        code: "custom",
        path: ["sites"],
        message: `host "${host}" is used by more than one site`,
      });
    }
    const tokens = config.sites.flatMap((site) =>
      site.monitors.flatMap((m) => (m.token ? [m.token] : [])),
    );
    if (duplicates(tokens).length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["sites"],
        message: "a heartbeat token is used by more than one monitor",
      });
    }
    const wantsEmail = config.sites.some((site) =>
      siteDestinations(config, site).some((d) => "email" in d),
    );
    if (wantsEmail && !config.alerts?.smtp) {
      ctx.addIssue({
        code: "custom",
        path: ["alerts", "smtp"],
        message: "an email destination needs alerts.smtp",
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;
export type SiteConfig = AppConfig["sites"][number];
export type MonitorConfig = SiteConfig["monitors"][number];
export type MaintenanceConfig = SiteConfig["maintenance"][number];
export type ComponentConfig = SiteConfig["components"][number];
export type AlertsConfig = NonNullable<AppConfig["alerts"]>;
export type SmtpConfig = NonNullable<AlertsConfig["smtp"]>;

/**
 * Where a site's alerts go. The site's own list wins; otherwise the global
 * list, plus the SMTP `to` shorthand. `alerts: false` on a site means nowhere.
 */
export function siteDestinations(
  config: Pick<AppConfig, "alerts">,
  site: Pick<SiteConfig, "alerts">,
): Destination[] {
  if (site.alerts === false || !config.alerts) return [];
  if (site.alerts?.to) return site.alerts.to;
  const list = [...config.alerts.to];
  const to = config.alerts.smtp?.to;
  if (to && !list.some((d) => "email" in d && d.email === to))
    list.push({ email: to });
  return list;
}

export function siteRepeatMinutes(
  config: Pick<AppConfig, "alerts">,
  site: Pick<SiteConfig, "alerts">,
): number {
  if (site.alerts === false || !config.alerts) return 0;
  return site.alerts?.repeatMinutes ?? config.alerts.repeatMinutes;
}

/** Whether a site's destinations also get incident updates and maintenance. */
export function siteSendsUpdates(
  config: Pick<AppConfig, "alerts">,
  site: Pick<SiteConfig, "alerts">,
): boolean {
  if (site.alerts === false || !config.alerts) return false;
  return site.alerts?.updates ?? config.alerts.updates;
}

/** Whether a site's destinations are told when a vendor it follows changes state. */
export function siteSendsVendorAlerts(
  config: Pick<AppConfig, "alerts">,
  site: Pick<SiteConfig, "alerts">,
): boolean {
  if (site.alerts === false || !config.alerts) return false;
  return site.alerts?.vendors ?? config.alerts.vendors;
}

/** The public address of a site's page, for links in alerts and feeds. */
export function siteUrl(site: Pick<SiteConfig, "host" | "url">): string {
  if (site.url) return site.url;
  const bare = site.host.split(":")[0].toLowerCase();
  const local = bare === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(bare);
  return `${local ? "http" : "https"}://${site.host}`;
}

/**
 * Replaces `${NAME}` with the environment variable NAME, so secrets can stay
 * out of the file. An unset variable is an error, not an empty string.
 */
export type Env = Record<string, string | undefined>;

export function expandEnv(text: string, env: Env = process.env): string {
  return text.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
    const value = env[name];
    if (value === undefined)
      throw new Error(
        `Invalid config: environment variable ${name} is used but not set`,
      );
    return value;
  });
}

export function parseConfig(
  yamlText: string,
  env: Env = process.env,
): AppConfig {
  const result = configSchema.safeParse(parse(expandEnv(yamlText, env)));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid config: ${details}`);
  }
  return result.data;
}

export function configPath(): string {
  return process.env.CONFIG_PATH ?? "./config.yaml";
}

/** The folder of incident files: INCIDENTS_DIR, or `incidents` next to the config. */
export function incidentsDir(): string {
  return (
    process.env.INCIDENTS_DIR ?? resolve(dirname(configPath()), "incidents")
  );
}

export function loadConfig(path = configPath()): AppConfig {
  return parseConfig(readFileSync(path, "utf8"));
}

const globals = globalThis as { __statusConfig?: AppConfig };

export function getConfig(): AppConfig {
  globals.__statusConfig ??= loadConfig();
  return globals.__statusConfig;
}

export function findSiteByHost(
  config: AppConfig,
  hostHeader: string | null,
): SiteConfig | undefined {
  if (!hostHeader) return undefined;
  const host = hostHeader.split(":")[0].toLowerCase();
  return config.sites.find((site) => site.host.toLowerCase() === host);
}
