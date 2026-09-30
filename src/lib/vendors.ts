import type { AppConfig, ComponentState } from "./config";

/**
 * Vendor status. A component can stand for a vendor: it names the vendor's
 * public status page, and optionally one part of it. The scheduler reads
 * each such page every few minutes and the component's state follows it,
 * so the page says "GitHub reports an incident" before anyone has written
 * anything. Readings are kept in memory: after a restart the pages are
 * simply read again.
 *
 * Two formats are read: Atlassian Statuspage's /api/v2/summary.json, which
 * incident.io pages serve too, and a StatOSS page's /status.json.
 */

/** How often each vendor page is read. */
export const VENDOR_REFRESH_MS = 5 * 60_000;
/** A reading older than this no longer moves a component. */
export const VENDOR_STALE_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type VendorState = "up" | "slow" | "down";

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
  unknown: "up",
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
            : "up",
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

/** A GET for JSON. Null for a 404 or a body that is not JSON. */
async function getJson(
  url: string,
  fetchFn: typeof fetch,
): Promise<unknown | null> {
  const res = await fetchFn(url, {
    headers: {
      accept: "application/json",
      "user-agent":
        "statoss-standalone vendor status (+https://github.com/kroqdotdev/statoss-standalone)",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    if (res.status === 404) return null;
    throw new Error(`answered ${res.status}`);
  }
  try {
    return JSON.parse(await cappedText(res)) as unknown;
  } catch (err) {
    if (err instanceof Error && err.message === "answer too large") throw err;
    return null;
  }
}

type VendorFormat = "statuspage" | "statoss";

const FEED_PATH: Record<VendorFormat, string> = {
  statuspage: "/api/v2/summary.json",
  statoss: "/status.json",
};

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

/** The address as it is kept: no trailing slash, no query. */
export function normalizeVendorUrl(input: string): string {
  const url = new URL(input);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Reads a vendor's page in whichever of the two formats it serves. The
 * format that read last time is asked first; when that one fails the other
 * is tried, so a vendor that changes platform is read again at once.
 */
export async function fetchVendor(
  url: string,
  fetchFn: typeof fetch = fetch,
  known?: VendorFormat,
): Promise<{ reading: VendorReading; format: VendorFormat }> {
  const order: VendorFormat[] =
    known === "statoss" ? ["statoss", "statuspage"] : ["statuspage", "statoss"];
  let failure: unknown = null;
  for (const format of order) {
    try {
      const body = await getJson(`${url}${FEED_PATH[format]}`, fetchFn);
      if (body === null) continue;
      const reading =
        format === "statuspage"
          ? parseStatuspage(body, url)
          : parseStatoss(body, url);
      return { reading, format };
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure !== null) throw failure;
  throw new Error("no status feed at that address");
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

const STATES: Record<VendorState, ComponentState> = {
  up: "operational",
  slow: "degraded",
  down: "major",
};

/** What a component on this page shows for its vendor. */
export interface VendorView {
  /** The vendor's page. */
  url: string;
  /** Its hostname, for "reported by". */
  host: string;
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
  const base = { url, host: new URL(url).host, part, incidents: [] };
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
      problem: null,
    };
  const key = part.trim().toLowerCase();
  const found = reading.components.find(
    (c) => c.name.trim().toLowerCase() === key,
  );
  if (!found)
    return { ...base, state: null, problem: `has no part named "${part}"` };
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
