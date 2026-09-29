import {
  formatDuration,
  formatUtcDateTime,
  formatUtcStamp,
} from "@/lib/format";
import {
  maintenancePhase,
  STATUS_LABELS,
  type IncidentView,
} from "@/lib/incidents";

function scope(view: IncidentView): string {
  if (view.monitors.length === 0) return "";
  return ` Affects ${view.monitors.join(", ")}.`;
}

/** One line about when: started, planned window, or resolved. */
function when(view: IncidentView, now: number): string {
  if (view.kind === "maintenance" && view.endsAt !== null) {
    const phase = maintenancePhase(view, now);
    if (phase === "scheduled")
      return `Planned ${formatUtcDateTime(view.startedAt, now)} to ${formatUtcDateTime(view.endsAt, now)} UTC.`;
    if (phase === "in-progress")
      return `In progress until ${formatUtcDateTime(view.endsAt, now)} UTC.`;
    return `${formatUtcDateTime(view.startedAt, now)}, lasted ${formatDuration(
      (view.resolvedAt ?? view.endsAt) - view.startedAt,
    )}.`;
  }
  if (view.resolvedAt !== null)
    return `${formatUtcDateTime(view.startedAt, now)}, resolved after ${formatDuration(view.resolvedAt - view.startedAt)}.`;
  return `Since ${formatUtcDateTime(view.startedAt, now)}, ${formatDuration(now - view.startedAt)} so far.`;
}

function Updates({ view, now }: { view: IncidentView; now: number }) {
  if (view.updates.length === 0) return null;
  return (
    <ol className="mt-3 space-y-2.5 text-[14px] leading-relaxed">
      {view.updates.map((u) => (
        <li
          key={`${u.createdAt}-${u.status}`}
          className="grid gap-x-3 sm:grid-cols-[7.5rem_1fr]"
        >
          <span
            className="text-[13px] text-muted"
            title={formatUtcStamp(u.createdAt)}
          >
            {formatUtcDateTime(u.createdAt, now)}
          </span>
          <span>
            <span className="font-medium">{STATUS_LABELS[u.status]}.</span>{" "}
            <span className="whitespace-pre-line">{u.body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Open incidents and maintenance, shown under the headline. */
export function CurrentIncidents({
  incidents,
  now,
}: {
  incidents: IncidentView[];
  now: number;
}) {
  if (incidents.length === 0) return null;
  return (
    <section aria-label="Current incidents" className="mt-10 space-y-6">
      {incidents.map((view) => (
        <article
          key={view.id}
          className="rounded-xl border border-rule bg-none px-5 py-4"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <h2 className="page-heading flex items-center gap-2.5 text-[17px] font-medium leading-tight">
              <span
                aria-hidden="true"
                className={`block size-2 shrink-0 rounded-full ${
                  view.kind === "maintenance" ? "bg-rule-strong" : "bg-fail"
                }`}
              />
              {view.kind === "maintenance" ? "Maintenance: " : ""}
              {view.title}
            </h2>
            <span className="text-[13.5px] text-muted">
              {view.kind === "maintenance"
                ? maintenancePhase(view, now) === "scheduled"
                  ? "Scheduled"
                  : "In progress"
                : STATUS_LABELS[view.status]}
            </span>
          </div>
          <p className="mt-1.5 text-[13.5px] text-muted">
            {when(view, now)}
            {scope(view)}
          </p>
          <Updates view={view} now={now} />
        </article>
      ))}
    </section>
  );
}

/** Resolved incidents and finished maintenance, at the foot of the page. */
export function PastIncidents({
  incidents,
  now,
  days,
}: {
  incidents: IncidentView[];
  now: number;
  days: number;
}) {
  return (
    <section
      aria-label="Past incidents"
      className="mt-4 border-t border-rule py-8"
    >
      <h2 className="page-heading text-[17px] font-medium leading-tight">
        Past incidents
      </h2>
      {incidents.length === 0 ? (
        <p className="mt-2 text-[14px] text-muted">
          No incidents in the last {days} days.
        </p>
      ) : (
        <div className="mt-4 space-y-6">
          {incidents.map((view) => (
            <article key={view.id}>
              <h3 className="page-minor text-[15px] font-medium leading-tight">
                {view.kind === "maintenance" ? "Maintenance: " : ""}
                {view.title}
              </h3>
              <p className="mt-1 text-[13.5px] text-muted">
                {when(view, now)}
                {scope(view)}
              </p>
              <Updates view={view} now={now} />
              {view.postmortem && (
                <div className="mt-3 border-l-2 border-rule pl-4 text-[14px] leading-relaxed">
                  <p className="page-label mb-1 text-[12.5px] font-medium uppercase tracking-wide text-muted">
                    Post-mortem
                  </p>
                  <p className="whitespace-pre-line">{view.postmortem}</p>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
