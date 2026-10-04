import { spawn } from "node:child_process";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  DEFAULT_CERTIFICATE_WARN_DAYS,
  DEFAULT_DOMAIN_WARN_DAYS,
  DEFAULT_TIMEOUT_MS,
  type MonitorConfig,
} from "./config";
import {
  lookupAll,
  raceConnect,
  racingConnector,
  since,
  undiciAgent,
  type Address,
  type ConnectTiming,
  type Raced,
} from "./connect";

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

/**
 * Where a check's time went, in ms. Each part is null where the check has
 * no such step (no lookup for an IP address, no TLS over plain HTTP) or
 * did not get that far. A check across redirects to other hosts adds up
 * the lookups and connections it made.
 */
export interface CheckTiming {
  /** Looking the host up. */
  dnsMs: number | null;
  /** Opening the TCP connection, the race between addresses included. */
  connectMs: number | null;
  /** The TLS handshake. */
  tlsMs: number | null;
  /** http: the rest, until the response headers. */
  firstByteMs: number | null;
}

export interface CheckOutcome {
  ok: boolean;
  statusCode: number | null;
  /** Time to the response headers, the connection, or the answer. */
  latencyMs: number;
  error: string | null;
  /** certificate and domain: when it expires, whenever it was read. */
  expiresAt?: number | null;
  /** http, tcp and certificate. The other kinds have no steps to tell apart. */
  timing?: CheckTiming | null;
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

/** The code on the error behind a failed fetch, when it has one. */
function causeCode(err: unknown): unknown {
  const cause = (err as { cause?: unknown } | null)?.cause;
  return cause instanceof Error
    ? (cause as { code?: unknown }).code
    : undefined;
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
  // Connections of its own, timed step by step and closed after. Shared
  // with other checks, a connection would carry one check's lookup and
  // handshake into another's reading, or leave a reading with none.
  const phases: ConnectTiming = { dnsMs: null, connectMs: null, tlsMs: null };
  const agent = undiciAgent({ connect: racingConnector(phases, timeoutMs) });
  const start = performance.now();
  /**
   * The outcome with where its time went: the wait for the headers is
   * whatever the lookups, connections and handshakes did not take.
   */
  const timed = (outcome: CheckOutcome, answered: boolean): CheckOutcome => {
    if (agent === null) return outcome;
    const before =
      (phases.dnsMs ?? 0) + (phases.connectMs ?? 0) + (phases.tlsMs ?? 0);
    return {
      ...outcome,
      timing: {
        ...phases,
        firstByteMs: answered ? Math.max(0, outcome.latencyMs - before) : null,
      },
    };
  };
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
      ...(agent ? { dispatcher: agent } : {}),
    } as RequestInit);
    const latencyMs = since(start);
    const statusOk =
      expectStatus !== undefined
        ? res.status === expectStatus
        : res.status >= 200 && res.status < 300;
    if (!statusOk) {
      void res.body?.cancel().catch(() => {});
      return timed(
        {
          ok: false,
          statusCode: res.status,
          latencyMs,
          error: `unexpected status ${res.status}`,
        },
        true,
      );
    }
    if (keyword === null) {
      void res.body?.cancel().catch(() => {});
      return timed(
        { ok: true, statusCode: res.status, latencyMs, error: null },
        true,
      );
    }
    const found = (await readBody(res)).includes(keyword);
    const wantFound = (spec.keywordMode ?? "present") === "present";
    return timed(
      found === wantFound
        ? { ok: true, statusCode: res.status, latencyMs, error: null }
        : {
            ok: false,
            statusCode: res.status,
            latencyMs,
            error: wantFound ? "keyword missing" : "keyword present",
          },
      true,
    );
  } catch (err) {
    const latencyMs = since(start);
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        causeCode(err) === "ETIMEDOUT");
    const message = isTimeout ? "timeout" : describeFailure(err);
    return timed(
      { ok: false, statusCode: null, latencyMs, error: message },
      false,
    );
  } finally {
    // Closes what the check opened, a connection still racing included.
    void agent?.destroy().catch(() => {});
  }
}

const failed = (start: number, error: string): CheckOutcome => ({
  ok: false,
  statusCode: null,
  latencyMs: since(start),
  error,
});

/** A reading that got no further than the lookup. */
const lookedUp = (dnsMs: number | null): CheckTiming => ({
  dnsMs,
  connectMs: null,
  tlsMs: null,
  firstByteMs: null,
});

/** A connection, or how far the attempt got and why it stopped. */
type Opened =
  | { won: Raced; dnsMs: number | null }
  | { error: string; dnsMs: number | null };

/**
 * Looks a host up and races a connection to its addresses, within
 * `timeoutMs` of `start`. Running out of time is "timeout"; any other
 * failure is the lookup's or the socket's code.
 */
async function open(
  host: string,
  port: number,
  timeoutMs: number,
  start: number,
): Promise<Opened> {
  const literal = isIP(host.replace(/^\[|\]$/g, "")) !== 0;
  let addresses: Address[];
  try {
    addresses = await lookupAll(host, timeoutMs);
  } catch (err) {
    const code = errorCode(err);
    return code === "ETIMEDOUT"
      ? { error: "timeout", dnsMs: null }
      : { error: code, dnsMs: since(start) };
  }
  const dnsMs = literal ? null : since(start);
  try {
    const won = await raceConnect(addresses, port, {
      timeoutMs: Math.max(1, timeoutMs - since(start)),
    });
    return { won, dnsMs };
  } catch (err) {
    const code = errorCode(err);
    return { error: code === "ETIMEDOUT" ? "timeout" : code, dnsMs };
  }
}

/**
 * Opens a TCP connection and closes it again. Passes when the connection
 * is accepted in time.
 */
async function tcpCheck(spec: CheckSpec): Promise<CheckOutcome> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const port = spec.port ?? 0;
  if (!port)
    return { ok: false, statusCode: null, latencyMs: 0, error: "no port" };
  const start = performance.now();
  const opened = await open(spec.url, port, timeoutMs, start);
  if ("error" in opened)
    return { ...failed(start, opened.error), timing: lookedUp(opened.dnsMs) };
  opened.won.socket.destroy();
  return {
    ok: true,
    statusCode: null,
    latencyMs: since(start),
    error: null,
    timing: { ...lookedUp(opened.dnsMs), connectMs: opened.won.connectMs },
  };
}

/**
 * Asks the resolver for one record type. Passes when at least one answer
 * comes back, and when an expected value is set, when one answer has it.
 */
async function dnsCheck(spec: CheckSpec): Promise<CheckOutcome> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const type = (spec.dnsType ?? "A").toUpperCase();
  const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
  const start = performance.now();
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
    const latencyMs = since(start);
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
  const start = performance.now();
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
      const elapsed = since(start);
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
async function certificateCheck(spec: CheckSpec): Promise<CheckOutcome> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const port = spec.port ?? 443;
  const warnDays = spec.warnDays ?? DEFAULT_CERTIFICATE_WARN_DAYS;
  const host = spec.url.replace(/^\[|\]$/g, "");
  const start = performance.now();
  const opened = await open(host, port, timeoutMs, start);
  if ("error" in opened)
    return { ...failed(start, opened.error), timing: lookedUp(opened.dnsMs) };
  const { won, dnsMs } = opened;
  const tlsStart = performance.now();
  return new Promise((resolve) => {
    let done = false;
    /** `tlsMs` is null when the handshake did not finish. */
    const finish = (outcome: CheckOutcome, tlsMs: number | null) => {
      if (done) return;
      done = true;
      socket.destroy();
      won.socket.destroy();
      resolve({
        ...outcome,
        timing: { ...lookedUp(dnsMs), connectMs: won.connectMs, tlsMs },
      });
    };
    // Verification is not switched off: the socket still checks the chain
    // and the hostname and reports the result in `authorized`. Rejecting
    // would end the handshake with a bare socket error; reading the verdict
    // instead lets the check say why the certificate is bad.
    const socket = tlsConnect({
      socket: won.socket,
      host,
      // A name is sent; an IP address has none to send.
      ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: false,
    });
    socket.setTimeout(Math.max(1, timeoutMs - since(start)), () =>
      finish(failed(start, "timeout"), null),
    );
    socket.once("error", (err) => finish(failed(start, errorCode(err)), null));
    socket.once("secureConnect", () => {
      const latencyMs = since(start);
      const tlsMs = since(tlsStart);
      // The date is read whether or not the certificate is trusted, so an
      // expired one still says when it expired.
      const validTo = Date.parse(socket.getPeerCertificate()?.valid_to ?? "");
      if (!socket.authorized) {
        const reason: unknown = socket.authorizationError;
        return finish(
          {
            ok: false,
            statusCode: null,
            latencyMs,
            error: `certificate invalid (${
              reason instanceof Error ? errorCode(reason) : String(reason)
            })`,
            expiresAt: Number.isNaN(validTo) ? null : validTo,
          },
          tlsMs,
        );
      }
      finish(
        Number.isNaN(validTo)
          ? {
              ok: false,
              statusCode: null,
              latencyMs,
              error: "certificate invalid (no expiry date)",
            }
          : expiryOutcome("certificate", validTo, warnDays, null, latencyMs),
        tlsMs,
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
  const start = performance.now();
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
    const latencyMs = since(start);
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
