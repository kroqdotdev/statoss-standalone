// Turns what readKuma found into a configuration, a list of the secrets it
// refers to, and a summary of what came across and what did not.
//
// The rules below that mirror the loader's (hostnames, methods, record
// types, token shape, name anchors) are copied, not imported, so that this
// runs under plain Node in the image without the app's dependencies. The
// tests feed every output through the real loader to keep them in step.

import { randomBytes } from "node:crypto";
import type {
  KumaData,
  KumaMaintenance,
  KumaMonitor,
  KumaNotification,
} from "./read.mts";
import {
  isPlainSafe,
  renderYaml,
  type EnvRef,
  type Pair,
  type YamlMap,
  type YamlValue,
} from "./yaml.mts";

export interface Secret {
  name: string;
  value: string;
  /** What it is, for the comment above it in the .env output. */
  about: string;
}

export interface ImportResult {
  yaml: string;
  env: string;
  summary: string;
  secrets: Secret[];
  /** Things to look at, also marked "check:" in the file. */
  attention: string[];
  /** What was not imported, and why. */
  skipped: string[];
  /** Monitors paused in Kuma, left out. */
  paused: string[];
}

export interface ImportOptions {
  /** The file read, for the header. */
  file?: string;
  now?: number;
  /** Makes new secrets; random unless a test fixes it. */
  newSecret?: () => string;
}

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^[0-9A-Fa-f:]+$/;
const TOKEN = /^[A-Za-z0-9_-]{8,}$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const DNS_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]);
const HTTP_TYPES = new Set(["http", "keyword", "json-query", "real-browser"]);
/** Types whose interval sets how often they are checked here too. */
const TIMED_TYPES = new Set(["http", "tcp", "dns", "ping"]);
const PUBLIC_RESOLVERS = new Set([
  "1.1.1.1",
  "1.0.0.1",
  "8.8.8.8",
  "8.8.4.4",
  "9.9.9.9",
  "149.112.112.112",
  "208.67.222.222",
  "208.67.220.220",
]);
/** Kuma types a tcp monitor on the same port stands in for, roughly. */
const PORT_TYPES = new Set([
  "postgres",
  "mysql",
  "sqlserver",
  "mongodb",
  "redis",
  "rabbitmq",
  "mqtt",
  "smtp",
]);
/** Header names and values a request can carry, as the loader takes them. */
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const SECRET_HEADER =
  /auth|token|key|secret|cookie|session|passw|signature|credential/i;
/** Second-level labels under a country code, as in example.co.uk. */
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);
const PRIVATE_TLDS = new Set([
  "local",
  "localhost",
  "internal",
  "lan",
  "home",
  "arpa",
  "test",
  "example",
  "invalid",
  "intranet",
  "corp",
]);

type Result<T> = { ok: T } | { skip: string };

interface Entry {
  kumaId: number | null;
  name: string;
  type: string;
  group?: string;
  /** Kuma's interval, for the types where it carries over. */
  interval?: number;
  fields: Pair[];
  notes: string[];
}

interface Window {
  title: string;
  start: number;
  end: number;
  repeat?: "weekly" | "monthly";
  until?: string;
  monitors?: string[];
  notes?: string;
}

interface Site {
  name: string;
  host: string;
  pageId: number | null;
  description?: string;
  logo?: string;
  theme?: string;
  noindex: boolean;
  /** The zone the site's repeating maintenance keeps its time of day in. */
  timezone?: string;
  comments: string[];
  notes: string[];
  entries: Entry[];
  components: Entry[];
  maintenance: Window[];
  names: Set<string>;
  anchors: Set<string>;
  certificates: Map<string, { host: string; port: number; group?: string }>;
  domains: Map<string, { group?: string }>;
  notificationIds: number[];
}

interface Destination {
  id: number;
  name: string;
  items: YamlMap[];
  email: boolean;
  /** Said only if a site uses the destination. */
  notes: string[];
}

function slug(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The anchor a name gets on the page; two names with one anchor clash. */
function anchor(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "unnamed";
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function bareHost(host: string): string {
  return host
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

function isIp(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

/** The registrable domain of a host, as Kuma 2 found it or a fair guess. */
function domainOf(host: string, known: string[]): string | null {
  const h = bareHost(host).toLowerCase();
  if (isIp(h) || !h.includes(".")) return null;
  const labels = h.split(".");
  if (PRIVATE_TLDS.has(labels[labels.length - 1])) return null;
  const found = known
    .filter((d) => h === d || h.endsWith(`.${d}`))
    .sort((a, b) => b.length - a.length)[0];
  if (found) return found;
  const tld = labels[labels.length - 1];
  const keep =
    labels.length >= 3 &&
    tld.length === 2 &&
    SECOND_LEVEL.has(labels[labels.length - 2])
      ? 3
      : 2;
  return labels.slice(-keep).join(".");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The wall clock in a zone at a moment. `month` counts from 0. */
function wallClock(ts: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(ts);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month") - 1,
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

function zoneOffset(ts: number, zone: string): number {
  const c = wallClock(ts, zone);
  const wall = Date.UTC(c.year, c.month, c.day, c.hour, c.minute, c.second);
  return wall - Math.floor(ts / 1000) * 1000;
}

/** The moment a wall-clock time in a zone names. `month` counts from 0. */
function zoned(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string,
): number {
  const wall = Date.UTC(year, month, day, hour, minute, second);
  const guess = wall - zoneOffset(wall, zone);
  return wall - zoneOffset(guess, zone);
}

/** The day in a zone at a moment, as 2026-10-04. */
function localDay(ts: number, zone: string): string {
  const c = wallClock(ts, zone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${c.year}-${pad(c.month + 1)}-${pad(c.day)}`;
}

/** A Kuma maintenance time ("2026-10-10 02:00", in a zone) as UTC ms. */
export function kumaTime(text: string, zone: string): number | null {
  const s = text.trim();
  if (s === "") return null;
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    const ms = Date.parse(s.replace(" ", "T"));
    return Number.isFinite(ms) ? ms : null;
  }
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  return zoned(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
    zone,
  );
}

/** When repeating maintenance starts: weekdays (0 is Sunday) or days of the month (32 is the last). */
export interface Schedule {
  minute: number;
  hour: number;
  weekdays?: number[];
  days?: number[];
}

/**
 * The cron Kuma keeps for repeating maintenance, read as weekdays or as
 * days of the month at one time of day. Null for one that is neither,
 * such as one with steps, months, or both days and weekdays.
 */
export function readCron(cron: string): Schedule | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [mi, h, dom, month, dow] = fields;
  if (!/^\d{1,2}$/.test(mi) || !/^\d{1,2}$/.test(h) || month !== "*")
    return null;
  const minute = Number(mi);
  const hour = Number(h);
  if (minute > 59 || hour > 23) return null;
  const list = (field: string, low: number, high: number, last: boolean) => {
    const found = new Set<number>();
    for (const part of field.split(",")) {
      if (last && part === "L") {
        found.add(32);
        continue;
      }
      const r = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(part);
      if (!r) return null;
      const from = Number(r[1]);
      const to = Number(r[2] ?? r[1]);
      if (from < low || to > high || from > to) return null;
      for (let n = from; n <= to; n++) found.add(last ? n : n % 7);
    }
    return [...found].sort((a, b) => a - b);
  };
  if (dom === "*" && dow === "*")
    return { minute, hour, weekdays: [0, 1, 2, 3, 4, 5, 6] };
  if (dom === "*") {
    const weekdays = list(dow, 0, 7, false);
    return weekdays ? { minute, hour, weekdays } : null;
  }
  if (dow === "*") {
    const days = list(dom, 1, 31, true);
    return days ? { minute, hour, days } : null;
  }
  return null;
}

/** The first time at hour:minute in a zone, on a day that matches, from `from` on. */
function nextStart(
  from: number,
  zone: string,
  schedule: Schedule,
  matches: (year: number, month: number, day: number) => boolean,
): number | null {
  const c = wallClock(from, zone);
  for (let i = 0; i <= 400; i++) {
    const date = new Date(Date.UTC(c.year, c.month, c.day + i));
    const [y, m, d] = [
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
    ];
    if (!matches(y, m, d)) continue;
    const start = zoned(y, m, d, schedule.hour, schedule.minute, 0, zone);
    if (start >= from) return start;
  }
  return null;
}

function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

/** How Kuma's accepted status codes carry over: any 2xx, or one exact status. */
function statusRule(codes: string[]): {
  expect?: number;
  note?: string;
  skip?: string;
} {
  const list = codes.map((c) => c.trim()).filter(Boolean);
  if (list.length === 0) return {};
  const ranges = list.map((c) => {
    const m = /^(\d{3})(?:-(\d{3}))?$/.exec(c);
    return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
  });
  const shown = list.join(", ");
  if (ranges.some((r) => r === null))
    return { note: `Kuma accepted status ${shown}; this passes on any 2xx.` };
  const valid = ranges as number[][];
  if (valid.some(([from, to]) => from <= 200 && to >= 299)) {
    const others = list.filter((c) => c !== "200-299");
    return others.length > 0
      ? {
          note: `Kuma also accepted status ${others.join(", ")}; this passes on 2xx only.`,
        }
      : {};
  }
  if (valid.length === 1 && valid[0][0] === valid[0][1]) {
    const status = valid[0][0];
    return status >= 100 && status <= 599
      ? { expect: status }
      : { skip: `it expects status ${status}, which is not an HTTP status` };
  }
  if (valid.every(([from, to]) => from >= 200 && to <= 299))
    return { note: `Kuma accepted status ${shown}; this passes on any 2xx.` };
  return {
    skip: `it passes on status ${shown}, and here a check passes on any 2xx or on one exact status`,
  };
}

export function convertKuma(
  data: KumaData,
  options: ImportOptions = {},
): ImportResult {
  const now = options.now ?? Date.now();
  const newSecret =
    options.newSecret ?? (() => randomBytes(24).toString("base64url"));
  const monitors = new Map(data.monitors.map((m) => [m.id, m]));
  const children = new Map<number, KumaMonitor[]>();
  for (const m of data.monitors)
    if (m.parent !== null)
      children.set(m.parent, [...(children.get(m.parent) ?? []), m]);

  const secrets: Secret[] = [];
  const secretNames = new Map<string, string>();
  const envNames = new Set<string>(["SMTP_PASS"]);
  const attention: string[] = [];
  const skipped: string[] = [];
  const skippedIds = new Set<number>();
  const paused: string[] = [];
  const pausedIds = new Set<number>();
  const heartbeatIds = new Set<number>();
  const usedHosts = new Set<string>();

  /** A secret's reference, and the secret kept for the --env output. */
  function secretRef(
    key: string,
    base: string,
    value: string,
    about: string,
    prefix = "",
  ): EnvRef {
    // A value that is not safe bare goes between double quotes, where the
    // loader puts it in as it stands; quotes, backslashes and line breaks
    // in it are kept escaped the way YAML reads them there.
    const quote = !isPlainSafe(prefix + value);
    const escape = quote && /["\\\u0000-\u001f\u007f]/.test(value);
    let name = secretNames.get(key);
    if (name === undefined) {
      name = base;
      for (let n = 2; envNames.has(name); n++) name = `${base}_${n}`;
      envNames.add(name);
      secretNames.set(key, name);
      secrets.push({
        name,
        value: escape ? JSON.stringify(value).slice(1, -1) : value,
        about: escape ? `${about}, escaped as YAML reads it in quotes` : about,
      });
    }
    return {
      env: name,
      ...(prefix ? { prefix } : {}),
      ...(quote ? { quote } : {}),
    };
  }

  function ancestors(m: KumaMonitor): KumaMonitor[] {
    const list: KumaMonitor[] = [];
    const seen = new Set<number>([m.id]);
    for (let id = m.parent; id !== null && !seen.has(id);) {
      seen.add(id);
      const parent = monitors.get(id);
      if (!parent) break;
      list.push(parent);
      id = parent.parent;
    }
    return list;
  }

  /** Paused in Kuma, itself or through a group it is in. */
  const isPaused = (m: KumaMonitor) =>
    !m.active || ancestors(m).some((a) => !a.active);

  /** The notifications that fire for a monitor: its own and its groups'. */
  const notificationsOf = (m: KumaMonitor) =>
    new Set([m, ...ancestors(m)].flatMap((x) => x.notificationIds));

  const target = (m: KumaMonitor): string => {
    if (HTTP_TYPES.has(m.type)) return m.url;
    if (m.type === "push") return "";
    if (m.port && m.type === "port") return `${m.hostname}:${m.port}`;
    return m.hostname;
  };

  // Destinations ------------------------------------------------------------

  const activeMonitorNotifications = new Set(
    data.monitors
      .filter((m) => !isPaused(m))
      .flatMap((m) => [...notificationsOf(m)]),
  );
  const smtpServers = data.notifications.filter(
    (n) =>
      n.active &&
      n.type.toLowerCase() === "smtp" &&
      String(n.config.smtpHost ?? "").trim() !== "",
  );
  const smtpMain =
    smtpServers.find((n) => activeMonitorNotifications.has(n.id)) ??
    smtpServers[0];
  let smtp: YamlMap | null = null;
  const smtpNotes: string[] = [];
  if (smtpMain) {
    const c = smtpMain.config;
    const secure = c.smtpSecure === true || c.smtpSecure === "true";
    const port = Number(c.smtpPort) || (secure ? 465 : 587);
    const user = String(c.smtpUsername ?? "").trim();
    const from = String(c.smtpFrom ?? "").trim() || user;
    if (secure && port !== 465)
      smtpNotes.push(
        `Kuma used TLS from the start on port ${port}; this uses TLS from the start on 465 only, and STARTTLS on any other port.`,
      );
    if (c.smtpIgnoreSTARTTLS === true)
      smtpNotes.push(
        "Kuma sent mail without STARTTLS; this requires STARTTLS on any port but 465.",
      );
    if (!user)
      smtpNotes.push(
        "Kuma sent mail without signing in; this needs a user and SMTP_PASS.",
      );
    smtp = {
      pairs: [
        { key: "host", value: String(c.smtpHost).trim() },
        { key: "port", value: port },
        { key: "user", value: user || "CHANGE-ME" },
        { key: "from", value: from || "CHANGE-ME" },
      ],
      before: smtpNotes.map((n) => `check: ${n}`),
    };
    const password = String(c.smtpPassword ?? "");
    if (password) {
      secrets.push({
        name: "SMTP_PASS",
        value: password,
        about: `${smtpMain.name}: SMTP password`,
      });
    }
  }

  function destination(n: KumaNotification): Result<Destination> {
    const c = n.config;
    const s = (key: string) => String(c[key] ?? "").trim();
    const kind = n.type.toLowerCase();
    const label = n.name || `notification ${n.id}`;
    const base = (word: string) => {
      const words = slug(label)
        .split("_")
        .filter((w) => w && w !== word);
      return [word, ...words].join("_");
    };
    const notes: string[] = [];
    const note = (text: string) => notes.push(`Alerts, "${label}": ${text}`);
    const item = (...pairs: Pair[]): YamlMap => ({ pairs });
    if (!n.active) return { skip: "it is turned off in Kuma" };
    switch (kind) {
      case "smtp": {
        const addresses = [s("smtpTo"), s("smtpCC"), s("smtpBCC")]
          .join(",")
          .split(/[,;]/)
          .map((a) => a.trim())
          .filter(Boolean);
        if (!s("smtpHost")) return { skip: "it has no SMTP server" };
        if (addresses.length === 0) return { skip: "it has no recipient" };
        if (smtpMain && smtpMain.id !== n.id) {
          const main = smtpMain.config;
          if (
            s("smtpHost") !== String(main.smtpHost ?? "").trim() ||
            s("smtpUsername") !== String(main.smtpUsername ?? "").trim()
          )
            note(
              `it is sent through ${String(main.smtpHost).trim()} here, the one SMTP server a configuration has.`,
            );
        }
        return {
          ok: {
            id: n.id,
            name: label,
            email: true,
            notes,
            items: addresses.map((a) => item({ key: "email", value: a })),
          },
        };
      }
      case "slack": {
        const url = s("slackwebhookURL");
        if (!isHttpUrl(url)) return { skip: "it has no webhook URL" };
        const ref = secretRef(
          `n${n.id}`,
          base("SLACK"),
          url,
          `${label}: Slack webhook URL`,
        );
        return {
          ok: {
            id: n.id,
            name: label,
            email: false,
            notes,
            items: [item({ key: "slack", value: ref })],
          },
        };
      }
      case "discord": {
        let url = s("discordWebhookUrl");
        if (!isHttpUrl(url)) return { skip: "it has no webhook URL" };
        if (s("discordChannelType") === "postToThread" && s("threadId"))
          url += `${url.includes("?") ? "&" : "?"}thread_id=${encodeURIComponent(s("threadId"))}`;
        if (s("discordChannelType") === "createNewForumPost")
          note(
            "Kuma opened a forum post for each alert; this posts to the webhook's channel, which a forum channel refuses.",
          );
        const ref = secretRef(
          `n${n.id}`,
          base("DISCORD"),
          url,
          `${label}: Discord webhook URL`,
        );
        return {
          ok: {
            id: n.id,
            name: label,
            email: false,
            notes,
            items: [item({ key: "discord", value: ref })],
          },
        };
      }
      case "webhook": {
        const url = s("webhookURL");
        if (!isHttpUrl(url)) return { skip: "it has no URL" };
        const ref = secretRef(
          `n${n.id}`,
          base("WEBHOOK"),
          url,
          `${label}: webhook URL`,
        );
        const secret = secretRef(
          `n${n.id}:secret`,
          `${base("WEBHOOK")}_SECRET`,
          newSecret(),
          `${label}: new secret that signs each delivery`,
        );
        note(
          "the receiver gets StatOSS's JSON body, signed with a new secret, not Kuma's. See the webhook part of Monitor types in the README.",
        );
        return {
          ok: {
            id: n.id,
            name: label,
            email: false,
            notes,
            items: [
              item(
                { key: "webhook", value: ref },
                { key: "secret", value: secret },
              ),
            ],
          },
        };
      }
      case "pagerduty": {
        const key = s("pagerdutyIntegrationKey");
        if (!key) return { skip: "it has no integration key" };
        const url = s("pagerdutyIntegrationUrl");
        if (url && !url.startsWith("https://events.pagerduty.com/"))
          note(
            `Kuma sent events to ${url}; this sends them to events.pagerduty.com.`,
          );
        const ref = secretRef(
          `n${n.id}`,
          base("PAGERDUTY"),
          key,
          `${label}: PagerDuty integration key`,
        );
        return {
          ok: {
            id: n.id,
            name: label,
            email: false,
            notes,
            items: [item({ key: "pagerduty", value: ref })],
          },
        };
      }
      case "opsgenie": {
        const key = s("opsgenieApiKey");
        if (!key) return { skip: "it has no API key" };
        const ref = secretRef(
          `n${n.id}`,
          base("OPSGENIE"),
          key,
          `${label}: Opsgenie API key`,
        );
        const pairs: Pair[] = [{ key: "opsgenie", value: ref }];
        if (s("opsgenieRegion") === "eu")
          pairs.push({ key: "region", value: "eu" });
        return {
          ok: {
            id: n.id,
            name: label,
            email: false,
            notes,
            items: [item(...pairs)],
          },
        };
      }
      case "ntfy": {
        const server = (s("ntfyserverurl") || "https://ntfy.sh").replace(
          /\/+$/,
          "",
        );
        const topic = s("ntfytopic");
        const url = `${server}/${encodeURIComponent(topic)}`;
        if (!topic || !isHttpUrl(url))
          return { skip: "it has no server or topic" };
        const pairs: Pair[] = [{ key: "ntfy", value: url }];
        const method = s("ntfyAuthenticationMethod");
        const token = s("ntfyaccesstoken");
        if (token && (method === "accessToken" || method === "")) {
          pairs.push({
            key: "token",
            value: secretRef(
              `n${n.id}`,
              `${base("NTFY")}_TOKEN`,
              token,
              `${label}: ntfy access token`,
            ),
          });
        } else if (
          method === "usernamePassword" ||
          (method === "" && s("ntfyusername"))
        ) {
          note(
            "Kuma signed in to ntfy with a user name and password; make an access token and add it as token:.",
          );
        }
        return {
          ok: {
            id: n.id,
            name: label,
            email: false,
            notes,
            items: [item(...pairs)],
          },
        };
      }
      default:
        return {
          skip: `${n.type || "this kind of notification"} is not one of the destinations here`,
        };
    }
  }

  const destinations = new Map<number, Destination>();
  for (const n of data.notifications) {
    const label = `notification "${n.name || n.id}" (${n.type || "unknown"})`;
    if (!activeMonitorNotifications.has(n.id)) {
      skipped.push(`${label}: no active monitor uses it`);
      continue;
    }
    const result = destination(n);
    if ("skip" in result) skipped.push(`${label}: ${result.skip}`);
    else destinations.set(n.id, result.ok);
  }

  // Sites -------------------------------------------------------------------

  function newSite(
    name: string,
    wantedHost: string,
    placeholder: string,
    pageId: number | null,
  ): Site {
    let host = wantedHost && HOSTNAME.test(wantedHost) ? wantedHost : "";
    const isPlaceholder = host === "" || usedHosts.has(host);
    if (isPlaceholder) {
      host = placeholder;
      for (let n = 2; usedHosts.has(host); n++)
        host = placeholder.replace(/^([^.]+)/, `$1-${n}`);
    }
    usedHosts.add(host);
    return {
      name,
      host,
      pageId,
      noindex: false,
      comments: [],
      notes: isPlaceholder
        ? [
            `set host to the hostname this page is served on (${host} is made up).`,
          ]
        : [],
      entries: [],
      components: [],
      maintenance: [],
      names: new Set(),
      anchors: new Set(),
      certificates: new Map(),
      domains: new Map(),
      notificationIds: [],
    };
  }

  function uniqueName(site: Site, wanted: string): string {
    let name = wanted;
    for (let n = 2; site.names.has(name) || site.anchors.has(anchor(name)); n++)
      name = `${wanted} (${n})`;
    site.names.add(name);
    site.anchors.add(anchor(name));
    return name;
  }

  const tlsDays = Math.min(
    365,
    Math.max(0, ...(data.tlsExpiryDays.length ? data.tlsExpiryDays : [21])),
  );
  const domainDays = Math.min(
    365,
    Math.max(
      0,
      ...(data.domainExpiryDays.length ? data.domainExpiryDays : [21]),
    ),
  );

  /** One Kuma monitor on one site: a monitor, a component, or skipped. */
  function convertMonitor(
    m: KumaMonitor,
    site: Site,
    group: string | undefined,
  ): Result<{ entry: Entry; component: boolean }> {
    const name = m.name || `${m.type} ${m.id}`;
    const notes: string[] = [];
    const fields: Pair[] = [];
    const key = slug(name) || `MONITOR_${m.id}`;
    const expiry = (host: string, port: number) => {
      if (m.expiryNotification && HOSTNAME.test(host)) {
        const id = port === 443 ? host : `${host}:${port}`;
        if (!site.certificates.has(id))
          site.certificates.set(id, { host, port, group });
      }
    };
    const domain = (host: string) => {
      const d = m.domainExpiryNotification
        ? domainOf(host, data.knownDomains)
        : null;
      if (d && HOSTNAME.test(d) && !site.domains.has(d))
        site.domains.set(d, { group });
    };
    const checkHost = (): Result<string> => {
      const host = bareHost(m.hostname);
      if (!host) return { skip: "it has no host" };
      if (!HOSTNAME.test(host))
        return {
          skip: `its host "${host}" is not a hostname this takes (letters, digits, dots and dashes)`,
        };
      return { ok: host };
    };
    if (m.upsideDown && m.type !== "manual")
      return {
        skip: "it is in upside down mode, which the standalone does not have",
      };
    const entry = (type: string, interval?: number): Entry => ({
      kumaId: m.id,
      name,
      type,
      group,
      interval,
      fields,
      notes,
    });

    if (HTTP_TYPES.has(m.type)) {
      let url: URL;
      try {
        url = new URL(m.url);
      } catch {
        return { skip: `its URL is not valid: ${m.url}` };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:")
        return { skip: `its URL is not http or https: ${m.url}` };
      const auth = m.authMethod;
      if (auth === "oauth2-cc")
        return {
          skip: "it signs in with OAuth2 client credentials, which the standalone cannot do",
        };
      if (auth === "ntlm")
        return {
          skip: "it signs in with NTLM, which the standalone cannot do",
        };
      if (auth === "mtls")
        return {
          skip: "it sends a client certificate, which the standalone cannot do",
        };
      const status = statusRule(m.acceptedStatusCodes);
      if (status.skip) return { skip: status.skip };

      fields.push({
        key: "url",
        value:
          url.username || url.password
            ? secretRef(
                `m${m.id}:url`,
                `URL_${key}`,
                m.url,
                `${name}: URL with a password`,
              )
            : m.url,
      });
      const methodOk = METHODS.has(m.method);
      if (!methodOk) notes.push(`Kuma sent ${m.method}; this sends GET.`);
      else if (m.method !== "GET")
        fields.push({ key: "method", value: m.method });

      const headers: Pair[] = [];
      if (m.headers) {
        const parsed = parseJson(m.headers);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [rawName, rawValue] of Object.entries(parsed)) {
            const header = rawName.trim();
            if (!header) continue;
            const value = (
              typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue)
            ).trim();
            if (!HEADER_NAME.test(header)) {
              notes.push(
                `the header "${header}" was left out: a header name here has letters, digits and dashes only.`,
              );
              continue;
            }
            if (!HEADER_VALUE.test(value)) {
              notes.push(
                `the ${header} header was left out: its value has a character a request cannot carry.`,
              );
              continue;
            }
            headers.push({
              key: header,
              value: SECRET_HEADER.test(header)
                ? secretRef(
                    `m${m.id}:h:${header}`,
                    `HEADER_${key}_${slug(header)}`,
                    value,
                    `${name}: ${header} header`,
                  )
                : value,
            });
          }
        } else {
          notes.push("its headers are not valid JSON and were left out.");
        }
      }
      const hasHeader = (h: string) =>
        headers.some((p) => p.key.toLowerCase() === h);
      if (
        auth === "basic" &&
        (m.basicAuthUser || m.basicAuthPass) &&
        !hasHeader("authorization")
      ) {
        headers.push({
          key: "Authorization",
          value: secretRef(
            `m${m.id}:auth`,
            `AUTH_${key}`,
            Buffer.from(`${m.basicAuthUser}:${m.basicAuthPass}`).toString(
              "base64",
            ),
            `${name}: basic auth (base64 of user:password)`,
            "Basic ",
          ),
        });
      } else if (
        auth === "bearer" &&
        m.bearerToken.trim() &&
        !HEADER_VALUE.test(m.bearerToken.trim())
      ) {
        notes.push(
          "its bearer token was left out: it has a character a request cannot carry.",
        );
      } else if (
        auth === "bearer" &&
        m.bearerToken.trim() &&
        !hasHeader("authorization")
      ) {
        headers.push({
          key: "Authorization",
          value: secretRef(
            `m${m.id}:auth`,
            `AUTH_${key}`,
            m.bearerToken.trim(),
            `${name}: bearer token`,
            "Bearer ",
          ),
        });
      } else if (auth && auth !== "basic" && auth !== "bearer") {
        notes.push(`Kuma signed in with ${auth}; this does not.`);
      }

      const body = m.body.trim() ? m.body : "";
      if (body && (!methodOk || m.method === "GET" || m.method === "HEAD")) {
        notes.push(
          `Kuma sent a body with ${m.method}; this sends none with GET or HEAD.`,
        );
      } else if (body) {
        if (!hasHeader("content-type")) {
          const type =
            m.bodyEncoding === "xml"
              ? "text/xml; charset=utf-8"
              : m.bodyEncoding === "form"
                ? "application/x-www-form-urlencoded"
                : "application/json";
          headers.push({ key: "Content-Type", value: type });
        }
      }
      if (headers.length > 0)
        fields.push({ key: "headers", value: { pairs: headers } });
      if (body && methodOk && m.method !== "GET" && m.method !== "HEAD")
        fields.push({ key: "body", value: body });
      if (status.expect !== undefined)
        fields.push({ key: "expectStatus", value: status.expect });
      if (status.note) notes.push(status.note);
      if (m.type === "keyword" && m.keyword) {
        fields.push({ key: "keyword", value: m.keyword });
        if (m.invertKeyword)
          fields.push({ key: "keywordMode", value: "absent" });
      }
      if (m.type === "json-query")
        notes.push(
          `the JSON query is not checked, only the status: ${[m.jsonPath, m.jsonPathOperator || "==", m.expectedValue].join(" ")}.`,
        );
      if (m.type === "real-browser")
        notes.push("this loads the page with a plain request, not a browser.");
      if (m.ignoreTls && url.protocol === "https:")
        notes.push(
          "Kuma ignored certificate errors here; this check does not.",
        );
      if (m.proxyId !== null)
        notes.push("Kuma went through a proxy; this check goes direct.");
      const host = bareHost(url.hostname);
      if (url.protocol === "https:") expiry(host, Number(url.port) || 443);
      domain(host);
      return { ok: { entry: entry("http", m.interval), component: false } };
    }

    switch (m.type) {
      case "port": {
        const host = checkHost();
        if ("skip" in host) return host;
        if (!m.port || m.port < 1 || m.port > 65535)
          return { skip: "it has no port" };
        if (m.expectedTlsAlert && m.expectedTlsAlert !== "none")
          return {
            skip: "it expects a TLS alert, which the standalone does not check",
          };
        fields.push(
          { key: "host", value: host.ok },
          { key: "port", value: m.port },
        );
        domain(host.ok);
        return { ok: { entry: entry("tcp", m.interval), component: false } };
      }
      case "ping": {
        const host = checkHost();
        if ("skip" in host) return host;
        fields.push({ key: "host", value: host.ok });
        domain(host.ok);
        return { ok: { entry: entry("ping", m.interval), component: false } };
      }
      case "dns": {
        const host = checkHost();
        if ("skip" in host) return host;
        if (!DNS_TYPES.has(m.dnsType))
          return {
            skip: `${m.dnsType} records are not checked here (A, AAAA, CNAME, MX, TXT and NS are)`,
          };
        fields.push({ key: "host", value: host.ok });
        if (m.dnsType !== "A") fields.push({ key: "record", value: m.dnsType });
        const conditions = m.conditions ? parseJson(m.conditions) : [];
        if (Array.isArray(conditions) && conditions.length > 0) {
          const [only] = conditions as Array<Record<string, unknown>>;
          const simple =
            conditions.length === 1 &&
            only?.type === "expression" &&
            only.variable === "record" &&
            (only.operator === "contains" || only.operator === "equals") &&
            typeof only.value === "string" &&
            only.value.trim() !== "";
          if (simple) {
            fields.push({ key: "expect", value: String(only.value) });
            if (only.operator === "equals")
              notes.push(
                "Kuma wanted an answer equal to this; here one answer must contain it.",
              );
          } else {
            notes.push("Kuma's conditions on the answer are not checked here.");
          }
        }
        const servers = m.dnsServer
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (servers.some((s) => !PUBLIC_RESOLVERS.has(s)))
          notes.push(
            `Kuma asked ${servers.join(", ")}; this asks the system's resolver.`,
          );
        domain(host.ok);
        return { ok: { entry: entry("dns", m.interval), component: false } };
      }
      case "push": {
        if (heartbeatIds.has(m.id))
          return {
            skip: "it is a push monitor on another site already, and a heartbeat token can be used once",
          };
        heartbeatIds.add(m.id);
        const fresh = !TOKEN.test(m.pushToken);
        const token = fresh ? newSecret() : m.pushToken;
        const ref = secretRef(
          `m${m.id}:token`,
          `HEARTBEAT_${key}`,
          token,
          `${name}: heartbeat token${fresh ? " (new)" : ""}`,
        );
        fields.push(
          { key: "token", value: ref },
          { key: "intervalSeconds", value: Math.max(10, m.interval) },
        );
        notes.push(
          `the job must call https://${site.host}/heartbeat/$${ref.env} now, not Kuma's /api/push/ URL.${fresh ? " Kuma's token was too short, so this is a new one." : ""}`,
        );
        return { ok: { entry: entry("heartbeat"), component: false } };
      }
      case "manual": {
        const state =
          m.manualStatus === 0
            ? "major"
            : m.manualStatus === 2
              ? "degraded"
              : "operational";
        if (state !== "operational")
          fields.push({ key: "state", value: state });
        return { ok: { entry: entry("component"), component: true } };
      }
      default:
        return {
          skip: `${m.type} monitors are not checked here${PORT_TYPES.has(m.type) ? "; a tcp monitor on its port is the nearest" : ""}`,
        };
    }
  }

  function addMonitor(site: Site, m: KumaMonitor, group: string | undefined) {
    if (m.type === "group") return;
    if (isPaused(m)) {
      if (!pausedIds.has(m.id)) {
        pausedIds.add(m.id);
        const where = target(m);
        paused.push(`"${m.name}" (${m.type}${where ? ` ${where}` : ""})`);
      }
      return;
    }
    if (
      site.entries.some((e) => e.kumaId === m.id) ||
      site.components.some((c) => c.kumaId === m.id)
    )
      return;
    const result = convertMonitor(m, site, group);
    if ("skip" in result) {
      if (!skippedIds.has(m.id)) {
        skippedIds.add(m.id);
        skipped.push(
          `monitor "${m.name}" (${m.type}, ${site.name}): ${result.skip}`,
        );
      }
      return;
    }
    const { entry, component } = result.ok;
    entry.name = uniqueName(site, entry.name);
    (component ? site.components : site.entries).push(entry);
  }

  /** The monitors a page lists: a Kuma group stands for the monitors in it. */
  function expand(m: KumaMonitor, seen = new Set<number>()): KumaMonitor[] {
    if (seen.has(m.id)) return [];
    seen.add(m.id);
    if (m.type !== "group") return [m];
    return (children.get(m.id) ?? []).flatMap((c) => expand(c, seen));
  }

  const sites: Site[] = [];
  const onPage = new Set<number>();
  for (const page of data.statusPages) {
    const site = newSite(
      page.title || page.slug || "Status",
      page.domains[0] ?? "",
      `${/^[a-z0-9-]+$/.test(page.slug) ? page.slug : "status"}.example.com`,
      page.id,
    );
    site.comments.push(`Kuma's status page /status/${page.slug}.`);
    if (page.extras.length > 0)
      site.comments.push(`Not imported: ${page.extras.join(", ")}.`);
    if (page.description) {
      site.description =
        page.description.length > 400
          ? `${page.description.slice(0, 397).trimEnd()}...`
          : page.description;
      if (page.description.length > 400)
        site.notes.push("the description was cut to 400 characters.");
    }
    if (isHttpUrl(page.icon)) site.logo = page.icon;
    else if (page.icon.startsWith("/upload/")) {
      const file = page.icon.split("?")[0].replace(/^\//, "");
      site.notes.push(
        `the logo is ${file} in Kuma's data folder. Copy it next to config.yaml and add logo: with its file name.`,
      );
    }
    if (page.theme === "light" || page.theme === "dark")
      site.theme = page.theme;
    if (!page.searchEngineIndex) site.noindex = true;
    for (const group of page.groups) {
      for (const id of group.monitorIds) {
        const m = monitors.get(id);
        if (!m) continue;
        for (const shown of expand(m)) {
          onPage.add(shown.id);
          addMonitor(site, shown, group.name || undefined);
        }
        onPage.add(m.id);
      }
    }
    sites.push(site);
  }

  const rest = data.monitors.filter(
    (m) => !onPage.has(m.id) && m.type !== "group",
  );
  const restActive = rest.filter((m) => !isPaused(m));
  if (sites.length > 0 && restActive.length === 0)
    for (const m of rest) addMonitor(sites[0], m, undefined);
  if (sites.length === 0 || restActive.length > 0) {
    const alone = sites.length === 0;
    const site = newSite(
      alone ? "Status" : "Other monitors",
      "",
      alone ? "status.example.com" : "other.example.com",
      null,
    );
    site.noindex = true;
    site.notes.push(
      alone
        ? `${data.source.endsWith("backup") ? "a Kuma backup holds no status pages" : "Kuma had no status page"}, so every monitor is on this one site. Give it a name, and a password if the page is not for everyone.`
        : "these monitors were on no status page in Kuma. This site has a page of its own: give it a password, or move the monitors to another site.",
    );
    for (const m of rest) {
      const path = ancestors(m)
        .map((a) => a.name)
        .reverse()
        .join(" / ");
      addMonitor(site, m, path || undefined);
    }
    sites.push(site);
  }

  // Expiry monitors, and how often each monitor is checked ------------------

  for (const site of sites) {
    for (const [id, cert] of site.certificates) {
      site.entries.push({
        kumaId: null,
        name: uniqueName(site, `${id} certificate`),
        type: "certificate",
        group: cert.group,
        fields: [
          { key: "host", value: cert.host },
          ...(cert.port !== 443 ? [{ key: "port", value: cert.port }] : []),
          { key: "warnDays", value: tlsDays },
        ],
        notes: [],
      });
    }
    for (const [domain, info] of site.domains) {
      site.entries.push({
        kumaId: null,
        name: uniqueName(site, `${domain} domain`),
        type: "domain",
        group: info.group,
        fields: [
          { key: "host", value: domain },
          { key: "warnDays", value: domainDays },
        ],
        notes: [],
      });
    }
  }
  const timed = sites.flatMap((s) =>
    s.entries.filter(
      (e) => TIMED_TYPES.has(e.type) && e.interval !== undefined,
    ),
  );
  const checkInterval = Math.max(
    10,
    timed.length > 0 ? Math.min(...timed.map((e) => e.interval as number)) : 60,
  );

  // Where alerts go ---------------------------------------------------------

  for (const site of sites) {
    const checked = site.entries
      .map((e) => (e.kumaId === null ? undefined : monitors.get(e.kumaId)))
      .filter((m): m is KumaMonitor => m !== undefined);
    const sets = checked.map(notificationsOf);
    const ids = [...new Set(sets.flatMap((s) => [...s]))]
      .filter((id) => destinations.has(id))
      .sort((a, b) => a - b);
    site.notificationIds = ids;
    const partial = ids.flatMap((id) => {
      const count = sets.filter((s) => s.has(id)).length;
      return count < checked.length
        ? [`"${destinations.get(id)?.name}" (${count} of ${checked.length})`]
        : [];
    });
    if (partial.length > 0)
      site.notes.push(
        `in Kuma, ${partial.join(", ")} alerted for some of these monitors only; here each destination gets every monitor of the site.`,
      );
  }
  const sameEverywhere =
    sites.length > 0 &&
    sites[0].notificationIds.length > 0 &&
    sites.every(
      (s) => s.notificationIds.join() === sites[0].notificationIds.join(),
    );
  const itemsFor = (ids: number[]) =>
    ids.flatMap((id) => destinations.get(id)?.items ?? []);
  const usesEmail = sites.some((s) =>
    s.notificationIds.some((id) => destinations.get(id)?.email),
  );
  if (usesEmail) {
    attention.push(...smtpNotes.map((n) => `alerts.smtp: ${n}`));
  } else if (smtp) {
    // The server was only there for notifications nothing here uses.
    smtp = null;
    const i = secrets.findIndex((s) => s.name === "SMTP_PASS");
    if (i >= 0) secrets.splice(i, 1);
  }
  const used = new Set(sites.flatMap((s) => s.notificationIds));
  for (const d of destinations.values()) {
    if (used.has(d.id)) attention.push(...d.notes);
    else skipped.push(`notification "${d.name}": no imported monitor uses it`);
  }

  // Maintenance -------------------------------------------------------------

  let ended = 0;
  /** The zone Kuma read a window's times in, and a note when it is a guess. */
  const zoneOf = (m: KumaMaintenance): { zone: string; note?: string } => {
    const own = m.timezone && m.timezone !== "SAME_AS_SERVER" ? m.timezone : "";
    const zone = own || data.serverTimezone || "UTC";
    if (!isZone(zone))
      return {
        zone: "UTC",
        note: `${zone} is not a time zone; UTC is assumed.`,
      };
    if (!own && !data.serverTimezone)
      return {
        zone,
        note: "Kuma read its times in the server's time zone, which the database does not name; UTC is assumed.",
      };
    return { zone };
  };

  type Planned = Omit<Window, "title" | "monitors" | "notes">;
  /** The windows one Kuma maintenance becomes: one, or one per weekday or date it repeats on. */
  const planned = (
    m: KumaMaintenance,
    zone: string,
    notes: string[],
  ): Result<Planned[]> | { ended: true } => {
    if (m.strategy === "manual")
      return {
        skip: "it is on until it is turned off; write a window with an end under maintenance",
      };
    const first = kumaTime(m.startDate, zone);
    const last = kumaTime(m.endDate, zone);
    if (m.strategy === "single") {
      if (first === null || last === null || last <= first)
        return { skip: "it has no start and end" };
      return last <= now
        ? { ended: true }
        : { ok: [{ start: first, end: last }] };
    }
    let schedule = readCron(m.cron);
    if (m.strategy === "recurring-interval" && schedule) {
      const every = m.intervalDay ?? 1;
      if (every === 7 && first !== null) {
        const c = wallClock(first, zone);
        schedule = {
          ...schedule,
          weekdays: [new Date(Date.UTC(c.year, c.month, c.day)).getUTCDay()],
        };
      } else if (every !== 1) {
        return {
          skip: `it repeats every ${every} days, and here a window repeats every week or every month`,
        };
      }
    }
    if (!schedule)
      return {
        skip: `it repeats on a schedule that is not some weekdays or some days of the month (${m.cron || m.strategy})`,
      };
    const length = (m.duration ?? 0) * 1000;
    if (!(length > 0)) return { skip: "it has no length" };
    const repeat = schedule.weekdays ? "weekly" : "monthly";
    if (length >= (repeat === "weekly" ? 7 : 28) * 24 * 60 * 60 * 1000)
      return { skip: "each window lasts as long as the time between two" };
    if (last !== null && last <= now) return { ended: true };
    const until = last === null ? undefined : localDay(last, zone);
    const from = Math.max(now, first ?? now);
    if (schedule.days?.some((d) => d >= 29 && d <= 31))
      notes.push(
        "Kuma skipped the months without its day; here such a month has it on its last day.",
      );
    const windows: Planned[] = [];
    for (const target of schedule.weekdays ?? schedule.days ?? []) {
      // The last day of the month is found as a 31st: a monthly repeat
      // keeps to the last day of the shorter months.
      const start = nextStart(from, zone, schedule, (y, mo, d) =>
        schedule.weekdays
          ? new Date(Date.UTC(y, mo, d)).getUTCDay() === target
          : d === Math.min(target, 31),
      );
      if (
        start === null ||
        (until !== undefined && localDay(start, zone) > until)
      )
        continue;
      windows.push({
        start,
        end: start + length,
        repeat,
        ...(until ? { until } : {}),
      });
    }
    return windows.length > 0 ? { ok: windows } : { ended: true };
  };

  for (const m of data.maintenance) {
    if (!m.active) continue;
    const label = `maintenance "${m.title}"`;
    const { zone, note } = zoneOf(m);
    const notes = note ? [note] : [];
    const result = planned(m, zone, notes);
    if ("ended" in result) {
      ended++;
      continue;
    }
    if ("skip" in result) {
      skipped.push(`${label}: ${result.skip}`);
      continue;
    }
    let placed = false;
    for (const site of sites) {
      const whole =
        site.pageId !== null && m.statusPageIds.includes(site.pageId);
      const names = [...site.entries, ...site.components]
        .filter((e) => e.kumaId !== null && m.monitorIds.includes(e.kumaId))
        .map((e) => e.name);
      if (!whole && names.length === 0) continue;
      const title = m.title || "Maintenance";
      for (const w of result.ok) {
        if (
          site.maintenance.some(
            (other) =>
              other.title === title &&
              Math.floor(other.start / 60_000) === Math.floor(w.start / 60_000),
          )
        )
          continue;
        if (w.repeat) {
          // A repeat keeps its time of day in the site's zone, so the site
          // takes the zone of the first one.
          site.timezone ??= zone;
          // The loader reads `until` in the site's zone: a window that
          // would start after it there is one that never starts.
          if (
            w.until !== undefined &&
            localDay(w.start, site.timezone) > w.until
          )
            continue;
          if (site.timezone !== zone)
            notes.push(
              `it repeats at its time of day in ${site.timezone} on ${site.name}, where Kuma kept it in ${zone}.`,
            );
        }
        site.maintenance.push({
          title,
          ...w,
          ...(whole ? {} : { monitors: names }),
          ...(m.description ? { notes: m.description } : {}),
        });
        placed = true;
      }
    }
    if (!placed)
      skipped.push(`${label}: it covers no monitor that was imported`);
    else
      attention.push(
        ...[...new Set(notes)].map((n) => `Maintenance "${m.title}": ${n}`),
      );
  }

  if (data.pinnedIncidents > 0)
    attention.push(
      `Kuma had ${plural(data.pinnedIncidents, "incident")} pinned to a status page. Write the ones you want as incident files (see Incidents in the README).`,
    );
  const resending = data.monitors.filter(
    (m) => m.resendInterval > 0 && !isPaused(m),
  );
  if (resending.length > 0)
    attention.push(
      `Kuma repeated alerts for ${plural(resending.length, "monitor")} while down. Set alerts.repeatMinutes if you want that here.`,
    );

  // The configuration -------------------------------------------------------

  const monitorMap = (e: Entry): YamlMap => {
    const pairs: Pair[] = [{ key: "name", value: e.name }];
    if (e.type !== "http" && e.type !== "component")
      pairs.push({ key: "type", value: e.type });
    if (e.group) pairs.push({ key: "group", value: e.group });
    if (
      e.interval !== undefined &&
      TIMED_TYPES.has(e.type) &&
      e.interval > checkInterval
    )
      pairs.push({ key: "intervalSeconds", value: e.interval });
    pairs.push(...e.fields);
    return { pairs, before: e.notes.map((n) => `check: ${n}`) };
  };
  const siteMaps = sites.map((site, i): YamlMap => {
    const pairs: Pair[] = [
      { key: "name", value: site.name },
      { key: "host", value: site.host },
    ];
    if (site.description)
      pairs.push({ key: "description", value: site.description });
    if (site.logo) pairs.push({ key: "logo", value: site.logo });
    if (site.theme) pairs.push({ key: "theme", value: site.theme });
    if (site.timezone && site.timezone !== "UTC")
      pairs.push({ key: "timezone", value: site.timezone });
    if (site.noindex) pairs.push({ key: "noindex", value: true });
    if (!sameEverywhere && site.notificationIds.length > 0)
      pairs.push({
        key: "alerts",
        value: {
          pairs: [{ key: "to", value: itemsFor(site.notificationIds) }],
        },
      });
    pairs.push({ key: "monitors", value: site.entries.map(monitorMap) });
    if (site.components.length > 0)
      pairs.push({ key: "components", value: site.components.map(monitorMap) });
    if (site.maintenance.length > 0)
      pairs.push({
        key: "maintenance",
        value: site.maintenance.map((w): YamlMap => ({
          pairs: [
            { key: "title", value: w.title },
            { key: "start", value: iso(w.start) },
            { key: "end", value: iso(w.end) },
            ...(w.repeat ? [{ key: "repeat", value: w.repeat }] : []),
            ...(w.until ? [{ key: "until", value: w.until }] : []),
            ...(w.monitors
              ? [{ key: "monitors", value: w.monitors as YamlValue[] }]
              : []),
            ...(w.notes ? [{ key: "notes", value: w.notes }] : []),
          ],
        })),
      });
    return {
      pairs,
      blank: i > 0,
      before: [...site.comments, ...site.notes.map((n) => `check: ${n}`)],
    };
  });

  const docPairs: Pair[] = [
    { key: "checkIntervalSeconds", value: checkInterval },
  ];
  const alertPairs: Pair[] = [];
  if (smtp)
    alertPairs.push({
      key: "smtp",
      value: { pairs: smtp.pairs },
      before: smtp.before,
    });
  if (sameEverywhere)
    alertPairs.push({ key: "to", value: itemsFor(sites[0].notificationIds) });
  if (alertPairs.length > 0)
    docPairs.push({ key: "alerts", value: { pairs: alertPairs }, blank: true });
  docPairs.push({ key: "sites", value: siteMaps, blank: true });

  for (const site of sites) {
    attention.push(...site.notes.map((n) => `${site.name}: ${n}`));
    for (const e of [...site.entries, ...site.components])
      attention.push(...e.notes.map((n) => `${site.name}, "${e.name}": ${n}`));
  }
  // Only a reference writes "${" in the file: a literal one is escaped. So
  // the secrets in use are the ones whose reference is there.
  const body = renderYaml({ pairs: docPairs });
  const usedSecrets = secrets.filter(
    (s) => s.name === "SMTP_PASS" || body.includes(`\${${s.name}}`),
  );

  const date = new Date(now).toISOString().slice(0, 10);
  const header = [
    `Made by import-kuma from ${data.source}${options.file ? ` (${options.file})` : ""} on ${date}.`,
    'Lines that start with "check:" need a look before you start the container.',
    ...(usedSecrets.length > 0
      ? [
          "Secrets are not in this file. It reads them from environment variables;",
          "run import-kuma again with --env to print them, with their values, for .env.",
        ]
      : []),
  ];
  const footer = [
    ...(skipped.length > 0
      ? ["Not imported from Uptime Kuma:", ...skipped.map((s) => `  - ${s}`)]
      : []),
    ...(paused.length > 0
      ? [
          ...(skipped.length > 0 ? [""] : []),
          "Paused in Kuma, left out:",
          ...paused.map((p) => `  - ${p}`),
        ]
      : []),
  ];
  const yaml = renderYaml({ pairs: docPairs }, header, footer);

  const env = [
    "# Secrets for the configuration import-kuma wrote. Keep this file private.",
    ...usedSecrets.flatMap((s) => [
      `# ${s.about.replace(/[\r\n]+/g, " ")}`,
      envLine(s.name, s.value),
    ]),
    "",
  ].join("\n");

  const monitorCount = sites.reduce((n, s) => n + s.entries.length, 0);
  const added = sites.reduce(
    (n, s) => n + s.entries.filter((e) => e.kumaId === null).length,
    0,
  );
  const componentCount = sites.reduce((n, s) => n + s.components.length, 0);
  const windowCount = sites.reduce((n, s) => n + s.maintenance.length, 0);
  const skippedOf = (prefix: string) =>
    skipped.filter((s) => s.startsWith(prefix)).length;
  const parts = [
    plural(monitorCount, "monitor") +
      (added > 0 ? ` (${added} for certificate or domain expiry)` : ""),
    ...(componentCount > 0 ? [plural(componentCount, "component")] : []),
    plural(used.size, "alert destination"),
    ...(windowCount > 0 ? [plural(windowCount, "maintenance window")] : []),
  ];
  const notImported = [
    ...(skippedOf("monitor") > 0
      ? [plural(skippedOf("monitor"), "monitor")]
      : []),
    ...(skippedOf("notification") > 0
      ? [plural(skippedOf("notification"), "notification")]
      : []),
    ...(skippedOf("maintenance") > 0
      ? [plural(skippedOf("maintenance"), "maintenance window")]
      : []),
  ];
  const summary = [
    `Read ${data.source}: ${plural(data.monitors.length, "monitor")}, ${plural(data.notifications.length, "notification")}, ${plural(data.statusPages.length, "status page")}, ${plural(data.maintenance.length, "maintenance window")}.`,
    `Wrote ${plural(sites.length, "site")}: ${parts.join(", ")}.`,
    ...(notImported.length > 0
      ? [
          `Not imported: ${notImported.join(", ")}. They are listed at the end of the file.`,
        ]
      : []),
    ...(paused.length > 0
      ? [`Paused in Kuma, left out: ${plural(paused.length, "monitor")}.`]
      : []),
    ...(ended > 0
      ? [`Maintenance that has ended, left out: ${plural(ended, "window")}.`]
      : []),
    ...(data.monitors.length === 0
      ? [
          "No monitors found. If Kuma is running, its newest changes are in kuma.db-wal: copy that file too, or stop Kuma first.",
        ]
      : []),
    ...(attention.length > 0
      ? [
          "",
          'Needs attention (marked "check:" in the file):',
          ...attention.map((a) => `  - ${a}`),
        ]
      : []),
    ...(usedSecrets.length > 0
      ? [
          "",
          "Secrets are not in the file. Set these environment variables; run again with --env to print them with their values:",
          `  ${usedSecrets.map((s) => s.name).join(", ")}`,
        ]
      : []),
    "",
  ].join("\n");

  return {
    yaml,
    env,
    summary,
    secrets: usedSecrets,
    attention,
    skipped,
    paused,
  };
}

/** NAME=value for .env: bare when safe, quoted the way Docker Compose reads it. */
function envLine(name: string, value: string): string {
  if (/^[A-Za-z0-9_./:@+=,%?&~-]*$/.test(value)) return `${name}=${value}`;
  if (!value.includes("'") && !/[\r\n]/.test(value))
    return `${name}='${value}'`;
  return `${name}="${value.replace(/[\\"$`]/g, "\\$&").replace(/\r?\n/g, "\\n")}"`;
}
