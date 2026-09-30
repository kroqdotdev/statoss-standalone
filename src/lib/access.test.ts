import { beforeEach, describe, expect, it } from "vitest";
import {
  clearFailures,
  MAX_FAILURES,
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

  it("stops after ten wrong passwords in a minute, and lets go after it", () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) noteFailure("h", 1000 + i);
    expect(tooManyFailures("h", 2000)).toBe(false);
    noteFailure("h", 2000);
    expect(tooManyFailures("h", 2001)).toBe(true);
    expect(tooManyFailures("other", 2001)).toBe(false);
    expect(tooManyFailures("h", 62_001)).toBe(false);
  });
});
