import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { incidentsDir, type AppConfig } from "./config";
import { parseIncidentFile, type IncidentView } from "./incidents";

/**
 * The incidents folder, read on demand. Every call lists the folder and
 * compares names, sizes and modification times with the last read, so a
 * file added or edited while the server runs shows up on the next request
 * and nothing is parsed twice. A file that does not parse is logged and
 * skipped; it never takes the page down.
 */

const INCIDENT_FILE = /\.(md|markdown|ya?ml)$/i;

export type IncidentsBySite = Map<string, IncidentView[]>;

interface Cache {
  signature: string;
  bySite: IncidentsBySite;
}

const globals = globalThis as { __statusIncidentFiles?: Cache };

function listFiles(dir: string): Array<{ name: string; signature: string }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: Array<{ name: string; signature: string }> = [];
  for (const name of names.sort()) {
    if (!INCIDENT_FILE.test(name) || name.startsWith(".")) continue;
    try {
      const stat = statSync(join(dir, name));
      if (!stat.isFile()) continue;
      files.push({ name, signature: `${name}:${stat.size}:${stat.mtimeMs}` });
    } catch {
      // Removed between the listing and the stat. Skip it.
    }
  }
  return files;
}

export function readIncidentFiles(
  config: AppConfig,
  dir = incidentsDir(),
): IncidentsBySite {
  const files = listFiles(dir);
  const signature = files.map((f) => f.signature).join("\n");
  const cache = globals.__statusIncidentFiles;
  if (cache && cache.signature === signature) return cache.bySite;

  const bySite: IncidentsBySite = new Map();
  for (const file of files) {
    try {
      const text = readFileSync(join(dir, file.name), "utf8");
      const { site, view } = parseIncidentFile(file.name, text, config);
      const list = bySite.get(site.name) ?? [];
      list.push(view);
      bySite.set(site.name, list);
    } catch (err) {
      console.error(
        `[incidents] ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  globals.__statusIncidentFiles = { signature, bySite };
  return bySite;
}

/** For tests. */
export function clearIncidentFileCache(): void {
  delete globals.__statusIncidentFiles;
}
