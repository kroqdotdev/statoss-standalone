import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import {
  CheckpointCard,
  type CheckpointView,
} from "@/components/CheckpointCard";
import { StatusBanner } from "@/components/StatusBanner";
import { findSiteByHost, getConfig } from "@/lib/config";
import { getDb, getState } from "@/lib/db";
import { dailyUptime, latencySeries } from "@/lib/queries";
import { overallStatus } from "@/lib/state";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function StatusPage() {
  const host = (await headers()).get("host");
  const site = findSiteByHost(getConfig(), host);
  if (!site) notFound();

  const db = getDb();
  // Request-scoped Server Component: `headers()` above is already the
  // per-request suspension point, so this timestamp is stable for the
  // lifetime of this render.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const sinceMs = now - DAY_MS;

  const checkpoints: CheckpointView[] = site.checkpoints.map((cp) => ({
    name: cp.name,
    status: getState(db, site.name, cp.name)?.status ?? "up",
    days: dailyUptime(db, site.name, cp.name, 90, now),
    latency: latencySeries(db, site.name, cp.name, sinceMs, now),
  }));

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <AutoRefresh />
      <h1 className="mb-6 text-2xl font-bold">{site.name} status</h1>
      <StatusBanner
        status={overallStatus(checkpoints.map((cp) => cp.status))}
      />
      <div className="mt-6 flex flex-col gap-4">
        {checkpoints.map((cp) => (
          <CheckpointCard
            key={cp.name}
            checkpoint={cp}
            sinceMs={sinceMs}
            untilMs={now}
          />
        ))}
      </div>
      <p className="mt-8 text-xs text-neutral-400">
        Updated {new Date(now).toUTCString()} · refreshes automatically
      </p>
    </main>
  );
}
