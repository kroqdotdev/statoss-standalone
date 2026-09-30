import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SitePage } from "@/components/SitePage";
import { findSiteByHost, getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { RANGES, parseRange } from "@/lib/ranges";
import { monitorView, siteBudget, siteIncidents } from "@/lib/status-data";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const site = findSiteByHost(getConfig(), (await headers()).get("host"));
  return site ? { title: `${site.name} status` } : {};
}

export default async function StatusPage(props: PageProps<"/">) {
  const [host, searchParams] = await Promise.all([
    headers().then((h) => h.get("host")),
    props.searchParams,
  ]);
  const config = getConfig();
  const site = findSiteByHost(config, host);
  if (!site) notFound();

  const range = parseRange(searchParams.range);
  const db = getDb();
  // Request-scoped Server Component: `headers()` above is already the
  // per-request suspension point, so this timestamp is stable for the
  // lifetime of this render.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  return (
    <SitePage
      name={site.name}
      monitors={site.monitors.map((cp) =>
        monitorView(db, site, cp, range, now, config.retentionDays),
      )}
      budget={siteBudget(db, site, now)}
      retentionDays={config.retentionDays}
      incidents={siteIncidents(db, config, site, now)}
      range={RANGES[range].key}
      now={now}
      intervalSeconds={config.checkIntervalSeconds}
    />
  );
}
