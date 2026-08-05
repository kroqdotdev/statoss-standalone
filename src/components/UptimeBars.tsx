import type { DayUptime } from "@/lib/queries";

function barColor(pct: number | null): string {
  if (pct === null) return "bg-neutral-200 dark:bg-neutral-700";
  if (pct >= 99) return "bg-emerald-500";
  if (pct >= 90) return "bg-amber-400";
  return "bg-red-500";
}

export function UptimeBars({ days }: { days: DayUptime[] }) {
  const measured = days.filter((d) => d.uptimePct !== null);
  const overall =
    measured.length > 0
      ? (
          measured.reduce((sum, d) => sum + (d.uptimePct ?? 0), 0) /
          measured.length
        ).toFixed(2)
      : null;
  return (
    <div>
      <div className="flex gap-px">
        {days.map((d) => (
          <div
            key={d.date}
            title={`${d.date}: ${d.uptimePct === null ? "no data" : `${d.uptimePct}%`}`}
            className={`h-8 min-w-0 flex-1 rounded-sm ${barColor(d.uptimePct)}`}
          />
        ))}
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        {overall === null
          ? "No data yet"
          : `${overall}% uptime over the last 90 days`}
      </p>
    </div>
  );
}
