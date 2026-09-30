import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRemote, readAsset } from "./assets";

const dir = mkdtempSync(join(tmpdir(), "status-assets-"));
writeFileSync(
  join(dir, "logo.svg"),
  "<svg xmlns='http://www.w3.org/2000/svg'/>",
);
writeFileSync(join(dir, "notes.txt"), "hello");
writeFileSync(join(dir, "big.png"), Buffer.alloc(1024 * 1024 + 1));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readAsset", () => {
  it("reads an image next to the configuration, with its type and a stamp", () => {
    const asset = readAsset("logo.svg", dir);
    expect(asset?.contentType).toBe("image/svg+xml");
    expect(asset?.body.toString()).toContain("<svg");
    expect(asset?.version).toMatch(/^[0-9a-z]+$/);
  });

  it("serves nothing that is not an image, is too large, is missing or is an address", () => {
    expect(readAsset("notes.txt", dir)).toBeNull();
    expect(readAsset("big.png", dir)).toBeNull();
    expect(readAsset("none.png", dir)).toBeNull();
    expect(readAsset("https://example.com/logo.png", dir)).toBeNull();
    expect(readAsset(undefined, dir)).toBeNull();
    expect(isRemote("https://example.com/logo.png")).toBe(true);
  });

  it("does not leave the configuration's folder by a relative path", () => {
    expect(readAsset("../logo.svg", join(dir, "sub"))).toBeNull();
  });
});
