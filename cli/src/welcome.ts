// What a person sees first: the welcome screen of a bare run at a terminal (the CLI's name in block
// letters, its version, a greeting, the sign-in, how to start) and, with signInFirst, the Sign in /
// Exit question asked before any command. Coding agents, scripts and pipes never see either: they
// get the help, or exit 3 with the sign-in command, as plain text.

import { emitKeypressEvents } from "node:readline";
import { styleText } from "node:util";
import { brandOf, HEX, updatesItself, type CliConfig } from "./commands.ts";
import type { CliIO } from "./run.ts";

/** Claude Code, Cursor and Codex mark their commands' environment; their terminal is not a person's. */
export function codingAgent(env: Record<string, string | undefined>): boolean {
  return Boolean(env.CLAUDECODE || env.CURSOR_AGENT || env.CODEX_CI || env.AI_AGENT);
}

/** A person at a terminal, who can read a screen and answer a question. */
export function person(io: CliIO): boolean {
  return io.interactive && !codingAgent(io.env ?? process.env);
}

// Five rows a letter, "#" filled; letters without a glyph leave the banner out.
const FONT: Record<string, string> = {
  A: " ### /#   #/#####/#   #/#   #", B: "#### /#   #/#### /#   #/#### ", C: " ####/#    /#    /#    / ####",
  D: "#### /#   #/#   #/#   #/#### ", E: "#####/#    /#### /#    /#####", F: "#####/#    /#### /#    /#    ",
  G: " ####/#    /#  ##/#   #/ ####", H: "#   #/#   #/#####/#   #/#   #", I: "###/ # / # / # /###",
  J: "  ###/    #/    #/#   #/ ### ", K: "#   #/#  # /###  /#  # /#   #", L: "#    /#    /#    /#    /#####",
  M: "#   #/## ##/# # #/#   #/#   #", N: "#   #/##  #/# # #/#  ##/#   #", O: " ### /#   #/#   #/#   #/ ### ",
  P: "#### /#   #/#### /#    /#    ", Q: " ### /#   #/# # #/#  # / ## #", R: "#### /#   #/#### /#  # /#   #",
  S: " ####/#    / ### /    #/#### ", T: "#####/  #  /  #  /  #  /  #  ", U: "#   #/#   #/#   #/#   #/ ### ",
  V: "#   #/#   #/#   #/ # # /  #  ", W: "#   #/#   #/# # #/## ##/#   #", X: "#   #/ # # /  #  / # # /#   #",
  Y: "#   #/ # # /  #  /  #  /  #  ", Z: "#####/   # /  #  / #   /#####", "0": " ### /#  ##/# # #/##  #/ ### ",
  "1": " # /## / # / # /###", "2": "#### /    #/ ### /#    /#####", "3": "#### /    #/ ### /    #/#### ",
  "4": "#   #/#   #/#####/    #/    #", "5": "#####/#    /#### /    #/#### ", "6": " ### /#    /#### /#   #/ ### ",
  "7": "#####/    #/   # /  #  /  #  ", "8": " ### /#   #/ ### /#   #/ ### ", "9": " ### /#   #/ ####/    #/ ### ",
  "-": "    /    /####/    /    ", " ": "  /  /  /  /  ",
};

/** The name in block letters, two columns a dot when that fits the terminal, else one; undefined when neither fits. */
export function banner(name: string, columns = 80): string | undefined {
  const glyphs = [...name.toUpperCase()].map((c) => FONT[c]?.split("/"));
  if (!glyphs.length || glyphs.some((g) => !g)) return undefined;
  for (const scale of [2, 1]) {
    const rows = [0, 1, 2, 3, 4].map((r) => glyphs.map((g) => g![r]!.replace(/./g, (c) => (c === "#" ? "█" : " ").repeat(scale))).join(" ".repeat(scale)).trimEnd());
    if (Math.max(...rows.map((r) => r.length)) + 2 <= columns) return rows.join("\n");
  }
  return undefined;
}

export interface WelcomeState {
  server?: string;
  /** "env" when a token variable or --token is used, "login" for a stored sign-in, null for none. */
  signedIn: "env" | "login" | null;
  tokenEnv: string;
}

type Paint = (format: Parameters<typeof styleText>[0], text: string) => string;

function painter(io: CliIO): Paint {
  const env = io.env ?? process.env;
  return io.interactive && !env.NO_COLOR && env.TERM !== "dumb" ? (format, text) => styleText(format, text, { validateStream: false }) : (_f, text) => text;
}

/**
 * How many colors the terminal shows: none (NO_COLOR, TERM=dumb), 16, 256, or RGB only when
 * COLORTERM says so. An RGB escape a terminal cannot read is taken apart into other codes: macOS
 * Terminal read #645bff's `38;2;100;91;255` as a grey background and red text.
 */
export function colorDepth(env: Record<string, string | undefined>): 0 | 16 | 256 | "rgb" {
  if (env.NO_COLOR || env.TERM === "dumb") return 0;
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

/** The SGR parameters for the brand's accent, in as many colors as the terminal shows, else cyan's; undefined without color. */
export function accentCode(config: CliConfig, env: Record<string, string | undefined>): string | undefined {
  const depth = colorDepth(env);
  const hex = brandOf(config).accent;
  if (depth === 0) return undefined;
  return (hex && HEX.test(hex) ? colorCode(hex, depth) : undefined) ?? "36";
}

/** The banner in the accent. */
function accent(config: CliConfig, io: CliIO): (text: string) => string {
  const code = io.interactive ? accentCode(config, io.env ?? process.env) : undefined;
  return (text) => (code ? text.split("\n").map((line) => `\u001b[${code}m${line}\u001b[0m`).join("\n") : text);
}

/** The welcome screen: banner, version, greeting, then (unless only the top is wanted) sign-in and tips. */
export function welcomeScreen(config: CliConfig, state: WelcomeState, io: CliIO, top = false): string {
  const options = config.welcome || {};
  const paint = painter(io);
  const indent = (text: string) => text.split("\n").map((line) => (line ? `  ${line}` : line)).join("\n");
  const art = options.banner === false ? undefined : options.banner ?? banner(config.name, io.columns || 80);
  const blocks: string[] = [];
  if (art) blocks.push(accent(config, io)(indent(art.trimEnd())));
  blocks.push(indent([paint("bold", config.name), config.version ? paint("dim", `v${config.version}`) : ""].filter(Boolean).join(" ")));
  const title = options.title ?? `Welcome to ${brandOf(config).name}`;
  const text = options.text ?? config.description;
  blocks.push(indent([paint("bold", title), ...(text ? [text] : [])].join("\n")));
  if (!top) {
    blocks.push(signInLine(config, state, paint));
    blocks.push(tips(config, paint));
  }
  return `\n${blocks.join("\n\n")}\n\n`;
}

function signInLine(config: CliConfig, state: WelcomeState, paint: Paint): string {
  if (!state.server) return `  ${paint("yellow", "○")} No server: pass --server <url> or set ${config.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_SERVER.`;
  if (state.signedIn === "env") return `  ${paint("green", "●")} Signed in with ${state.tokenEnv}`;
  if (state.signedIn === "login") return `  ${paint("green", "●")} Signed in to ${state.server}`;
  return `  ${paint("yellow", "○")} Not signed in. ${paint("dim", `Run ${config.name} auth login to sign in.`)}`;
}

/** How to start: the team's own lines, else chat and --help. */
export function tips(config: CliConfig, paint: Paint = (_f, t) => t): string {
  const own = (config.welcome || {}).tips;
  if (own) return own.map((line) => `  ${line}`).join("\n");
  const rows: Array<[string, string]> = config.commands?.chat
    ? [[`${config.name} --help`, "See every command"]]
    : [[`${config.name} chat "<request>"`, "Ask for anything in plain words"], [`${config.name} chat`, "Start a conversation"], [`${config.name} --help`, "See every command"]];
  const width = Math.max(...rows.map(([c]) => c.length));
  return [`  ${paint("bold", "Get started")}`, ...rows.map(([c, brief]) => `    ${paint("cyan", c.padEnd(width))}  ${paint("dim", brief)}`)].join("\n");
}

/** Whether this command line waits for a sign-in under signInFirst. */
export function waitsForSignIn(config: CliConfig, words: string[]): boolean {
  if (!config.signInFirst) return false;
  if (words.includes("--help") || words.includes("-h")) return false;
  const first = words.filter((w) => !w.startsWith("-"));
  const except = typeof config.signInFirst === "object" ? (config.signInFirst.except ?? []) : [];
  return !["auth", "help", ...(updatesItself(config) ? ["update"] : []), ...except].some((e) => {
    const parts = e.trim().split(/\s+/);
    return parts.every((p, i) => first[i] === p);
  });
}

export function signInQuestion(config: CliConfig): string {
  return (typeof config.signInFirst === "object" && config.signInFirst.message) || `Please sign in to ${brandOf(config).name} to continue.`;
}

/**
 * An arrow-key menu on stderr: Up/Down (or j/k) move, Enter picks, a number picks that line,
 * Escape, q or Ctrl-C cancels. Resolves with the chosen line's index, or undefined.
 */
export async function chooseAtTerminal(question: string, options: string[], color = true): Promise<number | undefined> {
  const input = process.stdin;
  const out = process.stderr;
  const paint: Paint = color ? (format, text) => styleText(format, text, { validateStream: false }) : (_f, t) => t;
  let at = 0;
  const draw = (again: boolean) => {
    if (again) out.write(`\u001b[${options.length}A`);
    for (const [i, option] of options.entries()) out.write(`\r\u001b[2K  ${i === at ? paint(["bold", "cyan"], `> ${option}`) : `  ${option}`}\n`);
  };
  out.write(`  ${question}\n\n`);
  draw(false);
  emitKeypressEvents(input);
  const raw = input.isTTY && !input.isRaw;
  if (raw) input.setRawMode(true);
  input.resume();
  out.write("\u001b[?25l");
  try {
    return await new Promise<number | undefined>((resolve) => {
      const done = (value: number | undefined) => { input.off("keypress", key); resolve(value); };
      const key = (text: string | undefined, k: { name?: string; ctrl?: boolean } = {}) => {
        if (k.ctrl && k.name === "c") return done(undefined);
        if (k.name === "escape" || text === "q") return done(undefined);
        if (k.name === "return" || k.name === "enter") return done(at);
        const n = Number(text);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) { at = n - 1; draw(true); return done(at); }
        if (k.name === "up" || text === "k") at = (at + options.length - 1) % options.length;
        else if (k.name === "down" || text === "j" || k.name === "tab") at = (at + 1) % options.length;
        else return;
        draw(true);
      };
      input.on("keypress", key);
    });
  } finally {
    out.write("\u001b[?25h\n");
    if (raw) input.setRawMode(false);
    input.pause();
  }
}
