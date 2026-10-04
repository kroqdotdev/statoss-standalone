import { afterEach, describe, expect, it, vi } from "vitest";
import {
  basePath,
  basePathMismatch,
  parseBasePath,
  withBase,
} from "./base-path";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseBasePath", () => {
  it("takes no value, or an empty one, as no base path", () => {
    expect(parseBasePath(undefined)).toBe("");
    expect(parseBasePath("")).toBe("");
  });

  it("takes a path of one or more parts", () => {
    expect(parseBasePath("/status")).toBe("/status");
    expect(parseBasePath("/standalone-demo")).toBe("/standalone-demo");
    expect(parseBasePath("/tools/status_v2.1~x")).toBe("/tools/status_v2.1~x");
  });

  it("refuses a path without a leading slash", () => {
    expect(() => parseBasePath("status")).toThrow(
      'Invalid BASE_PATH "status": it must start with a slash, like /status.',
    );
  });

  it("refuses a trailing slash, the root included", () => {
    expect(() => parseBasePath("/status/")).toThrow(
      "must not end with a slash",
    );
    expect(() => parseBasePath("/")).toThrow("must not end with a slash");
  });

  it("refuses characters a path should not carry, and empty or dot parts", () => {
    for (const value of [
      "/sta tus",
      "/status?x=1",
      "/status#top",
      "/a//b",
      "/./status",
      "/a/..",
      "/_next",
      "/%2e%2e",
      "/über",
      '/"x"',
      "/a\\b",
    ])
      expect(() => parseBasePath(value), value).toThrow(
        "may hold only letters, digits, dots, dashes, underscores and tildes",
      );
  });
});

describe("withBase", () => {
  it("leaves a path alone without a base path", () => {
    expect(withBase("/", "")).toBe("/");
    expect(withBase("/feed.xml", "")).toBe("/feed.xml");
    expect(withBase("/?unlock=wrong", "")).toBe("/?unlock=wrong");
  });

  it("puts the base path in front", () => {
    expect(withBase("/feed.xml", "/status")).toBe("/status/feed.xml");
    expect(withBase("/checks?monitor=API&from=1&to=2", "/a/b")).toBe(
      "/a/b/checks?monitor=API&from=1&to=2",
    );
    expect(withBase("/logo?v=abc", "/status")).toBe("/status/logo?v=abc");
  });

  it("makes the page the base path alone, with no slash Next would redirect", () => {
    expect(withBase("/", "/status")).toBe("/status");
    expect(withBase("/?unlock=wrong", "/status")).toBe("/status?unlock=wrong");
    expect(withBase("/#updates", "/status")).toBe("/status#updates");
  });

  it("reads the base path the build wrote in", () => {
    expect(basePath()).toBe("");
    expect(withBase("/feed.xml")).toBe("/feed.xml");
    vi.stubEnv("STATOSS_BASE_PATH", "/status");
    expect(basePath()).toBe("/status");
    expect(withBase("/feed.xml")).toBe("/status/feed.xml");
  });
});

describe("basePathMismatch", () => {
  it("says nothing when BASE_PATH is not set where the server starts, or agrees", () => {
    expect(basePathMismatch(undefined, "")).toBeNull();
    expect(basePathMismatch(undefined, "/status")).toBeNull();
    expect(basePathMismatch("/status", "/status")).toBeNull();
    expect(basePathMismatch("", "")).toBeNull();
  });

  it("says the base path is set at build time when they differ", () => {
    expect(basePathMismatch("/status", "")).toBe(
      '[base-path] BASE_PATH is "/status" here, but this build serves under no base path. BASE_PATH is read when the app is built: rebuild with it, for the image with --build-arg BASE_PATH=/status.',
    );
    expect(basePathMismatch("", "/status")).toContain('serves under "/status"');
  });
});
