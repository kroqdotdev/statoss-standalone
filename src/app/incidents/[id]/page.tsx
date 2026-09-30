import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import {
  Postmortem,
  Scope,
  stateWord,
  Updates,
  When,
} from "@/components/IncidentList";
import { SubPage } from "@/components/SubPage";
import { getDb } from "@/lib/db";
import { LocalTime } from "@/components/LocalTime";
import { pageSite } from "@/lib/page-site";
import { findIncident } from "@/lib/status-data";

export const dynamic = "force-dynamic";

type Props = PageProps<"/incidents/[id]">;

async function load(props: Props) {
  const [{ config, site, locked }, { id }] = await Promise.all([
    pageSite(),
    props.params,
  ]);
  if (!site) return null;
  // A locked page's incidents are locked with it; the form is on the page.
  if (locked) redirect("/");
  // Next hands the id over decoded already.
  const view = findIncident(getDb(), config, site, id, Date.now());
  return view ? { site, view } : null;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const found = await load(props);
  return found
    ? { title: `${found.view.title} - ${found.site.name} status` }
    : {};
}

export default async function IncidentPage(props: Props) {
  const found = await load(props);
  if (!found) notFound();
  const { site, view } = found;
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  return (
    <SubPage site={site.name}>
      <article className="mt-8">
        <p className="text-[13.5px] text-muted">
          {view.kind === "maintenance" ? "Maintenance" : "Incident"},{" "}
          {stateWord(view, now).toLowerCase()}
        </p>
        <h1 className="page-title mt-1 text-[2rem] font-semibold leading-tight">
          {view.title}
        </h1>
        <p className="mt-3 text-[14.5px] text-muted">
          <When view={view} now={now} />
          <Scope view={view} />
        </p>
        <p className="mt-1 text-[13px] text-muted">
          {view.kind === "maintenance" && view.endsAt !== null ? (
            <>
              <LocalTime ts={view.startedAt} style="stamp" /> to{" "}
              <LocalTime ts={view.endsAt} style="stamp" />
            </>
          ) : (
            <>
              Started <LocalTime ts={view.startedAt} style="stamp" />
              {view.resolvedAt !== null && (
                <>
                  , resolved <LocalTime ts={view.resolvedAt} style="stamp" />
                </>
              )}
            </>
          )}
        </p>
        {view.postmortem && <Postmortem text={view.postmortem} />}
        <div className="mt-6 border-t border-rule pt-4">
          <h2 className="page-heading text-[17px] font-medium leading-tight">
            {view.kind === "maintenance" ? "Notes" : "Updates"}
          </h2>
          {view.updates.length === 0 ? (
            <p className="mt-2 text-[14px] text-muted">Nothing posted.</p>
          ) : (
            <Updates view={view} now={now} />
          )}
        </div>
      </article>
    </SubPage>
  );
}
