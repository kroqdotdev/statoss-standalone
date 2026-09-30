import type Database from "better-sqlite3";
import type { ComponentState, SiteConfig } from "./config";
import type { IncidentView } from "./incidents";
import { EMPTY_BUCKET, rangeWindow, type Bucket } from "./queries";
import type { RangeSpec } from "./ranges";

/**
 * A component's states over time, so its row can draw a strip. A component
 * has no checks, so a bar stands for the state it was in: operational,
 * degraded or out, the worst of the bar's span. Two things move a
 * component's state. The configuration, read at start: every change found
 * there is recorded with the time it was seen. And incidents that name the
 * component with a state, for as long as each was open, read from the
 * files whenever the strip is drawn.
 */

const RANK: Record<ComponentState, number> = {
  operational: 0,
  degraded: 1,
  partial: 2,
  major: 3,
};

/** Notes each component's configured state when it differs from the last one noted. */
export function recordComponentStates(
  db: Database.Database,
  sites: Array<Pick<SiteConfig, "name" | "components">>,
  now: number,
): void {
  const last = db.prepare(
    `SELECT state FROM component_state WHERE site = ? AND component = ?
     ORDER BY at DESC LIMIT 1`,
  );
  const insert = db.prepare(
    "INSERT OR REPLACE INTO component_state (site, component, state, at) VALUES (?, ?, ?, ?)",
  );
  for (const site of sites)
    for (const c of site.components) {
      const row = last.get(site.name, c.name) as { state: string } | undefined;
      if (row?.state !== c.state) insert.run(site.name, c.name, c.state, now);
    }
}

interface Change {
  at: number;
  state: ComponentState;
}

/**
 * The component's strip over a range: in each bar the worst state it was
 * in, as a bucket of one check that passed (operational), passed slowly
 * (degraded) or failed (an outage); before its history begins, empty.
 */
export function componentBuckets(
  db: Database.Database,
  site: string,
  component: string,
  incidents: IncidentView[],
  spec: RangeSpec,
  now: number,
): Bucket[] {
  const { start } = rangeWindow(spec, now);
  const changes = db
    .prepare(
      `SELECT at, state FROM component_state
       WHERE site = ? AND component = ? AND at <= ? ORDER BY at`,
    )
    .all(site, component, now) as Change[];
  const spans = incidents
    .filter(
      (v) =>
        v.kind === "incident" &&
        v.startedAt <= now &&
        (v.states[component] ?? "none") !== "none",
    )
    .map((v) => ({
      from: v.startedAt,
      to: v.resolvedAt ?? now + 1,
      state: v.states[component] as ComponentState,
    }));
  const first = changes[0]?.at ?? Infinity;
  const buckets: Bucket[] = [];
  let next = 0;
  let configured: ComponentState | null = null;
  for (let i = 0; i < spec.buckets; i++) {
    const ts = start + i * spec.bucketMs;
    const end = ts + spec.bucketMs;
    // The configured state the bar begins in, then every change inside it.
    while (next < changes.length && changes[next].at <= ts)
      configured = changes[next++].state;
    let worst: ComponentState | null = ts <= now ? configured : null;
    while (next < changes.length && changes[next].at < end) {
      configured = changes[next++].state;
      if (worst === null || RANK[configured] > RANK[worst]) worst = configured;
    }
    for (const span of spans)
      if (span.from < end && span.to > ts && ts <= now)
        if (worst === null || RANK[span.state] > RANK[worst])
          worst = span.state;
    // Nothing is known of it before it was first in the configuration,
    // unless an incident says something about it then.
    if (worst === null || (end <= first && worst === "operational")) {
      buckets.push({ ts, ...EMPTY_BUCKET });
      continue;
    }
    const out = worst === "partial" || worst === "major";
    buckets.push({
      ts,
      ...EMPTY_BUCKET,
      total: 1,
      up: out ? 0 : 1,
      slow: worst === "degraded" ? 1 : 0,
    });
  }
  return buckets;
}

/** Forgets states older than any range can show, keeping each component's last one. */
export function pruneComponentStates(
  db: Database.Database,
  before: number,
): number {
  return db
    .prepare(
      `DELETE FROM component_state
       WHERE at < ? AND at < (
         SELECT MAX(at) FROM component_state AS newer
         WHERE newer.site = component_state.site
           AND newer.component = component_state.component
           AND newer.at < ?)`,
    )
    .run(before, before).changes;
}
