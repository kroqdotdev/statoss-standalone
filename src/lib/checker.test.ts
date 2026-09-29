import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monitorSpec, runCheck } from "./checker";
import { parseConfig } from "./config";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/ok") {
        res.writeHead(200).end("ok");
      } else if (req.url === "/err") {
        res.writeHead(500).end("boom");
      } else if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/ok" }).end();
      } else if (req.url === "/slow") {
        setTimeout(() => res.writeHead(200).end("late"), 500);
      } else if (req.url === "/health") {
        res.writeHead(200).end('{"status":"green","queue":0}');
      } else if (req.url === "/echo") {
        res
          .writeHead(200)
          .end(`${req.method} ${req.headers["x-token"] ?? "-"} ${body || "-"}`);
      } else {
        res.writeHead(404).end();
      }
    });
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
    const outcome = await runCheck({ url: `${base}/ok` });
    expect(outcome.ok).toBe(true);
    expect(outcome.statusCode).toBe(200);
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    expect(outcome.error).toBeNull();
  });

  it("fails on non-2xx with an error message", async () => {
    const outcome = await runCheck({ url: `${base}/err` });
    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBe(500);
    expect(outcome.error).toMatch(/500/);
  });

  it("passes when expectStatus matches a non-2xx", async () => {
    const outcome = await runCheck({ url: `${base}/err`, expectStatus: 500 });
    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeNull();
  });

  it("follows redirects by default", async () => {
    const outcome = await runCheck({ url: `${base}/redirect` });
    expect(outcome.ok).toBe(true);
    expect(outcome.statusCode).toBe(200);
  });

  it("asserts the redirect itself when expectStatus is 3xx", async () => {
    const outcome = await runCheck({
      url: `${base}/redirect`,
      expectStatus: 302,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.statusCode).toBe(302);
  });

  it("fails with a timeout error when the response is too slow", async () => {
    const outcome = await runCheck({ url: `${base}/slow`, timeoutMs: 100 });
    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBeNull();
    expect(outcome.error).toBe("timeout");
  });

  it("fails with an error on connection refused", async () => {
    const outcome = await runCheck({
      url: "http://127.0.0.1:1/ok",
      timeoutMs: 1000,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBeNull();
    expect(outcome.error).toBeTruthy();
  });

  it("sends the method, headers and body", async () => {
    const outcome = await runCheck({
      url: `${base}/echo`,
      method: "POST",
      headers: { "x-token": "abc" },
      body: "hello",
      keyword: "POST abc hello",
    });
    expect(outcome.ok).toBe(true);
  });

  it("drops the body on GET", async () => {
    const outcome = await runCheck({
      url: `${base}/echo`,
      body: "hello",
      keyword: "GET - -",
    });
    expect(outcome.ok).toBe(true);
  });

  it("fails when the keyword is missing", async () => {
    const outcome = await runCheck({
      url: `${base}/health`,
      keyword: '"status":"red"',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBe(200);
    expect(outcome.error).toBe("keyword missing");
  });

  it("fails when a keyword that must be absent is present", async () => {
    const outcome = await runCheck({
      url: `${base}/health`,
      keyword: "green",
      keywordMode: "absent",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("keyword present");
  });

  it("passes when the keyword is present", async () => {
    const outcome = await runCheck({
      url: `${base}/health`,
      keyword: "green",
    });
    expect(outcome.ok).toBe(true);
  });
});

describe("monitorSpec", () => {
  it("carries every request option from the config", () => {
    const config = parseConfig(`
sites:
  - name: s
    host: s.example.com
    monitors:
      - name: API
        url: https://api.example.com/health
        method: POST
        headers:
          Authorization: Bearer x
        body: '{"ping":true}'
        expectStatus: 201
        keyword: pong
        keywordMode: absent
        slowThresholdMs: 800
`);
    expect(monitorSpec(config.sites[0].monitors[0])).toEqual({
      url: "https://api.example.com/health",
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: '{"ping":true}',
      expectStatus: 201,
      keyword: "pong",
      keywordMode: "absent",
    });
  });

  it("defaults to a plain GET", () => {
    const config = parseConfig(`
sites:
  - name: s
    host: s.example.com
    monitors:
      - name: Home
        url: https://example.com
`);
    expect(monitorSpec(config.sites[0].monitors[0])).toEqual({
      url: "https://example.com",
      method: "GET",
      headers: {},
      body: null,
      expectStatus: null,
      keyword: null,
      keywordMode: "present",
    });
  });
});
