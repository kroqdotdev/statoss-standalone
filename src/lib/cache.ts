import { getDataVersion } from "./data-version";

interface Entry<T> {
  version: number;
  value: T;
}

const globals = globalThis as { __statusCache?: Map<string, Entry<unknown>> };

function store(): Map<string, Entry<unknown>> {
  globals.__statusCache ??= new Map();
  return globals.__statusCache;
}

/**
 * Returns the cached value for `key` unless the data version has moved since
 * it was computed. One entry per key, so the cache stays bounded by the
 * number of distinct keys (sites x monitors x ranges).
 */
export function cached<T>(
  key: string,
  compute: () => T,
  version = getDataVersion(),
): T {
  const entry = store().get(key) as Entry<T> | undefined;
  if (entry !== undefined && entry.version === version) return entry.value;
  const value = compute();
  store().set(key, { version, value });
  return value;
}

interface TimedEntry<T> {
  until: number;
  tag: string;
  value: T;
}

/**
 * Like `cached`, but by the clock: the value is kept for `ttlMs`, or until
 * `tag` changes. The tag carries what the value depends on (a window's
 * end, a monitor's state), so a change there is seen at once. One entry
 * per key, like `cached`.
 */
export function cachedFor<T>(
  key: string,
  tag: string,
  ttlMs: number,
  compute: () => T,
  now = Date.now(),
): T {
  const entry = store().get(key) as TimedEntry<T> | undefined;
  if (
    entry !== undefined &&
    "until" in entry &&
    entry.until > now &&
    entry.tag === tag
  )
    return entry.value;
  const value = compute();
  store().set(key, {
    until: now + ttlMs,
    tag,
    value,
  } as unknown as Entry<unknown>);
  return value;
}

/** For tests. */
export function clearCache(): void {
  store().clear();
}
