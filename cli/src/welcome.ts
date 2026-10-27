// What a person sees first: the welcome screen of a bare run at a terminal (the CLI's name in block
// letters, its version, a greeting, the sign-in, how to start) and, with signInFirst, the Sign in /
// Exit question asked before any command. Coding agents, scripts and pipes never see either: they
// get the help, or exit 3 with the sign-in command, as plain text.

import { emitKeypressEvents } from "node:readline";
import { styleText } from "node:util";
import { brandOf, type CliConfig } from "./commands.ts";
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

/** The accent for the banner: the brand's when it has one, else cyan. */
function accent(config: CliConfig, io: CliIO, paint: Paint): (text: string) => string {
  const env = io.env ?? process.env;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(brandOf(config).accent ?? "");
  if (hex && io.interactive && !env.NO_COLOR && env.TERM !== "dumb") {
    const [r, g, b] = hex.slice(1).map((h) => parseInt(h, 16));
    return (text) => text.split("\n").map((line) => `\u001b[38;2;${r};${g};${b}m${line}\u001b[39m`).join("\n");
  }
  return (text) => text.split("\n").map((line) => paint("cyan", line)).join("\n");
}

/** The welcome screen: banner, version, greeting, then (unless only the top is wanted) sign-in and tips. */
export function welcomeScreen(config: CliConfig, state: WelcomeState, io: CliIO, top = false): string {
  const options = config.welcome || {};
  const paint = painter(io);
  const indent = (text: string) => text.split("\n").map((line) => (line ? `  ${line}` : line)).join("\n");
  const art = options.banner === false ? undefined : options.banner ?? banner(config.name, io.columns || 80);
  const blocks: string[] = [];
  if (art) blocks.push(accent(config, io, paint)(indent(art.trimEnd())));
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
  return !["auth", "help", ...except].some((e) => {
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
