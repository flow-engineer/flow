// The CLI's colors, in one place: the help, the welcome, the chat (line and full screen) and the
// Markdown tools write all take theirs from here. The brand's accent sets most of them; the CLI
// file's `colors` replaces any part. Red is for errors only.

import { inspect } from "node:util";
import { brandOf, HEX, type CliConfig, type ColorPart } from "./commands.ts";

/**
 * How many colors the terminal shows: none (NO_COLOR, FORCE_COLOR=0, TERM=dumb), 16, 256, or RGB only when
 * COLORTERM says so. An RGB escape a terminal cannot read is taken apart into other codes: macOS
 * Terminal read #645bff's `38;2;100;91;255` as a grey background and red text.
 */
export function colorDepth(env: Record<string, string | undefined>): 0 | 16 | 256 | "rgb" {
  if (env.NO_COLOR || env.FORCE_COLOR === "0" || env.TERM === "dumb") return 0;
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return "rgb";
  return /256/.test(env.TERM ?? "") ? 256 : 16;
}

/** The nearest of the 256-color palette's cube and greys. */
export function nearest256(rgb: number[]): number {
  const cube = [0, 95, 135, 175, 215, 255];
  let closest = 16, distance = Infinity;
  for (let index = 16; index < 256; index++) {
    const n = index - 16;
    const candidate = index >= 232 ? Array(3).fill(8 + (index - 232) * 10)
      : [cube[Math.floor(n / 36)]!, cube[Math.floor(n / 6) % 6]!, cube[n % 6]!];
    const delta = candidate.reduce((sum, value, channel) => sum + (value - rgb[channel]!) ** 2, 0);
    if (delta < distance) { closest = index; distance = delta; }
  }
  return closest;
}

// The 16 basic colors as xterm draws them, by their codes; black and bright white are left out,
// since one of them is the background.
const BASIC: Array<[number, number[]]> = [
  [31, [205, 0, 0]], [32, [0, 205, 0]], [33, [205, 205, 0]], [34, [0, 0, 238]], [35, [205, 0, 205]], [36, [0, 205, 205]], [37, [229, 229, 229]],
  [90, [127, 127, 127]], [91, [255, 0, 0]], [92, [0, 255, 0]], [93, [255, 255, 0]], [94, [92, 92, 255]], [95, [255, 0, 255]], [96, [0, 255, 255]],
];

/** The SGR parameters for a hex color at this depth; undefined without color. */
export function colorCode(hex: string, depth: ReturnType<typeof colorDepth>): string | undefined {
  if (depth === 0) return undefined;
  const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  if (depth === "rgb") return `38;2;${rgb.join(";")}`;
  if (depth === 256) return `38;5;${nearest256(rgb)}`;
  const distance = (c: number[]) => c.reduce((sum, value, channel) => sum + (value - rgb[channel]!) ** 2, 0);
  return String(BASIC.reduce((best, next) => (distance(next[1]) < distance(best[1]) ? next : best))[0]);
}

/** One part's escape codes, opening and closing; `rgb` when it was given as a hex color. */
export interface Style { open: string; close: string; rgb?: number[] }

/** Every part's style at this terminal (undefined: the terminal's own color), which parts the CLI file set, and the terminal's depth (0: no styles at all, bold included). */
export type Palette = Record<ColorPart, Style | undefined> & { readonly chosen: ReadonlySet<ColorPart>; readonly depth: ReturnType<typeof colorDepth> };

const fg = (open: string, rgb?: number[]): Style => ({ open, close: "39", ...(rgb ? { rgb } : {}) });

/** A color as `colors` or brand.accent gives it (a name or six-digit hex), at this depth. */
function styleOf(value: string, depth: ReturnType<typeof colorDepth>): Style | undefined {
  if (HEX.test(value)) {
    const code = colorCode(value, depth);
    return code ? fg(code, [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16))) : undefined;
  }
  const named = (inspect.colors as Record<string, [number, number] | undefined>)[value];
  return named ? { open: String(named[0]), close: String(named[1]) } : undefined;
}

/**
 * The colors for this CLI at this terminal: none without color (`color` false, NO_COLOR,
 * TERM=dumb). The accent is colors.accent, else brand.accent, else the terminal's cyan; links,
 * inline code, keys and keywords follow it unless set themselves.
 */
export function palette(config: CliConfig, env: Record<string, string | undefined>, color = true): Palette {
  const depth = color ? colorDepth(env) : 0;
  const own = config.colors ?? {};
  const chosen = new Set(Object.keys(own) as ColorPart[]);
  const pick = (part: ColorPart, fallback: Style | undefined) => {
    if (depth === 0) return undefined;
    const value = own[part];
    return value === false ? undefined : value === undefined ? fallback : styleOf(value, depth);
  };
  const brand = brandOf(config).accent;
  const accent = pick("accent", (brand && HEX.test(brand) ? styleOf(brand, depth) : undefined) ?? fg("36"));
  return {
    chosen, depth, accent,
    heading: pick("heading", undefined), link: pick("link", accent), code: pick("code", accent), key: pick("key", accent), keyword: pick("keyword", accent),
    string: pick("string", fg("32")), number: pick("number", fg("33")), comment: pick("comment", fg("90")),
    muted: pick("muted", { open: "2", close: "22" }), success: pick("success", fg("32")), warning: pick("warning", fg("33")), error: pick("error", fg("31")),
  };
}

/** The palette for this io: colored only for a person's terminal (interactive). */
export function colorsAt(config: CliConfig, io: { interactive: boolean; env?: Record<string, string | undefined> }): Palette {
  return palette(config, io.env ?? process.env, io.interactive);
}

/** Bold, or a part's color; a list applies each. */
export type Paint = (style: ColorPart | "bold" | Array<ColorPart | "bold">, text: string) => string;

/** Paints with a palette, nothing without one. */
export function painter(colors: Palette | undefined): Paint {
  return (style, text) => {
    if (!colors?.depth) return text;
    const styles = (Array.isArray(style) ? style : [style]).map((s) => (s === "bold" ? { open: "1", close: "22" } : colors[s])).filter((s): s is Style => s !== undefined);
    return styles.length ? `\u001b[${styles.map((s) => s.open).join(";")}m${text}\u001b[${[...new Set(styles.map((s) => s.close))].join(";")}m` : text;
  };
}

/** How an exit's message is painted: sign-in needed (3) and --yes needed (4) are for doing, not failures. */
export function severity(code: number): "warning" | "error" {
  return code === 3 || code === 4 ? "warning" : "error";
}
