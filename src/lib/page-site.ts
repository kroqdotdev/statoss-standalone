import { cookies, headers } from "next/headers";
import { mayView, UNLOCK_COOKIE } from "./access";
import { findSiteByHost, getConfig } from "./config";

/**
 * The site a page request is for, by its Host header, and whether this
 * browser may see it: a password page needs its cookie first.
 */
export async function pageSite() {
  const [host, jar] = await Promise.all([
    headers().then((h) => h.get("host")),
    cookies(),
  ]);
  const config = getConfig();
  const site = findSiteByHost(config, host);
  if (!site) return { config, site: undefined, locked: false } as const;
  const locked = !mayView(site, jar.get(UNLOCK_COOKIE)?.value);
  return { config, site, locked } as const;
}
