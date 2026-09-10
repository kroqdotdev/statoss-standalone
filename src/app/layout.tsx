import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted so that `next build` (and the Docker build) needs no network.
// IBM Plex Sans, latin subset, variable weight axis. SIL Open Font License.
const plex = localFont({
  src: "./fonts/ibm-plex-sans-latin.woff2",
  variable: "--font-plex",
  weight: "400 600",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Status",
  description: "Service status and uptime",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plex.variable} h-full`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
