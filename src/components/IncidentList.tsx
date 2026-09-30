import Link from "next/link";
import {
  formatDuration,
  formatUtcDateTime,
  formatUtcStamp,
  rowId,
} from "@/lib/format";
import {
  foldAutomatic,
  maintenancePhase,
  postmortemBlocks,
  STATUS_LABELS,
  type IncidentView,
} from "@/lib/incidents";
import { IMPACT_LABELS } from "@/lib/stated";

export function incidentHref(view: Pick<IncidentView, "id">): string {
  return `/incidents/${encodeURIComponent(view.id)}`;
}

/** The rows an incident names, each with the state it gives it, if any. */
export function Scope({
  view,
  linked = false,
}: {
  view: IncidentView;
  /** On the status page a name links to its row. */
  linked?: boolean;
}) {
  if (view.monitors.length === 0) return null;
  return (
    <>
      {" "}
      Affects{" "}
      {view.monitors.map((name, i) => {
        const state = view.states[name];
        return (
          <span key={name}>
            {i > 0 && ", "}
            {linked ? (
              <a href={`#${rowId(name)}`} className="page-link">
                {name}
              </a>
            ) : (
              name
            )}
            {state && state !== "none" && view.resolvedAt === null
              ? ` (${IMPACT_LABELS[state].toLowerCase()})`
              : ""}
          </span>
        );
      })}
      .
    </>
  );
}

/** One line about when: started, planned window, or resolved. */
export function when(view: IncidentView, now: number): string {
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

/** The word on the right of a card: a window's stage, or an incident's status. */
export function stateWord(view: IncidentView, now: number): string {
  if (view.kind !== "maintenance") return STATUS_LABELS[view.status];
  const phase = maintenancePhase(view, now);
  return phase === "scheduled"
    ? "Scheduled"
    : phase === "in-progress"
      ? "In progress"
      : "Completed";
}

export function Updates({ view, now }: { view: IncidentView; now: number }) {
  if (view.updates.length === 0) return null;
  return (
    <ol className="mt-3 space-y-2.5 text-[14px] leading-relaxed">
      {view.updates.map((u) => (
        <li
          key={`${u.createdAt}-${u.status}-${u.body.slice(0, 24)}`}
          className="grid gap-x-3 sm:grid-cols-[7.5rem_1fr]"
        >
          <span
            className="text-[13px] text-muted"
            title={formatUtcStamp(u.createdAt)}
          >
            {formatUtcDateTime(u.createdAt, now)}
          </span>
          <span>
            {view.kind === "incident" && (
              <>
                <span className="font-medium">
                  {STATUS_LABELS[u.status]}.
                </span>{" "}
              </>
            )}
            <span className="whitespace-pre-line">{u.body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A post-mortem, set as headings and paragraphs. */
export function Postmortem({ text }: { text: string }) {
  return (
    <div className="mt-4 border-l-2 border-rule pl-4 text-[14px] leading-relaxed">
      <p className="page-label mb-1 text-[12.5px] font-medium uppercase tracking-wide text-muted">
        Post-mortem
      </p>
      <div className="space-y-2.5">
        {postmortemBlocks(text).map((block, i) =>
          block.heading ? (
            <h3 key={i} className="page-minor pt-1 font-medium">
              {block.text}
            </h3>
          ) : (
            <p key={i}>{block.text}</p>
          ),
        )}
      </div>
    </div>
  );
}

const DOT = {
  none: "bg-fail",
  degraded: "bg-slow",
  partial: "bg-timeout",
  major: "bg-fail",
} as const;

function dot(view: IncidentView): string {
  if (view.kind === "maintenance") return "bg-rule-strong";
  // An outage the checker opened has no impact of its own, and is red.
  return view.auto ? "bg-fail" : DOT[view.impact];
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
  const automatic = incidents.filter((v) => v.auto).length;
  return (
    <section aria-label="Current incidents" className="mt-10 space-y-4">
      {foldAutomatic(incidents).map((view) => {
        // Several outages folded into one card have no one page to open.
        const folded = view.auto && automatic > 1;
        const title = `${view.kind === "maintenance" ? "Maintenance: " : ""}${view.title}`;
        return (
          <article
            key={view.id}
            className="rounded-xl border border-rule bg-none px-5 py-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <h2 className="page-heading flex items-center gap-2.5 text-[17px] font-medium leading-tight">
                <span
                  aria-hidden="true"
                  className={`block size-2 shrink-0 rounded-full ${dot(view)}`}
                />
                {folded ? (
                  title
                ) : (
                  <Link href={incidentHref(view)} className="hover:underline">
                    {title}
                  </Link>
                )}
              </h2>
              <span className="text-[13.5px] text-muted">
                {stateWord(view, now)}
              </span>
            </div>
            <p className="mt-1.5 text-[13.5px] text-muted">
              {when(view, now)}
              <Scope view={view} linked />
            </p>
            <Updates view={view} now={now} />
          </article>
        );
      })}
    </section>
  );
}

/** One resolved incident or finished window, as a row that opens its page. */
export function IncidentRow({
  view,
  now,
}: {
  view: IncidentView;
  now: number;
}) {
  const latest = view.kind === "incident" ? view.updates[0] : undefined;
  return (
    <article>
      <h3 className="page-minor text-[15px] font-medium leading-tight">
        <Link href={incidentHref(view)} className="hover:underline">
          {view.kind === "maintenance" ? "Maintenance: " : ""}
          {view.title}
        </Link>
      </h3>
      <p className="mt-1 text-[13.5px] text-muted">
        {when(view, now)}
        <Scope view={view} />
        {view.postmortem ? " Post-mortem inside." : ""}
      </p>
      {latest && !view.auto && (
        <p className="mt-1.5 text-[14px] leading-relaxed">{latest.body}</p>
      )}
    </article>
  );
}

/** The last days' resolved incidents and finished maintenance, at the foot of the page. */
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
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="page-heading text-[17px] font-medium leading-tight">
          Past incidents
        </h2>
        <Link href="/history" className="page-link text-[14px]">
          Incident history
        </Link>
      </div>
      {incidents.length === 0 ? (
        <p className="mt-2 text-[14px] text-muted">
          No incidents in the last {days} days.
        </p>
      ) : (
        <div className="mt-4 space-y-6">
          {incidents.map((view) => (
            <IncidentRow key={view.id} view={view} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}
