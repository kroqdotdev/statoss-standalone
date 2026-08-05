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
