const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

interface Parts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar fields of a moment in a time zone. UTC needs no lookup. */
function parts(ts: number, zone: string): Parts {
  if (zone === "UTC") {
    const d = new Date(ts);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(),
      day: d.getUTCDate(),
      weekday: d.getUTCDay(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    };
  }
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(zone, formatter);
  }
  const get: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ts)))
    get[part.type] = part.value;
  return {
    year: Number(get.year),
    month: Number(get.month) - 1,
    day: Number(get.day),
    weekday: WEEKDAYS.indexOf(get.weekday),
    hour: Number(get.hour),
    minute: Number(get.minute),
  };
}

/** Whether a name is a time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The short name of a zone at a moment: "UTC", "CEST", "GMT+2". */
export function zoneAbbreviation(ts: number, zone: string): string {
  if (zone === "UTC") return "UTC";
  const part = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    timeZoneName: "short",
  })
    .formatToParts(new Date(ts))
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? zone;
}

/*
  The formatters below are named for UTC, which is what they write unless
  a zone is given. On the page the zone is the visitor's own.
*/

/** "14:32". */
export function formatUtcClock(ts: number, zone = "UTC"): string {
  const p = parts(ts, zone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "14:32:07", for a list of checks that may be seconds apart. */
export function formatUtcClockSeconds(ts: number, zone = "UTC"): string {
  // Zones are offset by whole minutes, so the seconds are UTC's.
  return `${formatUtcClock(ts, zone)}:${pad(new Date(ts).getUTCSeconds())}`;
}

/** "2023-11-14 22:13 UTC". */
export function formatUtcStamp(ts: number, zone = "UTC"): string {
  const p = parts(ts, zone);
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${zoneAbbreviation(ts, zone)}`;
}

/** "12 Aug 2026". */
export function formatUtcDate(ts: number, zone = "UTC"): string {
  const p = parts(ts, zone);
  return `${p.day} ${MONTHS[p.month]} ${p.year}`;
}

/** "12 Aug". */
export function formatUtcDay(ts: number, zone = "UTC"): string {
  const p = parts(ts, zone);
  return `${p.day} ${MONTHS[p.month]}`;
}

/** "Tue 14:00". */
export function formatUtcWeekdayClock(ts: number, zone = "UTC"): string {
  const p = parts(ts, zone);
  return `${WEEKDAYS[p.weekday]} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "Today 14:32", "Yesterday 03:10" or "12 Aug 14:32", relative to `now`. */
export function formatUtcDateTime(
  ts: number,
  now: number,
  zone = "UTC",
): string {
  const p = parts(ts, zone);
  const n = parts(now, zone);
  const clock = `${pad(p.hour)}:${pad(p.minute)}`;
  // Days apart on the calendar, whatever the hours in each.
  const daysApart = Math.round(
    (Date.UTC(n.year, n.month, n.day) - Date.UTC(p.year, p.month, p.day)) /
      DAY_MS,
  );
  if (daysApart === 0) return `Today ${clock}`;
  if (daysApart === 1) return `Yesterday ${clock}`;
  return `${p.day} ${MONTHS[p.month]}${p.year === n.year ? "" : ` ${p.year}`} ${clock}`;
}

/** "1 min", "2 h 10 min", "3 d 4 h". Under a minute rounds up to "1 min". */
export function formatDuration(ms: number): string {
  const mins = Math.round(ms / MINUTE_MS);
  if (mins < 60) return `${Math.max(mins, 1)} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rest = mins % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

/** Like formatDuration, but spans under a minute show seconds: "42 s". */
export function formatSpan(ms: number): string {
  if (ms < MINUTE_MS) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return formatDuration(ms);
}

/** "every minute", "every 5 minutes", "every 30 seconds". */
export function formatInterval(seconds: number): string {
  if (seconds === 60) return "every minute";
  if (seconds % 60 === 0) return `every ${seconds / 60} minutes`;
  return `every ${seconds} seconds`;
}

/** "1,438" with a thousands separator. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** "99.93%": two decimals, but "100%" when nothing failed. */
export function formatPercent(up: number, total: number): string {
  if (total === 0) return "";
  if (up === total) return "100%";
  return `${((up / total) * 100).toFixed(2)}%`;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

const CAUSE_LABELS: Array<[RegExp, string]> = [
  [/ECONNREFUSED/, "Connection refused"],
  [/ECONNRESET/, "Connection reset"],
  [/ENOTFOUND|EAI_AGAIN/, "DNS lookup failed"],
  [/EHOSTUNREACH|ENETUNREACH/, "Host unreachable"],
  [/CERT_|certificate|SSL|TLS/i, "TLS error"],
];

/**
 * Turns a stored check error into a short label for the page. Unknown
 * messages are not shown verbatim, because the page is public and a raw
 * error could name an internal host.
 * Old rows with plain "fetch failed" still get a sensible label.
 */
export function describeError(error: string | null): string {
  if (error === null) return "Failed";
  if (error === "timeout") return "Timed out";
  if (error === "keyword missing") return "Keyword missing";
  if (error === "keyword present") return "Keyword present";
  if (error === "no ping") return "No ping";
  if (error === "no records") return "No DNS records";
  if (error === "expected record missing") return "Expected record missing";
  if (error === "no reply") return "No reply";
  if (error.startsWith("ping unavailable")) return "Ping unavailable";
  if (error === "domain not registered") return "Domain not registered";
  // "certificate expires in 9 days", "domain expired": safe to show as is.
  if (/^(certificate|domain) (expired|expires in \d+ days)$/.test(error))
    return `${error[0].toUpperCase()}${error.slice(1)}`;
  if (error.startsWith("certificate invalid")) return "Certificate invalid";
  if (/^registry answered \d{3}$/.test(error)) return "Registry unavailable";
  const status = /^unexpected status (\d{3})$/.exec(error);
  if (status) return `HTTP ${status[1]}`;
  for (const [pattern, label] of CAUSE_LABELS) {
    if (pattern.test(error)) return label;
  }
  if (error.startsWith("fetch failed")) return "Connection failed";
  return "Failed";
}

/**
 * "2 timeouts", "3 failed checks", "3 failed checks, 1 timeout", or null
 * when nothing failed.
 */
export function failureSummary(
  failed: number,
  timeouts: number,
): string | null {
  if (failed === 0) return null;
  if (timeouts === failed) return pluralize(failed, "timeout");
  const base = pluralize(failed, "failed check");
  return timeouts === 0 ? base : `${base}, ${pluralize(timeouts, "timeout")}`;
}

/** The id of a row on the page, so an incident can link to the monitor it names. */
export function rowId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `row-${slug || "unnamed"}`;
}
