import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** The request methods a checkpoint can use. */
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

const checkpointSchema = z.object({
  name: z.string().min(1),
  url: z.url(),
  /** Checkpoints with the same group are shown together on the page. */
  group: z.string().min(1).optional(),
  method: z.enum(METHODS).default("GET"),
  headers: z.record(z.string().min(1), z.string()).optional(),
  body: z.string().optional(),
  expectStatus: z.number().int().min(100).max(599).optional(),
  /** Text the response body must contain, or must not (keywordMode). */
  keyword: z.string().min(1).optional(),
  keywordMode: z.enum(["present", "absent"]).default("present"),
  /** A successful check slower than this counts as slow. */
  slowThresholdMs: z.number().int().min(1).optional(),
});

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
  | { webhook: string; secret: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DESTINATION_HELP =
  "A destination is one of: email: <address>, slack: <webhook url>, discord: <webhook url>, or webhook: <url> with secret: <text>.";

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
  return fail(DESTINATION_HELP);
});

const alertsSchema = z.object({
  smtp: smtpSchema.optional(),
  /** Destinations for every site that has no list of its own. */
  to: z.array(destinationSchema).default([]),
  /** Minutes between repeat notices while a checkpoint stays down. 0 is off. */
  repeatMinutes: z.number().int().min(0).default(0),
});

const siteAlertsSchema = z.object({
  to: z.array(destinationSchema).optional(),
  repeatMinutes: z.number().int().min(0).optional(),
});

const maintenanceSchema = z
  .object({
    title: z.string().min(1),
    start: timestampSchema,
    end: timestampSchema,
    /** Checkpoint names the window covers. Omit it for the whole site. */
    checkpoints: z.array(z.string().min(1)).min(1).optional(),
    notes: z.string().optional(),
  })
  .refine((window) => window.end > window.start, {
    message: "end must be after start",
    path: ["end"],
  });

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

const siteSchema = z
  .object({
    name: z.string().min(1),
    host: z.string().min(1),
    /** Where the page lives, for links in alerts. Default: https://<host>. */
    url: z.url().optional(),
    checkpoints: z.array(checkpointSchema).min(1),
    /** false turns alerts off for this site. */
    alerts: z.union([z.literal(false), siteAlertsSchema]).optional(),
    maintenance: z.array(maintenanceSchema).default([]),
  })
  .superRefine((site, ctx) => {
    const names = site.checkpoints.map((cp) => cp.name);
    for (const name of duplicates(names)) {
      ctx.addIssue({
        code: "custom",
        path: ["checkpoints"],
        message: `checkpoint name "${name}" is used more than once`,
      });
    }
    site.maintenance.forEach((window, i) => {
      for (const name of window.checkpoints ?? []) {
        if (!names.includes(name))
          ctx.addIssue({
            code: "custom",
            path: ["maintenance", i, "checkpoints"],
            message: `"${name}" is not a checkpoint of this site`,
          });
      }
    });
  });

const configSchema = z
  .object({
    checkIntervalSeconds: z.number().int().min(10).default(60),
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
export type CheckpointConfig = SiteConfig["checkpoints"][number];
export type MaintenanceConfig = SiteConfig["maintenance"][number];
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
