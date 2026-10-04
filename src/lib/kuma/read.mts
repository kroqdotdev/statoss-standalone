// Reads an Uptime Kuma installation into one shape: its SQLite database
// (kuma.db, Kuma 1.23 and 2.x) or the JSON backup that Kuma 1 could export.
//
// Columns are read with SELECT * and looked up by name, so a database made
// by an older or newer Kuma, or one upgraded from 1.23 to 2, reads the same:
// a column that is missing reads as its default.

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface KumaMonitor {
  id: number;
  name: string;
  type: string;
  active: boolean;
  parent: number | null;
  url: string;
  method: string;
  /** The headers as Kuma keeps them: JSON text, or "". */
  headers: string;
  body: string;
  /** json (Kuma's default), form or xml. */
  bodyEncoding: string;
  hostname: string;
  port: number | null;
  interval: number;
  keyword: string;
  invertKeyword: boolean;
  acceptedStatusCodes: string[];
  dnsType: string;
  dnsServer: string;
  /** Kuma 2's conditions on a DNS answer: JSON text, or "". */
  conditions: string;
  pushToken: string;
  expiryNotification: boolean;
  domainExpiryNotification: boolean;
  ignoreTls: boolean;
  upsideDown: boolean;
  /** basic, bearer, ntlm, mtls, oauth2-cc, or "" for none. */
  authMethod: string;
  basicAuthUser: string;
  basicAuthPass: string;
  bearerToken: string;
  jsonPath: string;
  jsonPathOperator: string;
  expectedValue: string;
  proxyId: number | null;
  expectedTlsAlert: string;
  manualStatus: number | null;
  resendInterval: number;
  /** Seconds Kuma waited for an answer; 0 for its old default. */
  timeout: number;
  notificationIds: number[];
}

export interface KumaNotification {
  id: number;
  name: string;
  type: string;
  active: boolean;
  config: Record<string, unknown>;
}

export interface KumaStatusPage {
  id: number;
  slug: string;
  title: string;
  description: string;
  icon: string;
  theme: string;
  searchEngineIndex: boolean;
  /** Kuma answers 404 for a page that is not published. */
  published: boolean;
  domains: string[];
  /** Footer, CSS and analytics that have no place here. */
  extras: string[];
  groups: Array<{ name: string; monitorIds: number[] }>;
}

export interface KumaMaintenance {
  id: number;
  title: string;
  description: string;
  strategy: string;
  active: boolean;
  startDate: string;
  endDate: string;
  timezone: string;
  /** When a repeating window starts, as Kuma keeps it: "30 3 * * 1,4". */
  cron: string;
  /** How long a repeating window lasts, in seconds. */
  duration: number | null;
  /** recurring-interval: every this many days. */
  intervalDay: number | null;
  monitorIds: number[];
  statusPageIds: number[];
}

export interface KumaData {
  /** What was read, in words: "Uptime Kuma 2 database", "Uptime Kuma 1.23.17 backup". */
  source: string;
  monitors: KumaMonitor[];
  notifications: KumaNotification[];
  statusPages: KumaStatusPage[];
  maintenance: KumaMaintenance[];
  /** Days before expiry Kuma warns about a certificate or a domain. */
  tlsExpiryDays: number[];
  domainExpiryDays: number[];
  serverTimezone: string;
  /** Registrable domains Kuma 2 has looked up, from its domain_expiry table. */
  knownDomains: string[];
  pinnedIncidents: number;
}

type Row = Record<string, unknown>;

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function int(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function dayList(value: unknown): number[] {
  const list = parseJson(value);
  return Array.isArray(list)
    ? list.map(Number).filter((n) => Number.isInteger(n) && n >= 0)
    : [];
}

function stringList(value: unknown): string[] {
  const list = parseJson(value);
  return Array.isArray(list) ? list.map(String) : [];
}

/** One monitor from a database row or a backup entry, by Kuma's field names. */
function monitorFrom(row: Row, notificationIds: number[]): KumaMonitor {
  const pick = (...keys: string[]) => {
    for (const key of keys) if (row[key] !== undefined) return row[key];
    return undefined;
  };
  const basicAuthUser = text(pick("basic_auth_user"));
  // Before Kuma 1.21 a basic auth user was all it took; the upgrade set
  // auth_method to basic for those, but a backup from then has no method.
  const authMethod =
    text(pick("auth_method", "authMethod")) || (basicAuthUser ? "basic" : "");
  const codes = pick("accepted_statuscodes_json", "accepted_statuscodes");
  return {
    id: int(row.id) ?? 0,
    name: text(row.name).trim(),
    type: text(row.type) || "http",
    active: row.active === undefined ? true : bool(row.active),
    parent: int(row.parent),
    url: text(row.url).trim(),
    method: text(row.method).toUpperCase() || "GET",
    headers: text(pick("headers")).trim(),
    body: text(row.body),
    bodyEncoding: text(pick("http_body_encoding", "httpBodyEncoding")),
    hostname: text(row.hostname).trim(),
    port: int(row.port),
    interval: int(row.interval) ?? 60,
    keyword: text(row.keyword),
    invertKeyword: bool(pick("invert_keyword", "invertKeyword")),
    acceptedStatusCodes: Array.isArray(codes)
      ? codes.map(String)
      : stringList(codes),
    dnsType: text(pick("dns_resolve_type")).toUpperCase() || "A",
    dnsServer: text(pick("dns_resolve_server")),
    conditions: text(pick("conditions")),
    pushToken: text(pick("push_token", "pushToken")),
    expiryNotification: bool(pick("expiry_notification", "expiryNotification")),
    domainExpiryNotification: bool(
      pick("domain_expiry_notification", "domainExpiryNotification"),
    ),
    ignoreTls: bool(pick("ignore_tls", "ignoreTls")),
    upsideDown: bool(pick("upside_down", "upsideDown")),
    authMethod,
    basicAuthUser,
    basicAuthPass: text(pick("basic_auth_pass")),
    bearerToken: text(pick("bearer_token")),
    jsonPath: text(pick("json_path", "jsonPath")),
    jsonPathOperator: text(pick("json_path_operator", "jsonPathOperator")),
    expectedValue: text(pick("expected_value", "expectedValue")),
    proxyId: int(pick("proxy_id", "proxyId")),
    expectedTlsAlert: text(pick("expected_tls_alert", "expectedTlsAlert")),
    manualStatus: int(pick("manual_status", "manualStatus")),
    resendInterval: int(pick("resend_interval", "resendInterval")) ?? 0,
    timeout: Number(pick("timeout")) || 0,
    notificationIds,
  };
}

function notificationFrom(row: Row): KumaNotification {
  const config = parseJson(row.config);
  const settings =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};
  return {
    id: int(row.id) ?? 0,
    name: (text(row.name) || text(settings.name)).trim(),
    type: text(settings.type),
    active: row.active === undefined ? true : bool(row.active),
    config: settings,
  };
}

/** Reads an open Kuma database. */
export function readKumaDatabase(db: Database.Database): KumaData {
  const tables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((t) => t.name),
  );
  if (!tables.has("monitor"))
    throw new Error(
      "this is not an Uptime Kuma database: it has no monitor table",
    );
  const all = (table: string, order = "id"): Row[] =>
    tables.has(table)
      ? (db
          .prepare(`SELECT * FROM "${table}" ORDER BY ${order}`)
          .all() as Row[])
      : [];

  const links = new Map<number, number[]>();
  for (const row of all("monitor_notification")) {
    const id = int(row.monitor_id);
    const notification = int(row.notification_id);
    if (id === null || notification === null) continue;
    links.set(id, [...(links.get(id) ?? []), notification]);
  }

  const settings = new Map<string, unknown>();
  for (const row of all("setting"))
    settings.set(text(row.key), parseJson(row.value));

  const domains = new Map<number, string[]>();
  for (const row of all("status_page_cname")) {
    const page = int(row.status_page_id);
    const domain = text(row.domain).trim().toLowerCase();
    if (page === null || domain === "") continue;
    domains.set(page, [...(domains.get(page) ?? []), domain]);
  }

  const groupMonitors = new Map<number, number[]>();
  for (const row of all("monitor_group", "weight, id")) {
    const group = int(row.group_id);
    const monitor = int(row.monitor_id);
    if (group === null || monitor === null) continue;
    groupMonitors.set(group, [...(groupMonitors.get(group) ?? []), monitor]);
  }
  const groups = all("group", "weight, id").filter(
    (g) => g.public === undefined || bool(g.public),
  );

  const statusPages = all("status_page").map((row): KumaStatusPage => {
    const id = int(row.id) ?? 0;
    const extras = [
      text(row.footer_text).trim() ? "the footer text" : "",
      text(row.custom_css).trim() ? "the custom CSS" : "",
      text(row.google_analytics_tag_id ?? row.analytics_id).trim()
        ? "the analytics tag"
        : "",
    ].filter(Boolean);
    return {
      id,
      slug: text(row.slug),
      title: text(row.title).trim(),
      description: text(row.description).trim(),
      icon: text(row.icon),
      theme: text(row.theme),
      published: row.published === undefined ? true : bool(row.published),
      searchEngineIndex:
        row.search_engine_index === undefined
          ? true
          : bool(row.search_engine_index),
      domains: domains.get(id) ?? [],
      extras,
      groups: groups
        .filter((g) => int(g.status_page_id) === id)
        .map((g) => ({
          name: text(g.name).trim(),
          monitorIds: groupMonitors.get(int(g.id) ?? 0) ?? [],
        })),
    };
  });

  const byMaintenance = (table: string, column: string) => {
    const map = new Map<number, number[]>();
    for (const row of all(table)) {
      const id = int(row.maintenance_id);
      const other = int(row[column]);
      if (id === null || other === null) continue;
      map.set(id, [...(map.get(id) ?? []), other]);
    }
    return map;
  };
  const maintenanceMonitors = byMaintenance(
    "monitor_maintenance",
    "monitor_id",
  );
  const maintenancePages = byMaintenance(
    "maintenance_status_page",
    "status_page_id",
  );
  const maintenance = all("maintenance").map((row): KumaMaintenance => {
    const id = int(row.id) ?? 0;
    return {
      id,
      title: text(row.title).trim(),
      description: text(row.description).trim(),
      strategy: text(row.strategy) || "single",
      active: row.active === undefined ? true : bool(row.active),
      startDate: text(row.start_date),
      endDate: text(row.end_date),
      timezone: text(row.timezone),
      cron: text(row.cron).trim(),
      duration: int(row.duration),
      intervalDay: int(row.interval_day),
      monitorIds: maintenanceMonitors.get(id) ?? [],
      statusPageIds: maintenancePages.get(id) ?? [],
    };
  });

  const incidents = all("incident").filter(
    (row) => bool(row.pin) && (row.active === undefined || bool(row.active)),
  );

  return {
    source: `Uptime Kuma ${tables.has("knex_migrations") ? "2" : "1"} database`,
    monitors: all("monitor").map((row) =>
      monitorFrom(row, links.get(int(row.id) ?? 0) ?? []),
    ),
    notifications: all("notification").map(notificationFrom),
    statusPages,
    maintenance,
    tlsExpiryDays: dayList(settings.get("tlsExpiryNotifyDays")),
    domainExpiryDays: dayList(settings.get("domainExpiryNotifyDays")),
    serverTimezone: text(settings.get("serverTimezone")),
    knownDomains: all("domain_expiry")
      .map((row) => text(row.domain).trim().toLowerCase())
      .filter(Boolean),
    pinnedIncidents: incidents.length,
  };
}

/**
 * Reads the JSON backup Kuma 1 exported (Settings, Backup). It holds the
 * monitors and the notifications; status pages and maintenance were never
 * part of it. Kuma 2 has no such export.
 */
export function readKumaBackup(backup: unknown): KumaData {
  if (!backup || typeof backup !== "object" || Array.isArray(backup))
    throw new Error("this is not an Uptime Kuma backup");
  const { version, monitorList, notificationList } = backup as Row;
  const listOf = (value: unknown): Row[] =>
    (Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? Object.values(value)
        : []
    ).filter((item): item is Row => !!item && typeof item === "object");
  if (monitorList === undefined)
    throw new Error("this is not an Uptime Kuma backup: it has no monitorList");
  return {
    source: `Uptime Kuma ${text(version) || "1"} backup`,
    monitors: listOf(monitorList).map((row) => {
      const ids = row.notificationIDList;
      const notificationIds =
        ids && typeof ids === "object"
          ? Object.entries(ids)
              .filter(([, on]) => on)
              .map(([id]) => Number(id))
              .filter(Number.isInteger)
          : [];
      return monitorFrom(row, notificationIds);
    }),
    notifications: listOf(notificationList).map(notificationFrom),
    statusPages: [],
    maintenance: [],
    tlsExpiryDays: [],
    domainExpiryDays: [],
    serverTimezone: "",
    knownDomains: [],
    pinnedIncidents: 0,
  };
}

const SQLITE_HEADER = "SQLite format 3\0";

function startsWithSqliteHeader(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SQLITE_HEADER.length);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("latin1") === SQLITE_HEADER;
  } finally {
    closeSync(fd);
  }
}

function readDatabaseFile(path: string): KumaData {
  // Kuma keeps its database in WAL mode, and while it runs, recent changes
  // live in kuma.db-wal. Read in place when that works. A read-only mount
  // cannot hold the files SQLite needs for a WAL database, so then read a
  // copy of the database and its WAL instead.
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return readKumaDatabase(db);
    } finally {
      db.close();
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("this is not"))
      throw err;
  }
  const dir = mkdtempSync(join(tmpdir(), "import-kuma-"));
  try {
    const copy = join(dir, "kuma.db");
    copyFileSync(path, copy);
    if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
    const db = new Database(copy, { fileMustExist: true });
    try {
      return readKumaDatabase(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Reads kuma.db, Kuma's data folder (which holds kuma.db), or a JSON
 * backup file.
 */
export function readKuma(path: string): KumaData {
  if (!existsSync(path)) throw new Error(`there is no file at ${path}`);
  const file = statSync(path).isDirectory() ? join(path, "kuma.db") : path;
  if (!existsSync(file)) throw new Error(`there is no kuma.db in ${path}`);
  if (startsWithSqliteHeader(file)) return readDatabaseFile(file);
  let backup: unknown;
  try {
    backup = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(
      `${file} is neither an Uptime Kuma database nor a Kuma backup file`,
    );
  }
  return readKumaBackup(backup);
}
