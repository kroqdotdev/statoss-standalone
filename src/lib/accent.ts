/**
 * A site's accent colour, made readable. Buttons keep the colour as given,
 * with black or white text on it; links and focus rings use a shade of it
 * that reads on the page's background in each theme, since an amber link
 * on paper or a navy one on charcoal all but disappears.
 */

/** What text sits on, by theme: the page and its cards. */
const DAY_BACKGROUNDS = ["#f5f5f2", "#e6e6e2"];
const NIGHT_BACKGROUNDS = ["#121312", "#1f211f"];
/** WCAG's contrast for body text. */
const TEXT_CONTRAST = 4.5;

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

function linear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast between two colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The colour itself when it reads on every background, or the nearest
 * shade toward black (by day) or white (by night) that does.
 */
function readableShade(
  hex: string,
  backgrounds: string[],
  toward: Rgb,
): string {
  const from = toRgb(hex);
  for (let step = 0; step <= 50; step++) {
    const t = step / 50;
    const shade = toHex([
      from[0] + (toward[0] - from[0]) * t,
      from[1] + (toward[1] - from[1]) * t,
      from[2] + (toward[2] - from[2]) * t,
    ]);
    if (backgrounds.every((bg) => contrast(shade, bg) >= TEXT_CONTRAST))
      return shade;
  }
  return toHex(toward);
}

/** The shades links and focus rings take in each theme. */
export function accentShades(hex: string): { day: string; night: string } {
  return {
    day: readableShade(hex, DAY_BACKGROUNDS, [0, 0, 0]),
    night: readableShade(hex, NIGHT_BACKGROUNDS, [255, 255, 255]),
  };
}

/** Whether the page's ink or white reads better on a colour, by contrast. */
export function inkOn(hex: string): string {
  const dark = "#161715";
  const light = "#ffffff";
  return contrast(hex, dark) >= contrast(hex, light) ? dark : light;
}

/**
 * The CSS custom properties the page root takes for an accent: the colour
 * for buttons, the text on it, and the readable shade for each theme.
 * Undefined for no accent.
 */
export function accentVars(
  accent: string | undefined,
): Record<string, string> | undefined {
  if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) return undefined;
  const shades = accentShades(accent);
  return {
    "--accent": accent,
    "--accent-ink": inkOn(accent),
    "--accent-day": shades.day,
    "--accent-night": shades.night,
  };
}
