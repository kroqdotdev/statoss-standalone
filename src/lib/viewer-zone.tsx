"use client";

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/** Nothing ever changes it during a visit, so there is nothing to listen to. */
const subscribe = () => () => {};

/** The zone the visitor's browser is set to, or UTC when it does not say. */
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The zone the server writes times in: the site's `timezone`, or UTC. */
const SiteZoneContext = createContext("UTC");

export function SiteZone({
  zone,
  children,
}: {
  zone: string;
  children: ReactNode;
}) {
  return (
    <SiteZoneContext.Provider value={zone}>{children}</SiteZoneContext.Provider>
  );
}

/**
 * The visitor's time zone. While the server renders and the page hydrates
 * it is the site's zone, so the HTML matches; the browser then renders
 * again in its own.
 */
export function useViewerZone(): string {
  const fallback = useContext(SiteZoneContext);
  return useSyncExternalStore(subscribe, browserZone, () => fallback);
}
