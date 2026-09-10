const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type RangeKey = "24h" | "7d" | "90d";

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
};

export const DEFAULT_RANGE: RangeKey = "24h";

export function parseRange(value: unknown): RangeKey {
  return typeof value === "string" && value in RANGES
    ? (value as RangeKey)
    : DEFAULT_RANGE;
}
