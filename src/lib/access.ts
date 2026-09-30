import { createHmac, timingSafeEqual } from "node:crypto";
import type { SiteConfig } from "./config";

/**
 * Password pages. A site with a `password` shows a form instead of the
 * page; the right password sets a cookie that opens the page and its
 * endpoints on that browser for 30 days. The cookie holds no password: it
 * is a keyed hash of the site's host under the password, so changing the
 * password locks every browser out again. Embeds (a badge in a README, the
 * widget on another site) carry no cookie and use `?key=<embedKey>`.
 */

export const UNLOCK_COOKIE = "statoss_unlock";
export const UNLOCK_DAYS = 30;

type Locked = Pick<SiteConfig, "host" | "password" | "embedKey">;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What the unlock cookie holds for a site, or null when it has no password. */
export function unlockToken(site: Locked): string | null {
  if (!site.password) return null;
  return createHmac("sha256", site.password)
    .update(`statoss-unlock:${site.host.toLowerCase()}`)
    .digest("hex");
}

export function passwordMatches(site: Locked, given: string): boolean {
  return site.password !== undefined && same(site.password, given);
}

/**
 * Whether a request may see the site: it has no password, the cookie is
 * right, or (for the endpoints) the key is.
 */
export function mayView(
  site: Locked,
  cookie: string | undefined,
  key?: string | null,
): boolean {
  const token = unlockToken(site);
  if (token === null) return true;
  if (cookie !== undefined && same(cookie, token)) return true;
  return (
    typeof key === "string" &&
    site.embedKey !== undefined &&
    same(key, site.embedKey)
  );
}

// ---------------------------------------------------------------------------
// A brake on guessing: a handful of wrong passwords a minute per site.

const WINDOW_MS = 60_000;
export const MAX_FAILURES = 10;

const globals = globalThis as {
  __statusUnlockFailures?: Map<string, number[]>;
};

function failures(): Map<string, number[]> {
  globals.__statusUnlockFailures ??= new Map();
  return globals.__statusUnlockFailures;
}

/** Whether the site has had too many wrong passwords in the last minute. */
export function tooManyFailures(host: string, now: number): boolean {
  const recent = (failures().get(host) ?? []).filter(
    (at) => now - at < WINDOW_MS,
  );
  failures().set(host, recent);
  return recent.length >= MAX_FAILURES;
}

export function noteFailure(host: string, now: number): void {
  const list = failures().get(host) ?? [];
  list.push(now);
  failures().set(host, list);
}

/** For tests. */
export function clearFailures(): void {
  failures().clear();
}
