/**
 * The path the app is served under, such as /status for a page at
 * example.com/status. BASE_PATH sets it when the app is built (see
 * next.config.ts), and the build keeps it: Next prefixes its own links,
 * redirects from pages and files with it, and this module does the rest.
 */

/**
 * One part of the path: letters, digits, dots, dashes, underscores and
 * tildes, starting with a letter or digit, so never "." or "..".
 */
const PART = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/** What is wrong with a BASE_PATH that is set, or null. */
function basePathProblem(value: string): string | null {
  if (!value.startsWith("/")) return "must start with a slash";
  if (value.endsWith("/")) return "must not end with a slash";
  if (
    !value
      .slice(1)
      .split("/")
      .every((part) => PART.test(part))
  )
    return "may hold only letters, digits, dots, dashes, underscores and tildes, in parts separated by single slashes, each part starting with a letter or digit";
  return null;
}

/**
 * BASE_PATH as given to the build, checked. Unset or empty is no base
 * path (""). Anything else is "/" and one or more parts separated by
 * single slashes, like /status or /tools/status. Throws a message that
 * says what is wrong.
 */
export function parseBasePath(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  const problem = basePathProblem(value);
  if (problem === null) return value;
  throw new Error(
    `Invalid BASE_PATH "${value}": it ${problem}, like /status. Leave it unset to serve the app at the root of the domain.`,
  );
}

/**
 * The base path this build serves under, or "" for none. The build writes
 * the value in where this is read, so the browser's code has it too.
 */
export function basePath(): string {
  return process.env.STATOSS_BASE_PATH ?? "";
}

/**
 * A path of the app, such as /feed.xml, as a browser has to ask for it:
 * with the base path in front. The page itself is the base path alone,
 * /status rather than /status/, which Next would redirect.
 */
export function withBase(path: string, base = basePath()): string {
  if (!base) return path;
  if (path === "/" || path.startsWith("/?") || path.startsWith("/#"))
    return `${base}${path.slice(1)}`;
  return `${base}${path}`;
}

/**
 * What to log when BASE_PATH is set where the server starts but differs
 * from the one it was built with, which is the one it serves under. Null
 * when they agree or it is not set.
 */
export function basePathMismatch(
  given: string | undefined,
  built = basePath(),
): string | null {
  if (given === undefined || given === built) return null;
  return `[base-path] BASE_PATH is "${given}" here, but this build serves under ${built ? `"${built}"` : "no base path"}. BASE_PATH is read when the app is built: rebuild with it, for the image with --build-arg BASE_PATH=${given || '""'}.`;
}
