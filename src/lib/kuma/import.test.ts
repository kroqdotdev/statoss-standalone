import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, type AppConfig, type SiteConfig } from "../config";
import {
  convertKuma,
  kumaTime,
  readCron,
  type ImportResult,
} from "./convert.mts";
import { readKuma } from "./read.mts";
import { renderYaml, yamlString } from "./yaml.mts";

const FIXTURES = join(__dirname, "fixtures");
const NOW = Date.parse("2026-10-04T12:00:00Z");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kuma-test-"));
  dirs.push(dir);
  return dir;
}

function fixtureSql(version: "1.23" | "2.5", rows = true): string {
  const sql = readFileSync(join(FIXTURES, `kuma-${version}.sql`), "utf8");
  return rows
    ? sql
    : sql
        .split("\n")
        .filter((line) => !line.startsWith("INSERT"))
        .join("\n");
}

/** A database for a test, written without waiting on the disk. */
function fastDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("synchronous = OFF");
  return db;
}

/** A kuma.db built from a fixture, in a folder of its own. */
function fixtureDb(version: "1.23" | "2.5"): string {
  const path = join(tempDir(), "kuma.db");
  const db = fastDb(path);
  db.exec(fixtureSql(version));
  db.close();
  return path;
}

function convert(path: string): ImportResult {
  let n = 0;
  return convertKuma(readKuma(path), {
    now: NOW,
    newSecret: () => `new-secret-${++n}`,
  });
}

function envOf(result: ImportResult): Record<string, string> {
  return Object.fromEntries(result.secrets.map((s) => [s.name, s.value]));
}

/** The configuration as the app reads it, with the secrets set. */
function load(result: ImportResult): AppConfig {
  return parseConfig(result.yaml, envOf(result));
}

function site(config: AppConfig, name: string): SiteConfig {
  const found = config.sites.find((s) => s.name === name);
  if (!found) throw new Error(`no site ${name}`);
  return found;
}

function monitor(s: SiteConfig, name: string) {
  const found = s.monitors.find((m) => m.name === name);
  if (!found) throw new Error(`no monitor ${name} on ${s.name}`);
  return found;
}

type Row = Record<string, unknown>;

/**
 * Imports a Kuma 2.5 database with these rows in it. Monitors get a URL
 * and no expiry checks unless a row says otherwise.
 */
function importRows(
  rows: Record<string, Row[]>,
  version: "1.23" | "2.5" = "2.5",
): { result: ImportResult; config: AppConfig } {
  const path = join(tempDir(), "kuma.db");
  const db = fastDb(path);
  db.exec(fixtureSql(version, false));
  const order = [
    "monitor",
    "notification",
    "monitor_notification",
    "status_page",
    "status_page_cname",
    "group",
    "monitor_group",
    "maintenance",
    "monitor_maintenance",
    "maintenance_status_page",
    "setting",
    "domain_expiry",
    "incident",
  ];
  for (const table of order) {
    for (const raw of rows[table] ?? []) {
      const row: Row =
        table === "monitor"
          ? { expiry_notification: 0, domain_expiry_notification: 0, ...raw }
          : table === "notification"
            ? { user_id: 1, ...raw, config: JSON.stringify(raw.config) }
            : table === "status_page"
              ? { icon: "/icon.svg", theme: "light", ...raw }
              : raw;
      if (version === "1.23") delete row.domain_expiry_notification;
      const cols = Object.keys(row);
      db.prepare(
        `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ).run(
        ...cols.map((c) => {
          const v = row[c];
          if (typeof v === "boolean") return v ? 1 : 0;
          if (v !== null && typeof v === "object") return JSON.stringify(v);
          return v;
        }),
      );
    }
  }
  db.close();
  const result = convert(path);
  return { result, config: load(result) };
}

const SECRETS_IN_FIXTURES = [
  "smtp-secret-pass",
  "SLACKSECRET",
  "DISCORDSECRET",
  "abc123",
  "PDKEY123456",
  "OGKEY-123",
  "tk_secret123",
  "secret-key-1",
  "pa55",
  "bearer-secret",
  "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56",
];

describe("a database from Uptime Kuma", () => {
  for (const version of ["1.23", "2.5"] as const) {
    describe(version, () => {
      it("becomes a configuration the app loads", () => {
        const config = load(convert(fixtureDb(version)));
        expect(config.sites.map((s) => [s.name, s.host])).toEqual([
          ["Example", "status.example.com"],
          ["Internal", "internal.example.com"],
          ["Other monitors", "other.example.com"],
        ]);
        expect(config.checkIntervalSeconds).toBe(30);
      });

      it("maps each kind of monitor", () => {
        const config = load(convert(fixtureDb(version)));
        const example = site(config, "Example");
        expect(example.theme).toBe("dark");
        expect(example.description).toBe("Everything Example runs.");
        expect(monitor(example, "Website")).toMatchObject({
          type: "http",
          group: "Services",
          url: "https://example.com",
          intervalSeconds: 60,
        });
        expect(monitor(example, "API")).toMatchObject({
          method: "POST",
          body: '{"ping": true}',
          keyword: "ok",
          keywordMode: "present",
          headers: {
            "X-Api-Key": "secret-key-1",
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        });
        expect(monitor(example, "JSON health").keyword).toBeUndefined();
        expect(monitor(example, "Database")).toMatchObject({
          type: "tcp",
          group: "Infrastructure",
          host: "db.example.com",
          port: 5432,
          intervalSeconds: 120,
        });
        expect(monitor(example, "Gateway")).toMatchObject({
          type: "ping",
          host: "gw.example.com",
        });
        expect(monitor(example, "Gateway").intervalSeconds).toBeUndefined();
        expect(monitor(example, "example.com certificate")).toMatchObject({
          type: "certificate",
          host: "example.com",
          warnDays: 21,
        });

        // A Kuma group on a page stands for the monitors in it.
        const internal = site(config, "Internal");
        expect(internal.monitors.map((m) => [m.name, m.group])).toEqual(
          expect.arrayContaining([
            ["Nightly backup", "Jobs"],
            ["API", "Jobs"],
            ["No errors", "Jobs"],
          ]),
        );
        expect(monitor(internal, "No errors").keywordMode).toBe("absent");
        expect(monitor(internal, "Nightly backup")).toMatchObject({
          type: "heartbeat",
          token: "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56",
          intervalSeconds: 86400,
        });

        const other = site(config, "Other monitors");
        expect(other.noindex).toBe(true);
        expect(monitor(other, "Old domain").expectStatus).toBe(301);
        expect(monitor(other, "Admin").headers).toEqual({
          Authorization: `Basic ${Buffer.from("kuma:pa55").toString("base64")}`,
        });
        expect(monitor(other, "Mail records")).toMatchObject({
          type: "dns",
          host: "example.com",
          record: "MX",
        });
        expect(monitor(other, "Cron")).toMatchObject({
          type: "heartbeat",
          token: "new-secret-2",
          intervalSeconds: 300,
        });
      });

      it("lists what it left out, and why", () => {
        const result = convert(fixtureDb(version));
        expect(result.skipped).toEqual([
          'notification "Telegram" (telegram): its bot token is not one, which looks like 123456789:AAH4... as @BotFather gives it',
          'monitor "Broker" (mqtt, Example): mqtt monitors are not checked here; a tcp monitor on its port is the nearest',
          'monitor "CAA" (dns, Other monitors): CAA records are not checked here (A, AAAA, CNAME, MX, TXT and NS are)',
        ]);
        expect(result.paused).toEqual([
          '"Old API" (http https://old-api.example.com)',
        ]);
        expect(result.yaml).toContain("# Not imported from Uptime Kuma:");
        expect(result.yaml).toContain('#   - "Old API"');
        expect(result.summary).toContain(
          "Paused in Kuma, left out: 1 monitor.",
        );
      });

      it("sends alerts where Kuma's notifications went", () => {
        const config = load(convert(fixtureDb(version)));
        expect(config.alerts?.smtp).toEqual({
          host: "smtp.example.com",
          port: 587,
          user: "alerts@example.com",
          from: "Kuma <alerts@example.com>",
        });
        expect(config.alerts?.to).toEqual([]);
        expect(site(config, "Example").alerts).toEqual({
          to: [
            { email: "ops@example.com" },
            { email: "oncall@example.com" },
            { slack: "https://hooks.slack.com/services/T000/B000/SLACKSECRET" },
            { discord: "https://discord.com/api/webhooks/123/DISCORDSECRET" },
            { pagerduty: "PDKEY123456" },
            { opsgenie: "OGKEY-123", region: "eu" },
            { ntfy: "https://ntfy.sh/kuma-alerts", token: "tk_secret123" },
          ],
        });
        expect(site(config, "Other monitors").alerts).toEqual({
          to: [
            {
              webhook: "https://n8n.example.com/webhook/abc123",
              secret: "new-secret-1",
            },
          ],
        });
      });

      it("keeps every secret out of the file", () => {
        const result = convert(fixtureDb(version));
        for (const secret of SECRETS_IN_FIXTURES)
          expect(result.yaml).not.toContain(secret);
        for (const s of result.secrets)
          expect(result.env).toContain(`\n${s.name}=${s.value}\n`);
        expect(result.secrets.map((s) => s.name)).toContain("SMTP_PASS");
        expect(result.yaml).toContain("slack: ${SLACK_TEAM}");
      });

      it("says at the top what concerns no one line", () => {
        const result = convert(fixtureDb(version));
        const top = result.yaml.split("\ncheckIntervalSeconds")[0];
        expect(top).toContain(
          '# check: Alerts, "n8n hook": the receiver gets StatOSS\'s JSON body',
        );
        // Kuma's default timeout is 48 seconds.
        expect(top).toMatch(
          /# check: Kuma waited up to 48 seconds for an answer from \d+ monitors; here a check that takes longer than 10 seconds fails\./,
        );
        expect(result.attention).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^Kuma waited up to 48/),
          ]),
        );
      });

      it("brings maintenance over, in UTC, and the weekly one as a repeat", () => {
        const config = load(convert(fixtureDb(version)));
        expect(site(config, "Example").maintenance).toEqual([
          {
            title: "Database upgrade",
            start: Date.parse("2030-10-10T00:00:00Z"),
            end: Date.parse("2030-10-10T02:00:00Z"),
            monitors: ["Database"],
            notes: "Postgres 17.",
          },
          {
            // Every Sunday at 04:00 UTC for half an hour, on the whole page.
            title: "Weekly restart",
            start: Date.parse("2026-10-11T04:00:00Z"),
            end: Date.parse("2026-10-11T04:30:00Z"),
            repeat: "weekly",
          },
        ]);
        expect(site(config, "Example").timezone).toBe("UTC");
      });
    });
  }

  it("adds Kuma 2's domain checks and manual monitors", () => {
    const config = load(convert(fixtureDb("2.5")));
    const example = site(config, "Example");
    expect(monitor(example, "example.com domain")).toMatchObject({
      type: "domain",
      host: "example.com",
      warnDays: 21,
    });
    expect(example.components).toEqual([
      expect.objectContaining({
        name: "Mobile app",
        group: "Infrastructure",
        state: "operational",
      }),
    ]);
    const other = site(config, "Other monitors");
    expect(monitor(other, "example.org domain").host).toBe("example.org");
    expect(monitor(other, "Apex A")).toMatchObject({
      type: "dns",
      host: "example.org",
      expect: "93.184",
    });
    expect(monitor(other, "Private API").headers).toEqual({
      Authorization: "Bearer bearer-secret",
    });
  });

  it("reads a database Kuma is still running on, from a read-only folder", () => {
    const live = join(tempDir(), "kuma.db");
    const writer = fastDb(live);
    writer.pragma("journal_mode = WAL");
    writer.pragma("wal_autocheckpoint = 0");
    writer.exec(fixtureSql("2.5"));
    // Everything is still in kuma.db-wal while the writer is open.
    const mounted = tempDir();
    copyFileSync(live, join(mounted, "kuma.db"));
    copyFileSync(`${live}-wal`, join(mounted, "kuma.db-wal"));
    writer.close();
    chmodSync(mounted, 0o555);
    const data = readKuma(mounted);
    expect(data.monitors).toHaveLength(18);
    expect(data.source).toBe("Uptime Kuma 2 database");
  });

  it("says so when it is not a Kuma database", () => {
    const path = join(tempDir(), "other.db");
    const db = new Database(path);
    db.exec("CREATE TABLE things (id INTEGER)");
    db.close();
    expect(() => readKuma(path)).toThrow(/not an Uptime Kuma database/);
    expect(() => readKuma(join(tempDir(), "missing.db"))).toThrow(
      /there is no file/,
    );
  });
});

describe("a backup from Uptime Kuma 1", () => {
  it("puts every monitor on one site", () => {
    const result = convert(join(FIXTURES, "kuma-1.23-backup.json"));
    const config = load(result);
    expect(config.sites).toHaveLength(1);
    const status = config.sites[0];
    expect(status).toMatchObject({
      name: "Status",
      host: "status.example.com",
    });
    expect(status.monitors.map((m) => [m.name, m.type, m.group])).toEqual([
      ["Website", "http", undefined],
      ["API", "http", "Backend"],
      ["No errors", "http", "Backend"],
      ["JSON health", "http", undefined],
      ["Old domain", "http", undefined],
      ["Admin", "http", undefined],
      ["Database", "tcp", undefined],
      ["Gateway", "ping", undefined],
      ["Mail records", "dns", undefined],
      ["Nightly backup", "heartbeat", undefined],
      ["Cron", "heartbeat", undefined],
      ["example.com certificate", "certificate", undefined],
    ]);
    expect(config.alerts?.to).toHaveLength(8);
    expect(result.summary).toMatch(/^Read Uptime Kuma 1\.23\.17 backup: 15/);
    expect(result.attention.join("\n")).toContain(
      "a Kuma backup holds no status pages",
    );
    for (const secret of SECRETS_IN_FIXTURES)
      expect(result.yaml).not.toContain(secret);
  });
});

const page = (id: number, slug: string, extra: Row = {}): Row => ({
  id,
  slug,
  title: slug,
  ...extra,
});

describe("monitors", () => {
  it("carries over status codes it can, and skips the ones it cannot", () => {
    const { result, config } = importRows({
      monitor: [
        {
          id: 1,
          name: "A",
          url: "https://a.example",
          accepted_statuscodes_json: '["200-299","300-399"]',
        },
        {
          id: 2,
          name: "B",
          url: "https://b.example",
          accepted_statuscodes_json: '["404"]',
        },
        {
          id: 3,
          name: "C",
          url: "https://c.example",
          accepted_statuscodes_json: '["400-499"]',
        },
        {
          id: 4,
          name: "D",
          url: "https://d.example",
          accepted_statuscodes_json: '["200-204"]',
        },
      ],
    });
    const s = config.sites[0];
    expect(monitor(s, "A").expectStatus).toBeUndefined();
    expect(monitor(s, "B").expectStatus).toBe(404);
    expect(s.monitors.map((m) => m.name)).toEqual(["A", "B", "D"]);
    expect(result.skipped.join("\n")).toContain(
      'monitor "C" (http, Status): it passes on status 400-499',
    );
    expect(result.attention).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Kuma also accepted status 300-399"),
        expect.stringContaining("Kuma accepted status 200-204"),
      ]),
    );
  });

  it("sends the body Kuma sent, with its content type", () => {
    const { result, config } = importRows({
      monitor: [
        {
          id: 1,
          name: "Xml",
          url: "https://x.example",
          method: "PUT",
          body: "<a/>",
          http_body_encoding: "xml",
        },
        {
          id: 2,
          name: "Form",
          url: "https://f.example",
          method: "POST",
          body: "a=1",
          http_body_encoding: "form",
          headers: '{"content-type": "text/plain"}',
        },
        { id: 3, name: "Get", url: "https://g.example", body: '{"a":1}' },
        { id: 4, name: "Options", url: "https://o.example", method: "OPTIONS" },
        {
          id: 5,
          name: "Bad headers",
          url: "https://h.example",
          headers: "{nope",
        },
      ],
    });
    const s = config.sites[0];
    expect(monitor(s, "Xml")).toMatchObject({
      method: "PUT",
      body: "<a/>",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });
    expect(monitor(s, "Form").headers).toEqual({
      "content-type": "text/plain",
    });
    expect(monitor(s, "Get").body).toBeUndefined();
    expect(monitor(s, "Options").method).toBe("GET");
    expect(monitor(s, "Bad headers").headers).toBeUndefined();
    const notes = result.attention.join("\n");
    expect(notes).toContain('"Get": Kuma sent a body with GET');
    expect(notes).toContain('"Options": Kuma sent OPTIONS; this sends GET.');
    expect(notes).toContain('"Bad headers": its headers are not valid JSON');
  });

  it("leaves out headers a request cannot carry", () => {
    const { result, config } = importRows({
      monitor: [
        {
          id: 1,
          name: "Headers",
          url: "https://h.example",
          headers: JSON.stringify({
            X_Underscore: "a",
            "X-Curly": "\u201cquoted\u201d",
            "X-Trailing": "value\n",
            "X-Fine": "ok",
          }),
        },
        {
          id: 2,
          name: "Token",
          url: "https://t.example",
          auth_method: "bearer",
          bearer_token: "tok\u2019en",
        },
      ],
    });
    expect(monitor(config.sites[0], "Headers").headers).toEqual({
      "X-Trailing": "value",
      "X-Fine": "ok",
    });
    expect(monitor(config.sites[0], "Token").headers).toBeUndefined();
    const notes = result.attention.join("\n");
    expect(notes).toContain('the header "X_Underscore" was left out');
    expect(notes).toContain("the X-Curly header was left out");
    expect(notes).toContain('"Token": its bearer token was left out');
  });

  it("skips what cannot be checked here, with the reason", () => {
    const { result, config } = importRows({
      monitor: [
        {
          id: 1,
          name: "OAuth",
          url: "https://o.example",
          auth_method: "oauth2-cc",
        },
        { id: 2, name: "Inverted", url: "https://i.example", upside_down: 1 },
        {
          id: 3,
          name: "Underscore",
          type: "port",
          hostname: "my_db",
          port: 5432,
        },
        {
          id: 4,
          name: "Dmarc",
          type: "dns",
          hostname: "_dmarc.example.com",
          dns_resolve_type: "TXT",
        },
        { id: 5, name: "Postgres", type: "postgres" },
        { id: 6, name: "Docker", type: "docker" },
        { id: 7, name: "No port", type: "port", hostname: "db.example.com" },
        {
          id: 8,
          name: "Fine",
          type: "port",
          hostname: "db.example.com",
          port: 22,
        },
      ],
    });
    expect(config.sites[0].monitors.map((m) => m.name)).toEqual(["Fine"]);
    expect(result.skipped).toEqual([
      'monitor "OAuth" (http, Status): it signs in with OAuth2 client credentials, which the standalone cannot do',
      'monitor "Inverted" (http, Status): it is in upside down mode, which the standalone does not have',
      'monitor "Underscore" (port, Status): its host "my_db" is not a hostname this takes (letters, digits, dots and dashes)',
      'monitor "Dmarc" (dns, Status): its host "_dmarc.example.com" is not a hostname this takes (letters, digits, dots and dashes)',
      'monitor "Postgres" (postgres, Status): postgres monitors are not checked here; a tcp monitor on its port is the nearest',
      'monitor "Docker" (docker, Status): docker monitors are not checked here',
      'monitor "No port" (port, Status): it has no port',
    ]);
  });

  it("leaves out paused monitors, and those in a paused group", () => {
    const { result, config } = importRows({
      monitor: [
        { id: 1, name: "Group", type: "group", active: 0 },
        { id: 2, name: "Child", url: "https://c.example", parent: 1 },
        {
          id: 3,
          name: "Off",
          type: "ping",
          hostname: "off.example",
          active: 0,
        },
        { id: 4, name: "On", type: "ping", hostname: "on.example" },
      ],
    });
    expect(config.sites[0].monitors.map((m) => m.name)).toEqual(["On"]);
    expect(result.paused).toEqual([
      '"Child" (http https://c.example)',
      '"Off" (ping off.example)',
    ]);
  });

  it("keeps names apart that would clash on the page", () => {
    const { config } = importRows({
      monitor: [
        { id: 1, name: "API", type: "ping", hostname: "a.example" },
        { id: 2, name: "API", type: "ping", hostname: "b.example" },
        { id: 3, name: "API v2", type: "ping", hostname: "c.example" },
        { id: 4, name: "API-v2", type: "ping", hostname: "d.example" },
      ],
    });
    expect(config.sites[0].monitors.map((m) => m.name)).toEqual([
      "API",
      "API (2)",
      "API v2",
      "API-v2 (2)",
    ]);
  });

  it("writes text the loader reads back as it was", () => {
    const { result, config } = importRows({
      monitor: [
        {
          id: 1,
          name: "Dollar",
          url: "https://d.example",
          method: "POST",
          body: '{"user": "${USER}"}',
          type: "keyword",
          keyword: "${HOME}",
        },
        {
          id: 2,
          name: "Numbers",
          url: "https://n.example",
          type: "keyword",
          keyword: "200",
          headers: '{"X-Count": 3, "X-Flag": "true"}',
        },
        { id: 3, name: "Odd # name: yes", type: "ping", hostname: "o.example" },
        { id: 4, name: "Price ${COST}", type: "docker" },
      ],
    });
    const s = config.sites[0];
    expect(monitor(s, "Dollar")).toMatchObject({
      body: '{"user": "${USER}"}',
      keyword: "${HOME}",
    });
    expect(monitor(s, "Numbers")).toMatchObject({
      keyword: "200",
      headers: { "X-Count": "3", "X-Flag": "true" },
    });
    expect(monitor(s, "Odd # name: yes").type).toBe("ping");
    expect(result.yaml).toContain("Price $ {COST}");
  });

  it("turns push monitors into heartbeats with tokens the loader takes", () => {
    const { result, config } = importRows({
      monitor: [
        {
          id: 1,
          name: "Backup",
          type: "push",
          push_token: "abcDEF123_-xyz",
          interval: 3600,
        },
        { id: 2, name: "Short", type: "push", push_token: "abc", interval: 5 },
      ],
    });
    const s = config.sites[0];
    expect(monitor(s, "Backup")).toMatchObject({
      token: "abcDEF123_-xyz",
      intervalSeconds: 3600,
    });
    expect(monitor(s, "Short")).toMatchObject({
      token: "new-secret-1",
      intervalSeconds: 10,
    });
    expect(result.attention.join("\n")).toContain(
      "https://status.example.com/heartbeat/$HEARTBEAT_BACKUP",
    );
  });

  it("maps DNS checks, their conditions and resolvers", () => {
    const { result, config } = importRows({
      monitor: [
        {
          id: 1,
          name: "Equals",
          type: "dns",
          hostname: "e.example",
          dns_resolve_type: "CNAME",
          conditions: [
            {
              type: "expression",
              variable: "record",
              operator: "equals",
              value: "x.example",
              andOr: "and",
            },
          ],
        },
        {
          id: 2,
          name: "Two",
          type: "dns",
          hostname: "t.example",
          conditions: [
            {
              type: "expression",
              variable: "record",
              operator: "contains",
              value: "1",
              andOr: "and",
            },
            {
              type: "expression",
              variable: "record",
              operator: "contains",
              value: "2",
              andOr: "or",
            },
          ],
        },
        {
          id: 3,
          name: "Own resolver",
          type: "dns",
          hostname: "r.example",
          dns_resolve_server: "10.0.0.53",
        },
        {
          id: 4,
          name: "Public",
          type: "dns",
          hostname: "p.example",
          dns_resolve_server: "1.1.1.1,8.8.8.8",
        },
      ],
    });
    const s = config.sites[0];
    expect(monitor(s, "Equals")).toMatchObject({
      record: "CNAME",
      expect: "x.example",
    });
    expect(monitor(s, "Two").expect).toBeUndefined();
    const notes = result.attention.join("\n");
    expect(notes).toContain('"Equals": Kuma wanted an answer equal to this');
    expect(notes).toContain(
      '"Two": Kuma\'s conditions on the answer are not checked here.',
    );
    expect(notes).toContain('"Own resolver": Kuma asked 10.0.0.53');
    expect(notes).not.toContain('"Public"');
  });

  it("adds one certificate and one domain check per host and domain", () => {
    const { config } = importRows({
      monitor: [
        {
          id: 1,
          name: "Site",
          url: "https://www.example.co.uk",
          expiry_notification: 1,
          domain_expiry_notification: 1,
        },
        {
          id: 2,
          name: "Shop",
          url: "https://www.example.co.uk/shop",
          expiry_notification: 1,
          domain_expiry_notification: 1,
        },
        {
          id: 3,
          name: "Alt port",
          url: "https://api.example.net:8443",
          expiry_notification: 1,
          domain_expiry_notification: 1,
        },
        {
          id: 4,
          name: "Plain",
          url: "http://plain.example.org",
          expiry_notification: 1,
          domain_expiry_notification: 1,
        },
        {
          id: 5,
          name: "Inside",
          type: "ping",
          hostname: "nas.local",
          domain_expiry_notification: 1,
        },
      ],
      setting: [
        { key: "tlsExpiryNotifyDays", value: "[7,30]" },
        { key: "domainExpiryNotifyDays", value: "[14]" },
      ],
      domain_expiry: [{ domain: "example.net" }],
    });
    const added = config.sites[0].monitors
      .filter((m) => m.type === "certificate" || m.type === "domain")
      .map((m) => [m.name, m.host, m.port, m.warnDays]);
    expect(added).toEqual([
      ["www.example.co.uk certificate", "www.example.co.uk", undefined, 30],
      ["api.example.net:8443 certificate", "api.example.net", 8443, 30],
      ["example.co.uk domain", "example.co.uk", undefined, 14],
      ["example.net domain", "example.net", undefined, 14],
      ["example.org domain", "example.org", undefined, 14],
    ]);
  });

  it("checks often enough for the most frequent monitor", () => {
    const { config } = importRows({
      monitor: [
        {
          id: 1,
          name: "Fast",
          type: "ping",
          hostname: "f.example",
          interval: 20,
        },
        {
          id: 2,
          name: "Slow",
          type: "ping",
          hostname: "s.example",
          interval: 300,
        },
        {
          id: 3,
          name: "Job",
          type: "push",
          push_token: "abcdefgh12",
          interval: 5,
        },
      ],
    });
    expect(config.checkIntervalSeconds).toBe(20);
    expect(monitor(config.sites[0], "Fast").intervalSeconds).toBeUndefined();
    expect(monitor(config.sites[0], "Slow").intervalSeconds).toBe(300);
  });

  it("quotes a secret that is not safe bare", () => {
    const { config, result } = importRows({
      monitor: [
        {
          id: 1,
          name: "Spaced",
          url: "https://s.example",
          auth_method: "bearer",
          bearer_token: "a b: c #d",
        },
        {
          id: 2,
          name: "Quoted",
          url: "https://q.example",
          headers: JSON.stringify({ "X-Api-Key": 'say "hi" \\ there' }),
        },
      ],
    });
    expect(result.yaml).toContain('Authorization: "Bearer ${AUTH_SPACED}"');
    expect(monitor(config.sites[0], "Spaced").headers).toEqual({
      Authorization: "Bearer a b: c #d",
    });
    // As docker run --env-file reads it: the value as it is.
    expect(result.env).toContain("\nAUTH_SPACED=a b: c #d\n");
    expect(monitor(config.sites[0], "Quoted").headers).toEqual({
      "X-Api-Key": 'say "hi" \\ there',
    });
  });
});

describe("sites", () => {
  it("takes the host, logo, look and groups from each status page", () => {
    const long = "x".repeat(450);
    const { result, config } = importRows({
      monitor: [
        { id: 1, name: "One", type: "ping", hostname: "one.example" },
        { id: 2, name: "Two", type: "ping", hostname: "two.example" },
      ],
      status_page: [
        page(1, "main", {
          title: "Main",
          theme: "dark",
          icon: "https://cdn.example/logo.png",
          description: long,
          search_engine_index: 0,
        }),
        page(2, "docs", {
          title: "Docs",
          icon: "/upload/logo2.png?t=1",
          footer_text: "hi",
          custom_css: "a{}",
        }),
        page(3, "Bad Slug!", { title: "Third" }),
        page(4, "draft", { title: "Draft", published: 0 }),
      ],
      status_page_cname: [
        { status_page_id: 1, domain: "Status.Example.com" },
        { status_page_id: 2, domain: "status.example.com" },
        { status_page_id: 4, domain: "draft.example.org" },
      ],
      group: [
        { id: 1, name: "Second", status_page_id: 1, weight: 2, public: 1 },
        { id: 2, name: "First", status_page_id: 1, weight: 1, public: 1 },
        { id: 3, name: "Docs", status_page_id: 2, weight: 1, public: 1 },
      ],
      monitor_group: [
        { monitor_id: 1, group_id: 1, weight: 1 },
        { monitor_id: 2, group_id: 2, weight: 1 },
        { monitor_id: 1, group_id: 3, weight: 1 },
      ],
    });
    const main = site(config, "Main");
    expect(main).toMatchObject({
      host: "status.example.com",
      theme: "dark",
      logo: "https://cdn.example/logo.png",
      noindex: true,
    });
    expect(main.description).toHaveLength(400);
    expect(main.monitors.map((m) => [m.name, m.group])).toEqual([
      ["Two", "First"],
      ["One", "Second"],
    ]);
    expect(site(config, "Docs").host).toBe("docs.example.com");
    expect(site(config, "Third").host).toBe("status-2.example.com");
    // Kuma answered 404 for a page it had not published: it gets no real host.
    expect(site(config, "Draft")).toMatchObject({
      host: "draft.example.com",
      noindex: true,
    });
    expect(config.sites).toHaveLength(4);
    const notes = result.attention.join("\n");
    expect(notes).toContain("Main: the description was cut to 400 characters.");
    expect(notes).toContain("Draft: Kuma had not published this page.");
    expect(notes).toContain(
      "Docs: the logo is upload/logo2.png in Kuma's data folder.",
    );
    expect(result.yaml).toContain(
      "# Not imported: the footer text, the custom CSS.",
    );
  });

  it("puts monitors on no page on a site of their own, grouped as in Kuma", () => {
    const { config } = importRows({
      monitor: [
        { id: 1, name: "Shown", type: "ping", hostname: "s.example" },
        { id: 2, name: "Infra", type: "group" },
        {
          id: 3,
          name: "Hidden",
          type: "ping",
          hostname: "h.example",
          parent: 2,
        },
      ],
      status_page: [page(1, "main")],
      group: [{ id: 1, name: "All", status_page_id: 1, public: 1 }],
      monitor_group: [{ monitor_id: 1, group_id: 1 }],
    });
    expect(config.sites.map((s) => s.name)).toEqual(["main", "Other monitors"]);
    expect(site(config, "Other monitors").monitors).toEqual([
      expect.objectContaining({ name: "Hidden", group: "Infra" }),
    ]);
  });

  it("writes one site when Kuma has no status page, and none of its monitors", () => {
    const { result, config } = importRows({});
    expect(config.sites).toEqual([
      expect.objectContaining({ name: "Status", monitors: [] }),
    ]);
    expect(result.summary).toContain("No monitors found.");
  });
});

describe("alerts", () => {
  const smtp = (id: number, extra: Row = {}): Row => ({
    id,
    name: `Mail ${id}`,
    config: {
      type: "smtp",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpUsername: "u@example.com",
      smtpPassword: "pw",
      smtpFrom: "from@example.com",
      smtpTo: `to${id}@example.com`,
      ...extra,
    },
  });

  it("lists the same destinations once for every site", () => {
    const { config } = importRows({
      monitor: [
        { id: 1, name: "A", type: "ping", hostname: "a.example" },
        { id: 2, name: "B", type: "ping", hostname: "b.example" },
      ],
      notification: [
        smtp(1, {
          smtpTo: "a@example.com; b@example.com",
          smtpCC: "c@example.com",
        }),
      ],
      monitor_notification: [
        { monitor_id: 1, notification_id: 1 },
        { monitor_id: 2, notification_id: 1 },
      ],
      status_page: [page(1, "one"), page(2, "two")],
      group: [
        { id: 1, name: "G", status_page_id: 1, public: 1 },
        { id: 2, name: "G", status_page_id: 2, public: 1 },
      ],
      monitor_group: [
        { monitor_id: 1, group_id: 1 },
        { monitor_id: 2, group_id: 2 },
      ],
    });
    expect(config.alerts?.to).toEqual([
      { email: "a@example.com" },
      { email: "b@example.com" },
      { email: "c@example.com" },
    ]);
    expect(config.sites.every((s) => s.alerts === undefined)).toBe(true);
  });

  it("follows a group's notifications to the monitors in it", () => {
    const { config } = importRows({
      monitor: [
        { id: 1, name: "Group", type: "group" },
        {
          id: 2,
          name: "Child",
          type: "ping",
          hostname: "c.example",
          parent: 1,
        },
      ],
      notification: [
        {
          id: 1,
          name: "Chat",
          config: {
            type: "slack",
            slackwebhookURL: "https://hooks.slack.com/services/x",
          },
        },
      ],
      monitor_notification: [{ monitor_id: 1, notification_id: 1 }],
    });
    expect(config.alerts?.to).toEqual([
      { slack: "https://hooks.slack.com/services/x" },
    ]);
  });

  it("says what changes on the way, and skips what has no destination here", () => {
    const { result, config } = importRows({
      monitor: [{ id: 1, name: "A", type: "ping", hostname: "a.example" }],
      notification: [
        smtp(1, { smtpPort: 2525, smtpSecure: true }),
        smtp(2, { smtpHost: "other.example.com" }),
        {
          id: 3,
          name: "Thread",
          config: {
            type: "discord",
            discordWebhookUrl: "https://discord.com/api/webhooks/1/x",
            discordChannelType: "postToThread",
            threadId: "99",
          },
        },
        {
          id: 4,
          name: "EU pager",
          config: {
            type: "PagerDuty",
            pagerdutyIntegrationKey: "123456",
            pagerdutyIntegrationUrl:
              "https://events.eu.pagerduty.com/v2/enqueue",
          },
        },
        {
          id: 5,
          name: "Push",
          config: {
            type: "ntfy",
            ntfyserverurl: "https://ntfy.example.com/",
            ntfytopic: "alerts",
            ntfyAuthenticationMethod: "usernamePassword",
            ntfyusername: "u",
            ntfypassword: "p",
          },
        },
        {
          id: 6,
          name: "Off",
          active: 0,
          config: {
            type: "slack",
            slackwebhookURL: "https://hooks.slack.com/x",
          },
        },
        { id: 7, name: "Gotify", config: { type: "gotify" } },
        {
          id: 8,
          name: "Unused",
          config: {
            type: "slack",
            slackwebhookURL: "https://hooks.slack.com/y",
          },
        },
      ],
      monitor_notification: [1, 2, 3, 4, 5, 6, 7].map((id) => ({
        monitor_id: 1,
        notification_id: id,
      })),
    });
    expect(config.alerts?.smtp).toMatchObject({
      host: "smtp.example.com",
      port: 2525,
    });
    expect(config.alerts?.to).toEqual([
      { email: "to1@example.com" },
      { email: "to2@example.com" },
      { discord: "https://discord.com/api/webhooks/1/x?thread_id=99" },
      { pagerduty: "123456" },
      { ntfy: "https://ntfy.example.com/alerts" },
    ]);
    const notes = result.attention.join("\n");
    expect(notes).toContain("Kuma used TLS from the start on port 2525");
    expect(notes).toContain(
      '"Mail 2": it is sent through smtp.example.com here',
    );
    expect(notes).toContain(
      "Kuma sent events to https://events.eu.pagerduty.com/v2/enqueue",
    );
    expect(notes).toContain(
      '"Push": Kuma signed in to ntfy with a user name and password',
    );
    expect(result.skipped).toEqual([
      'notification "Off" (slack): it is turned off in Kuma',
      'notification "Gotify" (gotify): gotify is not one of the destinations here',
      'notification "Unused" (slack): no active monitor uses it',
    ]);
    // A PagerDuty key of digits only is still read as text.
    expect(result.yaml).toContain('pagerduty: "${PAGERDUTY_EU_PAGER}"');
  });

  it("brings Telegram, Pushover and Teams over, with their tokens kept out of the file", () => {
    const telegramToken = "123456:fake-telegram-bot-token-0000";
    const appToken = "apptokenapptokenapptokenapp123";
    const workflow =
      "https://prod-12.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=s1g";
    const { result, config } = importRows({
      monitor: [{ id: 1, name: "A", type: "ping", hostname: "a.example" }],
      notification: [
        {
          id: 1,
          name: "Ops chat",
          config: {
            type: "telegram",
            telegramBotToken: telegramToken,
            telegramChatID: "-1001234567890",
            telegramMessageThreadID: "7",
            telegramSendSilently: true,
          },
        },
        {
          id: 2,
          name: "On call",
          config: {
            type: "pushover",
            pushoveruserkey: "useruseruseruseruseruseruser12",
            pushoverapptoken: appToken,
            pushoverpriority: "2",
            pushoverdevice: "phone",
          },
        },
        {
          id: 3,
          name: "Quiet",
          config: {
            type: "pushover",
            pushoveruserkey: "groupgroupgroupgroupgroupgro12",
            pushoverapptoken: appToken,
            pushoverpriority: "-1",
          },
        },
        {
          id: 4,
          name: "Teams",
          config: { type: "teams", webhookUrl: workflow },
        },
      ],
      monitor_notification: [1, 2, 3, 4].map((id) => ({
        monitor_id: 1,
        notification_id: id,
      })),
    });
    expect(config.alerts?.to).toEqual([
      { telegram: "-1001234567890", token: telegramToken },
      {
        pushover: "useruseruseruseruseruseruser12",
        token: appToken,
        emergency: true,
      },
      { pushover: "groupgroupgroupgroupgroupgro12", token: appToken },
      { teams: workflow },
    ]);
    for (const secret of [telegramToken, appToken, "s1g"])
      expect(result.yaml).not.toContain(secret);
    expect(result.yaml).toContain('telegram: "-1001234567890"');
    expect(result.secrets.map((s) => s.name)).toEqual(
      expect.arrayContaining(["TELEGRAM_OPS_CHAT_TOKEN", "TEAMS"]),
    );
    const notes = result.attention.join("\n");
    expect(notes).toContain('"Ops chat": Kuma posted to topic 7 of the chat');
    expect(notes).toContain('"Ops chat": Kuma sent without a sound');
    expect(notes).toContain(
      '"On call": Kuma sent every alert at emergency priority',
    );
    expect(notes).toContain('"On call": Kuma sent to the device phone only');
    expect(notes).toContain('"Quiet": Kuma sent every alert at priority -1');
    expect(result.skipped).toEqual([]);
  });

  it("skips a Telegram, Pushover or Teams notification it cannot send to, and says why", () => {
    const { result, config } = importRows({
      monitor: [{ id: 1, name: "A", type: "ping", hostname: "a.example" }],
      notification: [
        {
          id: 1,
          name: "No chat",
          config: { type: "telegram", telegramBotToken: "123456:abc" },
        },
        {
          id: 2,
          name: "Short key",
          config: {
            type: "pushover",
            pushoveruserkey: "u123",
            pushoverapptoken: "apptokenapptokenapptokenapp123",
          },
        },
        {
          id: 3,
          name: "Old connector",
          config: {
            type: "teams",
            webhookUrl:
              "https://outlook.office.com/webhook/abc/IncomingWebhook/def",
          },
        },
        {
          id: 4,
          name: "Connector",
          config: {
            type: "teams",
            webhookUrl:
              "https://contoso.webhook.office.com/webhookb2/abc/IncomingWebhook/def",
          },
        },
      ],
      monitor_notification: [1, 2, 3, 4].map((id) => ({
        monitor_id: 1,
        notification_id: id,
      })),
    });
    expect(config.alerts?.to).toEqual([
      {
        teams:
          "https://contoso.webhook.office.com/webhookb2/abc/IncomingWebhook/def",
      },
    ]);
    expect(result.skipped).toEqual([
      'notification "No chat" (telegram): it has no bot token or chat id',
      'notification "Short key" (pushover): its user key or application token is not 30 letters and digits',
      'notification "Old connector" (teams): its URL is neither a Teams workflow nor a webhook.office.com connector; make a workflow with "Post to a channel when a webhook request is received" and add teams: <its URL>',
    ]);
  });
});

describe("maintenance", () => {
  it("brings planned windows over, in UTC, and says what it left", () => {
    const { result, config } = importRows({
      monitor: [{ id: 1, name: "A", type: "ping", hostname: "a.example" }],
      status_page: [page(1, "main")],
      group: [{ id: 1, name: "G", status_page_id: 1, public: 1 }],
      monitor_group: [{ monitor_id: 1, group_id: 1 }],
      maintenance: [
        {
          id: 1,
          title: "Whole page",
          description: "",
          strategy: "single",
          start_date: "2027-01-15 22:00",
          end_date: "2027-01-16 01:00",
          timezone: "SAME_AS_SERVER",
        },
        {
          id: 2,
          title: "Done",
          description: "",
          strategy: "single",
          start_date: "2026-01-01 00:00",
          end_date: "2026-01-01 01:00",
          timezone: "UTC",
        },
        { id: 3, title: "Manual", description: "", strategy: "manual" },
        {
          id: 5,
          title: "Paused",
          description: "",
          strategy: "single",
          active: 0,
          start_date: "2027-01-01 00:00",
          end_date: "2027-01-02 00:00",
        },
      ],
      maintenance_status_page: [{ maintenance_id: 1, status_page_id: 1 }],
      setting: [{ key: "serverTimezone", value: '"America/New_York"' }],
    });
    expect(site(config, "main").maintenance).toEqual([
      {
        title: "Whole page",
        start: Date.parse("2027-01-16T03:00:00Z"),
        end: Date.parse("2027-01-16T06:00:00Z"),
      },
    ]);
    expect(result.skipped).toEqual([
      'maintenance "Manual": it is on until it is turned off; write a window with an end under maintenance',
    ]);
    expect(result.summary).toContain(
      "Maintenance that has ended, left out: 1 window.",
    );
  });

  it("turns maintenance that repeats into windows that repeat", () => {
    const window = (id: number, extra: Row): Row => ({
      id,
      title: `W${id}`,
      description: "",
      timezone: "UTC",
      duration: 3600,
      ...extra,
    });
    const { result, config } = importRows({
      monitor: [{ id: 1, name: "A", type: "ping", hostname: "a.example" }],
      maintenance: [
        // Mondays and Thursdays at 02:30 in Copenhagen, November to March.
        window(1, {
          strategy: "recurring-weekday",
          cron: "30 2 * * 1,4",
          timezone: "Europe/Copenhagen",
          start_date: "2026-11-01 00:00",
          end_date: "2027-03-31 00:00",
        }),
        // The 1st and the last day of the month, at 01:00 UTC.
        window(2, { strategy: "recurring-day-of-month", cron: "0 1 1,L * *" }),
        window(3, {
          strategy: "recurring-interval",
          cron: "0 5  * * *",
          interval_day: 3,
        }),
        window(4, {
          strategy: "recurring-interval",
          cron: "0 5  * * *",
          interval_day: 1,
          duration: 600,
        }),
        window(5, { strategy: "cron", cron: "*/15 * * * *" }),
        window(6, {
          strategy: "recurring-weekday",
          cron: "0 4 * * 0",
          end_date: "2026-09-01 00:00",
        }),
        window(7, { strategy: "cron", cron: "0 0 30 * *" }),
      ],
      monitor_maintenance: [1, 2, 3, 4, 5, 6, 7].map((id) => ({
        monitor_id: 1,
        maintenance_id: id,
      })),
    });
    const s = config.sites[0];
    expect(s.timezone).toBe("Europe/Copenhagen");
    const of = (title: string) =>
      s.maintenance
        .filter((w) => w.title === title)
        .map((w) => [
          new Date(w.start).toISOString(),
          (w.end - w.start) / 60_000,
          w.repeat,
          w.until,
        ]);
    expect(of("W1")).toEqual([
      ["2026-11-02T01:30:00.000Z", 60, "weekly", "2027-03-31"],
      ["2026-11-05T01:30:00.000Z", 60, "weekly", "2027-03-31"],
    ]);
    expect(of("W2")).toEqual([
      ["2026-11-01T01:00:00.000Z", 60, "monthly", undefined],
      ["2026-10-31T01:00:00.000Z", 60, "monthly", undefined],
    ]);
    expect(of("W4")).toHaveLength(7);
    expect(
      of("W4").every(
        ([, minutes, repeat]) => minutes === 10 && repeat === "weekly",
      ),
    ).toBe(true);
    expect(of("W7")).toEqual([
      ["2026-10-30T00:00:00.000Z", 60, "monthly", undefined],
    ]);
    expect(result.skipped).toEqual([
      'maintenance "W3": it repeats every 3 days, and here a window repeats every week or every month',
      'maintenance "W5": it repeats on a schedule that is not some weekdays or some days of the month (*/15 * * * *)',
    ]);
    expect(result.summary).toContain(
      "Maintenance that has ended, left out: 1 window.",
    );
    const notes = result.attention.join("\n");
    expect(notes).toContain(
      'Maintenance "W2": it repeats at its time of day in Europe/Copenhagen on Status, where Kuma kept it in UTC.',
    );
    expect(notes).toContain(
      'Maintenance "W7": Kuma skipped the months without its day; here such a month has it on its last day.',
    );
  });

  it("reads the cron Kuma keeps for repeating maintenance", () => {
    expect(readCron("0 4 * * 7")).toEqual({
      minute: 0,
      hour: 4,
      weekdays: [0],
    });
    expect(readCron("30 3  * * *")?.weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(readCron("0 9 * * 1-5")?.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(readCron("0 1 1,15,L * *")).toEqual({
      minute: 0,
      hour: 1,
      days: [1, 15, 32],
    });
    for (const cron of [
      "0 1 1 * 1",
      "*/5 * * * *",
      "0 1 * 1 *",
      "0 25 * * *",
      "0 1 * * 8",
      "",
      "0 1 0 * *",
    ])
      expect(readCron(cron)).toBeNull();
  });

  it("reads Kuma's local times in their zone", () => {
    expect(kumaTime("2026-03-29 02:30", "Europe/Copenhagen")).toBe(
      Date.parse("2026-03-29T01:30:00Z"),
    );
    expect(kumaTime("2026-07-01 12:00:00", "Europe/Copenhagen")).toBe(
      Date.parse("2026-07-01T10:00:00Z"),
    );
    expect(kumaTime("2026-07-01T12:00:00.000Z", "Asia/Tokyo")).toBe(
      Date.parse("2026-07-01T12:00:00Z"),
    );
    expect(kumaTime("", "UTC")).toBeNull();
  });
});

describe("the YAML writer", () => {
  it("quotes what would read back as something else", () => {
    for (const text of [
      "true",
      "No",
      "null",
      "~",
      "1.5",
      "0x1f",
      "12",
      ".inf",
      "- a",
      "a: b",
      "a #b",
      "{x}",
      "'q'",
      " pad",
      "${X}",
      "",
      "@at",
    ])
      expect(yamlString(text)).toMatch(/^"/);
    for (const text of [
      "plain",
      "https://example.com/a?b=c&d=e",
      "1.2.3",
      "API v2",
      "Kuma (2)",
    ])
      expect(yamlString(text)).toBe(text);
    expect(yamlString("${X}")).toBe('"\\x24{X}"');
  });

  it("renders comments, lists and empty values", () => {
    expect(
      renderYaml(
        {
          pairs: [
            { key: "a", value: [], comment: "none ${YET}" },
            {
              key: "b",
              value: [
                {
                  pairs: [
                    { key: "c", value: 1 },
                    { key: "d", value: { pairs: [] } },
                  ],
                  before: ["one", "two\nthree"],
                },
              ],
              blank: true,
            },
          ],
        },
        ["head"],
      ),
    ).toBe(
      "# head\n\na: []  # none $ {YET}\n\nb:\n  # one\n  # two\n  # three\n  - c: 1\n    d: {}\n",
    );
  });
});

describe("the import-kuma command", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/import-kuma.mts", ...args], {
      encoding: "utf8",
    });

  it("prints a configuration and its secrets that load together", () => {
    const db = fixtureDb("2.5");
    const yaml = run(db);
    expect(yaml.status).toBe(0);
    expect(yaml.stderr).toMatch(/^Read Uptime Kuma 2 database: 18 monitors/);
    const envRun = run("--env", db);
    expect(envRun.status).toBe(0);
    expect(envRun.stderr).toBe("");
    const env = Object.fromEntries(
      envRun.stdout
        .split("\n")
        .filter((line) => /^[A-Z]/.test(line))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    expect(parseConfig(yaml.stdout, env).sites).toHaveLength(3);
  });

  it("explains how it is used", () => {
    expect(run().status).toBe(2);
    expect(run("--nope", "x").stderr).toContain("unknown option --nope");
    const missing = run("/nowhere/kuma.db");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("there is no file at /nowhere/kuma.db");
    expect(run("--help").stdout).toContain("Usage: import-kuma");
  });
});
