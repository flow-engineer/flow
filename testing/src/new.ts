// `flow new <name>`: makes ./<name>/, an agent of its own started from the café example (Pip),
// that depends on the @flow-engineer/flow package. Its imports become "@flow-engineer/flow",
// "@flow-engineer/flow/simulators" and "@flow-engineer/flow/flow-messaging", and the coding-agent
// skills go in .claude/skills/, with an AGENTS.md (and a CLAUDE.md importing it) pointing at them.
// `flow init` makes the same agent in the current folder. Inside a clone, `npm run new -- <name>`
// makes agents/<name>/ instead.

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

const ENV_EXAMPLE = `# One model key. The first line with a value is the one used.
# Make it at the provider, then paste it here. Never commit this file.
#   OPENROUTER_API_KEY   https://openrouter.ai/keys
#   OPENAI_API_KEY       https://platform.openai.com/api-keys
#   ANTHROPIC_API_KEY    https://console.anthropic.com/settings/keys
#   GEMINI_API_KEY       https://aistudio.google.com/apikey
OPENROUTER_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=

# Optional. The model id for that provider; empty is that provider's default.
# CAFE_MODEL=

# The test cloud (npx @flow-engineer/flow test --synthetic) and traces. Sign in at https://flow.engineer/observe,
# add the agent, and on its Developers page make a CI key (oci_..., shown once); the trace key is
# from the same site.
FLOW_FRAMEWORK_CLOUD=https://flow.engineer/observe
FLOW_FRAMEWORK_CLOUD_KEY=
FLOW_FRAMEWORK_TRACES_URL=https://flow.engineer/observe
FLOW_FRAMEWORK_TRACES_KEY=
`;

const agentsMd = (name: string) => `# ${name}

A chat agent on Flow Framework (https://github.com/flow-engineer/flow), started from its café example (Pip).

- Load the skills in \`.claude/skills/\` before changing it: \`flow-framework\` to build the agent, \`flow-framework-tools\`
  for its tools and their test files, \`flow-framework-tests\` for its test scenarios.
- \`agent/AGENTS.md\` is the agent's own prompt, not instructions for coding agents.
- The owner puts one model key in \`.env\` (never read or print it): \`OPENROUTER_API_KEY\`,
  \`OPENAI_API_KEY\`, \`ANTHROPIC_API_KEY\` or \`GEMINI_API_KEY\`. Then \`npx @flow-engineer/flow chat\`
  talks to it in the terminal, \`npm start\` runs it in the playground, and \`npx @flow-engineer/flow link\`
  signs in, puts its other keys in \`.env\` and prints the link that reaches it from a phone while
  \`npm start\` runs. \`npm run typecheck\` checks the types, \`npm test -- --synthetic\` runs the
  tests in the test cloud at https://flow.engineer/observe with the owner's \`FLOW_FRAMEWORK_CLOUD_KEY\`
  (\`npx @flow-engineer/flow --help\`).
- The guide for coding agents, with exit codes and next steps: https://github.com/flow-engineer/flow/blob/main/docs/agents.md
`;

/** Makes `<into>/<name>` (the current folder by default) and returns it. */
export function newStandalone(name: string, options: { into?: string; root?: string } = {}): string {
  checkName(name);
  const dir = join(options.into ?? process.cwd(), name);
  if (existsSync(dir)) throw new Error(`${dir} already exists: pick another name or remove it.`);
  makeAgent(dir, name, options.root ?? packageRoot());
  return dir;
}

/** What `flow init` writes into a folder; it refuses a folder that holds any of them, so nothing is overwritten. */
const MADE = ["package.json", "tsconfig.json", "src", "agent", "tests", ".env.example", "AGENTS.md", "CLAUDE.md", ".npmrc"];

/** Makes the agent in `dir` (the current folder by default), named after the folder; returns its name. */
export function initHere(dir = process.cwd(), options: { root?: string } = {}): string {
  const taken = MADE.filter((f) => existsSync(join(dir, f)));
  if (taken.length) throw new Error(`${dir} has ${taken.join(", ")} already: run flow init in an empty folder, or flow new <name> to make one.`);
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "my-agent";
  makeAgent(dir, name, options.root ?? packageRoot());
  return name;
}

function makeAgent(dir: string, name: string, root: string): void {
  const cafe = join(root, "examples", "cafe");
  for (const part of ["agent", "src", "tests"]) cpSync(join(cafe, part), join(dir, part), { recursive: true });

  for (const file of readdirSync(join(dir, "src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"))) {
    const path = join(dir, "src", file);
    const source = readFileSync(path, "utf8")
      .replace(/(["'])(\.\.\/)+src\/index\.ts\1/g, '"@flow-engineer/flow"')
      .replace(/(["'])(\.\.\/)+simulators\/src\/index\.ts\1/g, '"@flow-engineer/flow/simulators"')
      .replace(/(["'])(\.\.\/)+flow-messaging\/src\/index\.ts\1/g, '"@flow-engineer/flow/flow-messaging"');
    if (/["']\.\.\/\.\.\//.test(source)) throw new Error(`flow: ${file} imports a file outside the agent; only Flow Framework's public entries can be rewritten.`);
    writeFileSync(path, source);
  }

  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pkg = {
    name,
    version: "0.1.0",
    private: true,
    description: `${name}: a Flow Framework agent, started from the café example.`,
    type: "module",
    engines: own.engines,
    scripts: { start: "node --env-file-if-exists=.env src/main.ts", test: "flow test", typecheck: "tsc --noEmit" },
    dependencies: { "@flow-engineer/flow": `^${own.version}` },
    devDependencies: { "@types/node": own.devDependencies["@types/node"], typescript: own.devDependencies.typescript },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  // An existing .gitignore (flow init in a fresh repository) keeps its lines and gets the missing ones.
  const ignore = join(dir, ".gitignore");
  const ignored = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  const missing = ["node_modules/", ".env", ".flow/"].filter((line) => !ignored.split("\n").includes(line));
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
