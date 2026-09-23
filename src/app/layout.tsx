import type { Metadata } from "next";
import localFont from "next/font/local";
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

export const metadata: Metadata = {
  title: "Status",
  description: "Service status and uptime",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${text.variable} ${display.variable} h-full`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
