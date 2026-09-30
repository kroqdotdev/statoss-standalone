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
// A brake on guessing: ten wrong passwords a minute from one address, and a
// hundred a minute on one site from all of them. One visitor guessing does
// not lock everyone else out; many together still cannot guess quickly.

const WINDOW_MS = 60_000;
export const MAX_FAILURES = 10;
export const MAX_SITE_FAILURES = 100;

const globals = globalThis as {
  __statusUnlockFailures?: Map<string, number[]>;
};

function failures(): Map<string, number[]> {
  globals.__statusUnlockFailures ??= new Map();
  return globals.__statusUnlockFailures;
}

function recent(key: string, now: number): number[] {
  const list = (failures().get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (list.length === 0) failures().delete(key);
  else failures().set(key, list);
  return list;
}

/**
 * Who is guessing, as far as the request says: the first address the
 * reverse proxy forwarded, or one bucket for requests that came direct.
 */
export function clientOf(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "direct";
}

/** Whether this address, or the site as a whole, has had too many wrong passwords. */
export function tooManyFailures(
  host: string,
  client: string,
  now: number,
): boolean {
  return (
    recent(`${host}\0${client}`, now).length >= MAX_FAILURES ||
    recent(host, now).length >= MAX_SITE_FAILURES
  );
}

export function noteFailure(host: string, client: string, now: number): void {
  for (const key of [`${host}\0${client}`, host]) {
    const list = failures().get(key) ?? [];
    list.push(now);
    failures().set(key, list);
  }
}

/** For tests. */
export function clearFailures(): void {
  failures().clear();
}
