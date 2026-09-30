export type Transition =
  "went-down" | "recovered" | "went-slow" | "back-to-normal" | null;

export interface MonitorState {
  status: "up" | "slow" | "down";
  consecutiveFails: number;
  consecutiveSlow: number;
  since: number;
}

/** What one check found. */
export interface CheckVerdict {
  ok: boolean;
  /** A successful check over the monitor's slow threshold. */
  slow: boolean;
}

const DOWN_AFTER_CONSECUTIVE_FAILS = 2;
const SLOW_AFTER_CONSECUTIVE_SLOW = 2;

/**
 * Down after two failed checks in a row, back after one success. Slow works
 * the same way: two slow successes in a row, and one fast success ends it.
 * A monitor that comes back slow is "up" first, so the recovery is
 * reported, and turns slow on the next slow check.
 */
export function applyResult(
  prev: MonitorState | undefined,
  verdict: CheckVerdict | boolean,
  now: number,
): { next: MonitorState; transition: Transition } {
  const { ok, slow } =
    typeof verdict === "boolean" ? { ok: verdict, slow: false } : verdict;
  const current: MonitorState = prev ?? {
    status: "up",
    consecutiveFails: 0,
    consecutiveSlow: 0,
    since: now,
  };

  if (!ok) {
    const fails = current.consecutiveFails + 1;
    const goesDown =
      current.status !== "down" && fails >= DOWN_AFTER_CONSECUTIVE_FAILS;
    return {
      next: {
        status: goesDown ? "down" : current.status,
        consecutiveFails: fails,
        consecutiveSlow: 0,
        since: goesDown ? now : current.since,
      },
      transition: goesDown ? "went-down" : null,
    };
  }

  if (current.status === "down") {
    return {
      next: {
        status: "up",
        consecutiveFails: 0,
        consecutiveSlow: slow ? 1 : 0,
        since: now,
      },
      transition: "recovered",
    };
  }

  if (!slow) {
    const wasSlow = current.status === "slow";
    return {
      next: {
        status: "up",
        consecutiveFails: 0,
        consecutiveSlow: 0,
        since: wasSlow ? now : current.since,
      },
      transition: wasSlow ? "back-to-normal" : null,
    };
  }

  const slowCount = current.consecutiveSlow + 1;
  const goesSlow =
    current.status === "up" && slowCount >= SLOW_AFTER_CONSECUTIVE_SLOW;
  return {
    next: {
      status: goesSlow ? "slow" : current.status,
      consecutiveFails: 0,
      consecutiveSlow: slowCount,
      since: goesSlow ? now : current.since,
    },
    transition: goesSlow ? "went-slow" : null,
  };
}

export type MonitorStatus = "up" | "slow" | "down" | "unknown";
export type Overall =
  "operational" | "degraded" | "partial" | "major" | "unknown";

/**
 * Rolls monitor statuses up into one headline state. A monitor is
 * "unknown" until its first check has run; unknown monitors never count
 * as up, and a site where nothing has been checked yet, or that has
 * nothing to check, is "unknown".
 * Any monitor down outranks any monitor slow.
 */
export function overallStatus(statuses: MonitorStatus[]): Overall {
  if (statuses.length === 0) return "unknown";
  if (statuses.every((status) => status === "up")) return "operational";
  if (statuses.every((status) => status === "unknown")) return "unknown";
  const known = statuses.filter((status) => status !== "unknown");
  if (known.every((status) => status === "down")) return "major";
  if (known.some((status) => status === "down")) return "partial";
  if (known.some((status) => status === "slow")) return "degraded";
  return "operational";
}

export type IncidentImpact = "none" | "degraded" | "partial" | "major";

const SEVERITY: Record<Overall, number> = {
  unknown: 0,
  operational: 1,
  degraded: 2,
  partial: 3,
  major: 4,
};

/**
 * The headline state once open incidents have their say. An incident written
 * by hand describes a problem the checks cannot see, so its impact outranks
 * a green set of monitors. "unknown" only survives when nothing has been
 * checked and nothing is open.
 */
export function pageOverall(
  statuses: MonitorStatus[],
  impacts: IncidentImpact[],
): Overall {
  let overall = overallStatus(statuses);
  for (const impact of impacts) {
    if (impact === "none") continue;
    if (SEVERITY[impact] > SEVERITY[overall]) overall = impact;
  }
  return overall;
}

/**
 * Whether a monitor's checks have stopped arriving: three intervals with no
 * result, and five minutes at the least, so one slow round is not "late".
 * A stored state is only as good as the last check behind it. Null, a
 * state from before the time was kept, is not called late.
 */
export function checkLate(
  checkedAt: number | null | undefined,
  intervalSeconds: number,
  now: number,
): boolean {
  if (checkedAt === null || checkedAt === undefined) return false;
  return now - checkedAt > Math.max(3 * intervalSeconds, 5 * 60) * 1000;
}
