import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  // The server never reads the importer. The image copies the files it
  // runs from on its own (see the Dockerfile), and its fixtures stay out.
  outputFileTracingExcludes: { "**": ["src/lib/kuma/**"] },
};

export default nextConfig;
