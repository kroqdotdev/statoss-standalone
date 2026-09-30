import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * The browser journeys: the built server against a seeded database, at
 * desktop and phone width. `pnpm build` first; `pnpm e2e` seeds, starts
 * and runs. Every screen is measured for sideways overflow (see
 * e2e/journeys.ts).
 */
const PORT = 3222;

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.journey\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      // What the monitors check.
      command: "node e2e/target.mjs",
      url: "http://127.0.0.1:3224/ok",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // The seed runs before the server, which then finds its
      // configuration, its incidents and its database in .e2e/. The
      // standalone build does not carry the static files; they are copied
      // next to it, as the Dockerfile does.
      command:
        "node e2e/seed.mts && cp -r .next/static .next/standalone/.next/ && node .next/standalone/server.js",
      url: `http://localhost:${PORT}/status.json`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(PORT),
        HOSTNAME: "127.0.0.1",
        // Absolute: the standalone server moves to its own folder at start.
        CONFIG_PATH: resolve(".e2e/config.yaml"),
        DB_PATH: resolve(".e2e/status.db"),
        DEPLOY_TOKEN: "journey-deploy-token",
      },
    },
  ],
});
