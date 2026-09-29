import type { MonitorConfig } from "./config";

/** Everything one HTTP check needs to know. */
export interface CheckSpec {
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
  timeoutMs?: number;
}

export interface CheckOutcome {
  ok: boolean;
  statusCode: number | null;
  /** Time to the response headers. */
  latencyMs: number;
  error: string | null;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
/** Bodies are read up to this much when a keyword is set. */
const MAX_BODY_BYTES = 1024 * 1024;

/** The check a monitor's configuration describes. */
export function monitorSpec(cp: MonitorConfig): CheckSpec {
  return {
    url: cp.url,
    method: cp.method,
    headers: cp.headers ?? {},
    body: cp.body ?? null,
    expectStatus: cp.expectStatus ?? null,
    keyword: cp.keyword ?? null,
    keywordMode: cp.keywordMode,
  };
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

export async function runCheck(spec: CheckSpec): Promise<CheckOutcome> {
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
