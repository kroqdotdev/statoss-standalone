import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import {
  CheckpointSection,
  type CheckpointView,
} from "@/components/CheckpointSection";
import { RangeSwitch } from "@/components/RangeSwitch";
import { StatusHeadline } from "@/components/StatusHeadline";
import { cached } from "@/lib/cache";
import { findSiteByHost, getConfig } from "@/lib/config";
import { getDb, getState } from "@/lib/db";
import { formatUtcClock } from "@/lib/format";
import {
  bucketSeries,
  failureRuns,
  rangeWindow,
  windowSummary,
} from "@/lib/queries";
import { RANGES, parseRange } from "@/lib/ranges";
import { overallStatus } from "@/lib/state";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

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
  const spec = RANGES[range];
  const db = getDb();
  // Request-scoped Server Component: `headers()` above is already the
  // per-request suspension point, so this timestamp is stable for the
  // lifetime of this render.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const { start, end } = rangeWindow(spec, now);
  const intervalMs = config.checkIntervalSeconds * 1000;

  const checkpoints: CheckpointView[] = site.checkpoints.map((cp) => {
    const state = getState(db, site.name, cp.name);
    // The aggregate queries scan the whole window, so they are computed once
    // per scheduler tick and shared by every request until new checks land.
    const data = cached(`${site.name}\0${cp.name}\0${range}`, () => ({
      buckets: bucketSeries(db, site.name, cp.name, spec, now),
      summary: windowSummary(db, site.name, cp.name, start, end),
      runs: failureRuns(db, site.name, cp.name, start, end),
      last24h: windowSummary(db, site.name, cp.name, now - DAY_MS, now + 1),
    }));
    return {
      name: cp.name,
      status: state?.status ?? "up",
      since: state?.since ?? null,
      ...data,
    };
  });

  return (
    <main className="mx-auto w-full max-w-[46rem] px-5 py-12 sm:py-20">
      <AutoRefresh intervalMs={intervalMs} />
      <StatusHeadline
        site={site.name}
        overall={overallStatus(checkpoints.map((cp) => cp.status))}
        checkpoints={checkpoints}
        now={now}
      />

      <div className="mt-12 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3 pb-5 sm:mt-16">
        <RangeSwitch current={range} />
        <p className="text-[13px] leading-snug text-muted">
          Bar height is response time. Amber is a timeout, red is another failed
          check.
        </p>
      </div>

      {checkpoints.map((cp) => (
        <CheckpointSection
          key={cp.name}
          checkpoint={cp}
          range={range}
          now={now}
          intervalMs={intervalMs}
        />
      ))}

      <footer className="border-t border-rule pt-6 text-[13px] leading-relaxed text-muted">
        <p>
          Checks run every {config.checkIntervalSeconds} seconds. Times are UTC.
          Updated {formatUtcClock(now)}, and this page refreshes on its own.
        </p>
      </footer>
    </main>
  );
}
