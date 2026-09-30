import { expect, test as base, type Page } from "@playwright/test";

/**
 * What every journey gets: a way to say "this is a screen", which measures
 * it for sideways overflow.
 */

/** The password site answers on this address. */
export const LOCKED = "http://127.0.0.1:3222";

/** Elements that run past the viewport's right edge, ignoring intentional scrollers. */
export async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const vw = de.clientWidth;
    const out: string[] = [];
    if (de.scrollWidth > vw + 1) out.push(`page ${vw}->${de.scrollWidth}`);
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= vw + 1 && r.left >= -1) continue;
      if (getComputedStyle(el).position === "fixed") continue;
      // Inside a scroller, or clipped by an ancestor that fits: not overflow.
      let p = el.parentElement;
      let contained = false;
      while (p && p !== document.body) {
        const o = getComputedStyle(p).overflowX;
        const pr = p.getBoundingClientRect();
        if (
          ((o === "auto" || o === "scroll") && p.scrollWidth > p.clientWidth) ||
          ((o === "hidden" || o === "clip") &&
            pr.right <= vw + 1 &&
            pr.left >= -1)
        ) {
          contained = true;
          break;
        }
        p = p.parentElement;
      }
      if (contained) continue;
      const cls =
        typeof el.className === "string"
          ? el.className.split(" ").slice(0, 3).join(".")
          : "";
      out.push(
        `${el.tagName.toLowerCase()}.${cls} [${Math.round(r.left)},${Math.round(r.right)}]`,
      );
    }
    return out.slice(0, 12);
  });
}

export const test = base.extend<{
  /** Call once the screen has settled: fails when anything runs off the side. */
  fits: (name: string) => Promise<void>;
}>({
  fits: async ({ page }, provide) => {
    await provide(async (name) => {
      expect(await overflow(page), `sideways overflow on ${name}`).toEqual([]);
    });
  },
});

export { expect };
