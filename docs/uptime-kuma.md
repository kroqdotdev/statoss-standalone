# The Uptime Kuma importer

`import-kuma` turns an Uptime Kuma installation into a configuration. The README's [Moving from Uptime Kuma](../README.md#moving-from-uptime-kuma) says how to use it and what maps to what. This note is about how it works.

## Files

| Path                          | Job                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `scripts/import-kuma.mts`     | The command: arguments, the configuration or `--env` on stdout, the summary on stderr.                |
| `src/lib/kuma/read.mts`       | Reads `kuma.db` or a Kuma 1 JSON backup into one shape.                                               |
| `src/lib/kuma/convert.mts`    | Maps that shape to sites, monitors, components, destinations and maintenance, with notes and secrets. |
| `src/lib/kuma/yaml.mts`       | Writes the YAML, with comments.                                                                       |
| `src/lib/kuma/fixtures/`      | Two Kuma databases as SQL and a Kuma 1 backup, made by the real Kuma (see below).                     |
| `src/lib/kuma/import.test.ts` | Runs every output through the app's own loader.                                                       |

## Plain Node, no build

The image runs the importer with Node's own TypeScript support, which is on by default from Node 22.18, from its sources. `pnpm import-kuma` turns it on with `--experimental-strip-types`, so a clone needs Node 22.6. So the files are `.mts`, import each other with the extension, and use only types that can be stripped. They depend on Node and `better-sqlite3` and nothing else: the image's `node_modules` holds what the server needs, and `yaml` and `zod` are inside the server's bundle, not there. That is why the importer writes its own YAML and repeats a few of the loader's rules (hostnames, methods, record types, token shape, name anchors) instead of importing them. The tests hold the two together.

The Dockerfile copies the four `.mts` files, puts an `import-kuma` script on the path, and gives `better-sqlite3` a plain name beside the hashed one Next uses. `next.config.ts` keeps `src/lib/kuma` out of the server's traced files.

## Reading

Every table is read with `SELECT *` and its columns looked up by name, so a database from 1.23, from 2.x, or upgraded from one to the other reads the same way; a missing column reads as its default. Kuma keeps the database in WAL mode, and while it runs, recent changes are only in `kuma.db-wal`. The importer reads in place when it can. A read-only mount cannot hold the shared-memory file SQLite needs for that, so then it copies `kuma.db` and `kuma.db-wal` to a temporary folder and reads the copy.

## Repeating maintenance

Kuma keeps every repeating schedule as a cron with a length in seconds, whichever way it was set up: weekdays, days of the month (`L` for the last), every day, or a cron written by hand. The importer reads that cron when it is one time of day on some weekdays or on some days of the month, and writes a window for each of those days, repeating weekly or monthly from its next start. A last day of the month becomes a window on the next 31st, which a monthly repeat keeps to the last day of shorter months. A site with repeating windows takes the zone of the first, since a repeat keeps its time of day in the site's zone.

## The output and the loader

The loader replaces `${NAME}` everywhere in the file, comments included, before it parses it. So every secret becomes such a reference, and a literal `${` in a value is written as `\x24{` inside double quotes, and as `$ {` in a comment. A secret that is not safe bare is put between double quotes; if it holds a quote or a backslash, the value printed by `--env` is escaped the way YAML reads it there.

## The fixtures

`kuma-1.23.sql` and `kuma-2.5.sql` were made by running `louislam/uptime-kuma:1` (1.23.17) and `louislam/uptime-kuma:2` (2.5.5) in Docker and adding monitors, notifications, two status pages and two maintenance windows through Kuma's socket.io API, the way its UI does. Then the tables the importer reads were dumped: their schema as Kuma made it, and each row with the columns that are not at their default. `kuma-1.23-backup.json` is the backup Kuma 1.23 builds from the same data, with its empty fields left out. To add a case, prefer a row in a test (`importRows`) over a new fixture.
