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

export function overallStatus(
  statuses: Array<"up" | "down">,
): "operational" | "partial" | "major" {
  if (statuses.length === 0 || statuses.every((status) => status === "up"))
    return "operational";
  if (statuses.every((status) => status === "down")) return "major";
  return "partial";
}
