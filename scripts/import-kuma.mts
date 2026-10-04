// import-kuma: prints a statoss-standalone configuration made from an
// Uptime Kuma database or backup, and a summary on stderr.
//
//   import-kuma <kuma.db | Kuma's data folder | backup.json> > config.yaml
//   import-kuma --env <same file> > .env
//
// Runs under plain Node (22.18 or newer), which reads the TypeScript itself:
// in the image as the import-kuma command, and from a clone as
// `pnpm -s import-kuma`.

import { basename } from "node:path";
import { convertKuma } from "../src/lib/kuma/convert.mts";
import { readKuma } from "../src/lib/kuma/read.mts";

const USAGE = `Usage: import-kuma [--env] <kuma.db, Kuma's data folder, or a Kuma 1 backup .json>

Prints a configuration for statoss-standalone, made from an Uptime Kuma
database or backup, and a summary of what came across on stderr.

  --env   print the secrets the configuration refers to, as NAME=value
          lines for a .env file, instead of the configuration

With Docker, mount the folder Kuma keeps its data in, and give the path
inside the container:

  docker run --rm -v uptime-kuma:/kuma:ro ghcr.io/kroqdotdev/statoss-standalone import-kuma /kuma > config.yaml
`;

function main(argv: string[]): number {
  const args = argv.filter((a) => a !== "--env");
  const wantEnv = args.length !== argv.length;
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const unknown = args.find((a) => a.startsWith("-"));
  if (args.length !== 1 || unknown) {
    process.stderr.write(
      unknown ? `import-kuma: unknown option ${unknown}\n\n${USAGE}` : USAGE,
    );
    return 2;
  }
  const [path] = args;
  let result;
  try {
    result = convertKuma(readKuma(path), { file: basename(path) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`import-kuma: ${message}\n`);
    if (message.startsWith("there is no"))
      process.stderr.write(
        "In Docker, give the path inside the container, where the file or folder is mounted.\n",
      );
    return 1;
  }
  process.stdout.write(wantEnv ? result.env : result.yaml);
  if (!wantEnv) process.stderr.write(result.summary);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
