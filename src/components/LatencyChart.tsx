import type { LatencyPoint } from "@/lib/queries";

export function LatencyChart({
  points,
  sinceMs,
  untilMs,
}: {
  points: LatencyPoint[];
  sinceMs: number;
  untilMs: number;
}) {
  if (points.length === 0) {
    return <p className="text-xs text-neutral-500">No latency data yet</p>;
  }
  const W = 600;
  const H = 80;
  const PAD = 2;
  const max = Math.max(...points.map((p) => p.latencyMs), 1);
  const x = (ts: number) =>
    PAD + ((ts - sinceMs) / (untilMs - sinceMs)) * (W - 2 * PAD);
  const y = (ms: number) => H - PAD - (ms / max) * (H - 2 * PAD);
  const path = points
    .map((p) => `${x(p.ts).toFixed(1)},${y(p.latencyMs).toFixed(1)}`)
    .join(" ");
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Response time, last 24 hours"
      >
        <polyline
          points={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-sky-500"
        />
      </svg>
      <p className="text-xs text-neutral-500">
        Last 24 hours · max {Math.round(max)} ms
      </p>
    </div>
  );
}
