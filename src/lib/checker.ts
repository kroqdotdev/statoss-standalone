export interface CheckOutcome {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
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
    // Cancel response body to release socket back to keep-alive pool
    void res.body?.cancel().catch(() => {});
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
    const message = isTimeout ? "timeout" : describeFailure(err);
    return { ok: false, statusCode: null, latencyMs, error: message };
  }
}
