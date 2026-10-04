import { describe, expect, it } from "vitest";
import {
  describeError,
  describeTiming,
  formatDuration,
  formatPercent,
  formatSpan,
  formatUtcClock,
  formatUtcDateTime,
  formatUtcDay,
  formatUtcStamp,
  formatUtcWeekdayClock,
  isTimeZone,
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
      "24 Dec 2023 08:05",
    );
    expect(formatUtcDateTime(Date.UTC(2024, 0, 2, 8, 5), NOW)).toBe(
      "2 Jan 08:05",
    );
  });
});

describe("formatUtcDay", () => {
  it("gives a day its year only when it is not now's", () => {
    expect(formatUtcDay(Date.UTC(2023, 7, 12), "UTC", NOW)).toBe("12 Aug 2023");
    expect(formatUtcDay(Date.UTC(2024, 0, 2), "UTC", NOW)).toBe("2 Jan");
    expect(formatUtcDay(Date.UTC(2023, 7, 12))).toBe("12 Aug");
  });

  it("reads the year in the zone it is given", () => {
    // New Year's Eve in Los Angeles is already New Year's Day in UTC.
    const eve = Date.UTC(2024, 0, 1, 5);
    expect(formatUtcDay(eve, "America/Los_Angeles", NOW)).toBe("31 Dec 2023");
    expect(formatUtcDay(eve, "UTC", NOW)).toBe("1 Jan");
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

describe("describeTiming", () => {
  it("names each step a check took", () => {
    expect(
      describeTiming({ dnsMs: 3, connectMs: 12, tlsMs: 24, firstByteMs: 1061 }),
    ).toBe("DNS 3 ms, connect 12 ms, TLS 24 ms, first byte 1,061 ms");
  });

  it("leaves out a step the check does not have", () => {
    expect(
      describeTiming({
        dnsMs: null,
        connectMs: 2,
        tlsMs: null,
        firstByteMs: 9,
      }),
    ).toBe("Connect 2 ms, first byte 9 ms");
    expect(
      describeTiming({ dnsMs: 1, connectMs: 2, tlsMs: 30, firstByteMs: null }),
    ).toBe("DNS 1 ms, connect 2 ms, TLS 30 ms");
  });

  it("says where a check that timed out stopped", () => {
    expect(
      describeTiming(
        { dnsMs: 3, connectMs: null, tlsMs: null, firstByteMs: null },
        true,
      ),
    ).toBe("DNS 3 ms, no connection");
    expect(
      describeTiming(
        { dnsMs: 3, connectMs: 12, tlsMs: 24, firstByteMs: null },
        true,
      ),
    ).toBe("DNS 3 ms, connect 12 ms, TLS 24 ms, no answer in time");
    // Timed out reading the body, after the headers came.
    expect(
      describeTiming(
        { dnsMs: 3, connectMs: 12, tlsMs: 24, firstByteMs: 40 },
        true,
      ),
    ).toBe("DNS 3 ms, connect 12 ms, TLS 24 ms, first byte 40 ms");
  });

  it("says nothing for a check without timings", () => {
    expect(describeTiming(null)).toBeNull();
    expect(describeTiming(null, true)).toBeNull();
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

describe("describeError for the other check types", () => {
  it.each([
    ["no ping", "No ping"],
    ["no records", "No DNS records"],
    ["no reply", "No reply"],
    ["ping unavailable (not permitted)", "Ping unavailable"],
    ["certificate expires in 9 days", "Certificate expires in 9 days"],
    ["domain expired", "Domain expired"],
    ["certificate invalid (CERT_HAS_EXPIRED)", "Certificate invalid"],
    ["registry answered 503", "Registry unavailable"],
    ["ECONNREFUSED", "Connection refused"],
  ])("%s reads %s", (error, label) => {
    expect(describeError(error)).toBe(label);
  });
});

describe("times in a zone", () => {
  // 30 September 2026, 22:30 UTC: already 1 October in Copenhagen.
  const ts = Date.UTC(2026, 8, 30, 22, 30);

  it("writes UTC unless a zone is given", () => {
    expect(formatUtcStamp(ts)).toBe("2026-09-30 22:30 UTC");
    expect(formatUtcStamp(ts, "Europe/Copenhagen")).toBe(
      "2026-10-01 00:30 CEST",
    );
    expect(formatUtcClock(ts, "Asia/Kolkata")).toBe("04:00");
    expect(formatUtcDay(ts, "America/Los_Angeles")).toBe("30 Sep");
    expect(formatUtcWeekdayClock(ts, "Europe/Copenhagen")).toBe("Thu 00:30");
  });

  it("says today and yesterday by the zone's calendar", () => {
    const now = Date.UTC(2026, 8, 30, 23, 0);
    expect(formatUtcDateTime(ts, now)).toBe("Today 22:30");
    expect(
      formatUtcDateTime(Date.UTC(2026, 8, 30, 21), now, "Europe/Copenhagen"),
    ).toBe("Yesterday 23:00");
    expect(formatUtcDateTime(Date.UTC(2025, 5, 2, 13), now)).toBe(
      "2 Jun 2025 13:00",
    );
  });

  it("knows a time zone from a typo", () => {
    expect(isTimeZone("Europe/Copenhagen")).toBe(true);
    expect(isTimeZone("Europe/Copenhagn")).toBe(false);
  });
});
