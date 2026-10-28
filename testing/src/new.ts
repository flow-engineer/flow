// `flow new <name>`: makes ./<name>/, an agent of its own started from the café example,
// that depends on the @flow-engineer/flow package. Its imports become "@flow-engineer/flow",
// "@flow-engineer/flow/simulators" and "@flow-engineer/flow/flow-messaging", and the coding-agent
// skills go in .claude/skills/, with an AGENTS.md (and a CLAUDE.md importing it) pointing at them.
// `flow init` makes the same agent in the current folder, named by `--name`, else after
// `--display-name`, else after the folder. Inside a clone, `npm run new -- <name>` makes
// agents/<name>/ instead. `--display-name` is what people call the agent ("FlatX agent"), kept as
// package.json's displayName: the message a phone sends to reach it is "Join <it> (ref <code>)".
// The café's agent is Pip; the display name takes Pip's place in its prompt (agent/AGENTS.md). Every
// other name in the agent's code comes from package.json through src/name.ts (its CLI command, the
// CLI's variables, its MCP server), so nothing here rewrites them. `flow link --display-name` (and
// `setup`) renames an agent made already, the same way (setDisplayName).

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Throws unless `name` can be an agent's folder and package name. */
export function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a usable name: use lowercase letters, digits and dashes, such as my-agent.`);
}

/** The @flow-engineer/flow package's folder: the root of a clone, or the installed package. */
export function packageRoot(from = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === "@flow-engineer/flow") return dir;
    if (dirname(dir) === dir) throw new Error("flow: can't find its own package.json");
  }
}

const TSCONFIG = {
  compilerOptions: {
    target: "es2023",
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    erasableSyntaxOnly: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    types: ["node"],
  },
  include: ["src"],
};

const ENV_EXAMPLE = `# The model key. The first line with a value is the one used. npx @flow-engineer/flow setup writes
# FLOW_KEY, the agent's one Flow key, which calls models on the account's free trial credit, so no
# provider key is needed; your own, made at the provider and pasted on its line, wins over it.
# Never commit this file.
#   OPENROUTER_API_KEY   https://openrouter.ai/keys
#   OPENAI_API_KEY       https://platform.openai.com/api-keys
#   ANTHROPIC_API_KEY    https://console.anthropic.com/settings/keys
#   GEMINI_API_KEY       https://aistudio.google.com/apikey
OPENROUTER_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
FLOW_KEY=

# Optional. The model id for that provider; empty is that provider's default.
# MODEL=

# The test cloud (npx @flow-engineer/flow test --synthetic) and traces. Sign in at https://flow.engineer/observe,
# add the agent, and on its Developers page make a CI key (oci_..., shown once); the trace key is
# from the same site.
FLOW_FRAMEWORK_CLOUD=https://flow.engineer/observe
FLOW_FRAMEWORK_CLOUD_KEY=
FLOW_FRAMEWORK_TRACES_URL=https://flow.engineer/observe
FLOW_FRAMEWORK_TRACES_KEY=
`;

const agentsMd = (name: string) => `# ${name}

An agent on Flow Framework (https://github.com/flow-engineer/flow): a chat agent, and the same tools as an
MCP server and a CLI. It starts as the café example; replace the café with the owner's product.

- The skills are plain Markdown files, \`.claude/skills/<skill>/SKILL.md\`. A coding agent that does not
  load them by name (or started before this folder existed) reads them as files.
- Start with \`flow-framework\` in \`.claude/skills/\` for setup, names and layout. Then load only the
  relevant guides: \`flow-framework-build-agent\` for the messaging runtime, playground and deployment;
  \`flow-framework-mcp\` for MCP servers, CLIs and plugins; \`flow-framework-tools\` for tools and their
  test files; \`flow-framework-tests\` for scenarios; \`flow-framework-context\` to gather the context
  pack from an existing codebase; and \`flow-framework-auth\` for sign-in.
- \`agent/AGENTS.md\` is the agent's own prompt, not instructions for coding agents.
- The agent's names live in package.json, and the code reads them from there (src/name.ts):
  \`name\` is the package, the CLI command (keep the \`bin\` key the same), its \`<NAME>_SERVER\` and
  \`<NAME>_TOKEN\` variables and the MCP server's name; \`displayName\` is what people call the agent,
  also written in its prompt. To rename it, change \`name\` and the \`bin\` key; for the display name
  run \`npx @flow-engineer/flow link --display-name <name>\` (package.json and the prompt). Where
  people see each name: the flow-framework skill, "Names".
- The model key goes in \`.env\` (never read or print it): \`npx @flow-engineer/flow link\` (or \`setup\`)
  writes \`FLOW_KEY\`, the agent's one Flow key, which calls models on Flow's free trial credit, so no provider key is needed; a key the owner types
  (\`OPENROUTER_API_KEY\`, \`OPENAI_API_KEY\`, \`ANTHROPIC_API_KEY\` or \`GEMINI_API_KEY\`) wins over it. \`npm start\` runs it in the playground,
  and \`npx @flow-engineer/flow link\` signs in, puts its other keys in \`.env\` and prints the link that
  reaches it from a phone while \`npm start\` runs.
- The free trial takes 25 people per channel; past that, new people are held (kept, not delivered).
  More people, or the owner's own iMessage number, is a paid plan only the workspace owner buys, at
  https://flow.engineer/dashboard/plans: Shared (more people on Flow's shared lines), Dedicated (an own
  iMessage number) and the Outbound add-on (the agent messages people first). When \`setup\`, \`link\` or
  \`status\` prints a \`Next:\` line with that link, or an error carries a \`hint\` (\`plan_ended\`: the
  plan ended), show it to the owner with the link instead of retrying.
- When the owner asks how to test it, recommend first the playground (\`npm start\`, then open the link
  it prints: the test people and the channels side by side), then their phone (the \`link\`).
- Your own checks, not the owner's way to test: \`npx @flow-engineer/flow chat\` talks to it in the
  terminal, \`npm run typecheck\` checks the types, \`npm test -- --synthetic\` runs the tests in the
  test cloud at https://flow.engineer/observe with the owner's \`FLOW_FRAMEWORK_CLOUD_KEY\`
  (\`npx @flow-engineer/flow --help\`).
- The guide for coding agents, with exit codes and next steps: https://github.com/flow-engineer/flow/blob/main/docs/agents.md
- \`npm run mcp\` serves the same tools as an MCP server (src/mcp.ts) and \`npm run cli -- --help\` is
  its command line (src/cli.ts). \`npx flow check\` checks the tools and the CLI file for both.
`;

/** The longest display name: the join message carries it (flow.engineer's /try cuts it there too). */
export const MAX_DISPLAY_NAME = 60;

/** The name people call the agent, from the package name when none was given: "my-shop" is "my shop". */
export function displayNameOf(given: string | undefined, packageName: string): string {
  const name = (given ?? "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length > MAX_DISPLAY_NAME) throw new Error(`--display-name is at most ${MAX_DISPLAY_NAME} characters, such as "FlatX agent".`);
  return name || packageName.replace(/-/g, " ");
}

/** The café's name for its agent, in its prompt; a new agent's display name takes its place. */
const TEMPLATE_NAME = "Pip";

/** Puts `to` in place of each of `from` (whole words, the longest first, in one pass) in the agent's prompt; true when it changed. */
function renameInPrompt(dir: string, from: string[], to: string): boolean {
  const file = join(dir, "agent", "AGENTS.md");
  const names = [...new Set(from.filter((n) => n && n !== to))].sort((a, b) => b.length - a.length);
  if (!names.length || !existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  const word = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}_])`, "gu");
  const renamed = text.replace(word, () => to);
  if (renamed === text) return false;
  writeFileSync(file, renamed);
  return true;
}

/**
 * Renames the agent in `dir`: package.json's displayName, and in its prompt the old display name
 * (and the café's Pip) become the new one. Returns the name and whether the prompt changed (a prompt
 * rewritten by hand may name neither).
 */
export function setDisplayName(dir: string, given: string): { displayName: string; prompt: boolean } {
  const file = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; displayName?: string };
  const displayName = displayNameOf(given, pkg.name ?? folderName(dir));
  const before = typeof pkg.displayName === "string" ? pkg.displayName : "";
  if (before !== displayName) {
    // displayName stays right after name, where flow init puts it.
    const { name, displayName: _, ...rest } = pkg;
    writeFileSync(file, `${JSON.stringify({ ...(name !== undefined ? { name } : {}), displayName, ...rest }, null, 2)}\n`);
  }
  return { displayName, prompt: renameInPrompt(dir, [before, TEMPLATE_NAME], displayName) };
}

interface MakeOptions {
  root?: string;
  /** What people call the agent; the package name in words when not given. */
  displayName?: string;
}

/** Makes `<into>/<name>` (the current folder by default) and returns it. */
export function newStandalone(name: string, options: MakeOptions & { into?: string } = {}): string {
  checkName(name);
  const displayName = displayNameOf(options.displayName, name);
  const dir = join(options.into ?? process.cwd(), name);
  if (existsSync(dir)) throw new Error(`${dir} already exists: pick another name or remove it.`);
  makeAgent(dir, name, displayName, options.root ?? packageRoot());
  return dir;
}

/** What `flow init` writes into a folder; it refuses a folder that holds any of them, so nothing is overwritten. */
const MADE = ["package.json", "tsconfig.json", "src", "agent", "tests", ".env.example", "AGENTS.md", "CLAUDE.md", ".npmrc"];

/** Words as a package name: lowercase letters, digits and dashes ("Café Bot" is "cafe-bot"); empty when nothing is left. */
function slugOf(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The package name `flow init` gives the agent in `dir` when no name or display name gives one: the folder's name in lowercase and dashes. */
export function folderName(dir: string): string {
  return slugOf(basename(dir)) || "my-agent";
}

/**
 * Makes the agent in `dir` (the current folder by default) and returns its name: `options.name`,
 * else the display name as a package name ("FlatX agent" is flatx-agent), else the folder's name.
 */
export function initHere(dir = process.cwd(), options: MakeOptions & { name?: string } = {}): string {
  if (options.name !== undefined) checkName(options.name);
  const taken = MADE.filter((f) => existsSync(join(dir, f)));
  if (taken.length) throw new Error(`${dir} has ${taken.join(", ")} already: run flow init in an empty folder, or flow new <name> to make one.`);
  const name = options.name ?? (slugOf(options.displayName ?? "") || folderName(dir));
  makeAgent(dir, name, displayNameOf(options.displayName, name), options.root ?? packageRoot());
  return name;
}

function makeAgent(dir: string, name: string, displayName: string, root: string): void {
  const cafe = join(root, "examples", "cafe");
  for (const part of ["agent", "src", "tests"]) cpSync(join(cafe, part), join(dir, part), { recursive: true });
  renameInPrompt(dir, [TEMPLATE_NAME], displayName);

  for (const file of readdirSync(join(dir, "src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"))) {
    const path = join(dir, "src", file);
    const source = readFileSync(path, "utf8")
      .replace(/(["'])(\.\.\/)+src\/index\.ts\1/g, '"@flow-engineer/flow"')
      .replace(/(["'])(\.\.\/)+simulators\/src\/index\.ts\1/g, '"@flow-engineer/flow/simulators"')
      .replace(/(["'])(\.\.\/)+flow-messaging\/src\/index\.ts\1/g, '"@flow-engineer/flow/flow-messaging"')
      .replace(/(["'])(\.\.\/)+mcp\/src\/index\.ts\1/g, '"@flow-engineer/flow/mcp"')
      .replace(/(["'])(\.\.\/)+cli\/src\/index\.ts\1/g, '"@flow-engineer/flow/cli"');
    if (/["']\.\.\/\.\.\//.test(source)) throw new Error(`flow: ${file} imports a file outside the agent; only Flow Framework's public entries can be rewritten.`);
    writeFileSync(path, source);
  }

  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pkg = {
    name,
    // What people call it: the message a phone sends to reach it is "Join <displayName> (ref <code>)".
    displayName,
    version: "0.1.0",
    private: true,
    // Generated plugins carry it (flow plugin): say what the agent does once it does.
    description: `${displayName}, a Flow Framework agent.`,
    type: "module",
    bin: { [name]: "src/cli.ts" },
    engines: own.engines,
    scripts: { start: "node --env-file-if-exists=.env src/main.ts", mcp: "node --env-file-if-exists=.env src/mcp.ts", cli: "node --env-file-if-exists=.env src/cli.ts", test: "flow test", typecheck: "tsc --noEmit" },
    // The café serves its tools over MCP (src/mcp.ts) and as a CLI (src/cli.ts): their SDKs, pinned as Flow Framework pins them.
    dependencies: { "@flow-engineer/flow": `^${own.version}`, ...own.peerDependencies },
    devDependencies: { "@types/node": own.devDependencies["@types/node"], typescript: own.devDependencies.typescript },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  // An existing .gitignore (flow init in a fresh repository) keeps its lines and gets the missing ones.
  const ignore = join(dir, ".gitignore");
  const ignored = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  const missing = ["node_modules/", ".env", ".flow/", "release/"].filter((line) => !ignored.split("\n").includes(line));
  if (missing.length) writeFileSync(ignore, `${ignored}${ignored && !ignored.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  // npm install then refuses a Node older than the engines field says, before .ts files fail to load.
  writeFileSync(join(dir, ".npmrc"), "engine-strict=true\n");
  writeFileSync(join(dir, ".env.example"), ENV_EXAMPLE);

  const skills = join(root, "coding-agents");
  for (const file of readdirSync(skills).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(skills, file), "utf8");
    const skill = /^name:\s*(\S+)\s*$/m.exec(text)?.[1];
    if (!skill) throw new Error(`flow: coding-agents/${file} has no name in its front matter.`);
    mkdirSync(join(dir, ".claude", "skills", skill), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", skill, "SKILL.md"), text);
  }
  writeFileSync(join(dir, "AGENTS.md"), agentsMd(name));
  writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
}
