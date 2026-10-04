import { describe, expect, it } from "vitest";
import { icsCalendar, icsLine, icsText, icsTime } from "./ics";

const octets = (text: string) => new TextEncoder().encode(text).length;
const unfold = (lines: string[]) =>
  lines.map((p, i) => (i === 0 ? p : p.slice(1))).join("");

describe("iCalendar text", () => {
  it("escapes what the format reads as markup", () => {
    expect(icsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    expect(icsText("one\r\ntwo\rthree")).toBe("one\\ntwo\\nthree");
    expect(icsText("Notes: 50% off")).toBe("Notes: 50% off");
    expect(icsTime(Date.parse("2026-10-04T02:05:00.123Z"))).toBe(
      "20261004T020500Z",
    );
  });

  it("leaves a line of 75 octets as it is", () => {
    const line = `SUMMARY:${"x".repeat(67)}`;
    expect(octets(line)).toBe(75);
    expect(icsLine(line)).toBe(line);
  });

  it("folds a long line at 75 octets without splitting a character", () => {
    for (const char of ["ø", "€", "🛠"]) {
      const line = `DESCRIPTION:${char.repeat(60)}`;
      const folded = icsLine(line).split("\r\n");
      expect(folded.length).toBeGreaterThan(1);
      for (const part of folded) expect(octets(part)).toBeLessThanOrEqual(75);
      expect(folded.slice(1).every((p) => p.startsWith(" "))).toBe(true);
      expect(unfold(folded)).toBe(line);
    }
    const plain = icsLine(`DESCRIPTION:${"a".repeat(200)}`).split("\r\n");
    expect(plain.map(octets)).toEqual([75, 75, 64]);
  });

  it("writes a calendar with CRLF between lines", () => {
    const text = icsCalendar(
      "Acme maintenance",
      [
        {
          uid: "w1@status.acme.test",
          start: 0,
          end: 60_000,
          stamp: 0,
          summary: "Acme: Upgrade",
          description: "Writes pause, briefly; then\nall is well.",
          url: "https://status.acme.test/incidents/w1",
        },
      ],
      0,
    );
    expect(text.split("\r\n").slice(0, 2)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
    ]);
    expect(text).toContain("X-WR-CALNAME:Acme maintenance\r\n");
    expect(text).toContain("DTEND:19700101T000100Z\r\nSUMMARY:Acme: Upgrade");
    expect(text).toContain(
      "DESCRIPTION:Writes pause\\, briefly\\; then\\nall is well.\r\n",
    );
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
  });

  it("never dates a change later than the calendar itself", () => {
    const text = icsCalendar(
      "x",
      [{ uid: "a", start: 0, end: 1, stamp: 5_000, summary: "a" }],
      1_000,
    );
    expect(text).toContain("DTSTAMP:19700101T000001Z\r\n");
    expect(text).not.toContain("DESCRIPTION");
    expect(text).not.toContain("URL");
  });
});
