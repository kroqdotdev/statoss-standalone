import { notFound } from "next/navigation";
import { SitePage } from "@/components/SitePage";
import { Unlock } from "@/components/Unlock";
import { assetSrc } from "@/lib/assets";
import { getDb } from "@/lib/db";
import { pageSite } from "@/lib/page-site";
import { RANGES, parseRange } from "@/lib/ranges";
import { statedByName } from "@/lib/stated";
import {
  componentViews,
  monitorView,
  rowNames,
  siteBudget,
  siteIncidents,
  siteIncidentViews,
} from "@/lib/status-data";

export const dynamic = "force-dynamic";

export default async function StatusPage(props: PageProps<"/">) {
  const [{ config, site, locked }, searchParams] = await Promise.all([
    pageSite(),
    props.searchParams,
  ]);
  if (!site) notFound();
  if (locked)
    return (
      <Unlock
        site={site.name}
        logo={assetSrc(site.logo, "/logo")}
        problem={
          typeof searchParams.unlock === "string"
            ? searchParams.unlock
            : undefined
        }
      />
    );

  const range = parseRange(searchParams.range, site.defaultRange);
  const db = getDb();
  // Request-scoped Server Component: `headers()` above is already the
  // per-request suspension point, so this timestamp is stable for the
  // lifetime of this render.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const incidents = siteIncidents(db, config, site, now);
  // Everything ever written, for naming on the bars it touched.
  const views = siteIncidentViews(db, config, site, 0);
  const stated = statedByName(incidents.current, rowNames(site), now);

  return (
    <SitePage
      name={site.name}
      logo={assetSrc(site.logo, "/logo")}
      description={site.description ?? null}
      supportUrl={site.supportUrl ?? null}
      foldGroups={site.foldGroups}
      defaultRange={site.defaultRange}
      monitors={site.monitors.map((cp) =>
        monitorView(
          db,
          site,
          cp,
          range,
          now,
          config.retentionDays,
          config.checkIntervalSeconds,
          views,
        ),
      )}
      components={componentViews(site, stated, { db, views, range, now })}
      stated={stated}
      incidents={incidents}
      budget={siteBudget(db, site, now)}
      retentionDays={config.retentionDays}
      range={RANGES[range].key}
      now={now}
      intervalSeconds={config.checkIntervalSeconds}
    />
  );
}
