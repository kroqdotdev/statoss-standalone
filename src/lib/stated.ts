import type { ComponentState } from "./config";
import type { IncidentView } from "./incidents";
import { maintenancePhase } from "./incidents";
import type { IncidentImpact, MonitorStatus } from "./state";

/**
 * What the operator has said about a row, beside what its checks say: an
 * open incident's state for it, and whether a maintenance window covers it
 * now. The row shows the worse of an incident's state and its checks; a
 * window in progress shows "Under maintenance" instead of the checks,
 * which are not counted meanwhile.
 */
export interface Stated {
  /** The worst state an open incident gives the row, or null. */
  impact: Exclude<IncidentImpact, "none"> | null;
  /** When that incident began. */
  since: number | null;
  /**
   * An open incident that names the row: the one behind the state, or the
   * first with an impact, for the row's link.
   */
  incident: { id: string; title: string } | null;
  /** When the maintenance window covering the row now ends, or null. */
  maintenanceUntil: number | null;
}

const RANK = { none: 0, degraded: 1, partial: 2, major: 3 } as const;

export const IMPACT_LABELS: Record<Exclude<IncidentImpact, "none">, string> = {
  degraded: "Degraded",
  partial: "Partial outage",
  major: "Major outage",
};

/** What the site's open incidents and maintenance say about each row. */
export function statedByName(
  current: IncidentView[],
  names: string[],
  now: number,
): Map<string, Stated> {
  const out = new Map<string, Stated>();
  const at = (name: string): Stated => {
    let s = out.get(name);
    if (!s) {
      s = { impact: null, since: null, incident: null, maintenanceUntil: null };
      out.set(name, s);
    }
    return s;
  };
  for (const view of current) {
    if (view.kind === "incident") {
      if (view.resolvedAt !== null) continue;
      for (const name of view.monitors) {
        const state = view.states[name] ?? "none";
        const s = at(name);
        if (state !== "none") {
          if (s.impact === null || RANK[state] > RANK[s.impact]) {
            s.impact = state;
            s.since = view.startedAt;
            s.incident = { id: view.id, title: view.title };
          }
        } else if (s.incident === null && view.impact !== "none") {
          s.incident = { id: view.id, title: view.title };
        }
      }
    } else if (maintenancePhase(view, now) === "in-progress") {
      for (const name of view.monitors.length === 0 ? names : view.monitors) {
        const s = at(name);
        s.maintenanceUntil = Math.max(
          s.maintenanceUntil ?? 0,
          view.endsAt ?? now,
        );
      }
    }
  }
  return out;
}

/** How bad a check status reads beside a stated state. */
const CHECK_RANK: Record<MonitorStatus, number> = {
  unknown: 0,
  up: 0,
  slow: 1,
  down: 3,
};

/**
 * What a row shows: its checks, the incident's state when that is worse
 * (an equal one keeps the checks' more exact words), or maintenance.
 */
export function shownState(
  status: MonitorStatus,
  stated: Stated | undefined,
): "checks" | "stated" | "maintenance" {
  if (stated?.impact && RANK[stated.impact] > CHECK_RANK[status])
    return "stated";
  if (stated?.maintenanceUntil) return "maintenance";
  return "checks";
}

/** A row's status as programs read it: the worse of its checks and its stated state. */
export function statusWithStated(
  status: MonitorStatus,
  stated: Stated | undefined,
): MonitorStatus {
  if (shownState(status, stated) !== "stated" || !stated?.impact) return status;
  return stated.impact === "degraded" ? "slow" : "down";
}

/** A component's state: the file's, or an open incident's when that is worse. */
export function componentState(
  configured: ComponentState,
  stated: Stated | undefined,
): ComponentState {
  const own = configured === "operational" ? 0 : RANK[configured];
  return stated?.impact && RANK[stated.impact] > own
    ? stated.impact
    : configured;
}

/** A component's state in the words a monitor's status uses. */
export function componentStatus(state: ComponentState): MonitorStatus {
  return state === "operational"
    ? "up"
    : state === "degraded"
      ? "slow"
      : "down";
}

export const COMPONENT_LABELS: Record<ComponentState, string> = {
  operational: "Operational",
  ...IMPACT_LABELS,
};
