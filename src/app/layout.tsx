import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { accentVars } from "@/lib/accent";
import { assetSrc } from "@/lib/assets";
import { findSiteByHost, getConfig } from "@/lib/config";
import { SiteZone } from "@/lib/viewer-zone";
import "./globals.css";

// Self-hosted so that `next build` (and the Docker build) needs no network.
// Barlow for text, Barlow Condensed for headings. SIL Open Font License.
const text = localFont({
  src: [
    { path: "./fonts/barlow-400.woff2", weight: "400" },
    { path: "./fonts/barlow-500.woff2", weight: "500" },
    { path: "./fonts/barlow-600.woff2", weight: "600" },
  ],
  variable: "--font-barlow",
  display: "swap",
});

const display = localFont({
  src: [
    { path: "./fonts/barlow-condensed-500.woff2", weight: "500" },
    { path: "./fonts/barlow-condensed-600.woff2", weight: "600" },
    { path: "./fonts/barlow-condensed-700.woff2", weight: "700" },
  ],
  variable: "--font-barlow-cond",
  display: "swap",
});

/**
 * Every page belongs to the site its hostname names, so the tab's title,
 * icon and what search engines may do with it come from that site.
 */
export async function generateMetadata(): Promise<Metadata> {
  // headers() first: it is what makes the render wait for a request, and
  // the build, which has no configuration to read, stops there.
  const host = (await headers()).get("host");
  const site = findSiteByHost(getConfig(), host);
  if (!site)
    return { title: "Status", description: "Service status and uptime" };
  const favicon = assetSrc(site.favicon, "/favicon");
  return {
    title: `${site.name} status`,
    description: site.description ?? `Status and uptime of ${site.name}`,
    ...(favicon ? { icons: { icon: favicon } } : {}),
    // A password page is nobody's search result.
    ...(site.noindex || site.password
      ? { robots: { index: false, follow: false } }
      : {}),
    alternates: {
      types: {
        "application/rss+xml": "/feed.xml",
        "application/atom+xml": "/feed.atom",
      },
    },
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // headers() first: it is what makes the render wait for a request, and
  // the build, which has no configuration to read, stops there.
  const host = (await headers()).get("host");
  const site = findSiteByHost(getConfig(), host);
  return (
    <html
      lang="en"
      className={`${text.variable} ${display.variable} h-full`}
      data-theme={site && site.theme !== "auto" ? site.theme : undefined}
      style={accentVars(site?.accent)}
    >
      <body className="flex min-h-full flex-col">
        <SiteZone zone={site?.timezone ?? "UTC"}>{children}</SiteZone>
      </body>
    </html>
  );
}
