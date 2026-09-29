import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "./config";
import { clearIncidentFileCache, readIncidentFiles } from "./incident-files";

const CONFIG = parseConfig(`
sites:
  - name: webhooks.cc
    host: status.webhooks.cc
    monitors:
      - name: Main site
        url: https://webhooks.cc
`);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "statoss-incidents-"));
  clearIncidentFileCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readIncidentFiles", () => {
  it("is empty when the folder does not exist", () => {
    expect(readIncidentFiles(CONFIG, join(dir, "missing")).size).toBe(0);
  });

  it("reads every incident file and skips the rest", () => {
    writeFileSync(
      join(dir, "one.md"),
      "---\ntitle: One\nstarted: 2026-09-12T14:05:00Z\n---\nNotes.\n",
    );
    writeFileSync(
      join(dir, "two.yaml"),
      "title: Two\nstarted: 2026-09-13T14:05:00Z\n",
    );
    writeFileSync(join(dir, "README.txt"), "not an incident");
    writeFileSync(join(dir, ".draft.md"), "---\ntitle: Draft\n---\n");
    const bySite = readIncidentFiles(CONFIG, dir);
    expect(bySite.get("webhooks.cc")?.map((v) => v.title)).toEqual([
      "One",
      "Two",
    ]);
  });

  it("logs a bad file and keeps the good ones", () => {
    writeFileSync(join(dir, "bad.yaml"), "title: Bad\n");
    writeFileSync(
      join(dir, "good.yaml"),
      "title: Good\nstarted: 2026-09-13T14:05:00Z\n",
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bySite = readIncidentFiles(CONFIG, dir);
    expect(bySite.get("webhooks.cc")?.map((v) => v.title)).toEqual(["Good"]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("bad.yaml: started"),
    );
    errorSpy.mockRestore();
  });

  it("notices a file that was added or changed", () => {
    const path = join(dir, "one.yaml");
    writeFileSync(path, "title: One\nstarted: 2026-09-12T14:05:00Z\n");
    const first = readIncidentFiles(CONFIG, dir);
    expect(readIncidentFiles(CONFIG, dir)).toBe(first);
    writeFileSync(path, "title: Renamed\nstarted: 2026-09-12T14:05:00Z\n");
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    const second = readIncidentFiles(CONFIG, dir);
    expect(second).not.toBe(first);
    expect(second.get("webhooks.cc")?.[0].title).toBe("Renamed");
    writeFileSync(
      join(dir, "two.yaml"),
      "title: Two\nstarted: 2026-09-13T14:05:00Z\n",
    );
    expect(readIncidentFiles(CONFIG, dir).get("webhooks.cc")).toHaveLength(2);
  });
});
