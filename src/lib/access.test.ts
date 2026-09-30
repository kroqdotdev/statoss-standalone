import { beforeEach, describe, expect, it } from "vitest";
import {
  clearFailures,
  clientOf,
  MAX_FAILURES,
  MAX_SITE_FAILURES,
  mayView,
  noteFailure,
  passwordMatches,
  tooManyFailures,
  unlockToken,
} from "./access";

const OPEN = { host: "status.example.com" };
const LOCKED = { ...OPEN, password: "hunter22", embedKey: "embed-key-1" };

describe("password pages", () => {
  it("lets anyone see a site without a password", () => {
    expect(unlockToken(OPEN)).toBeNull();
    expect(mayView(OPEN, undefined)).toBe(true);
  });

  it("opens with the cookie the right password sets, and with nothing else", () => {
    const token = unlockToken(LOCKED)!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mayView(LOCKED, token)).toBe(true);
    expect(mayView(LOCKED, undefined)).toBe(false);
    expect(mayView(LOCKED, "hunter22")).toBe(false);
    expect(passwordMatches(LOCKED, "hunter22")).toBe(true);
    expect(passwordMatches(LOCKED, "hunter2")).toBe(false);
    expect(passwordMatches(OPEN, "")).toBe(false);
  });

  it("locks every browser out again when the password or the host changes", () => {
    const token = unlockToken(LOCKED)!;
    expect(mayView({ ...LOCKED, password: "another" }, token)).toBe(false);
    expect(mayView({ ...LOCKED, host: "other.example.com" }, token)).toBe(
      false,
    );
    expect(mayView({ ...LOCKED, host: "STATUS.example.com" }, token)).toBe(
      true,
    );
  });

  it("lets an embed in with the key, when one is set", () => {
    expect(mayView(LOCKED, undefined, "embed-key-1")).toBe(true);
    expect(mayView(LOCKED, undefined, "embed-key-2")).toBe(false);
    expect(mayView({ ...LOCKED, embedKey: undefined }, undefined, "")).toBe(
      false,
    );
  });
});

describe("the brake on guessing", () => {
  beforeEach(clearFailures);

  it("stops one address after ten wrong passwords in a minute, and lets go after it", () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) noteFailure("h", "a", 1000 + i);
    expect(tooManyFailures("h", "a", 2000)).toBe(false);
    noteFailure("h", "a", 2000);
    expect(tooManyFailures("h", "a", 2001)).toBe(true);
    // Somebody else on the same site is not held up by it.
    expect(tooManyFailures("h", "b", 2001)).toBe(false);
    expect(tooManyFailures("other", "a", 2001)).toBe(false);
    expect(tooManyFailures("h", "a", 62_001)).toBe(false);
  });

  it("stops the whole site after a hundred a minute from anywhere", () => {
    for (let i = 0; i < MAX_SITE_FAILURES; i++)
      noteFailure("h", `client-${i}`, 1000);
    expect(tooManyFailures("h", "new", 1001)).toBe(true);
  });

  it("knows the address the proxy forwarded", () => {
    expect(
      clientOf(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })),
    ).toBe("203.0.113.9");
    expect(clientOf(new Headers({ "x-real-ip": "203.0.113.7" }))).toBe(
      "203.0.113.7",
    );
    expect(clientOf(new Headers())).toBe("direct");
  });
});
