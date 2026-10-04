import { timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  clientOf,
  mayView,
  noteFailure,
  passwordMatches,
  tooManyFailures,
  UNLOCK_COOKIE,
  UNLOCK_DAYS,
  unlockToken,
} from "./access";
import { readAsset } from "./assets";
import { basePath, withBase } from "./base-path";
import { describeBudget } from "./budget";
import { checkDetail, MAX_DETAIL_WINDOW_MS } from "./check-detail";
import { findSiteByHost, getConfig, siteUrl } from "./config";
import { bumpDataVersion } from "./data-version";
import { getDb, listDeploys, recordDeploy, recordHeartbeat } from "./db";
import { FEED_DAYS, openImpacts } from "./incidents";
import { handleMcp, mcpOverLimit, siteTools } from "./mcp";
import { judgeHeartbeat } from "./scheduler";
import {
  badgeJson,
  badgeSvg,
  feedAtom,
  feedXml,
  maintenanceIcs,
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
      deploys: listDeploys(getDb(), site.name, 0, now + 1, 5),
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

/** GET /maintenance.ics: the site's maintenance, for a calendar app. */
export async function calendarResponse(request: Request): Promise<Response> {
  const site = await currentSite(request);
  if (site instanceof Response) return site;
  return new Response(maintenanceIcs(site, Date.now()), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="maintenance.ics"',
      "cache-control": cache(site, 300),
    },
  });
}

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
      await judgeHeartbeat(site.name, monitor.name);
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
 * back to the page; a wrong one goes back to the form, which says so. A
 * route handler's redirect is not given the base path by Next, so it is
 * added here. The cookie is sent only under the base path, not to the rest
 * of the domain.
 */
export async function unlockResponse(request: Request): Promise<Response> {
  const site = await hostSite();
  if (!site) return notFound();
  const token = unlockToken(site);
  if (token === null) redirect(withBase("/"));
  const now = Date.now();
  const host = site.host.toLowerCase();
  const client = clientOf(request.headers);
  if (tooManyFailures(host, client, now)) redirect(withBase("/?unlock=wait"));
  const form = await request.formData().catch(() => null);
  const given = form?.get("password");
  if (typeof given !== "string" || !passwordMatches(site, given)) {
    noteFailure(host, client, now);
    redirect(withBase("/?unlock=wrong"));
  }
  (await cookies()).set(UNLOCK_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: siteUrl(site).startsWith("https:"),
    path: basePath() || "/",
    maxAge: UNLOCK_DAYS * 24 * 60 * 60,
  });
  redirect(withBase("/"));
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

// ---------------------------------------------------------------------------
// Deploy markers.

const DAY_MS = 24 * 60 * 60 * 1000;

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? "";
}

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * POST /deploys, from CI: {"version": "v1.2.3"}, with `note`, `url` and
 * `at` when wanted, and the DEPLOY_TOKEN as a bearer token. There is no
 * such address until the token is set.
 */
export async function deployPostResponse(request: Request): Promise<Response> {
  const token = process.env.DEPLOY_TOKEN;
  const site = await hostSite();
  if (!token || !site) return notFound();
  if (!sameToken(token, bearer(request)))
    return json(401, { error: "Send the deploy token as a bearer token." });
  const body: unknown = await request.json().catch(() => null);
  const field = (name: string): unknown =>
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)[name]
      : undefined;
  const version = field("version");
  if (typeof version !== "string" || !/^\S.{0,59}$/.test(version.trim()))
    return json(400, { error: "version: 1 to 60 characters." });
  const note = field("note");
  if (note !== undefined && (typeof note !== "string" || note.length > 200))
    return json(400, { error: "note: at most 200 characters." });
  const url = field("url");
  if (
    url !== undefined &&
    (typeof url !== "string" ||
      !/^https?:\/\/\S+$/.test(url) ||
      url.length > 500)
  )
    return json(400, { error: "url: an http or https address." });
  const now = Date.now();
  const given = field("at");
  const at =
    given === undefined
      ? now
      : typeof given === "number"
        ? given
        : typeof given === "string"
          ? Date.parse(given)
          : NaN;
  // A marker may be filed a little late, not ahead of time.
  if (!Number.isFinite(at) || at > now + 5 * 60_000 || at < now - 400 * DAY_MS)
    return json(400, {
      error: "at: a time in the past, in ISO 8601 or milliseconds.",
    });
  const deploy = recordDeploy(getDb(), site.name, {
    version: version.trim(),
    note: typeof note === "string" && note.trim() ? note.trim() : null,
    url: typeof url === "string" ? url : null,
    at,
  });
  bumpDataVersion();
  return json(201, { ...deploy, at: new Date(deploy.at).toISOString() });
}

/** GET /deploys: the site's markers of the last 90 days, newest first. */
export async function deployListResponse(request: Request): Promise<Response> {
  const site = await currentSite(request);
  if (site instanceof Response) return site;
  const now = Date.now();
  return Response.json(
    listDeploys(getDb(), site.name, now - 90 * DAY_MS, now + 1).map((d) => ({
      ...d,
      at: new Date(d.at).toISOString(),
    })),
    { headers: { ...CORS, "cache-control": cache(site, 60) } },
  );
}

// ---------------------------------------------------------------------------
// For programs that read: an MCP endpoint and llms.txt.

/** POST /mcp: the site's status, incidents and error budget as MCP tools. */
export async function mcpResponse(request: Request): Promise<Response> {
  const site = await currentSite(request);
  if (site instanceof Response) return site;
  const db = getDb();
  const config = getConfig();
  return handleMcp(
    request,
    siteTools(site.name, {
      status: () => {
        const now = Date.now();
        return statusJson(db, site, liveSite(site, now).incidents, now, {
          budget: siteBudget(db, site, now),
          checkIntervalSeconds: config.checkIntervalSeconds,
          deploys: listDeploys(db, site.name, 0, now + 1, 5),
        });
      },
      incidents: () => {
        const now = Date.now();
        const { current, past } = liveSite(site, now, FEED_DAYS).incidents;
        return [...current, ...past].sort((a, b) => b.startedAt - a.startedAt);
      },
      budget: () => {
        const now = Date.now();
        const budget = siteBudget(db, site, now);
        return budget ? describeBudget(budget, now) : null;
      },
    }),
    { name: `${site.name} status`, version: "1" },
    (messages) => mcpOverLimit(site.host.toLowerCase(), messages, Date.now()),
  );
}

/** GET /llms.txt: where a program should read this site from. */
export async function llmsResponse(request: Request): Promise<Response> {
  const site = await currentSite(request);
  if (site instanceof Response) return site;
  const base = siteUrl(site).replace(/\/$/, "");
  const rows = [
    ...site.monitors.map(
      (m) => `- ${m.name}${m.group ? ` (${m.group})` : ""}, ${m.type}`,
    ),
    ...site.components.map(
      (c) =>
        `- ${c.name}${c.group ? ` (${c.group})` : ""}, component${
          c.vendor ? `, follows ${c.vendor}` : ""
        }`,
    ),
  ].join("\n");
  const text = `# ${site.name} status

> ${site.description ?? `The current status of ${site.name}, updated as every check runs.`}

This is a StatOSS status page. Read it as a machine through the links below rather than scraping the HTML.
${
  site.password
    ? `
The page is password-protected. Every link below answers 401 without \`?key=<key>\`, the embed key the page's owner shares.
`
    : ""
}
- Status as JSON: ${base}/status.json
- Incidents as RSS: ${base}/feed.xml, as Atom: ${base}/feed.atom
- Maintenance as iCalendar: ${base}/maintenance.ics
- MCP endpoint (Streamable HTTP, POST JSON-RPC, tools get_status, list_incidents, get_error_budget): ${base}/mcp
- Badge: ${base}/badge.svg
- Deploy markers as JSON: ${base}/deploys
- The page for people: ${base}
- Past incidents by month, for people: ${base}/history; each incident at ${base}/incidents/<id>

## Monitors and components

${rows || "- None yet"}

## How to read status.json

site.status is one of operational, degraded, partial, major or unknown. Each monitor has a status of up, slow, down or unknown, a since time, lastCheckedAt, stale (true when its checks have stopped arriving, and its status is then unknown), uptime24h as a percentage and latencyMs24h, the median response time over the last 24 hours. Each component has a status of operational, degraded, partial or major; one with a vendor follows that vendor's status page and does not count toward site.status. budget, when the site has an uptime target, holds the month so far. incidents holds what is open; maintenance holds what is in progress or planned within the next week. Times inside incidents and maintenance are epoch milliseconds; the others are ISO 8601.
`;
  return new Response(text, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": cache(site, 300),
    },
  });
}
