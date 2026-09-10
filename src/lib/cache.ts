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
 * number of distinct keys (sites x checkpoints x ranges).
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

/** For tests. */
export function clearCache(): void {
  store().clear();
}
