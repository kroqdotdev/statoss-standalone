import { spawn } from "node:child_process";
import { promises as dns } from "node:dns";
import { createConnection } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  DEFAULT_CERTIFICATE_WARN_DAYS,
  DEFAULT_DOMAIN_WARN_DAYS,
  DEFAULT_TIMEOUT_MS,
  type MonitorConfig,
} from "./config";

export { DEFAULT_TIMEOUT_MS };

/** The kinds of check that go out over the network. */
export type RemoteCheckType =
  "http" | "tcp" | "dns" | "ping" | "certificate" | "domain";

/** Everything one check needs to know. */
export interface CheckSpec {
  /** Defaults to http. */
  type?: RemoteCheckType;
  /** The URL for http; the hostname or domain otherwise. */
  url: string;
  /** Defaults to GET. */
  method?: string;
  headers?: Record<string, string>;
  /** Sent as-is with methods that take one. */
  body?: string | null;
  /** Exact status to pass on. Undefined or null means any 2xx. */
  expectStatus?: number | null;
  /** Text the body must contain, or must not (keywordMode). */
  keyword?: string | null;
  keywordMode?: "present" | "absent";
  /** tcp and certificate. */
  port?: number | null;
  /** dns: A, AAAA, CNAME, MX, TXT or NS. */
  dnsType?: string | null;
  /** dns: text an answer must contain. */
  dnsExpect?: string | null;
  /** certificate and domain: fail this close to expiry. */
  warnDays?: number | null;
  timeoutMs?: number;
}

export interface CheckOutcome {
  ok: boolean;
  statusCode: number | null;
  /** Time to the response headers, the connection, or the answer. */
  latencyMs: number;
  error: string | null;
  /** certificate and domain: when it expires, whenever it was read. */
  expiresAt?: number | null;
}

/** Bodies are read up to this much when a keyword is set. */
const MAX_BODY_BYTES = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The check a monitor's configuration describes. Heartbeats have none. */
export function monitorSpec(cp: MonitorConfig): CheckSpec {
  switch (cp.type) {
    case "tcp":
      return { type: "tcp", url: cp.host ?? "", port: cp.port };
    case "dns":
      return {
        type: "dns",
        url: cp.host ?? "",
        dnsType: cp.record ?? "A",
        dnsExpect: cp.expect ?? null,
      };
    case "ping":
      return { type: "ping", url: cp.host ?? "" };
    case "certificate":
      return {
        type: "certificate",
        url: cp.host ?? "",
        port: cp.port ?? 443,
        warnDays: cp.warnDays ?? DEFAULT_CERTIFICATE_WARN_DAYS,
      };
    case "domain":
      return {
        type: "domain",
        url: cp.host ?? "",
        warnDays: cp.warnDays ?? DEFAULT_DOMAIN_WARN_DAYS,
      };
    default:
      return {
        type: "http",
        url: cp.url ?? "",
        method: cp.method,
        headers: cp.headers ?? {},
        body: cp.body ?? null,
        expectStatus: cp.expectStatus ?? null,
        keyword: cp.keyword ?? null,
        keywordMode: cp.keywordMode,
      };
  }
}

/**
 * Node's fetch reports network failures as a bare "fetch failed" and hides the
 * reason in `cause`. Append the cause's code so the page can say why.
 */
function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const code =
    cause instanceof Error
      ? ((cause as { code?: unknown }).code ?? cause.message)
      : undefined;
  return typeof code === "string" && code.length > 0
    ? `${err.message} (${code})`
    : err.message;
}

/** Reads at most MAX_BODY_BYTES of the response as text. */
async function readBody(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytes >= MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return text + decoder.decode();
}

/** The code on a socket or DNS error, or its message. */
function errorCode(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    return err.message;
  }
  return String(err);
}

export async function runCheck(spec: CheckSpec): Promise<CheckOutcome> {
  switch (spec.type ?? "http") {
    case "tcp":
      return tcpCheck(spec);
    case "dns":
      return dnsCheck(spec);
    case "ping":
      return pingCheck(spec);
    case "certificate":
      return certificateCheck(spec);
    case "domain":
      return domainCheck(spec);
    default:
      return httpCheck(spec);
  }
}

async function httpCheck(spec: CheckSpec): Promise<CheckOutcome> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = (spec.method ?? "GET").toUpperCase();
  const expectStatus = spec.expectStatus ?? undefined;
  const expectsRedirect =
    expectStatus !== undefined && expectStatus >= 300 && expectStatus < 400;
  const keyword = spec.keyword ? spec.keyword : null;
  const start = Date.now();
  try {
    const res = await fetch(spec.url, {
      method,
      headers: spec.headers ?? {},
      body:
        spec.body && method !== "GET" && method !== "HEAD"
          ? spec.body
          : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: expectsRedirect ? "manual" : "follow",
      cache: "no-store",
    });
    const latencyMs = Date.now() - start;
    const statusOk =
      expectStatus !== undefined
        ? res.status === expectStatus
        : res.status >= 200 && res.status < 300;
    if (!statusOk) {
      void res.body?.cancel().catch(() => {});
      return {
        ok: false,
        statusCode: res.status,
        latencyMs,
        error: `unexpected status ${res.status}`,
      };
    }
    if (keyword === null) {
      // Cancel the body to release the socket back to the keep-alive pool.
      void res.body?.cancel().catch(() => {});
      return { ok: true, statusCode: res.status, latencyMs, error: null };
    }
    const found = (await readBody(res)).includes(keyword);
    const wantFound = (spec.keywordMode ?? "present") === "present";
    if (found === wantFound)
      return { ok: true, statusCode: res.status, latencyMs, error: null };
    return {
      ok: false,
      statusCode: res.status,
      latencyMs,
      error: wantFound ? "keyword missing" : "keyword present",
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    const message = isTimeout ? "timeout" : describeFailure(err);
    return { ok: false, statusCode: null, latencyMs, error: message };
  }
}

const failed = (start: number, error: string): CheckOutcome => ({
  ok: false,
  statusCode: null,
  latencyMs: Date.now() - start,
  error,
});

/**
 * Opens a TCP connection and closes it again. Passes when the connection
 * is accepted in time.
 */
function tcpCheck(spec: CheckSpec): Promise<CheckOutcome> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const port = spec.port ?? 0;
  const start = Date.now();
  if (!port)
    return Promise.resolve({
      ok: false,
      statusCode: null,
      latencyMs: 0,
      error: "no port",
    });
  return new Promise((resolve) => {
    const socket = createConnection({ host: spec.url, port });
    let done = false;
    const finish = (outcome: CheckOutcome) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(timeoutMs, () => finish(failed(start, "timeout")));
    socket.once("connect", () =>
      finish({
        ok: true,
        statusCode: null,
        latencyMs: Date.now() - start,
        error: null,
      }),
    );
    socket.once("error", (err) => finish(failed(start, errorCode(err))));
  });
}

/**
 * Asks the resolver for one record type. Passes when at least one answer
 * comes back, and when an expected value is set, when one answer has it.
 */
async function dnsCheck(spec: CheckSpec): Promise<CheckOutcome> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const type = (spec.dnsType ?? "A").toUpperCase();
  const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
  const start = Date.now();
  try {
    let answers: string[];
    switch (type) {
      case "MX":
        answers = (await resolver.resolveMx(spec.url)).map((r) => r.exchange);
        break;
      case "TXT":
        answers = (await resolver.resolveTxt(spec.url)).map((r) => r.join(""));
        break;
      case "CNAME":
        answers = await resolver.resolveCname(spec.url);
        break;
      case "NS":
        answers = await resolver.resolveNs(spec.url);
        break;
      case "AAAA":
        answers = await resolver.resolve6(spec.url);
        break;
      default:
        answers = await resolver.resolve4(spec.url);
    }
    const latencyMs = Date.now() - start;
    if (answers.length === 0)
      return { ok: false, statusCode: null, latencyMs, error: "no records" };
    const expect = spec.dnsExpect ? spec.dnsExpect.trim().toLowerCase() : "";
    if (expect && !answers.some((a) => a.toLowerCase().includes(expect)))
      return {
        ok: false,
        statusCode: null,
        latencyMs,
        error: "expected record missing",
      };
    return { ok: true, statusCode: null, latencyMs, error: null };
  } catch (err) {
    const code = errorCode(err);
    return failed(
      start,
      code === "ETIMEOUT"
        ? "timeout"
        : code === "ENOTFOUND" || code === "ENODATA"
          ? "no records"
          : code,
    );
  }
}

/** Arguments for one echo request with a five-second wait, per platform. */
function pingArgs(host: string): string[] {
  if (process.platform === "darwin") return ["-c", "1", "-t", "5", host];
  if (process.platform === "win32") return ["-n", "1", "-w", "5000", host];
  return ["-c", "1", "-W", "5", host];
}

/**
 * One ICMP echo through the system's ping command, since Node cannot open
 * raw sockets itself. A box without ping reports that instead of an outage.
 */
function pingCheck(spec: CheckSpec): Promise<CheckOutcome> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (outcome: CheckOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const unavailable = (detail: string): CheckOutcome => ({
      ok: false,
      statusCode: null,
      latencyMs: 0,
      error: detail ? `ping unavailable (${detail})` : "ping unavailable",
    });
    let child;
    try {
      child = spawn("ping", pingArgs(spec.url), {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return finish(unavailable(errorCode(err)));
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(failed(start, "timeout"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.once("error", (err) => {
      clearTimeout(timer);
      const code = errorCode(err);
      finish(unavailable(code === "ENOENT" ? "" : code));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const elapsed = Date.now() - start;
      const match = /time[=<]\s*([\d.]+)\s*ms/i.exec(out);
      const latencyMs = match ? Math.round(Number(match[1])) : elapsed;
      if (code === 0)
        return finish({ ok: true, statusCode: null, latencyMs, error: null });
      // A ping this user may not run (no setuid, no capability, no ping
      // group) has no opinion, like a missing one.
      if (/operation not permitted|cap_net_raw/i.test(out))
        return finish(unavailable("not permitted"));
      finish({
        ok: false,
        statusCode: null,
        latencyMs: elapsed,
        error: /unknown host|not known|could not resolve/i.test(out)
          ? "no records"
          : "no reply",
      });
    });
  });
}

/**
 * A TLS handshake with the server, then a look at the certificate it sent:
 * it has to be valid for the hostname and not expire within `warnDays`.
 */
function certificateCheck(spec: CheckSpec): Promise<CheckOutcome> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const port = spec.port ?? 443;
  const warnDays = spec.warnDays ?? DEFAULT_CERTIFICATE_WARN_DAYS;
  const start = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome: CheckOutcome) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(outcome);
    };
    // Verification is not switched off: the socket still checks the chain
    // and the hostname and reports the result in `authorized`. Rejecting
    // would end the handshake with a bare socket error; reading the verdict
    // instead lets the check say why the certificate is bad.
    const socket = tlsConnect({
      host: spec.url,
      port,
      servername: spec.url,
      rejectUnauthorized: false,
    });
    socket.setTimeout(timeoutMs, () => finish(failed(start, "timeout")));
    socket.once("error", (err) => finish(failed(start, errorCode(err))));
    socket.once("secureConnect", () => {
      const latencyMs = Date.now() - start;
      if (!socket.authorized) {
        const reason: unknown = socket.authorizationError;
        return finish({
          ok: false,
          statusCode: null,
          latencyMs,
          error: `certificate invalid (${
            reason instanceof Error ? errorCode(reason) : String(reason)
          })`,
        });
      }
      const validTo = Date.parse(socket.getPeerCertificate().valid_to);
      finish(
        Number.isNaN(validTo)
          ? {
              ok: false,
              statusCode: null,
              latencyMs,
              error: "certificate invalid (no expiry date)",
            }
          : expiryOutcome("certificate", validTo, warnDays, null, latencyMs),
      );
    });
  });
}

/** Passes while the expiry date is at least `warnDays` away. */
export function expiryOutcome(
  what: "certificate" | "domain",
  expiresAt: number,
  warnDays: number,
  statusCode: number | null,
  latencyMs: number,
  now = Date.now(),
): CheckOutcome {
  const daysLeft = Math.floor((expiresAt - now) / DAY_MS);
  const error =
    daysLeft < 0
      ? `${what} expired`
      : daysLeft < warnDays
        ? `${what} expires in ${daysLeft} days`
        : null;
  return { ok: error === null, statusCode, latencyMs, error, expiresAt };
}

/**
 * Asks the registry through RDAP when the domain expires. Registries that
 * publish no expiry date pass, since the alternative is a false outage.
 */
async function domainCheck(spec: CheckSpec): Promise<CheckOutcome> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warnDays = spec.warnDays ?? DEFAULT_DOMAIN_WARN_DAYS;
  const start = Date.now();
  try {
    const res = await fetch(
      `https://rdap.org/domain/${encodeURIComponent(spec.url)}`,
      {
        // rdap.org answers 403 to a request with Node's default user agent.
        headers: {
          accept: "application/rdap+json, application/json",
          "user-agent":
            "statoss-standalone (+https://github.com/kroqdotdev/statoss-standalone)",
        },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      },
    );
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return {
        ok: false,
        statusCode: res.status,
        latencyMs,
        error:
          res.status === 404
            ? "domain not registered"
            : `registry answered ${res.status}`,
      };
    }
    const body = (await res.json()) as {
      events?: Array<{ eventAction?: unknown; eventDate?: unknown }>;
    };
    const events = Array.isArray(body?.events) ? body.events : [];
    const expiry = events.find((e) => e?.eventAction === "expiration");
    const expiresAt =
      typeof expiry?.eventDate === "string"
        ? Date.parse(expiry.eventDate)
        : NaN;
    if (Number.isNaN(expiresAt))
      return { ok: true, statusCode: res.status, latencyMs, error: null };
    return expiryOutcome("domain", expiresAt, warnDays, res.status, latencyMs);
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    return failed(start, isTimeout ? "timeout" : describeFailure(err));
  }
}
