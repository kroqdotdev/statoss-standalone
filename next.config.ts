import type { NextConfig } from "next";
import { parseBasePath } from "./src/lib/base-path";

// BASE_PATH serves the app under a path of a domain, like /status for
// example.com/status. It is read here, when the app is built; a wrong
// value stops the build with a message.
const basePath = parseBasePath(process.env.BASE_PATH);

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  // The server never reads the importer. The image copies the files it
  // runs from on its own (see the Dockerfile), and its fixtures stay out.
  outputFileTracingExcludes: { "**": ["src/lib/kuma/**"] },
  basePath,
  // Written into the app's code, server and browser, for src/lib/base-path.ts.
  env: { STATOSS_BASE_PATH: basePath },
};

export default nextConfig;
