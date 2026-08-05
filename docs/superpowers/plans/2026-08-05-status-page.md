# Status Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted, multi-site status page (Next.js + SQLite) with an embedded uptime checker, per-hostname pages, and email alerts, deployed as a Docker container behind Caddy.

**Architecture:** One Next.js App Router application. A background checker starts from `src/instrumentation.ts` inside the server process, checks each configured checkpoint on an interval, and writes results to SQLite via `better-sqlite3`. Public pages resolve the `Host` header against `config.yaml` to render one site's status. Email alerts fire on state transitions (down after 2 consecutive failures, up on first success).

**Tech Stack:** Next.js (App Router, TypeScript, `src/` dir), pnpm, Tailwind CSS, better-sqlite3, zod, yaml, nodemailer, Vitest, ESLint + Prettier, Docker.

**Spec:** `docs/superpowers/specs/2026-08-05-status-page-design.md`

## Global Constraints

- Package manager is **pnpm** only. Never use npm/yarn.
- TypeScript strict mode (the create-next-app default). No `any` unless unavoidable.
- Every task ends with `pnpm lint`, `pnpm format:check`, and `pnpm test` passing.
- Timestamps are stored as **unix milliseconds** (integers) everywhere.
- A check passes on 2xx, or exactly `expectStatus` when configured. HTTP timeout is 10 seconds.
- Down after **2 consecutive failures**; up on **first success**. Alerts fire only on transitions.
- Retention: raw check rows older than **90 days** are pruned once per day.
- No chart libraries — latency chart is inline SVG.
- Secrets only via environment (`SMTP_PASS` from gitignored `.env`). Never commit `.env`.
- `next.config.ts` must have `output: 'standalone'` and `serverExternalPackages: ['better-sqlite3']`.
- Env vars with defaults: `CONFIG_PATH` (default `./config.yaml`), `DB_PATH` (default `./data/status.db`), `SMTP_PASS` (no default).
- Commit after every task (small, focused commits).

---

### Task 1: Scaffold Next.js project + tooling

**Files:**

- Create: Next.js scaffold (via create-next-app: `package.json`, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `src/app/*`, etc.)
- Create: `.prettierrc`, `.prettierignore`, `vitest.config.ts`, `config.yaml`
- Modify: `next.config.ts`, `eslint.config.mjs`, `package.json` (scripts), `.gitignore`

**Interfaces:**

- Consumes: nothing (first task)
- Produces: a building, linting, testable Next.js app; `config.yaml` at repo root; deps `yaml`, `zod`, `better-sqlite3`, `nodemailer` installed for later tasks.

- [ ] **Step 1: Scaffold with create-next-app**

create-next-app refuses directories containing unknown files, so move the env files aside first (`docs/` and `.gitignore` are allowed):

```bash
cd /Users/sauer/Dev/Projects/status-page
mv .env .env.example /tmp/
pnpm create next-app@latest . --typescript --eslint --tailwind --app --src-dir --import-alias "@/*" --use-pnpm --turbopack
mv /tmp/.env /tmp/.env.example .
git check-ignore .env   # MUST print ".env" — if not, re-add the env rules to .gitignore
```

If create-next-app replaced `.gitignore`, ensure it still contains these lines (append if missing):

```
.env
.env.*
!.env.example
*.db
*.db-journal
*.db-wal
*.db-shm
data/
```

- [ ] **Step 2: Install runtime and dev dependencies**

```bash
pnpm add yaml zod better-sqlite3 nodemailer
pnpm add -D vitest @types/better-sqlite3 @types/nodemailer prettier eslint-config-prettier
```

- [ ] **Step 3: Configure Next**

Replace `next.config.ts` with:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
```

- [ ] **Step 4: Configure Prettier and ESLint**

Create `.prettierrc`:

```json
{}
```

Create `.prettierignore`:

```
.next
node_modules
pnpm-lock.yaml
```

Replace `eslint.config.mjs` with (keeps the scaffold's Next presets, adds prettier last so it disables conflicting style rules):

```js
import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import eslintConfigPrettier from "eslint-config-prettier";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  eslintConfigPrettier,
  { ignores: [".next/**", "node_modules/**"] },
];

export default eslintConfig;
```

(If the scaffold's `eslint.config.mjs` differs structurally — e.g. no FlatCompat — keep its structure and just append `eslintConfigPrettier` and the ignores entry.)

- [ ] **Step 5: Configure Vitest and scripts**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

In `package.json`, add/merge scripts:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  }
}
```

(Keep whatever `dev`/`build`/`start`/`lint` the scaffold generated; only add the missing ones.)

- [ ] **Step 6: Create `config.yaml`** (real config — no secrets in it; the SMTP password comes from `SMTP_PASS`):

```yaml
checkIntervalSeconds: 60
alerts:
  smtp:
    host: smtp.example.com
    port: 587
    user: smtp-user@example.com
    from: status@example.com
    to: alerts@example.com
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    checkpoints:
      - name: Main site
        url: https://webhooks.cc
      - name: Redirector
        url: https://go.webhooks.cc
```

- [ ] **Step 7: Verify everything runs**

```bash
pnpm format
pnpm lint          # Expected: no errors
pnpm format:check  # Expected: all files formatted
pnpm test          # Expected: passes (no tests yet)
pnpm build         # Expected: build succeeds
git check-ignore .env  # Expected: .env
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with pnpm, tailwind, eslint, prettier, vitest"
```

---

### Task 2: Config loading and host resolution

**Files:**

- Create: `src/lib/config.ts`
- Test: `src/lib/config.test.ts`

**Interfaces:**

- Consumes: `config.yaml` shape from Task 1; deps `yaml`, `zod`.
- Produces:
  - `type AppConfig = { checkIntervalSeconds: number; alerts?: { smtp: SmtpConfig }; sites: SiteConfig[] }`
  - `type SiteConfig = { name: string; host: string; checkpoints: CheckpointConfig[] }`
  - `type CheckpointConfig = { name: string; url: string; expectStatus?: number }`
  - `type SmtpConfig = { host: string; port: number; user: string; from: string; to: string }`
  - `parseConfig(yamlText: string): AppConfig` — throws `Error` with field paths on invalid input
  - `loadConfig(path?: string): AppConfig` — reads `CONFIG_PATH` ?? `./config.yaml`
  - `getConfig(): AppConfig` — process-wide cached singleton
  - `findSiteByHost(config: AppConfig, hostHeader: string | null): SiteConfig | undefined`

- [ ] **Step 1: Write the failing tests** — create `src/lib/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findSiteByHost, parseConfig } from "./config";

const VALID = `
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    checkpoints:
      - name: Main site
        url: https://webhooks.cc
      - name: Redirector
        url: https://go.webhooks.cc
        expectStatus: 200
`;

describe("parseConfig", () => {
  it("parses a valid config and applies defaults", () => {
    const config = parseConfig(VALID);
    expect(config.checkIntervalSeconds).toBe(60);
    expect(config.alerts).toBeUndefined();
    expect(config.sites).toHaveLength(1);
    expect(config.sites[0].checkpoints[0].expectStatus).toBeUndefined();
    expect(config.sites[0].checkpoints[1].expectStatus).toBe(200);
  });

  it("parses an alerts block", () => {
    const config = parseConfig(
      VALID +
        `
alerts:
  smtp:
    host: smtp.example.com
    port: 587
    user: smtp-user@example.com
    from: status@example.com
    to: alerts@example.com
`,
    );
    expect(config.alerts?.smtp.host).toBe("smtp.example.com");
    expect(config.alerts?.smtp.port).toBe(587);
  });

  it("rejects a config with no sites", () => {
    expect(() => parseConfig("sites: []")).toThrow(/sites/);
  });

  it("rejects an invalid checkpoint url with a useful path", () => {
    const bad = VALID.replace("https://webhooks.cc", "not-a-url");
    expect(() => parseConfig(bad)).toThrow(/sites\.0\.checkpoints\.0\.url/);
  });

  it("rejects a missing site host", () => {
    const bad = VALID.replace("host: status.webhooks.cc", 'host: ""');
    expect(() => parseConfig(bad)).toThrow(/host/);
  });
});

describe("findSiteByHost", () => {
  const config = parseConfig(VALID);

  it("matches exact host", () => {
    expect(findSiteByHost(config, "status.webhooks.cc")?.name).toBe(
      "webhooks.cc",
    );
  });

  it("strips port and ignores case", () => {
    expect(findSiteByHost(config, "STATUS.webhooks.CC:3000")?.name).toBe(
      "webhooks.cc",
    );
  });

  it("returns undefined for unknown or missing host", () => {
    expect(findSiteByHost(config, "other.example.com")).toBeUndefined();
    expect(findSiteByHost(config, null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/config.test.ts`
Expected: FAIL — cannot resolve `./config`.

- [ ] **Step 3: Implement** — create `src/lib/config.ts`:

```ts
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const checkpointSchema = z.object({
  name: z.string().min(1),
  url: z.url(),
  expectStatus: z.number().int().min(100).max(599).optional(),
});

const smtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

const configSchema = z.object({
  checkIntervalSeconds: z.number().int().min(10).default(60),
  alerts: z.object({ smtp: smtpSchema }).optional(),
  sites: z
    .array(
      z.object({
        name: z.string().min(1),
        host: z.string().min(1),
        checkpoints: z.array(checkpointSchema).min(1),
      }),
    )
    .min(1),
});

export type AppConfig = z.infer<typeof configSchema>;
export type SiteConfig = AppConfig["sites"][number];
export type CheckpointConfig = SiteConfig["checkpoints"][number];
export type SmtpConfig = NonNullable<AppConfig["alerts"]>["smtp"];

export function parseConfig(yamlText: string): AppConfig {
  const result = configSchema.safeParse(parse(yamlText));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid config: ${details}`);
  }
  return result.data;
}

export function loadConfig(
  path = process.env.CONFIG_PATH ?? "./config.yaml",
): AppConfig {
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
```

Note: `z.url()` is the zod v4 form. If the installed zod is v3, use `z.string().url()` instead.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/config.test.ts`
Expected: PASS (all tests). If the url-path assertion fails only on message format, adjust the regex to match zod's actual path separator — the requirement is that the error names the offending field.

- [ ] **Step 5: Lint, format, commit**

```bash
pnpm lint && pnpm format:check && pnpm test
git add src/lib/config.ts src/lib/config.test.ts
git commit -m "feat: config loading with zod validation and host resolution"
```

---

### Task 3: SQLite layer

**Files:**

- Create: `src/lib/db.ts`
- Test: `src/lib/db.test.ts`

**Interfaces:**

- Consumes: `better-sqlite3`.
- Produces:
  - `openDb(path?: string): Database.Database` — `DB_PATH` ?? `./data/status.db`; creates parent dir (skipped for `:memory:`), WAL mode, creates schema
  - `getDb(): Database.Database` — process-wide cached singleton
  - `type CheckRow = { site: string; checkpoint: string; ts: number; ok: 0 | 1; statusCode: number | null; latencyMs: number | null; error: string | null }`
  - `type StateRow = { site: string; checkpoint: string; status: 'up' | 'down'; consecutiveFails: number; since: number }`
  - `insertCheck(db: Database.Database, row: CheckRow): void`
  - `getState(db: Database.Database, site: string, checkpoint: string): StateRow | undefined`
  - `setState(db: Database.Database, state: StateRow): void` — upsert
  - `pruneOldChecks(db: Database.Database, before: number): number` — deletes rows with `ts < before`, returns count
- Tables: `checks(id, site, checkpoint, ts, ok, status_code, latency_ms, error)` with indexes on `(site, checkpoint, ts)` and `(ts)`; `checkpoint_state(site, checkpoint, status, consecutive_fails, since)` with PK `(site, checkpoint)`.

- [ ] **Step 1: Write the failing tests** — create `src/lib/db.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getState, insertCheck, openDb, pruneOldChecks, setState } from "./db";

function memDb() {
  return openDb(":memory:");
}

describe("checks", () => {
  it("inserts and stores check rows", () => {
    const db = memDb();
    insertCheck(db, {
      site: "webhooks.cc",
      checkpoint: "Main site",
      ts: 1000,
      ok: 1,
      statusCode: 200,
      latencyMs: 123,
      error: null,
    });
    insertCheck(db, {
      site: "webhooks.cc",
      checkpoint: "Main site",
      ts: 2000,
      ok: 0,
      statusCode: null,
      latencyMs: 10000,
      error: "timeout",
    });
    const rows = db.prepare("SELECT * FROM checks ORDER BY ts").all() as Array<{
      ok: number;
      status_code: number | null;
      error: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].ok).toBe(1);
    expect(rows[0].status_code).toBe(200);
    expect(rows[1].ok).toBe(0);
    expect(rows[1].error).toBe("timeout");
  });

  it("prunes only rows older than the cutoff", () => {
    const db = memDb();
    for (const ts of [100, 200, 300]) {
      insertCheck(db, {
        site: "s",
        checkpoint: "c",
        ts,
        ok: 1,
        statusCode: 200,
        latencyMs: 1,
        error: null,
      });
    }
    const deleted = pruneOldChecks(db, 250);
    expect(deleted).toBe(2);
    const remaining = db.prepare("SELECT ts FROM checks").all() as Array<{
      ts: number;
    }>;
    expect(remaining.map((r) => r.ts)).toEqual([300]);
  });
});

describe("checkpoint_state", () => {
  it("returns undefined for unknown checkpoints", () => {
    expect(getState(memDb(), "s", "c")).toBeUndefined();
  });

  it("round-trips and upserts state", () => {
    const db = memDb();
    setState(db, {
      site: "s",
      checkpoint: "c",
      status: "up",
      consecutiveFails: 0,
      since: 500,
    });
    expect(getState(db, "s", "c")).toEqual({
      site: "s",
      checkpoint: "c",
      status: "up",
      consecutiveFails: 0,
      since: 500,
    });
    setState(db, {
      site: "s",
      checkpoint: "c",
      status: "down",
      consecutiveFails: 2,
      since: 900,
    });
    expect(getState(db, "s", "c")).toEqual({
      site: "s",
      checkpoint: "c",
      status: "down",
      consecutiveFails: 2,
      since: 900,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM checkpoint_state").get(),
    ).toEqual({ n: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/db.test.ts`
Expected: FAIL — cannot resolve `./db`.

- [ ] **Step 3: Implement** — create `src/lib/db.ts`:

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_site_cp_ts ON checks(site, checkpoint, ts);
CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts);
CREATE TABLE IF NOT EXISTS checkpoint_state (
  site TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  status TEXT NOT NULL,
  consecutive_fails INTEGER NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (site, checkpoint)
);
`;

export interface CheckRow {
  site: string;
  checkpoint: string;
  ts: number;
  ok: 0 | 1;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface StateRow {
  site: string;
  checkpoint: string;
  status: "up" | "down";
  consecutiveFails: number;
  since: number;
}

export function openDb(
  path = process.env.DB_PATH ?? "./data/status.db",
): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

const globals = globalThis as { __statusDb?: Database.Database };

export function getDb(): Database.Database {
  globals.__statusDb ??= openDb();
  return globals.__statusDb;
}

export function insertCheck(db: Database.Database, row: CheckRow): void {
  db.prepare(
    `INSERT INTO checks (site, checkpoint, ts, ok, status_code, latency_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.site,
    row.checkpoint,
    row.ts,
    row.ok,
    row.statusCode,
    row.latencyMs,
    row.error,
  );
}

export function getState(
  db: Database.Database,
  site: string,
  checkpoint: string,
): StateRow | undefined {
  return db
    .prepare(
      `SELECT site, checkpoint, status, consecutive_fails AS consecutiveFails, since
       FROM checkpoint_state WHERE site = ? AND checkpoint = ?`,
    )
    .get(site, checkpoint) as StateRow | undefined;
}

export function setState(db: Database.Database, state: StateRow): void {
  db.prepare(
    `INSERT INTO checkpoint_state (site, checkpoint, status, consecutive_fails, since)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(site, checkpoint) DO UPDATE SET
       status = excluded.status,
       consecutive_fails = excluded.consecutive_fails,
       since = excluded.since`,
  ).run(
    state.site,
    state.checkpoint,
    state.status,
    state.consecutiveFails,
    state.since,
  );
}

export function pruneOldChecks(db: Database.Database, before: number): number {
  return db.prepare("DELETE FROM checks WHERE ts < ?").run(before).changes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, format, commit**

```bash
pnpm lint && pnpm format:check && pnpm test
git add src/lib/db.ts src/lib/db.test.ts
git commit -m "feat: sqlite layer with checks and checkpoint_state tables"
```

---

### Task 4: HTTP check function

**Files:**

- Create: `src/lib/checker.ts`
- Test: `src/lib/checker.test.ts`

**Interfaces:**

- Consumes: nothing project-internal (global `fetch`).
- Produces:
  - `type CheckOutcome = { ok: boolean; statusCode: number | null; latencyMs: number; error: string | null }`
  - `runCheck(url: string, expectStatus?: number, timeoutMs?: number): Promise<CheckOutcome>` — default timeout 10 000 ms; 2xx passes unless `expectStatus` set (then exact match); redirects are followed, except when `expectStatus` is a 3xx (then not followed, so the redirect itself can be asserted); never throws.

- [ ] **Step 1: Write the failing tests** — create `src/lib/checker.test.ts`:

```ts
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheck } from "./checker";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200).end("ok");
    } else if (req.url === "/err") {
      res.writeHead(500).end("boom");
    } else if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/ok" }).end();
    } else if (req.url === "/slow") {
      setTimeout(() => res.writeHead(200).end("late"), 500);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

describe("runCheck", () => {
  it("passes on 2xx and records status and latency", async () => {
    const outcome = await runCheck(`${base}/ok`);
    expect(outcome.ok).toBe(true);
    expect(outcome.statusCode).toBe(200);
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    expect(outcome.error).toBeNull();
  });

  it("fails on non-2xx with an error message", async () => {
    const outcome = await runCheck(`${base}/err`);
    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBe(500);
    expect(outcome.error).toMatch(/500/);
  });

  it("passes when expectStatus matches a non-2xx", async () => {
    const outcome = await runCheck(`${base}/err`, 500);
    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeNull();
  });

  it("follows redirects by default", async () => {
    const outcome = await runCheck(`${base}/redirect`);
    expect(outcome.ok).toBe(true);
    expect(outcome.statusCode).toBe(200);
  });

  it("asserts the redirect itself when expectStatus is 3xx", async () => {
    const outcome = await runCheck(`${base}/redirect`, 302);
    expect(outcome.ok).toBe(true);
    expect(outcome.statusCode).toBe(302);
  });

  it("fails with a timeout error when the response is too slow", async () => {
    const outcome = await runCheck(`${base}/slow`, undefined, 100);
    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBeNull();
    expect(outcome.error).toBe("timeout");
  });

  it("fails with an error on connection refused", async () => {
    const outcome = await runCheck("http://127.0.0.1:1/ok", undefined, 1000);
    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBeNull();
    expect(outcome.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/checker.test.ts`
Expected: FAIL — cannot resolve `./checker`.

- [ ] **Step 3: Implement** — create `src/lib/checker.ts`:

```ts
export interface CheckOutcome {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
}

export async function runCheck(
  url: string,
  expectStatus?: number,
  timeoutMs = 10_000,
): Promise<CheckOutcome> {
  const start = Date.now();
  const expectsRedirect =
    expectStatus !== undefined && expectStatus >= 300 && expectStatus < 400;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: expectsRedirect ? "manual" : "follow",
      cache: "no-store",
    });
    const latencyMs = Date.now() - start;
    const ok =
      expectStatus !== undefined
        ? res.status === expectStatus
        : res.status >= 200 && res.status < 300;
    return {
      ok,
      statusCode: res.status,
      latencyMs,
      error: ok ? null : `unexpected status ${res.status}`,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    const message = isTimeout
      ? "timeout"
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, statusCode: null, latencyMs, error: message };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/checker.test.ts`
Expected: PASS. (Note: undici wraps some causes — if the connection-refused test's `error` is a generic "fetch failed", that is acceptable; the assertion only requires a truthy error.)

- [ ] **Step 5: Lint, format, commit**

```bash
pnpm lint && pnpm format:check && pnpm test
git add src/lib/checker.ts src/lib/checker.test.ts
git commit -m "feat: http checkpoint check with timeout and expectStatus"
```

---

### Task 5: State machine

**Files:**

- Create: `src/lib/state.ts`
- Test: `src/lib/state.test.ts`

**Interfaces:**

- Consumes: nothing project-internal (pure logic).
- Produces:
  - `type Transition = 'went-down' | 'recovered' | null`
  - `type CheckpointState = { status: 'up' | 'down'; consecutiveFails: number; since: number }`
  - `applyResult(prev: CheckpointState | undefined, ok: boolean, now: number): { next: CheckpointState; transition: Transition }`
  - `overallStatus(statuses: Array<'up' | 'down'>): 'operational' | 'partial' | 'major'`
- Rules: unknown checkpoint starts as `up` with 0 fails; down after 2 consecutive fails (transition fires exactly then); up again on first success; `since` changes only when `status` changes.

- [ ] **Step 1: Write the failing tests** — create `src/lib/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyResult, overallStatus, type CheckpointState } from "./state";

const UP: CheckpointState = { status: "up", consecutiveFails: 0, since: 100 };

describe("applyResult", () => {
  it("starts unknown checkpoints as up without a transition", () => {
    const { next, transition } = applyResult(undefined, true, 1000);
    expect(next).toEqual({ status: "up", consecutiveFails: 0, since: 1000 });
    expect(transition).toBeNull();
  });

  it("keeps status up after a single failure", () => {
    const { next, transition } = applyResult(UP, false, 2000);
    expect(next).toEqual({ status: "up", consecutiveFails: 1, since: 100 });
    expect(transition).toBeNull();
  });

  it("goes down on the second consecutive failure", () => {
    const afterOne = applyResult(UP, false, 2000).next;
    const { next, transition } = applyResult(afterOne, false, 3000);
    expect(next).toEqual({ status: "down", consecutiveFails: 2, since: 3000 });
    expect(transition).toBe("went-down");
  });

  it("stays down without re-firing the transition", () => {
    const down: CheckpointState = {
      status: "down",
      consecutiveFails: 2,
      since: 3000,
    };
    const { next, transition } = applyResult(down, false, 4000);
    expect(next).toEqual({ status: "down", consecutiveFails: 3, since: 3000 });
    expect(transition).toBeNull();
  });

  it("recovers on the first success", () => {
    const down: CheckpointState = {
      status: "down",
      consecutiveFails: 5,
      since: 3000,
    };
    const { next, transition } = applyResult(down, true, 9000);
    expect(next).toEqual({ status: "up", consecutiveFails: 0, since: 9000 });
    expect(transition).toBe("recovered");
  });

  it("resets the fail counter on success while up", () => {
    const flaky: CheckpointState = {
      status: "up",
      consecutiveFails: 1,
      since: 100,
    };
    const { next, transition } = applyResult(flaky, true, 5000);
    expect(next).toEqual({ status: "up", consecutiveFails: 0, since: 100 });
    expect(transition).toBeNull();
  });

  it("first-ever check failing does not immediately alert", () => {
    const { next, transition } = applyResult(undefined, false, 1000);
    expect(next).toEqual({ status: "up", consecutiveFails: 1, since: 1000 });
    expect(transition).toBeNull();
  });
});

describe("overallStatus", () => {
  it("is operational when every checkpoint is up (or there are none)", () => {
    expect(overallStatus(["up", "up"])).toBe("operational");
    expect(overallStatus([])).toBe("operational");
  });

  it("is partial when some are down", () => {
    expect(overallStatus(["up", "down"])).toBe("partial");
  });

  it("is major when all are down", () => {
    expect(overallStatus(["down", "down"])).toBe("major");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/state.test.ts`
Expected: FAIL — cannot resolve `./state`.

- [ ] **Step 3: Implement** — create `src/lib/state.ts`:

```ts
export type Transition = "went-down" | "recovered" | null;

export interface CheckpointState {
  status: "up" | "down";
  consecutiveFails: number;
  since: number;
}

const DOWN_AFTER_CONSECUTIVE_FAILS = 2;

export function applyResult(
  prev: CheckpointState | undefined,
  ok: boolean,
  now: number,
): { next: CheckpointState; transition: Transition } {
  const current: CheckpointState = prev ?? {
    status: "up",
    consecutiveFails: 0,
    since: now,
  };

  if (ok) {
    const recovered = current.status === "down";
    return {
      next: {
        status: "up",
        consecutiveFails: 0,
        since: recovered ? now : current.since,
      },
      transition: recovered ? "recovered" : null,
    };
  }

  const fails = current.consecutiveFails + 1;
  const goesDown =
    current.status === "up" && fails >= DOWN_AFTER_CONSECUTIVE_FAILS;
  return {
    next: {
      status: goesDown ? "down" : current.status,
      consecutiveFails: fails,
      since: goesDown ? now : current.since,
    },
    transition: goesDown ? "went-down" : null,
  };
}

export function overallStatus(
  statuses: Array<"up" | "down">,
): "operational" | "partial" | "major" {
  if (statuses.length === 0 || statuses.every((status) => status === "up"))
    return "operational";
  if (statuses.every((status) => status === "down")) return "major";
  return "partial";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, format, commit**

```bash
pnpm lint && pnpm format:check && pnpm test
git add src/lib/state.ts src/lib/state.test.ts
git commit -m "feat: checkpoint state machine and overall status"
```

---

### Task 6: Email alerts

**Files:**

- Create: `src/lib/alerts.ts`
- Test: `src/lib/alerts.test.ts`

**Interfaces:**

- Consumes: `SmtpConfig` from `src/lib/config.ts`; `nodemailer`; `SMTP_PASS` env var.
- Produces:
  - `type AlertEvent = { site: string; checkpoint: string; url: string; transition: 'went-down' | 'recovered'; error?: string | null; downSince?: number; now: number }`
  - `type Mail = { from: string; to: string; subject: string; text: string }`
  - `type SendMail = (mail: Mail) => Promise<unknown>`
  - `formatDuration(ms: number): string`
  - `buildAlertEmail(event: AlertEvent): { subject: string; text: string }`
  - `sendAlert(smtp: SmtpConfig, event: AlertEvent, send?: SendMail): Promise<void>` — never throws; logs failures. Default `send` uses nodemailer with `SMTP_PASS`.

- [ ] **Step 1: Write the failing tests** — create `src/lib/alerts.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  buildAlertEmail,
  formatDuration,
  sendAlert,
  type Mail,
} from "./alerts";
import type { SmtpConfig } from "./config";

const SMTP: SmtpConfig = {
  host: "mail.example.com",
  port: 587,
  user: "postmaster@example.com",
  from: "status@example.com",
  to: "alerts@example.com",
};

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(3 * 60_000)).toBe("3 min");
    expect(formatDuration(125 * 60_000)).toBe("2 h 5 min");
  });
});

describe("buildAlertEmail", () => {
  it("describes a down transition with the error", () => {
    const { subject, text } = buildAlertEmail({
      site: "webhooks.cc",
      checkpoint: "Redirector",
      url: "https://go.webhooks.cc",
      transition: "went-down",
      error: "timeout",
      now: 1_700_000_000_000,
    });
    expect(subject).toContain("webhooks.cc");
    expect(subject).toContain("Redirector");
    expect(subject).toContain("DOWN");
    expect(text).toContain("https://go.webhooks.cc");
    expect(text).toContain("timeout");
  });

  it("describes a recovery with the outage duration", () => {
    const now = 1_700_000_000_000;
    const { subject, text } = buildAlertEmail({
      site: "webhooks.cc",
      checkpoint: "Main site",
      url: "https://webhooks.cc",
      transition: "recovered",
      downSince: now - 10 * 60_000,
      now,
    });
    expect(subject).toContain("recovered");
    expect(text).toContain("10 min");
  });
});

describe("sendAlert", () => {
  const event = {
    site: "s",
    checkpoint: "c",
    url: "https://example.com",
    transition: "went-down" as const,
    error: "boom",
    now: 0,
  };

  it("sends via the injected transport with configured from/to", async () => {
    const send = vi
      .fn<(mail: Mail) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    await sendAlert(SMTP, event, send);
    expect(send).toHaveBeenCalledOnce();
    const mail = send.mock.calls[0][0];
    expect(mail.from).toBe("status@example.com");
    expect(mail.to).toBe("alerts@example.com");
    expect(mail.subject).toContain("DOWN");
  });

  it("never throws when the transport fails", async () => {
    const send = vi
      .fn<(mail: Mail) => Promise<unknown>>()
      .mockRejectedValue(new Error("smtp down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendAlert(SMTP, event, send)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/alerts.test.ts`
Expected: FAIL — cannot resolve `./alerts`.

- [ ] **Step 3: Implement** — create `src/lib/alerts.ts`:

```ts
import nodemailer from "nodemailer";
import type { SmtpConfig } from "./config";

export interface AlertEvent {
  site: string;
  checkpoint: string;
  url: string;
  transition: "went-down" | "recovered";
  error?: string | null;
  downSince?: number;
  now: number;
}

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export type SendMail = (mail: Mail) => Promise<unknown>;

export function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export function buildAlertEmail(event: AlertEvent): {
  subject: string;
  text: string;
} {
  const timestamp = new Date(event.now).toISOString();
  if (event.transition === "went-down") {
    return {
      subject: `🔴 ${event.site}: ${event.checkpoint} is DOWN`,
      text: `${event.checkpoint} (${event.url}) is failing.\n\nError: ${event.error ?? "unknown"}\nTime: ${timestamp}`,
    };
  }
  const duration =
    event.downSince !== undefined
      ? formatDuration(event.now - event.downSince)
      : "unknown";
  return {
    subject: `🟢 ${event.site}: ${event.checkpoint} recovered`,
    text: `${event.checkpoint} (${event.url}) is back up.\n\nDowntime: ${duration}\nTime: ${timestamp}`,
  };
}

function smtpSend(smtp: SmtpConfig): SendMail {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: process.env.SMTP_PASS },
  });
  return (mail) => transport.sendMail(mail);
}

export async function sendAlert(
  smtp: SmtpConfig,
  event: AlertEvent,
  send: SendMail = smtpSend(smtp),
): Promise<void> {
  const mail: Mail = {
    from: smtp.from,
    to: smtp.to,
    ...buildAlertEmail(event),
  };
  try {
    await send(mail);
  } catch (err) {
    console.error("[alerts] failed to send email", err);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/alerts.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, format, commit**

```bash
pnpm lint && pnpm format:check && pnpm test
git add src/lib/alerts.ts src/lib/alerts.test.ts
git commit -m "feat: email alerts for down/recovered transitions"
```

---

### Task 7: Scheduler and instrumentation

**Files:**

- Create: `src/lib/scheduler.ts`, `src/instrumentation.ts`
- Test: `src/lib/scheduler.test.ts`

**Interfaces:**

- Consumes: `AppConfig`/`getConfig` (Task 2); `getDb`, `insertCheck`, `getState`, `setState`, `pruneOldChecks` (Task 3); `runCheck`, `CheckOutcome` (Task 4); `applyResult` (Task 5); `sendAlert`, `AlertEvent` (Task 6).
- Produces:
  - `type SchedulerDeps = { config: AppConfig; db: Database.Database; check: (url: string, expectStatus?: number) => Promise<CheckOutcome>; alert: (event: AlertEvent) => Promise<void>; now: () => number }`
  - `tick(deps: SchedulerDeps): Promise<void>` — one full round: for every checkpoint, run check, insert row, update state, fire alert on transition (alert errors are caught and logged, never break the tick)
  - `startScheduler(): void` — idempotent via `globalThis` guard; runs `tick` immediately and then every `checkIntervalSeconds`; prunes rows older than 90 days once per calendar day
  - `src/instrumentation.ts` exports `register()` which calls `startScheduler()` only when `process.env.NEXT_RUNTIME === 'nodejs'`.

- [ ] **Step 1: Write the failing tests** — create `src/lib/scheduler.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config";
import { getState, openDb } from "./db";
import { tick, type SchedulerDeps } from "./scheduler";

const CONFIG: AppConfig = {
  checkIntervalSeconds: 60,
  alerts: {
    smtp: { host: "h", port: 587, user: "u", from: "f@x.com", to: "t@x.com" },
  },
  sites: [
    {
      name: "webhooks.cc",
      host: "status.webhooks.cc",
      checkpoints: [{ name: "Main site", url: "https://webhooks.cc" }],
    },
  ],
};

function makeDeps(outcomes: Array<{ ok: boolean }>): SchedulerDeps & {
  alertSpy: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  let time = 1000;
  const alertSpy = vi.fn().mockResolvedValue(undefined);
  return {
    config: CONFIG,
    db: openDb(":memory:"),
    check: vi.fn().mockImplementation(() => {
      const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
      return Promise.resolve({
        ok: outcome.ok,
        statusCode: outcome.ok ? 200 : 500,
        latencyMs: 50,
        error: outcome.ok ? null : "unexpected status 500",
      });
    }),
    alert: alertSpy,
    now: () => (time += 1000),
    alertSpy,
  };
}

describe("tick", () => {
  it("records a check row and an up state on success", async () => {
    const deps = makeDeps([{ ok: true }]);
    await tick(deps);
    const rows = deps.db.prepare("SELECT * FROM checks").all();
    expect(rows).toHaveLength(1);
    expect(getState(deps.db, "webhooks.cc", "Main site")?.status).toBe("up");
    expect(deps.alertSpy).not.toHaveBeenCalled();
  });

  it("alerts once after two consecutive failures", async () => {
    const deps = makeDeps([{ ok: false }]);
    await tick(deps);
    expect(deps.alertSpy).not.toHaveBeenCalled();
    await tick(deps);
    expect(deps.alertSpy).toHaveBeenCalledOnce();
    expect(deps.alertSpy.mock.calls[0][0]).toMatchObject({
      site: "webhooks.cc",
      checkpoint: "Main site",
      transition: "went-down",
      error: "unexpected status 500",
    });
    await tick(deps);
    expect(deps.alertSpy).toHaveBeenCalledOnce();
    expect(getState(deps.db, "webhooks.cc", "Main site")?.status).toBe("down");
  });

  it("alerts recovery with the downSince timestamp", async () => {
    const deps = makeDeps([{ ok: false }, { ok: false }, { ok: true }]);
    await tick(deps);
    await tick(deps);
    const downSince = getState(deps.db, "webhooks.cc", "Main site")?.since;
    await tick(deps);
    expect(deps.alertSpy).toHaveBeenCalledTimes(2);
    expect(deps.alertSpy.mock.calls[1][0]).toMatchObject({
      transition: "recovered",
      downSince,
    });
    expect(getState(deps.db, "webhooks.cc", "Main site")?.status).toBe("up");
  });

  it("does not alert when config has no alerts block", async () => {
    const deps = makeDeps([{ ok: false }]);
    deps.config = { ...CONFIG, alerts: undefined };
    await tick(deps);
    await tick(deps);
    expect(deps.alertSpy).not.toHaveBeenCalled();
    expect(getState(deps.db, "webhooks.cc", "Main site")?.status).toBe("down");
  });

  it("survives an alert function that rejects", async () => {
    const deps = makeDeps([{ ok: false }]);
    deps.alert = vi.fn().mockRejectedValue(new Error("smtp down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await tick(deps);
    await expect(tick(deps)).resolves.toBeUndefined();
    errorSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/scheduler.test.ts`
Expected: FAIL — cannot resolve `./scheduler`.

- [ ] **Step 3: Implement** — create `src/lib/scheduler.ts`:

```ts
import type Database from "better-sqlite3";
import { sendAlert, type AlertEvent } from "./alerts";
import { runCheck, type CheckOutcome } from "./checker";
import { getConfig, type AppConfig } from "./config";
import { getDb, getState, insertCheck, pruneOldChecks, setState } from "./db";
import { applyResult } from "./state";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface SchedulerDeps {
  config: AppConfig;
  db: Database.Database;
  check: (url: string, expectStatus?: number) => Promise<CheckOutcome>;
  alert: (event: AlertEvent) => Promise<void>;
  now: () => number;
}

export async function tick(deps: SchedulerDeps): Promise<void> {
  const { config, db, check, alert, now } = deps;
  await Promise.all(
    config.sites.flatMap((site) =>
      site.checkpoints.map(async (cp) => {
        const outcome = await check(cp.url, cp.expectStatus);
        const ts = now();
        insertCheck(db, {
          site: site.name,
          checkpoint: cp.name,
          ts,
          ok: outcome.ok ? 1 : 0,
          statusCode: outcome.statusCode,
          latencyMs: outcome.latencyMs,
          error: outcome.error,
        });
        const prev = getState(db, site.name, cp.name);
        const { next, transition } = applyResult(prev, outcome.ok, ts);
        setState(db, { site: site.name, checkpoint: cp.name, ...next });
        if (transition !== null && config.alerts) {
          try {
            await alert({
              site: site.name,
              checkpoint: cp.name,
              url: cp.url,
              transition,
              error: outcome.error,
              downSince: transition === "recovered" ? prev?.since : undefined,
              now: ts,
            });
          } catch (err) {
            console.error("[scheduler] alert failed", err);
          }
        }
      }),
    ),
  );
}

const globals = globalThis as { __statusSchedulerStarted?: boolean };

export function startScheduler(): void {
  if (globals.__statusSchedulerStarted) return;
  globals.__statusSchedulerStarted = true;

  const config = getConfig();
  const db = getDb();
  const deps: SchedulerDeps = {
    config,
    db,
    check: runCheck,
    alert: (event) =>
      config.alerts ? sendAlert(config.alerts.smtp, event) : Promise.resolve(),
    now: Date.now,
  };

  let lastPruneDay = "";
  const run = async () => {
    try {
      await tick(deps);
      const day = new Date().toISOString().slice(0, 10);
      if (day !== lastPruneDay) {
        lastPruneDay = day;
        const deleted = pruneOldChecks(db, Date.now() - RETENTION_MS);
        if (deleted > 0)
          console.log(`[scheduler] pruned ${deleted} old check rows`);
      }
    } catch (err) {
      console.error("[scheduler] tick failed", err);
    }
  };

  console.log(
    `[scheduler] started: ${config.sites.length} site(s), every ${config.checkIntervalSeconds}s`,
  );
  void run();
  setInterval(run, config.checkIntervalSeconds * 1000);
}
```

- [ ] **Step 4: Create `src/instrumentation.ts`**

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 6: Smoke-test the embedded checker**

```bash
pnpm dev &
sleep 8
sqlite3 data/status.db 'SELECT site, checkpoint, ok, status_code FROM checks;'
kill %1
```

Expected: the dev server logs `[scheduler] started: 1 site(s), every 60s` exactly once, and the query shows one row per configured checkpoint. (If `sqlite3` CLI is missing, verify via the dev log line and `ls data/status.db` instead.)

- [ ] **Step 7: Lint, format, commit**

```bash
pnpm lint && pnpm format:check && pnpm test
git add src/lib/scheduler.ts src/lib/scheduler.test.ts src/instrumentation.ts
git commit -m "feat: scheduler loop wired into next instrumentation"
```

---

### Task 8: Read queries for the page

**Files:**

- Create: `src/lib/queries.ts`
- Test: `src/lib/queries.test.ts`

**Interfaces:**

- Consumes: db handle + `insertCheck` (Task 3).
- Produces:
  - `type DayUptime = { date: string; total: number; up: number; uptimePct: number | null }` — `date` is UTC `YYYY-MM-DD`; `uptimePct` is rounded to 1 decimal, `null` when no data that day
  - `dailyUptime(db, site, checkpoint, days?: number, now?: number): DayUptime[]` — always returns exactly `days` (default 90) entries, oldest first, ending with today (UTC)
  - `type LatencyPoint = { ts: number; latencyMs: number }` — `ts` is the bucket start (5-minute buckets), `latencyMs` the average of successful checks in the bucket
  - `latencySeries(db, site, checkpoint, sinceMs: number, untilMs: number): LatencyPoint[]` — ordered by `ts`, failed checks and null latencies excluded

- [ ] **Step 1: Write the failing tests** — create `src/lib/queries.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { insertCheck, openDb } from "./db";
import { dailyUptime, latencySeries } from "./queries";

const DAY = 24 * 60 * 60 * 1000;
// 2024-01-10T12:00:00Z — fixed "now" so dates are deterministic
const NOW = Date.UTC(2024, 0, 10, 12, 0, 0);

function seed(
  db: ReturnType<typeof openDb>,
  ts: number,
  ok: 0 | 1,
  latencyMs: number | null,
) {
  insertCheck(db, {
    site: "s",
    checkpoint: "c",
    ts,
    ok,
    statusCode: ok ? 200 : 500,
    latencyMs,
    error: ok ? null : "unexpected status 500",
  });
}

describe("dailyUptime", () => {
  it("returns one entry per day, oldest first, ending today", () => {
    const days = dailyUptime(openDb(":memory:"), "s", "c", 90, NOW);
    expect(days).toHaveLength(90);
    expect(days[89].date).toBe("2024-01-10");
    expect(days[0].date).toBe("2023-10-13");
    expect(days.every((d) => d.uptimePct === null)).toBe(true);
  });

  it("computes per-day percentages and leaves gap days null", () => {
    const db = openDb(":memory:");
    // 2024-01-09 (yesterday): 3 ok, 1 fail => 75%
    const yesterdayNoon = Date.UTC(2024, 0, 9, 12, 0, 0);
    seed(db, yesterdayNoon, 1, 100);
    seed(db, yesterdayNoon + 60_000, 1, 100);
    seed(db, yesterdayNoon + 120_000, 1, 100);
    seed(db, yesterdayNoon + 180_000, 0, null);
    // 2024-01-10 (today): 1 ok => 100%
    seed(db, NOW - 60_000, 1, 100);

    const days = dailyUptime(db, "s", "c", 3, NOW);
    expect(days.map((d) => d.date)).toEqual([
      "2024-01-08",
      "2024-01-09",
      "2024-01-10",
    ]);
    expect(days[0].uptimePct).toBeNull();
    expect(days[1]).toMatchObject({ total: 4, up: 3, uptimePct: 75 });
    expect(days[2]).toMatchObject({ total: 1, up: 1, uptimePct: 100 });
  });

  it("scopes to the requested checkpoint", () => {
    const db = openDb(":memory:");
    seed(db, NOW - 60_000, 0, null);
    insertCheck(db, {
      site: "s",
      checkpoint: "other",
      ts: NOW - 60_000,
      ok: 1,
      statusCode: 200,
      latencyMs: 5,
      error: null,
    });
    const days = dailyUptime(db, "s", "other", 1, NOW);
    expect(days[0]).toMatchObject({ total: 1, up: 1, uptimePct: 100 });
  });
});

describe("latencySeries", () => {
  it("averages successful checks into 5-minute buckets, ordered by time", () => {
    const db = openDb(":memory:");
    const bucket = Math.floor((NOW - 60 * 60_000) / 300_000) * 300_000;
    seed(db, bucket + 1000, 1, 100);
    seed(db, bucket + 2000, 1, 300);
    seed(db, bucket + 3000, 0, 10_000); // failed: excluded
    seed(db, bucket + 300_000 + 1000, 1, 50);

    const points = latencySeries(db, "s", "c", NOW - DAY, NOW);
    expect(points).toEqual([
      { ts: bucket, latencyMs: 200 },
      { ts: bucket + 300_000, latencyMs: 50 },
    ]);
  });

  it("excludes points outside the window", () => {
    const db = openDb(":memory:");
    seed(db, NOW - 2 * DAY, 1, 100);
    expect(latencySeries(db, "s", "c", NOW - DAY, NOW)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/queries.test.ts`
Expected: FAIL — cannot resolve `./queries`.

- [ ] **Step 3: Implement** — create `src/lib/queries.ts`:

```ts
import type Database from "better-sqlite3";

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = 5 * 60 * 1000;

export interface DayUptime {
  date: string;
  total: number;
  up: number;
  uptimePct: number | null;
}

export interface LatencyPoint {
  ts: number;
  latencyMs: number;
}

function startOfUtcDay(ts: number): number {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

export function dailyUptime(
  db: Database.Database,
  site: string,
  checkpoint: string,
  days = 90,
  now = Date.now(),
): DayUptime[] {
  const since = startOfUtcDay(now) - (days - 1) * DAY_MS;
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS date,
              COUNT(*) AS total,
              SUM(ok) AS up
       FROM checks
       WHERE site = ? AND checkpoint = ? AND ts >= ?
       GROUP BY date`,
    )
    .all(site, checkpoint, since) as Array<{
    date: string;
    total: number;
    up: number;
  }>;
  const byDate = new Map(rows.map((row) => [row.date, row]));

  const result: DayUptime[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(since + i * DAY_MS).toISOString().slice(0, 10);
    const row = byDate.get(date);
    result.push(
      row
        ? {
            date,
            total: row.total,
            up: row.up,
            uptimePct: Math.round((row.up / row.total) * 1000) / 10,
          }
        : { date, total: 0, up: 0, uptimePct: null },
    );
  }
  return result;
}

export function latencySeries(
  db: Database.Database,
  site: string,
  checkpoint: string,
  sinceMs: number,
  untilMs: number,
): LatencyPoint[] {
  return db
    .prepare(
      `SELECT (ts / ${BUCKET_MS}) * ${BUCKET_MS} AS ts,
              ROUND(AVG(latency_ms)) AS latencyMs
       FROM checks
       WHERE site = ? AND checkpoint = ? AND ts >= ? AND ts <= ?
         AND ok = 1 AND latency_ms IS NOT NULL
       GROUP BY ts
       ORDER BY ts`,
    )
    .all(site, checkpoint, sinceMs, untilMs) as LatencyPoint[];
  // Note: integer division — ts and BUCKET_MS are both integers in SQLite.
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/queries.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, format, commit**

```bash
pnpm lint && pnpm format:check && pnpm test
git add src/lib/queries.ts src/lib/queries.test.ts
git commit -m "feat: daily uptime and latency queries"
```

---

### Task 9: Status page UI

**Files:**

- Create: `src/components/StatusBanner.tsx`, `src/components/UptimeBars.tsx`, `src/components/LatencyChart.tsx`, `src/components/CheckpointCard.tsx`, `src/components/AutoRefresh.tsx`, `src/app/not-found.tsx`
- Modify: `src/app/page.tsx` (replace scaffold), `src/app/layout.tsx` (metadata title)

**Interfaces:**

- Consumes: `getConfig`, `findSiteByHost` (Task 2); `getDb`, `getState` (Task 3); `overallStatus` (Task 5); `dailyUptime`, `latencySeries`, `DayUptime`, `LatencyPoint` (Task 8).
- Produces: the public page. No new library interfaces.

- [ ] **Step 1: Create `src/components/AutoRefresh.tsx`**

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function AutoRefresh({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
```

- [ ] **Step 2: Create `src/components/StatusBanner.tsx`**

```tsx
const STYLES = {
  operational: { bg: "bg-emerald-500", label: "All systems operational" },
  partial: { bg: "bg-amber-500", label: "Partial outage" },
  major: { bg: "bg-red-600", label: "Major outage" },
} as const;

export function StatusBanner({ status }: { status: keyof typeof STYLES }) {
  const { bg, label } = STYLES[status];
  return (
    <div
      className={`${bg} rounded-lg px-4 py-3 text-lg font-semibold text-white`}
    >
      {label}
    </div>
  );
}
```

- [ ] **Step 3: Create `src/components/UptimeBars.tsx`**

```tsx
import type { DayUptime } from "@/lib/queries";

function barColor(pct: number | null): string {
  if (pct === null) return "bg-neutral-200 dark:bg-neutral-700";
  if (pct >= 99) return "bg-emerald-500";
  if (pct >= 90) return "bg-amber-400";
  return "bg-red-500";
}

export function UptimeBars({ days }: { days: DayUptime[] }) {
  const measured = days.filter((d) => d.uptimePct !== null);
  const overall =
    measured.length > 0
      ? (
          measured.reduce((sum, d) => sum + (d.uptimePct ?? 0), 0) /
          measured.length
        ).toFixed(2)
      : null;
  return (
    <div>
      <div className="flex gap-px">
        {days.map((d) => (
          <div
            key={d.date}
            title={`${d.date}: ${d.uptimePct === null ? "no data" : `${d.uptimePct}%`}`}
            className={`h-8 min-w-0 flex-1 rounded-sm ${barColor(d.uptimePct)}`}
          />
        ))}
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        {overall === null
          ? "No data yet"
          : `${overall}% uptime over the last 90 days`}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Create `src/components/LatencyChart.tsx`**

```tsx
import type { LatencyPoint } from "@/lib/queries";

export function LatencyChart({
  points,
  sinceMs,
  untilMs,
}: {
  points: LatencyPoint[];
  sinceMs: number;
  untilMs: number;
}) {
  if (points.length === 0) {
    return <p className="text-xs text-neutral-500">No latency data yet</p>;
  }
  const W = 600;
  const H = 80;
  const PAD = 2;
  const max = Math.max(...points.map((p) => p.latencyMs), 1);
  const x = (ts: number) =>
    PAD + ((ts - sinceMs) / (untilMs - sinceMs)) * (W - 2 * PAD);
  const y = (ms: number) => H - PAD - (ms / max) * (H - 2 * PAD);
  const path = points
    .map((p) => `${x(p.ts).toFixed(1)},${y(p.latencyMs).toFixed(1)}`)
    .join(" ");
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Response time, last 24 hours"
      >
        <polyline
          points={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-sky-500"
        />
      </svg>
      <p className="text-xs text-neutral-500">
        Last 24 hours · max {Math.round(max)} ms
      </p>
    </div>
  );
}
```

- [ ] **Step 5: Create `src/components/CheckpointCard.tsx`**

```tsx
import { LatencyChart } from "./LatencyChart";
import { UptimeBars } from "./UptimeBars";
import type { DayUptime, LatencyPoint } from "@/lib/queries";

export interface CheckpointView {
  name: string;
  status: "up" | "down";
  days: DayUptime[];
  latency: LatencyPoint[];
}

export function CheckpointCard({
  checkpoint,
  sinceMs,
  untilMs,
}: {
  checkpoint: CheckpointView;
  sinceMs: number;
  untilMs: number;
}) {
  const up = checkpoint.status === "up";
  return (
    <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium">{checkpoint.name}</h2>
        <span
          className={`text-sm font-semibold ${up ? "text-emerald-600" : "text-red-600"}`}
        >
          {up ? "Operational" : "Down"}
        </span>
      </div>
      <UptimeBars days={checkpoint.days} />
      <div className="mt-4">
        <LatencyChart
          points={checkpoint.latency}
          sinceMs={sinceMs}
          untilMs={untilMs}
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Replace `src/app/page.tsx`**

```tsx
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import {
  CheckpointCard,
  type CheckpointView,
} from "@/components/CheckpointCard";
import { StatusBanner } from "@/components/StatusBanner";
import { findSiteByHost, getConfig } from "@/lib/config";
import { getDb, getState } from "@/lib/db";
import { dailyUptime, latencySeries } from "@/lib/queries";
import { overallStatus } from "@/lib/state";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function StatusPage() {
  const host = (await headers()).get("host");
  const site = findSiteByHost(getConfig(), host);
  if (!site) notFound();

  const db = getDb();
  const now = Date.now();
  const sinceMs = now - DAY_MS;

  const checkpoints: CheckpointView[] = site.checkpoints.map((cp) => ({
    name: cp.name,
    status: getState(db, site.name, cp.name)?.status ?? "up",
    days: dailyUptime(db, site.name, cp.name, 90, now),
    latency: latencySeries(db, site.name, cp.name, sinceMs, now),
  }));

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <AutoRefresh />
      <h1 className="mb-6 text-2xl font-bold">{site.name} status</h1>
      <StatusBanner
        status={overallStatus(checkpoints.map((cp) => cp.status))}
      />
      <div className="mt-6 flex flex-col gap-4">
        {checkpoints.map((cp) => (
          <CheckpointCard
            key={cp.name}
            checkpoint={cp}
            sinceMs={sinceMs}
            untilMs={now}
          />
        ))}
      </div>
      <p className="mt-8 text-xs text-neutral-400">
        Updated {new Date(now).toUTCString()} · refreshes automatically
      </p>
    </main>
  );
}
```

- [ ] **Step 7: Create `src/app/not-found.tsx` and set the layout title**

`src/app/not-found.tsx`:

```tsx
export default function NotFound() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold">Not found</h1>
      <p className="mt-2 text-neutral-500">
        No status page is configured for this hostname.
      </p>
    </main>
  );
}
```

In `src/app/layout.tsx`, set the metadata to:

```ts
export const metadata: Metadata = {
  title: "Status",
  description: "Service status and uptime",
};
```

Keep the rest of the scaffold layout (fonts, globals.css import) as-is.

- [ ] **Step 8: Verify in the dev server**

```bash
pnpm dev &
sleep 8
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: status.webhooks.cc' http://localhost:3000/   # Expected: 200
curl -s -H 'Host: status.webhooks.cc' http://localhost:3000/ | grep -o 'webhooks.cc status'     # Expected: webhooks.cc status
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: unknown.example.com' http://localhost:3000/  # Expected: 404
kill %1
```

Also open http://localhost:3000 with a hosts-file entry or browser dev tools if you want a visual check — bars render gray/green with only minutes of data, which is expected.

- [ ] **Step 9: Lint, format, build, commit**

```bash
pnpm lint && pnpm format:check && pnpm test && pnpm build
git add src/app src/components
git commit -m "feat: per-hostname status page with uptime bars and latency chart"
```

---

### Task 10: Docker, Compose, and deployment docs

**Files:**

- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `README.md`

**Interfaces:**

- Consumes: the standalone Next build (Task 1 config), `CONFIG_PATH`/`DB_PATH` env vars (Tasks 2–3), `SMTP_PASS`.
- Produces: a deployable container listening on `:3000` with `/data` volume for config + database.

- [ ] **Step 1: Create `Dockerfile`**

Use Debian (not Alpine) so better-sqlite3's prebuilt glibc binaries work without a compiler:

```dockerfile
FROM node:22-bookworm-slim AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CONFIG_PATH=/data/config.yaml \
    DB_PATH=/data/status.db
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 2: Create `.dockerignore`**

```
node_modules
.next
.git
data
.env
*.db
docs
```

- [ ] **Step 3: Create `docker-compose.yml`**

```yaml
services:
  status-page:
    build: .
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      - SMTP_PASS=${SMTP_PASS}
    volumes:
      - ./data:/data
```

(Compose reads `SMTP_PASS` from the `.env` file next to it. The port binds to localhost only — Caddy is the public entry point.)

- [ ] **Step 4: Write `README.md`**

````markdown
# status-page

Self-hosted status page for multiple sites. One Next.js app + SQLite; an embedded
checker hits every configured checkpoint on an interval, records uptime and latency,
and emails on state changes. Each site is served on its own hostname.

## Configuration

Sites, checkpoints, and SMTP settings live in `config.yaml` (see the file in this
repo for the format). The SMTP password is read from the `SMTP_PASS` environment
variable — locally from the gitignored `.env` file.

- A checkpoint passes on a 2xx response (or exactly `expectStatus` if set).
- A checkpoint is marked down after 2 consecutive failures and up on the first success.
- One email per transition (down / recovered).

## Development

```bash
pnpm install
pnpm dev        # http://localhost:3000 — send a Host header to select a site:
                # curl -H 'Host: status.webhooks.cc' http://localhost:3000/
pnpm test
pnpm lint
```

## Deployment (VPS with Caddy)

1. On the VPS, clone the repo and create the data directory:

   ```bash
   mkdir -p data
   cp config.yaml data/config.yaml     # edit as needed on the server
   echo 'SMTP_PASS=...' > .env
   docker compose up -d --build
   ```

   The container listens on `127.0.0.1:3000` and keeps its config and SQLite
   database in `./data`. After editing `data/config.yaml`, restart:
   `docker compose restart`.

2. Add one block per site to your Caddyfile (Caddy terminates TLS and routes by
   hostname; the app picks the site from the `Host` header):

   ```
   status.webhooks.cc {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Reload Caddy: `sudo systemctl reload caddy` (or `caddy reload`).

3. Point DNS for each `status.<domain>` at the VPS.

## Adding a site or checkpoint

Edit `data/config.yaml` (add the site with its `host` and checkpoints), restart the
container, then add the matching Caddyfile block and DNS record.
````

- [ ] **Step 5: Verify the production build in Docker** (skip gracefully if Docker isn't available locally — then verify `pnpm build` output contains `.next/standalone/server.js` instead):

```bash
mkdir -p data && cp config.yaml data/config.yaml
docker compose up -d --build
sleep 10
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: status.webhooks.cc' http://127.0.0.1:3000/   # Expected: 200
docker compose logs | grep scheduler   # Expected: "[scheduler] started" exactly once
docker compose down
```

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml README.md
git commit -m "feat: docker deployment with compose and caddy docs"
```
