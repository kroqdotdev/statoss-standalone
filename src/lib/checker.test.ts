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
