import { execFileSync } from "node:child_process";
import { promises as dnsPromises } from "node:dns";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  expiryOutcome,
  monitorSpec,
  runCheck,
  type CheckOutcome,
} from "./checker";
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
      type: "http",
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
      type: "http",
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

describe("expiryOutcome", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 8, 30);

  it("passes while the date is further off than the warning window", () => {
    expect(
      expiryOutcome("certificate", now + 30 * DAY, 14, null, 40, now),
    ).toEqual({
      ok: true,
      statusCode: null,
      latencyMs: 40,
      error: null,
      expiresAt: now + 30 * DAY,
    });
  });

  it("fails inside the window and after the date, and keeps the date", () => {
    expect(
      expiryOutcome("certificate", now + 9 * DAY + 5, 14, null, 40, now),
    ).toMatchObject({ ok: false, error: "certificate expires in 9 days" });
    expect(expiryOutcome("domain", now - DAY, 30, 200, 40, now)).toMatchObject({
      ok: false,
      error: "domain expired",
      expiresAt: now - DAY,
    });
  });
});

describe("tcp checks", () => {
  it("passes on an open port and fails on a closed one", async () => {
    const server = createTcpServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const open = await runCheck({ type: "tcp", url: "127.0.0.1", port });
    expect(open).toMatchObject({ ok: true, error: null });
    await new Promise((resolve) => server.close(resolve));
    const closed = await runCheck({ type: "tcp", url: "127.0.0.1", port });
    expect(closed).toMatchObject({ ok: false, error: "ECONNREFUSED" });
  });
});

/** The steps of a timed outcome added up, nulls as nothing. */
function stepsSum(outcome: CheckOutcome): number {
  const t = outcome.timing;
  return (
    (t?.dnsMs ?? 0) +
    (t?.connectMs ?? 0) +
    (t?.tlsMs ?? 0) +
    (t?.firstByteMs ?? 0)
  );
}

/** Listens on loopback and gives the port. */
async function listen(server: {
  listen: (port: number, host: string, cb: () => void) => unknown;
  address: () => AddressInfo | string | null;
}): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("where a check's time goes", () => {
  it("splits an HTTP reading into the connection and the wait for the headers", async () => {
    const outcome = await runCheck({ url: `${base}/slow` });
    expect(outcome.ok).toBe(true);
    // An IP address needs no lookup, and plain HTTP has no handshake.
    expect(outcome.timing).toMatchObject({ dnsMs: 0, tlsMs: null });
    expect(outcome.timing?.connectMs).toBeGreaterThanOrEqual(0);
    expect(outcome.timing?.firstByteMs).toBeGreaterThanOrEqual(490);
    expect(stepsSum(outcome)).toBe(outcome.latencyMs);
  });

  it("times the lookup of a name", async () => {
    const port = (server.address() as AddressInfo).port;
    const outcome = await runCheck({ url: `http://localhost:${port}/ok` });
    expect(outcome.ok).toBe(true);
    expect(outcome.timing?.dnsMs).toBeGreaterThanOrEqual(0);
    expect(outcome.timing?.connectMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps each check's steps its own when many run at once", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        runCheck({ url: `${base}/${i % 2 ? "slow" : "ok"}` }),
      ),
    );
    outcomes.forEach((outcome, i) => {
      expect(outcome.ok).toBe(true);
      expect(stepsSum(outcome)).toBe(outcome.latencyMs);
      if (i % 2)
        expect(outcome.timing?.firstByteMs).toBeGreaterThanOrEqual(490);
      else expect(outcome.timing?.firstByteMs).toBeLessThan(400);
    });
  });

  it("counts a server slow to take up an accepted connection as waiting for the first byte", async () => {
    // The system accepts the connection at once; the server reads it only
    // later, so the wait shows as time to the first byte, not connecting.
    const slow = createTcpServer({ pauseOnConnect: true }, (socket) => {
      setTimeout(() => {
        socket.resume();
        socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
      }, 150);
    });
    const port = await listen(slow);
    try {
      const outcome = await runCheck({ url: `http://127.0.0.1:${port}/` });
      expect(outcome.ok).toBe(true);
      expect(outcome.timing?.firstByteMs).toBeGreaterThanOrEqual(140);
      expect(outcome.timing?.connectMs).toBeLessThan(100);
    } finally {
      slow.close();
    }
  });

  it("says how far a failed check got", async () => {
    // Accepts the connection and never answers.
    const silent = createTcpServer(() => {});
    const port = await listen(silent);
    try {
      const unanswered = await runCheck({
        url: `http://127.0.0.1:${port}/`,
        timeoutMs: 300,
      });
      expect(unanswered.error).toBe("timeout");
      expect(unanswered.timing?.connectMs).toBeGreaterThanOrEqual(0);
      expect(unanswered.timing?.firstByteMs).toBeNull();
    } finally {
      silent.close();
    }
    const refused = await runCheck({
      url: `http://127.0.0.1:${port}/`,
      timeoutMs: 1000,
    });
    expect(refused.error).toBe("fetch failed (ECONNREFUSED)");
    expect(refused.timing?.connectMs).toBeNull();
  });

  it("keeps the first byte when the body stalls after the headers", async () => {
    const stalling = createServer((_req, res) => {
      res.writeHead(200);
      res.write("partial");
    });
    const port = await listen(stalling);
    try {
      const outcome = await runCheck({
        url: `http://127.0.0.1:${port}/`,
        keyword: "never sent",
        timeoutMs: 300,
      });
      expect(outcome.error).toBe("timeout");
      expect(outcome.timing?.connectMs).toBeGreaterThanOrEqual(0);
      expect(outcome.timing?.firstByteMs).toBeGreaterThanOrEqual(0);
      expect(outcome.timing?.firstByteMs).toBeLessThan(250);
    } finally {
      stalling.closeAllConnections();
      stalling.close();
    }
  });

  it("counts a lookup that never answers as where the time went", async () => {
    const lookup = vi
      .spyOn(dnsPromises, "lookup")
      .mockImplementation(() => new Promise(() => {}));
    try {
      const http = await runCheck({
        url: "http://hangs.example/",
        timeoutMs: 300,
      });
      expect(http.error).toBe("timeout");
      expect(http.timing?.dnsMs).toBeGreaterThanOrEqual(250);
      expect(http.timing).toMatchObject({
        connectMs: null,
        firstByteMs: null,
      });
      const tcp = await runCheck({
        type: "tcp",
        url: "hangs.example",
        port: 80,
        timeoutMs: 300,
      });
      expect(tcp.error).toBe("timeout");
      expect(tcp.timing?.dnsMs).toBeGreaterThanOrEqual(250);
      expect(tcp.timing?.connectMs).toBeNull();
    } finally {
      lookup.mockRestore();
    }
  });

  it("times a TCP connection, and a lookup that finds nothing", async () => {
    const port = (server.address() as AddressInfo).port;
    const open = await runCheck({ type: "tcp", url: "localhost", port });
    expect(open.ok).toBe(true);
    expect(open.timing).toMatchObject({ tlsMs: null, firstByteMs: null });
    expect(open.timing?.dnsMs).toBeGreaterThanOrEqual(0);
    expect(open.timing?.connectMs).toBeGreaterThanOrEqual(0);
    const missing = await runCheck({
      type: "tcp",
      url: "no-such-host.invalid",
      port,
    });
    expect(missing.error).toMatch(/ENOTFOUND|EAI_AGAIN/);
    expect(missing.timing?.dnsMs).toBeGreaterThanOrEqual(0);
    expect(missing.timing?.connectMs).toBeNull();
  });

  it("gives no steps for a check without a connection of its own", async () => {
    const dns = await runCheck({ type: "dns", url: "localhost" });
    expect(dns.timing ?? null).toBeNull();
  });
});

/**
 * Trusts a certificate for the rest of the process, and gives back what
 * undoes it. Node 22 may lack the call for it; there, verification is
 * switched off for the while instead.
 */
function trust(cert: Buffer): () => void {
  const store = tls as typeof tls & {
    getCACertificates?: (type: string) => string[];
    setDefaultCACertificates?: (certs: string[]) => void;
  };
  if (store.getCACertificates && store.setDefaultCACertificates) {
    const before = store.getCACertificates("default");
    store.setDefaultCACertificates([...before, cert.toString()]);
    return () => store.setDefaultCACertificates?.(before);
  }
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return () => delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}

describe("timing over TLS", () => {
  let dir = "";
  let key: Buffer | null = null;
  let cert: Buffer | null = null;

  beforeAll(() => {
    try {
      dir = mkdtempSync(join(tmpdir(), "statoss-cert-"));
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-days",
          "2",
          "-nodes",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1",
          "-keyout",
          join(dir, "key.pem"),
          "-out",
          join(dir, "cert.pem"),
        ],
        { stdio: "ignore" },
      );
      key = readFileSync(join(dir, "key.pem"));
      cert = readFileSync(join(dir, "cert.pem"));
    } catch {
      // No openssl to make a certificate with: the tests below skip.
    }
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("times the handshake of a certificate check", async (context) => {
    if (!key || !cert) return context.skip();
    const server = tls.createServer({ key, cert }, (socket) => socket.end());
    const port = await listen(server);
    try {
      const outcome = await runCheck({
        type: "certificate",
        url: "127.0.0.1",
        port,
      });
      // Self-signed, so not trusted; the handshake still happened.
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/certificate invalid/);
      expect(outcome.timing).toMatchObject({ dnsMs: 0, firstByteMs: null });
      expect(outcome.timing?.connectMs).toBeGreaterThanOrEqual(0);
      expect(outcome.timing?.tlsMs).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
    }
  });

  it("splits an HTTPS reading into the connection, the handshake and the first byte", async (context) => {
    if (!key || !cert) return context.skip();
    const https = createHttpsServer({ key, cert }, (_req, res) =>
      setTimeout(() => res.end("ok"), 100),
    );
    const port = await listen(https);
    const url = `https://localhost:${port}/`;
    let untrust: (() => void) | null = null;
    try {
      // An untrusted certificate fails the handshake: no TLS time.
      const untrusted = await runCheck({ url });
      expect(untrusted.ok).toBe(false);
      expect(untrusted.error).toMatch(/SELF_SIGNED/);
      expect(untrusted.timing?.connectMs).toBeGreaterThanOrEqual(0);
      expect(untrusted.timing?.tlsMs).toBeNull();
      // Trusted, the handshake has its own time.
      untrust = trust(cert);
      const trusted = await runCheck({ url });
      expect(trusted.ok).toBe(true);
      expect(trusted.timing?.dnsMs).toBeGreaterThanOrEqual(0);
      expect(trusted.timing?.tlsMs).toBeGreaterThanOrEqual(0);
      expect(trusted.timing?.firstByteMs).toBeGreaterThanOrEqual(90);
      expect(stepsSum(trusted)).toBe(trusted.latencyMs);
    } finally {
      untrust?.();
      https.close();
    }
  });
});
