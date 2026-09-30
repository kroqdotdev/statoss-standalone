import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { IncidentRow } from "@/components/IncidentList";
import { SubPage } from "@/components/SubPage";
import { getDb } from "@/lib/db";
import { historyMonths, historyPage } from "@/lib/incident-history";
import { maintenanceOver } from "@/lib/incidents";
import { pageSite } from "@/lib/page-site";
import { siteIncidentViews } from "@/lib/status-data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Incident history" };

export default async function HistoryPage(props: PageProps<"/history">) {
  const [{ config, site, locked }, searchParams] = await Promise.all([
    pageSite(),
    props.searchParams,
  ]);
  if (!site) notFound();
  // A locked page's history is locked with it; the form is on the page.
  if (locked) redirect("/");
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  // What is over: resolved incidents and finished windows. What is open
  // is on the status page itself.
  const views = siteIncidentViews(getDb(), config, site, 0).filter((v) =>
    v.kind === "incident" ? v.resolvedAt !== null : maintenanceOver(v, now),
  );
  const { months, page, later, earlier } = historyPage(
    historyMonths(views, now, site.timezone),
    Number(searchParams.page),
  );
  return (
    <SubPage site={site.name}>
      <h1 className="page-title mt-8 text-[2rem] font-semibold leading-tight">
        Incident history
      </h1>
      {months.map((month) => (
        <section key={month.key} className="mt-8 border-t border-rule pt-5">
          <h2 className="page-group">{month.label}</h2>
          {month.incidents.length === 0 ? (
            <p className="mt-2 text-[14px] text-muted">No incidents.</p>
          ) : (
            <div className="mt-4 space-y-6">
              {month.incidents.map((view) => (
                <IncidentRow key={view.id} view={view} now={now} />
              ))}
            </div>
          )}
        </section>
      ))}
      {(later || earlier) && (
        <nav
          aria-label="More history"
          className="mt-10 flex justify-between border-t border-rule pt-5 text-[14px]"
        >
          {later ? (
            <Link
              href={page === 1 ? "/history" : `/history?page=${page - 1}`}
              className="page-link"
            >
              Later
            </Link>
          ) : (
            <span />
          )}
          {earlier && (
            <Link href={`/history?page=${page + 1}`} className="page-link">
              Earlier
            </Link>
          )}
        </nav>
      )}
    </SubPage>
  );
}
