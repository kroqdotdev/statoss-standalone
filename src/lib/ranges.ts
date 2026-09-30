const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type RangeKey = "24h" | "7d" | "90d" | "1y";

export interface RangeSpec {
  key: RangeKey;
  /** Label for the range switcher, e.g. "24 hours". */
  label: string;
  /** Sentence fragment, e.g. "the last 24 hours". */
  phrase: string;
  bucketMs: number;
  buckets: number;
}

export const RANGES: Record<RangeKey, RangeSpec> = {
  "24h": {
    key: "24h",
    label: "24 hours",
    phrase: "the last 24 hours",
    bucketMs: 5 * 60 * 1000,
    buckets: 288,
  },
  "7d": {
    key: "7d",
    label: "7 days",
    phrase: "the last 7 days",
    bucketMs: HOUR_MS,
    buckets: 168,
  },
  "90d": {
    key: "90d",
    label: "90 days",
    phrase: "the last 90 days",
    bucketMs: DAY_MS,
    buckets: 90,
  },
  "1y": {
    key: "1y",
    label: "1 year",
    phrase: "the last year",
    bucketMs: DAY_MS,
    buckets: 365,
  },
};

/**
 * How long a range's figures may be served from memory. The last 24 hours
 * follow every check; the longer views move slowly and cost more to add up.
 */
export const RANGE_TTL_MS: Record<RangeKey, number> = {
  "24h": 0,
  "7d": 5 * 60 * 1000,
  "90d": 15 * 60 * 1000,
  "1y": 15 * 60 * 1000,
};

export const DEFAULT_RANGE: RangeKey = "24h";

export function parseRange(
  value: unknown,
  fallback: RangeKey = DEFAULT_RANGE,
): RangeKey {
  return typeof value === "string" && Object.hasOwn(RANGES, value)
    ? (value as RangeKey)
    : fallback;
}
