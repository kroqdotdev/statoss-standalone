import type { NextConfig } from "next";
import { parseBasePath } from "./src/lib/base-path";

// BASE_PATH serves the app under a path of a domain, like /status for
// example.com/status. It is read here, when the app is built; a wrong
// value stops the build with a message.
const basePath = parseBasePath(process.env.BASE_PATH);

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  // The server runs its compiled bundles and reads no file under src. The
  // tracer still took every file there, tests and the importer's fixtures
  // included, from the config paths it cannot resolve at build time. The
  // image copies the importer's sources on its own (see the Dockerfile).
  outputFileTracingExcludes: { "**": ["src/**"] },
  basePath,
  // Written into the app's code, server and browser, for src/lib/base-path.ts.
  env: { STATOSS_BASE_PATH: basePath },
};

export default nextConfig;
