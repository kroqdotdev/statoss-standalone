/*
 * iCalendar (RFC 5545), as much of it as a feed of events needs: text
 * escaped, lines folded at 75 octets, CRLF between them, times in UTC.
 */

/** A property's text value: backslash, semicolon, comma and newlines escaped. */
export function icsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** "20261005T020000Z". */
export function icsTime(ts: number): string {
  return new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

const encoder = new TextEncoder();

/**
 * A content line folded so no line passes 75 octets, each continuation
 * starting with a space. A character is never split across lines.
 */
export function icsLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // The first line holds 75 octets; the rest hold 74 after their space.
    const room = out.length === 0 ? 75 : 74;
    if (size + bytes > room) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join("\r\n ");
}

export interface IcsEvent {
  uid: string;
  start: number;
  end: number;
  /** When the event last changed. */
  stamp: number;
  summary: string;
  description?: string;
  url?: string;
}

/** A whole calendar of events. */
export function icsCalendar(
  name: string,
  events: IcsEvent[],
  now: number,
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//StatOSS//Maintenance//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name)}`,
    // How often a calendar app should read it again.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsText(e.uid)}`,
      `DTSTAMP:${icsTime(Math.min(e.stamp, now))}`,
      `DTSTART:${icsTime(e.start)}`,
      `DTEND:${icsTime(e.end)}`,
      `SUMMARY:${icsText(e.summary)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    // Confirmed, and not busy time for whoever subscribes.
    lines.push("STATUS:CONFIRMED", "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsLine).join("\r\n") + "\r\n";
}
