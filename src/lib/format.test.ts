import { describe, expect, it } from "vitest";
import {
  describeError,
  formatDuration,
  formatPercent,
  formatSpan,
  formatUtcDateTime,
  pluralize,
} from "./format";

const NOW = Date.UTC(2024, 0, 10, 12, 0, 0);

describe("formatDuration", () => {
  it("rounds sub-minute spans up to one minute", () => {
    expect(formatDuration(5_000)).toBe("1 min");
  });
  it("drops zero remainders", () => {
    expect(formatDuration(60 * 60_000)).toBe("1 h");
    expect(formatDuration(48 * 60 * 60_000)).toBe("2 d");
    expect(formatDuration(50 * 60 * 60_000)).toBe("2 d 2 h");
  });
});

describe("formatSpan", () => {
  it("shows seconds under a minute and minutes above", () => {
    expect(formatSpan(400)).toBe("1 s");
    expect(formatSpan(42_000)).toBe("42 s");
    expect(formatSpan(60_000)).toBe("1 min");
    expect(formatSpan(125 * 60_000)).toBe("2 h 5 min");
  });
});

describe("formatUtcDateTime", () => {
  it("uses Today and Yesterday relative to now", () => {
    expect(formatUtcDateTime(NOW - 60_000, NOW)).toBe("Today 11:59");
    expect(formatUtcDateTime(Date.UTC(2024, 0, 9, 3, 10), NOW)).toBe(
      "Yesterday 03:10",
    );
    expect(formatUtcDateTime(Date.UTC(2023, 11, 24, 8, 5), NOW)).toBe(
      "24 Dec 08:05",
    );
  });
});

describe("formatPercent", () => {
  it("shows 100% exactly and two decimals otherwise", () => {
    expect(formatPercent(10, 10)).toBe("100%");
    expect(formatPercent(1439, 1440)).toBe("99.93%");
    expect(formatPercent(0, 0)).toBe("");
  });
});

describe("pluralize", () => {
  it("handles singular, plural and irregular forms", () => {
    expect(pluralize(1, "check")).toBe("1 check");
    expect(pluralize(1440, "check")).toBe("1,440 checks");
    expect(pluralize(2, "timeout")).toBe("2 timeouts");
  });
});

describe("describeError", () => {
  it("labels timeouts, HTTP statuses and connection causes", () => {
    expect(describeError("timeout")).toBe("Timed out");
    expect(describeError("unexpected status 503")).toBe("HTTP 503");
    expect(describeError("fetch failed (ECONNREFUSED)")).toBe(
      "Connection refused",
    );
    expect(describeError("fetch failed (ENOTFOUND)")).toBe("DNS lookup failed");
    expect(describeError("fetch failed")).toBe("Connection failed");
    expect(describeError(null)).toBe("Failed");
    expect(describeError("fetch failed (EPROTO)")).toBe("Connection failed");
    expect(describeError("connect to internal-db.local failed")).toBe("Failed");
  });
});
