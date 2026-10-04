import type { AppConfig, ComponentState } from "./config";
import {
  isBetterStack,
  isHeroku,
  isInstatusSummary,
  isSlack,
  isSorryStatus,
  parseBetterStack,
  parseHeroku,
  parseInstatus,
  parseSlack,
  parseSorry,
  parseStatusIo,
  sorryOpenNotices,
  STATUS_IO_API,
  statusIoId,
  statusIoName,
} from "./vendor-formats";

/**
 * Vendor status. A component can stand for a vendor: it names the vendor's
 * public status page, and optionally one part of it. The scheduler reads
 * each such page every few minutes and the component's state follows it,
 * so the page says "GitHub reports an incident" before anyone has written
 * anything. Readings are kept in memory: after a restart the pages are
 * simply read again.
 *
 * Atlassian Statuspage's /api/v2/summary.json is read, which incident.io
 * pages serve too, a StatOSS page's /status.json, and the platforms in
 * vendor-formats.ts: Instatus, Better Stack, status.io, Sorry, and Heroku's
 * and Slack's own pages.
 */

/** How often each vendor page is read. */
export const VENDOR_REFRESH_MS = 5 * 60_000;
/** A reading older than this no longer moves a component. */
export const VENDOR_STALE_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** unknown: the page itself does not know, which is no reading at all. */
export type VendorState = "up" | "slow" | "down" | "unknown";

export interface VendorComponent {
  name: string;
  state: VendorState;
}

export interface VendorIncident {
  name: string;
  /** Where the vendor writes about it, or the vendor's page. */
  url: string;
  /** Names of the vendor's parts it touches. Empty when the page does not say. */
  components: string[];
}

/** One reading of a vendor page. */
export interface VendorReading {
  name: string | null;
  /** The whole page's state. */
  state: VendorState;
  components: VendorComponent[];
  incidents: VendorIncident[];
}

const COMPONENT_STATES: Record<string, VendorState> = {
  operational: "up",
  under_maintenance: "up",
  degraded_performance: "slow",
  partial_outage: "slow",
  major_outage: "down",
};

const INDICATOR_STATES: Record<string, VendorState> = {
  none: "up",
  maintenance: "up",
  minor: "slow",
  major: "slow",
  critical: "down",
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null;
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * A link out of a vendor's JSON, kept only when it is a web address: the
 * value ends up in an href on the page, and the vendor may be anyone.
 */
function webUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Reads a Statuspage summary.json, or incident.io's version of one. */
export function parseStatuspage(body: unknown, pageUrl: string): VendorReading {
  if (!isObject(body) || !isObject(body.status))
    throw new Error("not a status page summary");
  const indicator = text(body.status.indicator);
  if (!(indicator in INDICATOR_STATES))
    throw new Error("not a status page summary");
  const components = list(body.components)
    .filter(isObject)
    // A group row carries the worst of its members; the members say more.
    .filter((c) => c.group !== true)
    .map((c) => ({
      name: text(c.name),
      state: COMPONENT_STATES[text(c.status)] ?? "up",
    }))
    .filter((c) => c.name !== "");
  const incidents = list(body.incidents)
    .filter(isObject)
    .filter((i) => !["resolved", "postmortem"].includes(text(i.status)))
    .map((i) => ({
      name: text(i.name),
      url: webUrl(i.shortlink) ?? pageUrl,
      components: list(i.components)
        .filter(isObject)
        .map((c) => text(c.name))
        .filter((n) => n !== ""),
    }))
    .filter((i) => i.name !== "");
  return {
    name: isObject(body.page) ? text(body.page.name) || null : null,
    state: INDICATOR_STATES[indicator],
    components,
    incidents,
  };
}

const STATOSS_STATES: Record<string, VendorState> = {
  operational: "up",
  unknown: "unknown",
  degraded: "slow",
  partial: "slow",
  major: "down",
};

/**
 * Reads a StatOSS page's status.json: a hosted page's, which calls itself
 * `page`, or another standalone install's, which calls itself `site`.
 */
export function parseStatoss(body: unknown, pageUrl: string): VendorReading {
  const head = isObject(body)
    ? isObject(body.page)
      ? body.page
      : isObject(body.site)
        ? body.site
        : null
    : null;
  if (!isObject(body) || head === null || !Array.isArray(body.monitors))
    throw new Error("not a status.json");
  const overall = text(head.status);
  if (!(overall in STATOSS_STATES)) throw new Error("not a status.json");
  return {
    name: text(head.name) || null,
    state: STATOSS_STATES[overall],
    components: body.monitors.filter(isObject).map((m) => ({
      name: text(m.name),
      state:
        text(m.status) === "down"
          ? "down"
          : text(m.status) === "slow"
            ? "slow"
            : text(m.status) === "up"
              ? "up"
              : "unknown",
    })),
    incidents: list(body.incidents)
      .filter(isObject)
      .filter((i) => i.impact !== "none")
      .map((i) => ({
        name: text(i.title),
        url: webUrl(head.url) ?? pageUrl,
        // A hosted page lists objects with a name; a standalone one, names.
        components: list(i.monitors)
          .map((m) => (isObject(m) ? text(m.name) : text(m)))
          .filter((n) => n !== ""),
      }))
      .filter((i) => i.name !== ""),
  };
}

/**
 * The body as text, given up on at the cap while it is still arriving: an
 * address in a configuration may answer with a stream that never ends.
 */
async function cappedText(res: Response): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    void res.body?.cancel().catch(() => {});
    throw new Error("answer too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {});
      throw new Error("answer too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A vendor's answer other than 404 and success: the format may still be another. */
class Refused extends Error {}

/** A GET. Null on 404; a Refused on any other answer that is not a success. */
async function get(
  url: string,
  fetchFn: typeof fetch,
  accept = "application/json",
): Promise<{ headers: Headers; body: string } | null> {
  const res = await fetchFn(url, {
    headers: {
      accept,
      "user-agent":
        "statoss-standalone vendor status (+https://github.com/kroqdotdev/statoss-standalone)",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    if (res.status === 404) return null;
    throw new Refused(`answered ${res.status}`);
  }
  return { headers: res.headers, body: await cappedText(res) };
}

/** A GET for JSON. Null for a 404 or a body that is not JSON. */
async function getJson(
  url: string,
  fetchFn: typeof fetch,
): Promise<unknown | null> {
  const got = await get(url, fetchFn);
  if (got === null) return null;
  try {
    return JSON.parse(got.body) as unknown;
  } catch {
    return null;
  }
}

export type VendorFormat =
  | "statuspage"
  | "instatus"
  | "statoss"
  | "betterstack"
  | "statusio"
  | "sorry"
  | "heroku"
  | "slack";

/**
 * One reader per platform: the reading, or null when the address does not
 * serve that platform's feed. Each costs one request to rule out, Sorry
 * and status.io one or two more once recognised.
 */
const READERS: Record<
  VendorFormat,
  (url: string, fetchFn: typeof fetch) => Promise<VendorReading | null>
> = {
  async statuspage(url, fetchFn) {
    const body = await getJson(`${url}/api/v2/summary.json`, fetchFn);
    // Instatus answers at the same address in its own shape.
    if (body === null || isInstatusSummary(body)) return null;
    return parseStatuspage(body, url);
  },
  async instatus(url, fetchFn) {
    const summary = await getJson(`${url}/summary.json`, fetchFn);
    if (!isInstatusSummary(summary)) return null;
    const parts = await getJson(`${url}/v2/components.json`, fetchFn).catch(
      () => null,
    );
    return parseInstatus(summary, parts, url);
  },
  async statoss(url, fetchFn) {
    const body = await getJson(`${url}/status.json`, fetchFn);
    return body === null ? null : parseStatoss(body, url);
  },
  async betterstack(url, fetchFn) {
    const body = await getJson(`${url}/index.json`, fetchFn);
    return isBetterStack(body) ? parseBetterStack(body, url) : null;
  },
  async statusio(url, fetchFn) {
    const page = await get(url, fetchFn, "text/html");
    const id = statusIoId(page?.headers.get("x-status-page-id") ?? null);
    if (page === null || id === null) return null;
    const body = await getJson(`${STATUS_IO_API}/${id}`, fetchFn);
    if (body === null) return null;
    return parseStatusIo(body, url, id, statusIoName(page.body));
  },
  async sorry(url, fetchFn) {
    const status = await getJson(`${url}/api/v1/status`, fetchFn);
    if (!isSorryStatus(status)) return null;
    const [parts, notices] = await Promise.all([
      getJson(`${url}/api/v1/components`, fetchFn),
      getJson(
        `${url}/api/v1/notices?filter%5Btimeline_state_eq%5D=present`,
        fetchFn,
      ),
    ]);
    // Only a notice read on its own says which components it touches.
    const open = sorryOpenNotices(notices).slice(0, 5);
    const details = await Promise.all(
      open.map((id) =>
        getJson(`${url}/api/v1/notices/${id}`, fetchFn).catch(() => null),
      ),
    );
    return parseSorry(status, parts, details, url);
  },
  async heroku(url, fetchFn) {
    const body = await getJson(`${url}/api/v4/current-status`, fetchFn);
    return isHeroku(body) ? parseHeroku(body, url) : null;
  },
  async slack(url, fetchFn) {
    const body = await getJson(`${url}/api/v2.0.0/current`, fetchFn);
    return isSlack(body) ? parseSlack(body, url) : null;
  },
};

/** The order an address no format is remembered for is tried in. */
const ORDER = Object.keys(READERS) as VendorFormat[];

/** The parsers' "this is not my format", as against a failed connection. */
function isShapeError(err: unknown): boolean {
  return (
    err instanceof Error && /^not (a|an|Heroku's|Slack's) /.test(err.message)
  );
}

interface Stored {
  reading: VendorReading | null;
  /** When the page was last read with success. */
  fetchedAt: number | null;
  /** When it was last tried. */
  triedAt: number;
  error: string | null;
  format?: VendorFormat;
}

const globals = globalThis as { __statusVendors?: Map<string, Stored> };

function store(): Map<string, Stored> {
  globals.__statusVendors ??= new Map();
  return globals.__statusVendors;
}

/**
 * Status pages that are only a shell, by host, and the address their feed
 * is read from: status.stripe.com is Statuspage at www.stripestatus.com.
 */
const MOVED: Record<string, string> = {
  "status.stripe.com": "https://www.stripestatus.com",
};

/**
 * The address as it is kept: no query, no trailing slash, and no feed path
 * after it, since someone who pastes the feed's address means its page.
 */
export function normalizeVendorUrl(input: string): string {
  const url = new URL(input);
  const moved = MOVED[url.hostname.toLowerCase()];
  if (moved) return moved;
  const path = url.pathname
    .replace(
      /\/(api\/v2\/summary\.json|summary\.json|status\.json|index\.json|api\/v4\/current-status|api\/v2\.0\.0\/current|api\/v1\/status)$/i,
      "",
    )
    .replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/**
 * Reads a vendor's page in whichever format it serves. The format that read
 * last time is asked first, so a page is not asked for feeds it does not
 * have at every refresh; when it fails in any way the others are tried, so
 * a vendor that changes platform is read again at once. An address that
 * cannot be reached at all ends the round; one that answers in a shape or
 * a status a reader does not take moves on to the next.
 */
export async function fetchVendor(
  url: string,
  fetchFn: typeof fetch = fetch,
  known?: VendorFormat,
): Promise<{ reading: VendorReading; format: VendorFormat }> {
  const order: VendorFormat[] = known
    ? [known, ...ORDER.filter((f) => f !== known)]
    : [...ORDER];
  let failure: unknown = null;
  for (const format of order) {
    try {
      const reading = await READERS[format](url, fetchFn);
      if (reading === null) continue;
      return { reading, format };
    } catch (err) {
      // A refusal or a body of another shape: perhaps another platform.
      if (!(err instanceof Refused) && !isShapeError(err)) throw err;
      failure ??= err;
    }
  }
  if (failure !== null) throw failure;
  throw new Error("no status feed at that address");
}

/** What a vendor is called: its page's own name, or its address. */
export function vendorName(url: string, own?: string | null): string {
  // "Acme Status" is the page; the vendor is Acme.
  const name = own?.replace(/\s+status(\s+page)?$/i, "").trim();
  if (name) return name;
  try {
    return new URL(url).hostname.replace(/^(www|status)\./, "");
  } catch {
    return url;
  }
}

/** Every vendor page the configuration's components follow. */
export function vendorUrls(config: Pick<AppConfig, "sites">): string[] {
  return [
    ...new Set(
      config.sites.flatMap((site) =>
        site.components.flatMap((c) => (c.vendor ? [c.vendor] : [])),
      ),
    ),
  ];
}

/**
 * Reads the vendor pages that are due. Returns whether anything was read,
 * so the caller knows to draw the pages again.
 */
export async function refreshVendors(
  config: Pick<AppConfig, "sites">,
  now: number,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const due = vendorUrls(config).filter((url) => {
    const stored = store().get(url);
    return !stored || now - stored.triedAt >= VENDOR_REFRESH_MS;
  });
  await Promise.all(
    due.map(async (url) => {
      const before = store().get(url);
      // Marked as tried first, so a slow vendor is not asked twice at once.
      store().set(url, {
        reading: before?.reading ?? null,
        fetchedAt: before?.fetchedAt ?? null,
        triedAt: now,
        error: before?.error ?? null,
        format: before?.format,
      });
      try {
        const { reading, format } = await fetchVendor(
          url,
          fetchFn,
          before?.format,
        );
        if (before?.error) console.log(`[vendors] ${url} can be read again`);
        store().set(url, {
          reading,
          fetchedAt: now,
          triedAt: now,
          error: null,
          format,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (before?.error !== error)
          console.warn(`[vendors] ${url} could not be read: ${error}`);
        store().set(url, {
          reading: before?.reading ?? null,
          fetchedAt: before?.fetchedAt ?? null,
          triedAt: now,
          error,
        });
      }
    }),
  );
  return due.length > 0;
}

const PART_RANK: Record<VendorState, number> = {
  unknown: 0,
  up: 0,
  slow: 1,
  down: 2,
};

const STATES: Record<VendorState, ComponentState | null> = {
  up: "operational",
  slow: "degraded",
  down: "major",
  unknown: null,
};

/** What a component on this page shows for its vendor. */
export interface VendorView {
  /** The vendor's page. */
  url: string;
  /** Its hostname, for "reported by". */
  host: string;
  /** What the vendor is called, for alerts: its page's name, or the host. */
  name: string;
  /** The part of it this component follows, or null for the whole page. */
  part: string | null;
  /** Null until the vendor has been read, when it cannot be, or when the part is not there. */
  state: ComponentState | null;
  incidents: Array<{ name: string; url: string }>;
  /** Why there is no state. */
  problem: string | null;
}

/** The view of one vendor component from what was last read. */
export function vendorView(
  url: string,
  part: string | null,
  now: number,
): VendorView {
  const stored = store().get(url);
  const base = {
    url,
    host: new URL(url).host,
    name: vendorName(url, stored?.reading?.name),
    part,
    incidents: [],
  };
  if (!stored || stored.reading === null || stored.fetchedAt === null)
    return {
      ...base,
      state: null,
      problem: stored?.error ? "could not be read" : "not read yet",
    };
  if (now - stored.fetchedAt > VENDOR_STALE_MS)
    return { ...base, state: null, problem: "could not be read" };
  const { reading } = stored;
  if (part === null)
    return {
      ...base,
      state: STATES[reading.state],
      incidents: reading.incidents.map(({ name, url: link }) => ({
        name,
        url: link,
      })),
      problem:
        reading.state === "unknown" ? "does not know its own state" : null,
    };
  const key = part.trim().toLowerCase();
  const matches = reading.components.filter(
    (c) => c.name.trim().toLowerCase() === key,
  );
  if (matches.length === 0)
    return { ...base, state: null, problem: `has no part named "${part}"` };
  // A page may list one name under two headings; the worse of them counts.
  const known = matches.filter((c) => c.state !== "unknown");
  if (known.length === 0)
    return { ...base, state: null, problem: "does not know that part's state" };
  const found = known.reduce((a, b) =>
    PART_RANK[b.state] > PART_RANK[a.state] ? b : a,
  );
  return {
    ...base,
    state: STATES[found.state],
    // An incident that names no parts is about the whole vendor.
    incidents: reading.incidents
      .filter(
        (i) =>
          found.state !== "up" &&
          (i.components.length === 0 ||
            i.components.some((c) => c.trim().toLowerCase() === key)),
      )
      .map(({ name, url: link }) => ({ name, url: link })),
    problem: null,
  };
}

/** For tests. */
export function clearVendors(): void {
  store().clear();
}
