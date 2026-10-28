// An organization's CLI commands: every tool of its MCP server is a command under its own name
// (place_order → `place-order`), and the CLI file the team's coding agent writes (defineCli) adds
// what needs judgement: command groups and verbs (`order place`, where `order` is a group whose
// help lists its subcommands), the positional arguments, a table's columns, examples, aliases, and
// commands of its own. cliProblems is the rule-based check that keeps that file true to the tools;
// it never judges taste.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command as StricliCommand, CommandContext } from "@stricli/core";
import { FEEDBACK_NUDGE } from "../../src/skills.ts";

export interface ToolCommand {
  /** The tool this command calls. */
  tool: string;
  /** Input fields taken from positional arguments, in order (`order view 1042` → orderId). */
  args?: string[];
  /** For a list: the columns of the table people see. */
  columns?: string[];
  /** For one record: the fields people see, in order. */
  view?: string[];
  /**
   * Shorter ways to type its input flags, each naming an input field: a letter is a short flag
   * ({ n: "limit" } → `-n 5`), a word is the flag's name ({ all: "include_revoked" } → `--all`).
   * The field's own flag keeps working.
   */
  shorthands?: Record<string, string>;
  /** Values sent for inputs the person leaves out ({ limit: 20 }); they can still pass their own. */
  defaults?: Record<string, unknown>;
  /** Input fields with no flag: set by defaults or input, so people cannot change them. */
  hidden?: string[];
  /** A flag's line in help, by input field (default: the field's description). */
  help?: Record<string, string>;
  /** Flags of the command's own that are not tool inputs (`--from-file`); input gets their values. */
  options?: Record<string, CliOption>;
  /**
   * Your own code over what is sent: gets the input the person typed (defaults filled) and the
   * options' values, returns the tool's input. An error it throws is shown as wrong arguments (exit 2).
   */
  input?: (input: Record<string, unknown>, options: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Your own output for people: gets the tool's result, returns the text to print. --json and --fields still print the data. */
  print?: (result: unknown) => string | Promise<string>;
  /** Another name for the command. */
  alias?: string;
  /** One line under the command in help (default: the tool's title). */
  summary?: string;
  examples?: string[];
}

/** A flag of a command's own, not one of its tool's inputs. */
export interface CliOption {
  /** Its line in help. */
  help: string;
  /** What it takes (default "string"); a boolean takes no value. */
  kind?: "string" | "number" | "boolean";
  /** A one-letter form (`-f`). */
  short?: string;
}

/** What a command of the team's own gets as `this` (Stricli's context): the server's tools and the CLI's output. */
export interface CliContext extends CommandContext {
  readonly cli: {
    /** Call one of the server's tools; resolves with its result, throws its error. */
    call(tool: string, input: Record<string, unknown>): Promise<unknown>;
    /** Print a value as the CLI prints tool results (a table, fields, or JSON with --json). */
    print(value: unknown, options?: { json?: boolean; fields?: string[]; columns?: string[] }): void;
  };
}

/** A command of the team's own: any Stricli command (buildCommand from @stricli/core), one level down. */
export interface CustomCommand {
  command: StricliCommand<CliContext>;
}

export type CommandConfig = ToolCommand | CustomCommand | CommandBuilder;

export interface CliConfig {
  /** The command's name ("acme"): its help, its config folder (~/.config/<name>) and token variable. */
  name: string;
  /** The CLI client version sent to the server (default "1"). */
  version?: string;
  /** The organization's MCP endpoint. Else `--server` or <NAME>_SERVER. */
  server?: string;
  /**
   * The MCP server a CLI packed for an environment uses (`flow cli pack --server production`, and
   * flow deploy), in place of the hosted agent's address: an https URL such as
   * https://cli.acme.com/mcp, a domain of the agent's own. People's sign-ins are kept by server, so
   * once a CLI is out, this never changes.
   */
  servers?: { production?: string; staging?: string };
  /** The agent terminal URL; default the server origin plus /agent/terminal. */
  agent?: string;
  /**
   * The brand, set once: the chat, the welcome banner and the sign-in page read it. `name` is how
   * people see it written (default the command's name), `logo` an https or data:image URL, and
   * `accent` a six-digit hex color.
   */
  brand?: Brand;
  /** Human chat inherits the terminal's colors. `accent` is the older name for brand.accent. */
  chat?: { accent?: string };
  /** The variable a token is read from for CI and agents (default <NAME>_TOKEN). */
  tokenEnv?: string;
  /** Override the local credential/conversation/discovery directory, e.g. for an isolated embedded session. */
  directory?: string;
  /** Use cached tools immediately; revalidate in the background every five minutes. false disables caching. */
  discoveryCache?: false | { maxAgeMs?: number };
  description?: string;
  /** Commands by their words ("order place"): the first words are groups. Tools no command names keep their own name. */
  commands?: Record<string, CommandConfig>;
  /**
   * Tools that get no command of their own (["api_keys_reveal"]): not in help, completion or the
   * CLI's skill. They stay on the server, so a command of the team's own can still call them.
   */
  exclude?: string[];
  /** One line about each group, shown in help ("order": "Place and track orders"). Default: its subcommands. */
  groups?: Record<string, string>;
  /**
   * A group's default subcommand ({ scrape: "create" }): words after the group that name none of
   * its subcommands go to it, so `scrape <url>` runs `scrape create <url>`. Bare `scrape` shows the
   * group's help.
   */
  defaultCommands?: Record<string, string>;
  /**
   * Headings for the top-level help, each with its groups and commands in order
   * ({ Orders: ["order", "menu"] }). Those not placed are listed under Other. Default: one list.
   */
  sections?: Record<string, string[]>;
  /** A Client ID Metadata Document URL for sign-in; without it the CLI registers itself (DCR). */
  clientMetadataUrl?: string;
  /** A registered public OAuth client, for providers without dynamic registration. No client secret in a distributed CLI. */
  clientId?: string;
  /** A provider requiring an exact registered loopback port can fix it here; default chooses a free port. */
  redirectPort?: number;
  /** How a sign-in link is opened (default: printed for the person to open). */
  openUrl?: (url: string) => void | Promise<void>;
  /**
   * What a person sees who runs the CLI with no command at a terminal: the name in block letters,
   * the version, a greeting, whether they are signed in, and how to start. Each part can be
   * replaced; false prints the help instead. Coding agents, scripts and pipes always get the help.
   */
  welcome?: false | Welcome;
  /**
   * Sign-in comes first: a person who is not signed in is offered Sign in or Exit before any
   * command, then the command they typed runs. Without a terminal (coding agents, CI) the command
   * exits 3 with the sign-in command instead. `auth`, `help`, `update` and `--help` never ask; `except` adds
   * the team's own commands by their first words (["docs"]); `message` replaces the question.
   */
  signInFirst?: boolean | { message?: string; except?: string[] };
  /**
   * The browser page a sign-in ends on, as HTML, replacing Flow's branded page. It gets only what
   * the page shows, never the code, token or state; Flow sends it with no caching.
   */
  signInPage?: (page: SignInPage) => string;
  /**
   * How people update the CLI. `acme update` runs `command` in a shell (your install script, or
   * `npm install -g acme@latest`) and shows its output. With `latest`, a URL answering JSON with a
   * `version` (npm's https://registry.npmjs.org/acme/latest answers so), `acme update` first says
   * when `version` is already the newest, and a person at a terminal sees one line after a command
   * when a newer one is out, checked at most once a day. When the answer's `rolled_back_from` is
   * this version (`flow cli rollback`), its `version` is offered too, though older. A command of
   * your own named `update` replaces Flow's.
   */
  update?: { command: string; latest?: string };
  /**
   * Files the CLI reads at run time, by their paths in the agent's folder (["context/icon.svg"]):
   * `flow cli pack` ships them beside the bundle at the same paths. Read one with cliFile(path).
   */
  files?: string[];
}

export interface Brand {
  name?: string;
  logo?: string;
  accent?: string;
}

/** What the sign-in page shows: whether the sign-in worked, the brand, and one sentence. */
export interface SignInPage {
  status: "signed-in" | "failed";
  brand: Brand & { name: string };
  /** The command's name ("olostep"), to say where to go back to. */
  cli: string;
  message: string;
}

/** The brand with its defaults: the command's name, and chat.accent when brand.accent is unset. */
export function brandOf(config: CliConfig): Brand & { name: string } {
  const accent = config.brand?.accent ?? config.chat?.accent;
  return { ...config.brand, name: config.brand?.name ?? config.name, ...(accent ? { accent } : {}) };
}

/** The welcome screen's parts; any left out keep their default. */
export interface Welcome {
  /** Art above the rest, as written (its own ASCII art); default the CLI's name in block letters; false for none. */
  banner?: string | false;
  /** Default "Welcome to <name>". */
  title?: string;
  /** Default the CLI's description. */
  text?: string;
  /** Lines under it, as written; default how to start (chat and --help). */
  tips?: string[];
}

/** What the CLI knows of a tool, from the server's tools/list. */
export interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { properties?: Record<string, JsonSchema>; required?: string[]; [key: string]: unknown };
  outputSchema?: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  _meta?: Record<string, unknown>;
}

export interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  description?: string;
  [key: string]: unknown;
}

export interface Command {
  words: string[];
  summary: string;
  tool?: ToolInfo;
  config?: ToolCommand | CustomCommand;
}

/** What `flow cli pack` writes into a packed CLI (esbuild's define); never set in the source. */
declare const __FLOW_CLI_RELEASE__: { version: string; update: { command: string; latest: string } } | undefined;

/**
 * The CLI file's configuration. Packed by `flow cli pack`, its version is the release's, and
 * update's command and latest, where the file leaves them out, are the address it is served from.
 */
export function defineCli(config: CliConfig): CliConfig {
  if (typeof __FLOW_CLI_RELEASE__ === "undefined") return config;
  const release = __FLOW_CLI_RELEASE__;
  return { ...config, version: release.version, update: { command: config.update?.command ?? release.update.command, latest: config.update?.latest ?? release.update.latest } };
}

/**
 * Where a file of defineCli's files is: packed, beside the bundle (the package's own folder); from
 * the source, in the folder the CLI runs from, the agent's folder as `npm run cli` runs it.
 */
export function cliFile(path: string): string {
  return typeof __FLOW_CLI_RELEASE__ === "undefined" ? resolve(path) : fileURLToPath(new URL(`../${path}`, import.meta.url));
}

/**
 * A tool's command, written as code: `command("list_keys").arg("project").short("n", "limit")`.
 * Each step sets one of ToolCommand's fields, so help, completion, the CLI's skill and flow check
 * read it as they read the plain object.
 */
export function command(tool: string): CommandBuilder {
  return new CommandBuilder(tool);
}

export class CommandBuilder {
  readonly spec: ToolCommand;
  constructor(tool: string) {
    this.spec = { tool };
  }
  /** Take these input fields from positional arguments, in order. */
  arg(...fields: string[]): this {
    this.spec.args = [...(this.spec.args ?? []), ...fields];
    return this;
  }
  /** A one-letter flag for a field: short("n", "limit") → `-n 5`. */
  short(letter: string, field: string): this {
    this.spec.shorthands = { ...this.spec.shorthands, [letter]: field };
    return this;
  }
  /** The flag's name for a field: flag("all", "include_revoked") → `--all`; `--include-revoked` still works. */
  flag(name: string, field: string): this {
    this.spec.shorthands = { ...this.spec.shorthands, [name]: field };
    return this;
  }
  /** The value sent when the person leaves the field out. */
  default(field: string, value: unknown): this {
    this.spec.defaults = { ...this.spec.defaults, [field]: value };
    return this;
  }
  /** Give these fields no flag; set them with default() or map(). */
  hide(...fields: string[]): this {
    this.spec.hidden = [...(this.spec.hidden ?? []), ...fields];
    return this;
  }
  /** A field's flag line in help. */
  help(field: string, line: string): this {
    this.spec.help = { ...this.spec.help, [field]: line };
    return this;
  }
  /** A flag of the command's own, not a tool input; map() gets its value as options[name]. */
  option(name: string, option: CliOption): this {
    this.spec.options = { ...this.spec.options, [name]: option };
    return this;
  }
  /** Rewrite what is sent, in your own code; runs after arguments, flags and defaults. Throw to refuse (exit 2). */
  map(fn: NonNullable<ToolCommand["input"]>): this {
    this.spec.input = fn;
    return this;
  }
  /** Print the result your own way for people; --json and --fields still print the data. */
  print(fn: NonNullable<ToolCommand["print"]>): this {
    this.spec.print = fn;
    return this;
  }
  /** For a list: the columns of the table people see. */
  columns(...fields: string[]): this {
    this.spec.columns = fields;
    return this;
  }
  /** For one record: the fields people see, in order. */
  view(...fields: string[]): this {
    this.spec.view = fields;
    return this;
  }
  /** Another name for the command. */
  alias(words: string): this {
    this.spec.alias = words;
    return this;
  }
  /** One line under the command in help (default: the tool's title). */
  summary(line: string): this {
    this.spec.summary = line;
    return this;
  }
  examples(...lines: string[]): this {
    this.spec.examples = [...(this.spec.examples ?? []), ...lines];
    return this;
  }
}

/** The CLI file's commands, each a plain ToolCommand or CustomCommand (a builder gives its spec). */
export function commandEntries(config: CliConfig): [string, ToolCommand | CustomCommand][] {
  return Object.entries(config.commands ?? {}).map(([w, c]) => [w, c instanceof CommandBuilder ? c.spec : c]);
}

export function isCustom(config: ToolCommand | CustomCommand): config is CustomCommand {
  return (config as CustomCommand).command !== undefined;
}

/** The MCP server's own way to read its skills: plumbing for hosts, not a command, unless the CLI file names it. */
const HOST_ONLY = new Set(["read_skill"]);

/** Words the CLI keeps for itself. */
export const BUILT_IN = new Set(["auth", "tools", "skill"]);

/** The CLI's own commands a command of the team's own (buildCommand) may replace. */
export const REPLACEABLE = new Set(["auth status"]);

/** Whether `update` is the CLI's own: update is set and the CLI file names no command of its own `update`. */
export function updatesItself(config: CliConfig): boolean {
  return Boolean(config.update) && !commandEntries(config).some(([w]) => w.trim().split(/\s+/)[0] === "update");
}

/** "place_order" → "place-order". */
export function derivedName(tool: string): string {
  return tool.replace(/_/g, "-");
}

/** Flags the CLI puts on tool commands itself. */
export const OWN_FLAGS = ["json", "fields", "dry-run", "yes", "refresh-tools"];

/** Flags the CLI takes out of every command before parsing it (they pick the server and the token). */
const CONNECTION_FLAGS = ["server", "token"];

/** Letters the CLI keeps for itself: -h and -H are help. */
const OWN_LETTERS = new Set(["h", "H"]);

/** How one input field is typed as a flag: its flag's name, its letters, and the long name a word shorthand stands in for. */
export interface FlagSpec {
  field: string;
  flag: string;
  letters: string[];
  long?: string;
}

/** The flags of a tool command: every input field not taken positionally, with the CLI file's shorthands. */
export function flagsOf(tool: ToolInfo, settings?: ToolCommand): FlagSpec[] {
  const args = settings?.args ?? [];
  const shorthands = Object.entries(settings?.shorthands ?? {});
  return Object.keys(tool.inputSchema.properties ?? {})
    .filter((field) => !args.includes(field) && !settings?.hidden?.includes(field))
    .map((field) => {
      const mine = shorthands.filter(([, f]) => f === field).map(([s]) => s);
      const word = mine.find((s) => s.length > 1 && s !== flagName(field));
      return { field, flag: word ?? flagName(field), letters: mine.filter((s) => s.length === 1), ...(word ? { long: flagName(field) } : {}) };
    });
}

/** Every command: the CLI file's, then each tool it does not name, under the tool's own name. */
export function commandTable(config: CliConfig, tools: ToolInfo[]): Command[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const commands: Command[] = [];
  const named = new Set<string>(config.exclude);
  for (const [words, c] of commandEntries(config)) {
    const split = words.trim().split(/\s+/);
    if (isCustom(c)) {
      commands.push({ words: split, summary: "", config: c });
      continue;
    }
    const tool = byName.get(c.tool);
    if (!tool || config.exclude?.includes(c.tool)) continue;
    named.add(c.tool);
    commands.push({ words: split, summary: c.summary ?? tool.title ?? tool.name, tool, config: c });
    if (c.alias) commands.push({ words: c.alias.trim().split(/\s+/), summary: `Same as ${words}`, tool, config: c });
  }
  for (const tool of tools) {
    const name = derivedName(tool.name);
    if (!named.has(tool.name) && !HOST_ONLY.has(tool.name) && !commands.some(c => c.words.join(" ") === name)) commands.push({ words: [name], summary: tool.title ?? tool.name, tool });
  }
  return commands;
}

/**
 * How to send feedback from this CLI, when the server has its built-in feedback tool (a tool named
 * feedback with an `about`): `acme feedback --about tooling|product --message "<what happened>"`.
 */
export function feedbackUsage(config: CliConfig, tools: ToolInfo[]): string | undefined {
  const c = commandTable(config, tools).find((x) => x.tool?.name === "feedback" && x.tool.inputSchema.properties?.about && x.tool.inputSchema.properties?.message);
  if (!c) return undefined;
  const settings = c.config && !isCustom(c.config) ? c.config : undefined;
  const flag = (field: string) => (settings?.args?.includes(field) ? undefined : `--${flagsOf(c.tool!, settings).find((f) => f.field === field)?.flag ?? flagName(field)}`);
  const about = flag("about"), message = flag("message");
  return `${config.name} ${c.words.join(" ")} ${about ? `${about} ` : ""}tooling|product ${message ? `${message} ` : ""}"<what happened>"`;
}

/** The command the words start with, the longest match first, and the words left after it. */
export function findCommand(commands: Command[], words: string[]): { command: Command; rest: string[] } | null {
  let best: Command | null = null;
  for (const c of commands) {
    if (c.words.length <= words.length && c.words.every((w, i) => w === words[i]) && (!best || c.words.length > best.words.length)) best = c;
  }
  return best ? { command: best, rest: words.slice(best.words.length) } : null;
}

/** The words with a group's default subcommand put in where they name none of its subcommands. */
export function withDefaults(config: CliConfig, commands: Command[], words: string[]): string[] {
  // The CLI file's words too: before discovery, tool commands are not in the table yet.
  const paths = [...commands.map((c) => c.words.join(" ")), ...commandEntries(config).map(([w]) => w.trim().split(/\s+/).join(" "))];
  for (let i = words.length - 1; i >= 0; i--) {
    const group = words.slice(0, i + 1).join(" ");
    const sub = config.defaultCommands?.[group];
    if (!sub || !paths.includes(`${group} ${sub}`)) continue;
    const next = words[i + 1];
    if (next === undefined || paths.some((p) => p === `${group} ${next}` || p.startsWith(`${group} ${next} `))) return words;
    return [...words.slice(0, i + 1), sub, ...words.slice(i + 1)];
  }
  return words;
}

/** Fields a list's rows or a record carry: the output schema's, or for an array, its items'. */
function outputFields(tool: ToolInfo): Set<string> | null {
  const schema = tool.outputSchema;
  if (!schema) return null;
  const props = schema.properties ?? schema.items?.properties;
  if (!props) return null;
  const fields = new Set(Object.keys(props));
  // A list wrapped in an object ({ orders: [...] }) shows its rows' fields too.
  for (const p of Object.values(props)) for (const k of Object.keys(p.items?.properties ?? {})) fields.add(k);
  return fields;
}

/** An https URL with a host. */
export function httpsUrl(url: string): boolean {
  return /^https:\/\/[^/\s]/.test(url) && URL.canParse(url);
}

/** A brand accent: a six-digit hex color. */
export const HEX = /^#[0-9a-f]{6}$/i;

/** A logo a browser shows from the sign-in page: https, or an image written into the URL. */
export function logoProblem(logo: string): string | undefined {
  return /^https:\/\/[^\s"'<>]+$|^data:image\/[a-z0-9.+-]+(;[^,\s"'<>]*)?,[^\s"'<>]+$/i.test(logo) && URL.canParse(logo) ? undefined : "brand.logo must be an https URL or a data:image URL";
}

/** What is wrong in a CLI file against the server's tools, one sentence each; warnings apart. */
export function cliProblems(config: CliConfig, tools: ToolInfo[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { accent, logo } = brandOf(config);
  if (accent !== undefined && !HEX.test(accent)) errors.push(`brand.accent must be a six-digit hex color, for example #b85c00`);
  const logoError = logo === undefined ? undefined : logoProblem(logo);
  if (logoError) errors.push(logoError);
  for (const [environment, url] of Object.entries(config.servers ?? {})) {
    if (url !== undefined && !httpsUrl(url)) errors.push(`servers.${environment} must be an https URL, such as https://cli.acme.com/mcp`);
  }
  if (config.update) {
    if (!config.update.command?.trim()) errors.push("update.command must be the shell command that updates the CLI");
    if (config.update.latest !== undefined && !/^https?:$/.test(URL.canParse(config.update.latest) ? new URL(config.update.latest).protocol : "")) errors.push("update.latest must be an http or https URL");
    if (config.update.latest !== undefined && !config.version) errors.push("update.latest needs version, the version this CLI is, to compare with");
  }
  const byName = new Map(tools.map((t) => [t.name, t]));
  const words = new Map<string, string>();
  const claim = (w: string, owner: string) => {
    const key = w.trim().split(/\s+/).join(" ");
    if (words.has(key)) errors.push(`command "${key}": both ${words.get(key)} and ${owner} use it`);
    else words.set(key, owner);
  };
  const named = new Set<string>();
  for (const t of config.exclude ?? []) {
    if (!byName.has(t)) errors.push(`exclude names ${t}, but there is no tool named ${t} on the server`);
    named.add(t);
  }
  for (const [w, c] of commandEntries(config)) {
    claim(w, `"${w}"`);
    if (isCustom(c)) continue;
    if (c.alias) claim(c.alias, `the alias of "${w}"`);
    const tool = byName.get(c.tool);
    if (!tool) {
      errors.push(`command "${w}": no tool named ${c.tool} on the server`);
      continue;
    }
    if (config.exclude?.includes(c.tool)) errors.push(`command "${w}": ${c.tool} is in exclude, so it has no command`);
    named.add(c.tool);
    const input = new Set(Object.keys(tool.inputSchema.properties ?? {}));
    for (const a of c.args ?? []) if (!input.has(a)) errors.push(`command "${w}": args names ${a}, which ${c.tool}'s input does not have`);
    for (const [short, field] of Object.entries(c.shorthands ?? {})) {
      const typed = short.length === 1 ? `-${short}` : `--${short}`;
      if (!/^[a-zA-Z]$|^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(short)) errors.push(`command "${w}": shorthand "${short}" must be one letter or a lowercase word (a-z, 0-9, -)`);
      else if (!input.has(field)) errors.push(`command "${w}": shorthand ${typed} names ${field}, which ${c.tool}'s input does not have`);
      else if (c.args?.includes(field)) errors.push(`command "${w}": shorthand ${typed} names ${field}, which is a positional argument`);
      else if (OWN_LETTERS.has(short) || OWN_FLAGS.includes(short) || CONNECTION_FLAGS.includes(short)) errors.push(`command "${w}": shorthand ${typed} is the CLI's own`);
    }
    const flags = new Map<string, string>();
    for (const f of flagsOf(tool, c)) {
      if (Object.entries(c.shorthands ?? {}).filter(([s, field]) => field === f.field && s.length > 1).length > 1) errors.push(`command "${w}": ${f.field} has more than one word shorthand`);
      for (const name of [f.flag, ...(f.long ? [f.long] : [])]) {
        if (flags.has(name) && flags.get(name) !== f.field) errors.push(`command "${w}": --${name} would be both ${flags.get(name)} and ${f.field}`);
        flags.set(name, f.field);
      }
    }
    for (const field of Object.keys(c.defaults ?? {})) if (!input.has(field)) errors.push(`command "${w}": defaults names ${field}, which ${c.tool}'s input does not have`);
    const required = new Set(tool.inputSchema.required ?? []);
    for (const field of c.hidden ?? []) {
      if (!input.has(field)) errors.push(`command "${w}": hidden names ${field}, which ${c.tool}'s input does not have`);
      else if (c.args?.includes(field)) errors.push(`command "${w}": ${field} is both hidden and a positional argument`);
      else if (required.has(field) && !(field in (c.defaults ?? {})) && !c.input) errors.push(`command "${w}": ${field} is required and hidden, so it needs a default or input code`);
    }
    for (const field of Object.keys(c.help ?? {})) if (!input.has(field) || c.hidden?.includes(field)) errors.push(`command "${w}": help names ${field}, which is not one of its flags or arguments`);
    const letters = new Set(Object.keys(c.shorthands ?? {}).filter((k) => k.length === 1));
    for (const [name, option] of Object.entries(c.options ?? {})) {
      if (flags.has(name) || OWN_FLAGS.includes(name) || CONNECTION_FLAGS.includes(name)) errors.push(`command "${w}": option --${name} clashes with ${flags.has(name) ? `${flags.get(name)}'s flag` : "the CLI's own"}`);
      if (option.short && (letters.has(option.short) || OWN_LETTERS.has(option.short))) errors.push(`command "${w}": option --${name}'s -${option.short} is already taken`);
      if (option.short) letters.add(option.short);
    }
    if (c.options && Object.keys(c.options).length && !c.input) errors.push(`command "${w}": it has options but no input code to read them`);
    const lists = (c.args ?? []).filter((a) => input.has(a) && flagKind(tool.inputSchema.properties![a]!) === "list");
    if (lists.length && c.args!.length > 1) errors.push(`command "${w}": ${lists[0]} takes many values, so it must be the only positional argument`);
    const output = outputFields(tool);
    for (const key of ["columns", "view"] as const) {
      for (const f of c[key] ?? []) {
        if (!output) warnings.push(`command "${w}": ${key} names ${f}, but ${c.tool} declares no output to check it against`);
        else if (!output.has(f.split(".")[0]!)) errors.push(`command "${w}": ${key} names ${f}, which ${c.tool}'s output does not have`);
      }
    }
  }
  for (const t of tools) {
    if (named.has(t.name) || HOST_ONLY.has(t.name)) continue;
    if (commandEntries(config).some(([w, c]) => w.trim() === derivedName(t.name) && isCustom(c))) continue;
    if (derivedName(t.name) === "update" && updatesItself(config)) errors.push(`tool ${t.name} would be the command "update", which is the CLI's own while update is set; give it another name in commands`);
    claim(derivedName(t.name), `tool ${t.name}`);
    if (config.commands) warnings.push(`tool ${t.name} has no command in the CLI file; it is reachable as "${derivedName(t.name)}"`);
  }
  for (const [group, sub] of Object.entries(config.defaultCommands ?? {})) {
    const key = group.trim().split(/\s+/).join(" ");
    if (![...words.keys()].some((w) => w.startsWith(`${key} `))) errors.push(`defaultCommands: "${key}" is not a group`);
    else if (/\s/.test(sub.trim()) || !words.has(`${key} ${sub.trim()}`)) errors.push(`defaultCommands: "${key} ${sub}" is not a command of the group "${key}"`);
  }
  const tops = new Set([...words.keys()].map((key) => key.split(" ")[0]!));
  const placed = new Map<string, string>();
  for (const [heading, entries] of Object.entries(config.sections ?? {})) {
    for (const entry of entries) {
      if (!tops.has(entry)) errors.push(`section "${heading}": ${entry} is not a top-level command or group`);
      else if (placed.has(entry)) errors.push(`section "${heading}": ${entry} is already in "${placed.get(entry)}"`);
      else placed.set(entry, heading);
    }
  }
  const own = new Set(commandEntries(config).filter(([, c]) => isCustom(c)).map(([w]) => w.trim().split(/\s+/).join(" ")));
  for (const [key, owner] of words) {
    const first = key.split(" ")[0]!;
    if (REPLACEABLE.has(key) && !own.has(key)) errors.push(`command "${key}": only a command of your own (buildCommand) can replace the CLI's ${key}`);
    else if (BUILT_IN.has(first) && !REPLACEABLE.has(key)) errors.push(`command "${key}": ${first} is the CLI's own (${[...BUILT_IN].join(", ")})`);
    for (const other of words.keys()) {
      if (other !== key && other.startsWith(`${key} `)) errors.push(`command "${key}" (${owner}): it is also the group of "${other}"; a word is a command or a group, not both`);
    }
  }
  return { errors, warnings };
}

/** The CLI's SKILL.md for coding agents, made from the tools and the CLI file, never written by hand. */
export function skillFile(config: CliConfig, tools: ToolInfo[]): string {
  const name = config.name;
  const feedback = feedbackUsage(config, tools);
  const lines = [
    "---",
    `name: ${name}-cli`,
    `description: Use the ${name} command line${config.description ? ` (${config.description})` : ""}. Load before running ${name} commands or when asked to do something in ${name} from a terminal.`,
    "---",
    "",
    `# The ${name} command line`,
    "",
    `Run \`${name} <command> --json\` and read the JSON; never parse the human output. \`--fields a,b\` keeps only those fields.`,
    "Commands that change things accept `--dry-run` (shows the call, sends nothing) and, when they may delete or overwrite, need `--yes` without a terminal.",
    `Sign in once with \`${name} auth login\`, or set ${tokenEnvOf(config)} in CI.`,
    "Tool definitions may be cached; add `--refresh-tools` to fetch current commands and schemas.",
    `List workflow summaries with \`${name} skill list\`; read selected instructions with \`${name} skill get <name> [name...]\` before doing what they cover.`,
    `Find a command by what it does with \`${name} help <words>\` (every word must match its name or description).`,
    "",
    "Exit codes: 0 done, 1 the tool failed (its message on stderr), 2 wrong command or arguments, 3 sign-in needed, 4 needs --yes, 5 the server could not be reached.",
    "",
    ...(feedback ? ["## Sharing feedback", "", FEEDBACK_NUDGE(`\`${feedback}\``), ""] : []),
    "## Talking to the agent",
    "",
    `\`${name} chat "<message>"\` sends one message to the agent and prints its reply as written (\`--json\` for the full response); always pass the message. \`${name} chat\` alone is for a person at a terminal. Chat needs sign-in unless the agent lets guests chat.`,
    "The CLI keeps its conversation reference in chat.json in its config folder; --new forgets that reference and preserves shared person history. chat without a message needs a terminal (otherwise exits 2).",
    "",
    "## Commands",
  ];
  for (const c of commandTable(config, tools)) {
    if (!c.tool) {
      if (c.config && isCustom(c.config)) lines.push("", `### ${name} ${c.words.join(" ")}`, "", c.config.command.brief, "", `Run \`${name} ${c.words.join(" ")} --help\` for its arguments and flags.`);
      continue;
    }
    lines.push("", `### ${name} ${c.words.join(" ")}`, "", c.summary);
    if (c.tool) {
      lines.push("", `MCP tool: \`${c.tool.name}\``);
      if (c.tool.description && c.tool.description !== c.summary) lines.push("", c.tool.description);
      const settings = c.config && !isCustom(c.config) ? c.config : undefined;
      const args = settings?.args ?? [];
      const flags = flagList(c.tool, settings);
      const group = c.words.slice(0, -1).join(" ");
      const usageArgs = args.map((a) => ` <${a}${flagKind(c.tool!.inputSchema.properties?.[a] ?? {}) === "list" ? "..." : ""}>`).join("");
      // Bare, a group shows its help, so only a default with arguments runs from the group's name.
      if (group && args.length && config.defaultCommands?.[group] === c.words[c.words.length - 1]) lines.push("", `The default of \`${name} ${group}\`: \`${name} ${group}${usageArgs}\` runs it too.`);
      if (args.length || flags.length) lines.push("", `Usage: \`${name} ${c.words.join(" ")}${args.map((a) => ` <${a}${flagKind(c.tool!.inputSchema.properties?.[a] ?? {}) === "list" ? "..." : ""}>`).join("")}${flags.length ? " [flags]" : ""}\``);
      for (const f of flags) lines.push(`- ${f}`);
      if (c.tool.annotations?.readOnlyHint !== true) lines.push(`- Changes things${c.tool.annotations?.destructiveHint === false ? "" : " and may delete or overwrite: needs --yes"}.`);
      if (c.tool.outputSchema) lines.push("", "JSON output schema:", "", "```json", JSON.stringify(c.tool.outputSchema), "```");
    }
    for (const e of c.config && !isCustom(c.config) ? (c.config.examples ?? []) : []) lines.push("", "```bash", e, "```");
  }
  return lines.join("\n") + "\n";
}

export function tokenEnvOf(config: CliConfig): string {
  return config.tokenEnv ?? `${config.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN`;
}

export function flagName(field: string): string {
  return field.replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** One line per flag: its names, type, default and what it is for. */
export function flagList(tool: ToolInfo, settings?: ToolCommand): string[] {
  const required = new Set(tool.inputSchema.required ?? []);
  const defaults = settings?.defaults ?? {};
  const own = Object.entries(settings?.options ?? {}).map(([name, o]) => `\`${o.short ? `-${o.short}, ` : ""}--${name}\` ${o.kind ?? "string"}: ${o.help}`);
  return [...flagsOf(tool, settings).map(({ field, flag, letters, long }) => {
    const s = tool.inputSchema.properties![field]!;
    const kind = s.enum ? s.enum.join("|") : flagKind(s) === "json" ? `JSON: ${typeHint(s)} (or @file.json)` : flagKind(s);
    const names = [...letters.map((l) => `-${l}`), `--${flag}`].join(", ");
    const given = field in defaults ? `, default ${JSON.stringify(defaults[field])}` : required.has(field) ? ", required" : "";
    const about = settings?.help?.[field] ?? s.description;
    return `\`${names}\`${long ? ` (or \`--${long}\`)` : ""} ${kind}${given}${about ? `: ${about}` : ""}`;
  }), ...own];
}

/** A short picture of a JSON value's shape: "list of {item, size, milk?, quantity?}". */
export function typeHint(s: JsonSchema): string {
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  if (type === "array") return `list of ${s.items ? typeHint(s.items) : "values"}`;
  if (type === "object" || s.properties) {
    const required = new Set((s.required as string[] | undefined) ?? []);
    const keys = Object.keys(s.properties ?? {}).map((k) => (required.has(k) ? k : `${k}?`));
    return keys.length ? `{${keys.join(", ")}}` : "object";
  }
  return s.enum ? s.enum.join("|") : (type ?? "value");
}

export type FlagKind = "string" | "number" | "integer" | "boolean" | "list" | "json";

export function flagKind(s: JsonSchema): FlagKind {
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  if (type === "array") {
    const item = Array.isArray(s.items?.type) ? s.items?.type[0] : s.items?.type;
    return item === "string" || item === "number" || item === "integer" ? "list" : "json";
  }
  if (type === "number" || type === "integer" || type === "boolean" || type === "string") return type;
  return s.enum ? "string" : "json";
}
