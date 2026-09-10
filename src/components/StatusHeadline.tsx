import type { CheckpointView } from "./CheckpointSection";
import { failureSummary, formatDuration } from "@/lib/format";
import type { overallStatus } from "@/lib/state";

type Overall = ReturnType<typeof overallStatus>;

const DOT: Record<Overall, string> = {
  operational: "text-up",
  partial: "text-timeout",
  major: "text-fail",
};

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function headline(site: string, overall: Overall): string {
  if (overall === "operational") return `${site} is up.`;
  if (overall === "major") return `${site} is down.`;
  return `Part of ${site} is down.`;
}

function detail(checkpoints: CheckpointView[], now: number): string {
  const down = checkpoints.filter((cp) => cp.status === "down");
  const up = checkpoints.length - down.length;
  if (down.length === 0) {
    if (checkpoints.length === 1)
      return `${checkpoints[0].name} is responding.`;
    if (checkpoints.length === 2) return "Both checkpoints are responding.";
    return `All ${checkpoints.length} checkpoints are responding.`;
  }
  const longest = Math.max(...down.map((cp) => now - (cp.since ?? now)));
  const who = joinNames(down.map((cp) => cp.name));
  const verb = down.length === 1 ? "has" : "have";
  const rest =
    up === 0
      ? ""
      : up === 1
        ? " The other checkpoint is responding."
        : ` The other ${up} checkpoints are responding.`;
  return `${who} ${verb} been down for ${formatDuration(longest)}.${rest}`;
}

function recent(checkpoints: CheckpointView[]): string {
  const failed = checkpoints.reduce(
    (sum, cp) => sum + (cp.last24h.total - cp.last24h.up),
    0,
  );
  const timeouts = checkpoints.reduce(
    (sum, cp) => sum + cp.last24h.timeouts,
    0,
  );
  const summary = failureSummary(failed, timeouts);
  if (summary === null) return "No failed checks in the last 24 hours.";
  return `${summary[0].toUpperCase()}${summary.slice(1)} in the last 24 hours.`;
}

export function StatusHeadline({
  site,
  overall,
  checkpoints,
  now,
}: {
  site: string;
  overall: Overall;
  checkpoints: CheckpointView[];
  now: number;
}) {
  return (
    <header>
      <h1 className="flex items-center gap-4 text-[2rem] font-semibold leading-none tracking-[-0.02em] sm:text-[2.75rem]">
        <span
          aria-hidden="true"
          className={`block size-3 shrink-0 rounded-full bg-current sm:size-3.5 ${DOT[overall]}`}
        />
        <span>{headline(site, overall)}</span>
      </h1>
      <p className="mt-5 max-w-[36rem] text-[15px] leading-relaxed text-muted sm:text-[17px]">
        {detail(checkpoints, now)} {recent(checkpoints)}
      </p>
    </header>
  );
}
