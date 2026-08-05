import { LatencyChart } from "./LatencyChart";
import { UptimeBars } from "./UptimeBars";
import type { DayUptime, LatencyPoint } from "@/lib/queries";

export interface CheckpointView {
  name: string;
  status: "up" | "down";
  days: DayUptime[];
  latency: LatencyPoint[];
}

export function CheckpointCard({
  checkpoint,
  sinceMs,
  untilMs,
}: {
  checkpoint: CheckpointView;
  sinceMs: number;
  untilMs: number;
}) {
  const up = checkpoint.status === "up";
  return (
    <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium">{checkpoint.name}</h2>
        <span
          className={`text-sm font-semibold ${up ? "text-emerald-600" : "text-red-600"}`}
        >
          {up ? "Operational" : "Down"}
        </span>
      </div>
      <UptimeBars days={checkpoint.days} />
      <div className="mt-4">
        <LatencyChart
          points={checkpoint.latency}
          sinceMs={sinceMs}
          untilMs={untilMs}
        />
      </div>
    </section>
  );
}
