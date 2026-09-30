import { describe, expect, it } from "vitest";
import { accentShades, accentVars, contrast, inkOn } from "./accent";

describe("accent", () => {
  it("keeps a colour that already reads, and shades one that does not", () => {
    // A deep plum reads on paper as it is; a yellow does not.
    expect(accentShades("#6d2a7a").day).toBe("#6d2a7a");
    const yellow = accentShades("#ffd400");
    expect(yellow.day).not.toBe("#ffd400");
    expect(contrast(yellow.day, "#f5f5f2")).toBeGreaterThanOrEqual(4.5);
    expect(yellow.night).toBe("#ffd400");
    expect(
      contrast(accentShades("#101060").night, "#121312"),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("puts black or white on a button, whichever reads", () => {
    expect(inkOn("#ffd400")).toBe("#161715");
    expect(inkOn("#6d2a7a")).toBe("#ffffff");
    // Mid green: white reads at about 3:1, the ink at nearly 6.
    expect(inkOn("#00aa00")).toBe("#161715");
  });

  it("makes the properties the page root takes, or none", () => {
    expect(accentVars("#6d2a7a")).toEqual({
      "--accent": "#6d2a7a",
      "--accent-ink": "#ffffff",
      "--accent-day": "#6d2a7a",
      "--accent-night": expect.stringMatching(/^#[0-9a-f]{6}$/),
    });
    expect(accentVars(undefined)).toBeUndefined();
  });
});
