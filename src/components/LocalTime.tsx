"use client";

import {
  formatUtcClock,
  formatUtcDateTime,
  formatUtcStamp,
} from "@/lib/format";
import { useViewerZone } from "@/lib/viewer-zone";

/** How a time is written: "14:32", "Today 14:32", or "2026-09-10 14:32 CEST". */
export type TimeStyle = "clock" | "dateTime" | "stamp";

/**
 * A moment in the visitor's own time zone. The server writes it in the
 * site's zone (UTC unless `timezone` is set), and the browser rewrites it
 * once it runs. Pointing at it shows the full date, time and zone.
 */
export function LocalTime({
  ts,
  style,
  now = ts,
}: {
  ts: number;
  style: TimeStyle;
  /** What "today" is measured from, for the relative style. */
  now?: number;
}) {
  const zone = useViewerZone();
  return (
    <time
      dateTime={new Date(ts).toISOString()}
      title={formatUtcStamp(ts, zone)}
      suppressHydrationWarning
    >
      {style === "clock"
        ? formatUtcClock(ts, zone)
        : style === "dateTime"
          ? formatUtcDateTime(ts, now, zone)
          : formatUtcStamp(ts, zone)}
    </time>
  );
}

/** The visitor's time zone by name, for the line that says which zone times are in. */
export function ZoneName() {
  return <span suppressHydrationWarning>{useViewerZone()}</span>;
}
