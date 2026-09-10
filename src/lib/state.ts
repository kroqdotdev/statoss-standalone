export type Transition = "went-down" | "recovered" | null;

export interface CheckpointState {
  status: "up" | "down";
  consecutiveFails: number;
  since: number;
}

const DOWN_AFTER_CONSECUTIVE_FAILS = 2;

export function applyResult(
  prev: CheckpointState | undefined,
  ok: boolean,
  now: number,
): { next: CheckpointState; transition: Transition } {
  const current: CheckpointState = prev ?? {
    status: "up",
    consecutiveFails: 0,
    since: now,
  };

  if (ok) {
    const recovered = current.status === "down";
    return {
      next: {
        status: "up",
        consecutiveFails: 0,
        since: recovered ? now : current.since,
      },
      transition: recovered ? "recovered" : null,
    };
  }

  const fails = current.consecutiveFails + 1;
  const goesDown =
    current.status === "up" && fails >= DOWN_AFTER_CONSECUTIVE_FAILS;
  return {
    next: {
      status: goesDown ? "down" : current.status,
      consecutiveFails: fails,
      since: goesDown ? now : current.since,
    },
    transition: goesDown ? "went-down" : null,
  };
}

export type CheckpointStatus = "up" | "down" | "unknown";

/**
 * Rolls checkpoint statuses up into one headline state. A checkpoint is
 * "unknown" until its first check has run; unknown checkpoints never count
 * as up, and a site where nothing has been checked yet is "unknown".
 */
export function overallStatus(
  statuses: CheckpointStatus[],
): "operational" | "partial" | "major" | "unknown" {
  if (statuses.length === 0 || statuses.every((status) => status === "up"))
    return "operational";
  if (statuses.every((status) => status === "unknown")) return "unknown";
  const known = statuses.filter((status) => status !== "unknown");
  if (known.every((status) => status === "down")) return "major";
  if (known.some((status) => status === "down")) return "partial";
  return "operational";
}
