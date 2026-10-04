import { readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { withBase } from "./base-path";
import { configPath } from "./config";

/**
 * A site's logo and favicon, when they are files next to the configuration
 * rather than addresses. Read from disk and served by the app, so the
 * status page needs no other host.
 */

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Images larger than this are not served. */
const MAX_BYTES = 1024 * 1024;

export function isRemote(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export interface Asset {
  body: Buffer;
  contentType: string;
  /** Changes when the file does, for the address's ?v= and the ETag. */
  version: string;
}

/**
 * The file a logo or favicon names, from the folder the configuration is
 * in. Null when it is an address, is missing, is not an image this serves,
 * is too large, or points outside that folder.
 */
export function readAsset(
  value: string | undefined,
  baseDir = dirname(resolve(configPath())),
): Asset | null {
  if (!value || isRemote(value)) return null;
  const contentType = TYPES[extname(value).toLowerCase()];
  if (!contentType) return null;
  const path = isAbsolute(value) ? value : resolve(baseDir, value);
  if (!isAbsolute(value) && !path.startsWith(baseDir + sep)) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return {
      body: readFileSync(path),
      contentType,
      version: `${stat.size.toString(36)}${Math.round(stat.mtimeMs).toString(36)}`,
    };
  } catch {
    return null;
  }
}

/**
 * Where the page finds the image: the address itself, or the app's own
 * route, under the base path, with a stamp that changes with the file.
 * Null when there is none.
 */
export function assetSrc(
  value: string | undefined,
  route: "/logo" | "/favicon",
): string | null {
  if (!value) return null;
  if (isRemote(value)) return value;
  const asset = readAsset(value);
  return asset ? withBase(`${route}?v=${asset.version}`) : null;
}
