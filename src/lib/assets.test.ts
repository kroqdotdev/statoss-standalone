import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { assetSrc, isRemote, readAsset } from "./assets";

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

describe("assetSrc", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("points at the app's own route with the file's stamp, under the base path", () => {
    vi.stubEnv("CONFIG_PATH", join(dir, "config.yaml"));
    const version = readAsset("logo.svg", dir)?.version;
    expect(assetSrc("logo.svg", "/logo")).toBe(`/logo?v=${version}`);
    vi.stubEnv("STATOSS_BASE_PATH", "/status");
    expect(assetSrc("logo.svg", "/logo")).toBe(`/status/logo?v=${version}`);
    expect(assetSrc("logo.svg", "/favicon")).toBe(
      `/status/favicon?v=${version}`,
    );
  });

  it("leaves an address as it is, and has nothing for a missing file", () => {
    vi.stubEnv("CONFIG_PATH", join(dir, "config.yaml"));
    vi.stubEnv("STATOSS_BASE_PATH", "/status");
    expect(assetSrc("https://example.com/logo.png", "/logo")).toBe(
      "https://example.com/logo.png",
    );
    expect(assetSrc("none.png", "/logo")).toBeNull();
    expect(assetSrc(undefined, "/logo")).toBeNull();
  });
});
