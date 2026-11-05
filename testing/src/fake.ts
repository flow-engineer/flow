// `flow test fake <tool>`: writes a starter tests/tools/<tool>.fake.ts from the tool's file
// (tests/tools/*.yaml whose `tool:` is it), answering as the file's responses do, with comments on
// given: and state, for the developer to make the tool's answers depend on the run. Never writes
// over a file already there. Fakes are optional: a test without one plays, passes and costs as
// before. Exit status: 0 written, 1 a wrong flag, no tool file for that tool, or the file exists.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Failed, failed, parse, usageFailed } from "./conversations.ts";
import { parseToolFile, type ToolFile } from "./suite.ts";

export const FAKE_LINE = `  flow test fake <tool> [--json]
                            Write a starter fake for a tool, tests/tools/<tool>.fake.ts, from its
                            tool file: optional, it makes the tool free and repeatable in tests`;

const USAGE = `Usage:
  flow test fake <tool> [--json]

Writes tests/tools/<tool>.fake.ts from the agent's folder: your code playing <tool> in tests, so
its calls are free and give the same answer on every run, instead of a model's. The starter
answers as tests/tools/<tool>.yaml's responses do (the one whose input is the call's, else the
usual one); change it to answer from the call and the scenario's given:, and keep what the tool
changed in state for expect.state. It runs only in scenarios with a given: block. A file already
there is never written over.

Fakes are optional: a test without one plays, passes and costs as before.

Options:
  --json        One JSON report on stdout: { ok, tool, file, from }
  -h, --help    Show this help

Exit status: 0 written, 1 a wrong flag, no tool file for that tool, or its fake is there already.`;

/** A tool's name as tool files and fake file names hold it. */
const TOOL = /^[A-Za-z0-9_-]{1,64}$/;

/** Runs `flow test fake <tool>`; resolves to the exit status. */
export async function fakeCli(args: string[]): Promise<number> {
  const name = "flow test fake";
  const parsed = parse(name, args, {}, USAGE);
  if (!parsed) return 1;
  const { values, positionals } = parsed;
  if (values.help) return console.log(USAGE), 0;
  const json = values.json === true;
  const [tool, ...extra] = positionals;
  if (!tool || extra.length || !TOOL.test(tool)) return usageFailed(json, `${name} takes one tool's name, as its tool file's tool: says it.`, USAGE), 1;
  const dir = join(process.cwd(), "tests", "tools");
  const file = join(dir, `${tool}.fake.ts`);
  const shown = `tests/tools/${tool}.fake.ts`;
  if (existsSync(file)) return failed(json, new Failed(`${shown} is there already: ${name} never writes over it.`, "exists"));
  const found = toolFile(dir, tool);
  if (!found) return failed(json, new Failed(`No tool file for ${tool} in tests/tools/ (a .yaml whose tool: is ${tool}): write it first (the flow-framework-tools skill), then ${name} ${tool}.`, "no_tool_file"));
  writeFileSync(file, starter(tool, found.file, found.parsed));
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, tool, file: shown, from: `tests/tools/${found.file}` })}\n`);
  else {
    console.log(`Wrote ${shown}, from tests/tools/${found.file}. It answers as the tool file does; change it to answer from the call and given:.`);
    console.log("It plays the tool only in scenarios with a given: block; the others play as before.");
  }
  return 0;
}

/** The tool file for `tool`: <tool>.yaml first, else any .yaml there whose tool: is it. */
function toolFile(dir: string, tool: string): { file: string; parsed: ToolFile } | undefined {
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort((a, b) => Number(b.startsWith(`${tool}.`)) - Number(a.startsWith(`${tool}.`)));
  for (const file of names) {
    try {
      const parsed = parseToolFile({ path: `tests/tools/${file}`, content: readFileSync(join(dir, file), "utf8") });
      if (parsed.tool === tool) return { file, parsed };
    } catch { /* not a tool file, or one flow test names when it runs */ }
  }
  return undefined;
}

/** The starter: the tool file's responses as the answers, the kinds listed, and how to go further. */
function starter(tool: string, file: string, parsed: ToolFile): string {
  const kinds = parsed.responses.map((r, i) => `//   ${i}: ${r.when}${r.error !== undefined ? " (an error)" : ""}`).join("\n");
  const name = tool.replace(/[-_]+([A-Za-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/^[^A-Za-z_$]/, "_$&");
  return `// ${tool} in tests, played by this code instead of a model, so its calls are free and give the
// same answer on every run. Optional: delete this file and a model plays ${tool} from
// tests/tools/${file}, as before.
//
// It plays ${tool} only in scenarios with a given: block; what given: holds (but tools and seed)
// reaches it as \`world\`, and a tool file's name there is that tool's usual output:
//   given:
//     stock: { oat: true }
//     tools: { ${tool}: usual }       # usual | slow | down | flaky 30%
// \`state\` is one object per run, shared by every fake: keep what ${tool} changed there (an order
// placed, a booking made) and check it at the end with the scenario's expect.state:
//   expect:
//     state: { orders: [{ name: Sam }] }
// \`call\` counts this tool's calls in the run (1 for the first), \`now\` is the test's clock.
// Keep it deterministic: no Math.random, no real clock.
//
// The responses of tests/tools/${file}, which it answers from as written:
${kinds}
import type { Fake } from "@flow-engineer/flow/testing";

const ${name}: Fake = ({ input, responses }) => {
  // The response written for exactly this input, else the usual one (the first with an output).
  // Change it to answer from input and world, and to keep what it changes in state.
  const same = responses.find((r) => r.input !== undefined && JSON.stringify(r.input) === JSON.stringify(input));
  const answer = same ?? responses.find((r) => r.output !== undefined) ?? responses[0];
  return answer?.error !== undefined ? { error: answer.error } : { output: answer?.output ?? null };
};

export default ${name};
`;
}
