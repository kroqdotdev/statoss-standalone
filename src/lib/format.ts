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

/** "14:32" in UTC. */
export function formatUtcClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "2023-11-14 22:13 UTC". */
export function formatUtcStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${formatUtcClock(ts)} UTC`;
}

/** "12 Aug 2026" in UTC. */
export function formatUtcDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "12 Aug" in UTC. */
export function formatUtcDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Tue 14:00" in UTC. */
export function formatUtcWeekdayClock(ts: number): string {
  const d = new Date(ts);
  return `${WEEKDAYS[d.getUTCDay()]} ${formatUtcClock(ts)}`;
}

/** "Today 14:32", "Yesterday 03:10" or "12 Aug 14:32", relative to `now`, in UTC. */
export function formatUtcDateTime(ts: number, now: number): string {
  const day = Math.floor(ts / DAY_MS);
  const today = Math.floor(now / DAY_MS);
  const clock = formatUtcClock(ts);
  if (day === today) return `Today ${clock}`;
  if (day === today - 1) return `Yesterday ${clock}`;
  return `${formatUtcDay(ts)} ${clock}`;
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
