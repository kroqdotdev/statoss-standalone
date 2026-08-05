import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const checkpointSchema = z.object({
  name: z.string().min(1),
  url: z.url(),
  expectStatus: z.number().int().min(100).max(599).optional(),
});

const smtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

const configSchema = z.object({
  checkIntervalSeconds: z.number().int().min(10).default(60),
  alerts: z.object({ smtp: smtpSchema }).optional(),
  sites: z
    .array(
      z.object({
        name: z.string().min(1),
        host: z.string().min(1),
        checkpoints: z.array(checkpointSchema).min(1),
      }),
    )
    .min(1),
});

export type AppConfig = z.infer<typeof configSchema>;
export type SiteConfig = AppConfig["sites"][number];
export type CheckpointConfig = SiteConfig["checkpoints"][number];
export type SmtpConfig = NonNullable<AppConfig["alerts"]>["smtp"];

export function parseConfig(yamlText: string): AppConfig {
  const result = configSchema.safeParse(parse(yamlText));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid config: ${details}`);
  }
  return result.data;
}

export function loadConfig(
  path = process.env.CONFIG_PATH ?? "./config.yaml",
): AppConfig {
  return parseConfig(readFileSync(path, "utf8"));
}

const globals = globalThis as { __statusConfig?: AppConfig };

export function getConfig(): AppConfig {
  globals.__statusConfig ??= loadConfig();
  return globals.__statusConfig;
}

export function findSiteByHost(
  config: AppConfig,
  hostHeader: string | null,
): SiteConfig | undefined {
  if (!hostHeader) return undefined;
  const host = hostHeader.split(":")[0].toLowerCase();
  return config.sites.find((site) => site.host.toLowerCase() === host);
}
