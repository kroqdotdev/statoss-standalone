import { timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  mayView,
  noteFailure,
  passwordMatches,
  tooManyFailures,
  UNLOCK_COOKIE,
  UNLOCK_DAYS,
  unlockToken,
} from "./access";
import { readAsset } from "./assets";
import { checkDetail, MAX_DETAIL_WINDOW_MS } from "./check-detail";
import { findSiteByHost, getConfig, siteUrl } from "./config";
import { bumpDataVersion } from "./data-version";
import { getDb, recordHeartbeat } from "./db";
import { FEED_DAYS, openImpacts } from "./incidents";
import {
  badgeJson,
  badgeSvg,
  feedAtom,
  feedXml,
  statusJson,
  widgetJs,
} from "./public-feeds";
import { pageOverall } from "./state";
import { liveSite, siteBudget } from "./status-data";

/**
 * The route handlers that live next to a status page: status.json, the
 * badge, the feed and the widget. Each picks the site by the Host header,
 * like the page itself.
 */

const CORS = { "access-control-allow-origin": "*" };

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

async function hostSite() {
  return findSiteByHost(getConfig(), (await headers()).get("host"));
}

type Site = NonNullable<Awaited<ReturnType<typeof hostSite>>>;

/**
 * The site a request is for, or the answer to give instead: 404 for a
 * hostname nobody configured, 401 for a password page without its cookie
 * or its embed key.
 */
async function currentSite(request?: Request): Promise<Site | Response> {
  const site = await hostSite();
  if (!site) return notFound();
  const cookie = (await cookies()).get(UNLOCK_COOKIE)?.value;
  const key = request ? new URL(request.url).searchParams.get("key") : null;
  if (!mayView(site, cookie, key))
    return new Response("This status page is password-protected.\n", {
      status: 401,
      headers: { ...CORS, "cache-control": "no-store" },
    });
  return site;
}

/** Shared caches may keep an open page's answers, never a locked one's. */
function cache(site: Site, seconds: number): string {
  return site.password ? "private, no-store" : `public, max-age=${seconds}`;
}

function label(request: Request): string {
  return (new URL(request.url).searchParams.get("label") ?? "status").slice(
    0,
    40,
  );
}

export async function statusJsonResponse(request: Request): Promise<Response> {
  const site = await currentSite(request);
  if (site instanceof Response) return site;
  const now = Date.now();
  const { incidents } = liveSite(site, now);
  return Response.json(
    statusJson(getDb(), site, incidents, now, {
      budget: siteBudget(getDb(), site, now),
      checkIntervalSeconds: getConfig().checkIntervalSeconds,
    }),
    {
      headers: { ...CORS, "cache-control": cache(site, 30) },
    },
  );
}

async function overallNow(site: Site) {
  const { statuses, incidents } = liveSite(site, Date.now());
  return pageOverall(statuses, openImpacts(incidents.current));
}

export async function badgeSvgResponse(request: Request): Promise<Response> {
  const site = await currentSite(request);
  if (site instanceof Response) return site;
  return new Response(badgeSvg(await overallNow(site), label(request)), {
    headers: {
      ...CORS,
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": cache(site, 60),
    },
  });
}

export async function badgeJsonResponse(request: Request): Promise<Response> {
  const site = await currentSite(request);
  if (site instanceof Response) return site;
  return Response.json(badgeJson(await overallNow(site), label(request)), {
    headers: { ...CORS, "cache-control": cache(site, 60) },
  });
}

async function feed(
  request: Request,
  build: typeof feedXml,
  contentType: string,
): Promise<Response> {
  const site = await currentSite(request);
  if (site instanceof Response) return site;
  const now = Date.now();
  const { incidents } = liveSite(site, now, FEED_DAYS);
  return new Response(build(site, incidents, now), {
    headers: {
      "content-type": `${contentType}; charset=utf-8`,
      "cache-control": cache(site, 300),
    },
  });
}

export const feedResponse = (request: Request) =>
  feed(request, feedXml, "application/rss+xml");
export const feedAtomResponse = (request: Request) =>
  feed(request, feedAtom, "application/atom+xml");

export async function widgetResponse(request: Request): Promise<Response> {
  const site = await currentSite(request);
  if (site instanceof Response) return site;
  return new Response(widgetJs(), {
    headers: {
      ...CORS,
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": cache(site, 3600),
    },
  });
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * A job's ping for a heartbeat monitor. The token names the monitor, on
 * whichever hostname the request came in, so a job needs no Host header.
 */
export async function heartbeatResponse(token: string): Promise<Response> {
  for (const site of getConfig().sites) {
    for (const monitor of site.monitors) {
      if (monitor.type !== "heartbeat" || !monitor.token) continue;
      if (!sameToken(monitor.token, token)) continue;
      recordHeartbeat(getDb(), site.name, monitor.name, Date.now());
      bumpDataVersion();
      return new Response("ok\n", {
        headers: { "cache-control": "no-store" },
      });
    }
  }
  return notFound();
}

/** A site's logo or favicon, when it is a file next to the configuration. */
export async function assetResponse(
  which: "logo" | "favicon",
  request: Request,
): Promise<Response> {
  const site = await hostSite();
  const asset = site ? readAsset(site[which]) : null;
  if (!asset) return notFound();
  const etag = `"${asset.version}"`;
  const headersOut = {
    etag,
    // An address carrying the file's stamp can be kept; a new file gets a
    // new address.
    "cache-control": new URL(request.url).searchParams.has("v")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300",
  };
  if (request.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers: headersOut });
  return new Response(new Uint8Array(asset.body), {
    headers: {
      ...headersOut,
      "content-type": asset.contentType,
      // An SVG is a document: it may draw, not run or load anything.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * The password form's answer. The right password sets the cookie and goes
 * back to the page; a wrong one goes back to the form, which says so.
 */
export async function unlockResponse(request: Request): Promise<Response> {
  const site = await hostSite();
  if (!site) return notFound();
  const token = unlockToken(site);
  if (token === null) redirect("/");
  const now = Date.now();
  const host = site.host.toLowerCase();
  if (tooManyFailures(host, now)) redirect("/?unlock=wait");
  const form = await request.formData().catch(() => null);
  const given = form?.get("password");
  if (typeof given !== "string" || !passwordMatches(site, given)) {
    noteFailure(host, now);
    redirect("/?unlock=wrong");
  }
  (await cookies()).set(UNLOCK_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: siteUrl(site).startsWith("https:"),
    path: "/",
    maxAge: UNLOCK_DAYS * 24 * 60 * 60,
  });
  redirect("/");
}

/**
 * The checks behind one bar of a monitor's strip, for the panel a bar
 * opens: /checks?monitor=<name>&from=<ms>&to=<ms>.
 */
export async function checksResponse(request: Request): Promise<Response> {
  const site = await currentSite(request);
  if (site instanceof Response) return site;
  const params = new URL(request.url).searchParams;
  const monitor = site.monitors.find((m) => m.name === params.get("monitor"));
  const from = Number(params.get("from"));
  const to = Number(params.get("to"));
  if (
    !monitor ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    to <= from ||
    to - from > MAX_DETAIL_WINDOW_MS
  )
    return new Response("Bad request", { status: 400 });
  return Response.json(
    checkDetail(
      getDb(),
      site.name,
      monitor.name,
      monitor.slowThresholdMs ?? null,
      from,
      to,
    ),
    // A bar in the past does not change; the current one does.
    { headers: { "cache-control": cache(site, to < Date.now() ? 300 : 15) } },
  );
}
