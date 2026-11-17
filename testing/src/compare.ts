// `flow test compare`: the same scenarios played on two or more variants of the agent at the same time, and
// one table. It starts one ordinary `flow test --json` per variant (so the cloud, the flags, the flaky replay
// and the report are the ones `flow test` has), each told by FLOW_FRAMEWORK_COMPARE_CHILD what its variant
// changes (testing/src/variants.ts), and reads back each one's report and the events its agent emitted. The
// counts come from those events (variant-counts.ts), the noise rule is variant-stats.ts. Nothing here calls a model.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { FlowEvent } from "../../src/index.ts";
import { buildComparison, renderComparison, type VariantResult } from "./compare-table.ts";
import { loadSuite } from "./suite.ts";
import { childSpec, CURRENT, readVariantsFile, variantsFromFlags, type VariantSpec, type Variants } from "./variants.ts";
import { conversationCounts } from "./variant-counts.ts";
import type { JsonReport } from "./report.ts";

export const COMPARE_LINE = `  flow test compare [--variants <file> | --model <id>... | --instructions <file>... | --code-ref <ref>...] [test options]
                            Play the same scenarios on two or more variants of the agent at once
                            and print one table: pass rate, messages, model calls, time, tokens and
                            cost per variant, each difference marked "within noise" unless it clears a
                            stated rule (flow test compare --help)`;

const HELP = `Usage:
${COMPARE_LINE}

Compare variants of what you control, on the same scenarios, at the same time. The agent as it stands is
always the first variant, "current" (the baseline); name the others:

  --variants <file>        A YAML or JSON file: variants: { <name>: { instructions, model, code, builtIn,
                           agentUrl } } and optionally judge: [sentences] (below). Use it to change more
                           than one thing in a variant, or to set a model's reasoning, temperature,
                           prompt caching or base URL
  --model <id>             One variant per model id, given as often as you like. Any id the agent's own
                           key and provider can use (OPENROUTER_API_KEY, OPENAI_API_KEY, FLOW_KEY, ...)
  --instructions <file>    One variant per file that replaces the agent's instructions (agent/AGENTS.md)
  --code-ref <ref>         One variant per git ref (branch, tag or commit): the agent's code at that ref,
                           run in a temporary checkout beside your working tree
  --without-current        Leave the agent as it stands out; name two or more variants yourself

The flags of the three kinds do not mix; a variants file does. Test options, as flow test has them (each
variant is one session, so --concurrency is per variant): --runs <n> (default 5), --only <ids>,
--concurrency <runs>, --cloud <url>, --no-customer-data, --environment <name>, --no-retry,
--fail-on-flaky, --quick, --dotenv <path>, --agent-timeout <s>, --json. --save-events <folder> keeps each variant's events
(<name>.events.jsonl), what the counts are computed from, for your own analysis.

Variants file:
  judge:                                   # judged checks added to every scenario of every variant,
    - The acknowledgement does not narrate internal steps.   # read by the cloud's judge model: labelled judged
  variants:
    wording-b:
      instructions: { file: agent/AGENTS.b.md }          # or edits: [{ find: "text", replace: "text" }]
    sonnet:
      model: { id: anthropic/claude-sonnet-5, reasoning: low, temperature: 0.2, promptCaching: false }
    other-provider:
      model: { id: gpt-6-luna, baseUrl: https://api.openai.com/v1, apiKeyEnv: OPENAI_API_KEY }
    last-release:
      code: { ref: v0.19.0 }                             # or entry: src/agent-b.ts (another file in the same checkout)
    their-agent:
      agentUrl: http://localhost:3001/flow                # an agent on another framework (--agent-url)
    built-in-wording:                                      # for work on Flow Framework itself
      builtIn:
        edits: [{ find: "never that it is done", replace: "never that it has finished" }]

What is compared: each variant plays the same scenario files the same number of times, in its own session
(ref compare/<name>, so the dashboard keeps them off your main line). The simulated people are not seeded:
each run of each variant is its own conversation, which is why the table shows the spread.

How a difference is read: every number has a 95% interval; two variants differ on a row only when their
intervals do not overlap, else the row says "within noise" and, for pass rate, how many runs per scenario
would settle the gap seen now. Rows are not corrected for how many there are: one row clearing among many is a
lead to confirm with more runs. Counts are computed from the agent's events, not by a model; rows labelled
judged come from the cloud's judge model.

Exit status: 0 every variant played; 1 nothing was sent (a wrong flag or file); 2 a session or the cloud failed;
3 the cloud refused; 130 interrupted.`;

const FLAGS = {
  variants: { type: "string" },
  model: { type: "string", multiple: true },
  instructions: { type: "string", multiple: true },
  "code-ref": { type: "string", multiple: true },
  "without-current": { type: "boolean", default: false },
  cloud: { type: "string" },
  runs: { type: "string", default: "5" },
  only: { type: "string" },
  concurrency: { type: "string" },
  environment: { type: "string" },
  "no-retry": { type: "boolean", default: false },
  "fail-on-flaky": { type: "boolean", default: false },
  quick: { type: "boolean", default: false },
  "no-customer-data": { type: "boolean", default: false },
  dotenv: { type: "string" },
  "agent-timeout": { type: "string" },
  "save-events": { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

/** One variant's child, running. */
interface Child {
  name: string;
  proc: ChildProcess;
  stdout: string;
  stderr: string;
  code: number | null;
  startedAt: number;
  endedAt: number;
  done: Promise<void>;
}

/** The lines of a child's progress worth showing as they come: a run's verdict, the limits. */
const PROGRESS = /^(PASS|FAIL|FLAKY|ERROR|CREDIT|INVALID)\s|^Up to /;

export async function compareCli(argv: string[]): Promise<number> {
  let values: ReturnType<typeof parseArgs<{ options: typeof FLAGS }>>["values"];
  try {
    values = parseArgs({ args: argv, options: FLAGS, strict: true, allowPositionals: false }).values;
  } catch (error) {
    return fail(argv.includes("--json"), `flow test compare: ${(error as Error).message.split(". ")[0]}\n\n${HELP}`);
  }
  const json = values.json === true;
  const say = json ? (line: string) => console.error(line) : (line: string) => console.log(line);
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const projectDir = process.cwd();
  let plan: Variants;
  try {
    if (values.variants) {
      if (values.model?.length || values.instructions?.length || values["code-ref"]?.length) throw new Error("--variants names every variant: do not give --model, --instructions or --code-ref with it.");
      plan = readVariantsFile(resolve(projectDir, values.variants));
      if (values["without-current"]) plan = { ...plan, variants: plan.variants.filter((v) => v.name !== CURRENT) };
      if (plan.variants.length < 2) throw new Error("A comparison needs at least two variants.");
    } else {
      plan = variantsFromFlags({ model: values.model ?? [], instructions: values.instructions ?? [], codeRef: values["code-ref"] ?? [], withoutCurrent: values["without-current"] === true });
    }
    if (!/^[1-9]\d*$/.test(values.runs)) throw new Error(`--runs must be a whole number above 0 (got "${values.runs}").`);
    for (const v of plan.variants) if (v.spec.agentUrl && (v.spec.model || v.spec.instructions || v.spec.builtIn || v.spec.code)) throw new Error(`Variant ${v.name}: agentUrl is an agent running elsewhere, so it cannot also change model, instructions, code or built-in text here.`);
    if (!plan.variants.some((v) => v.spec.agentUrl) && !existsSync(join(projectDir, "src/agent.ts")) && !plan.variants.every((v) => v.spec.code?.entry)) throw new Error(`No src/agent.ts in ${projectDir}: run flow test compare from the agent's folder.`);
    if (!existsSync(join(projectDir, "tests", "scenarios"))) throw new Error(`No tests/scenarios in ${projectDir}: there is nothing to play.`);
    if (plan.judge.length && !loadSuite(join(projectDir, "tests")).some((f) => f.path.startsWith("scenarios/"))) throw new Error("No scenario files to add judged checks to.");
  } catch (error) {
    return fail(json, (error as Error).message);
  }

  const work = mkdtempSync(join(tmpdir(), "flow-compare-"));
  const checkouts: Array<{ root: string }> = [];
  const children: Child[] = [];
  let interrupted = false;
  const cleanup = () => {
    for (const c of checkouts) {
      try { execFileSync("git", ["worktree", "remove", "--force", c.root], { cwd: projectDir, stdio: "ignore" }); } catch { /* already gone */ }
    }
    rmSync(work, { recursive: true, force: true });
  };
  process.once("SIGINT", () => {
    interrupted = true;
    for (const c of children) c.proc.kill("SIGINT");
  });

  try {
    const prepared = plan.variants.map((variant) => {
      const files = { eventsFile: join(work, `${variant.name}.events.jsonl`), resultFile: join(work, `${variant.name}.result.json`) };
      const cwd = variant.spec.code?.ref ? checkout(projectDir, variant.name, variant.spec.code.ref, work, checkouts) : projectDir;
      const spec = childSpec(variant, projectDir, plan.judge, files);
      const specFile = join(work, `${variant.name}.spec.json`);
      writeFileSync(specFile, JSON.stringify(spec));
      return { variant, files, cwd, specFile };
    });

    say(`Comparing ${plan.variants.map((v) => v.name).join(", ")} (${plan.variants[0]!.name} is the baseline): ${values.runs} run${values.runs === "1" ? "" : "s"} of each scenario on each, all at the same time.`);
    const dotenv = values.dotenv ? resolve(projectDir, values.dotenv) : existsSync(join(projectDir, ".env")) ? join(projectDir, ".env") : undefined;
    for (const p of prepared) {
      const args = [process.argv[1]!, "test", "--json", "--min-pass", "0", "--runs", values.runs, "--ref", `compare/${p.variant.name}`];
      for (const [flag, value] of [["--cloud", values.cloud], ["--only", values.only], ["--concurrency", values.concurrency], ["--environment", values.environment], ["--agent-timeout", values["agent-timeout"]], ["--dotenv", dotenv], ["--agent-url", p.variant.spec.agentUrl]] as const) if (value) args.push(flag, value);
      for (const [flag, on] of [["--no-retry", values["no-retry"]], ["--fail-on-flaky", values["fail-on-flaky"]], ["--quick", values.quick], ["--no-customer-data", values["no-customer-data"]]] as const) if (on) args.push(flag);
      const proc = spawn(process.execPath, args, { cwd: p.cwd, env: { ...process.env, FLOW_FRAMEWORK_COMPARE_CHILD: p.specFile }, stdio: ["ignore", "pipe", "pipe"] });
      const child: Child = { name: p.variant.name, proc, stdout: "", stderr: "", code: null, startedAt: Date.now(), endedAt: 0, done: Promise.resolve() };
      let partial = "";
      proc.stdout!.on("data", (chunk) => { child.stdout += chunk; });
      proc.stderr!.on("data", (chunk) => {
        partial += chunk;
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          child.stderr += `${line}\n`;
          if (PROGRESS.test(line)) say(`[${child.name}] ${line}`);
        }
      });
      child.done = new Promise<void>((resolveDone) => proc.on("close", (code) => { child.code = code; child.endedAt = Date.now(); resolveDone(); }));
      children.push(child);
    }
    await Promise.all(children.map((c) => c.done));
    if (interrupted) return 130;

    const results: VariantResult[] = prepared.map((p, i) => {
      const child = children[i]!;
      let report: JsonReport | null = null;
      try { report = JSON.parse(child.stdout) as JsonReport; } catch { /* no report: it did not start */ }
      const events = existsSync(p.files.eventsFile) ? readEvents(p.files.eventsFile) : [];
      let unmatched: string[] = [];
      try { unmatched = (JSON.parse(readFileSync(p.files.resultFile, "utf8")) as { unmatchedEdits: string[] }).unmatchedEdits; } catch { /* the child never got to end */ }
      return { name: p.variant.name, spec: p.variant.spec, report, exitCode: child.code, wallMs: child.endedAt - child.startedAt, counts: p.variant.spec.agentUrl || !events.length ? null : conversationCounts(events), unmatchedEdits: unmatched, log: child.stderr.split("\n").filter(Boolean).slice(-4).join(" | ") };
    });
    if (values["save-events"]) {
      const folder = resolve(projectDir, values["save-events"]);
      mkdirSync(folder, { recursive: true });
      for (const p of prepared) if (existsSync(p.files.eventsFile)) copyFileSync(p.files.eventsFile, join(folder, `${p.variant.name}.events.jsonl`));
      say(`Events kept in ${folder}`);
    }
    const comparison = buildComparison(results, plan.judge, Number(values.runs));
    for (const line of renderComparison(comparison)) say(line);
    if (json) process.stdout.write(`${JSON.stringify(comparison)}\n`);
    // 1: a variant never sent anything; 3: the cloud refused; 2: a session failed. The comparison is printed whatever happened.
    return Math.max(0, ...results.map((r) => r.report?.exitCode ?? r.exitCode ?? 2));
  } catch (error) {
    return fail(json, (error as Error).message);
  } finally {
    cleanup();
  }
}

function fail(json: boolean, message: string): number {
  if (json) process.stdout.write(`${JSON.stringify({ version: 1, error: { message } })}\n`);
  console.error(message);
  return 1;
}

function readEvents(path: string): FlowEvent[] {
  const events: FlowEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try { events.push(JSON.parse(line) as FlowEvent); } catch { /* a line cut off by a kill */ }
  }
  return events;
}

/** A temporary checkout of `ref` for a code variant: the agent's folder in it, with node_modules and nothing else shared with the working tree. */
function checkout(projectDir: string, name: string, ref: string, work: string, made: Array<{ root: string }>): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let top: string;
  try { top = git("rev-parse", "--show-toplevel"); } catch { throw new Error(`Variant ${name}: code.ref needs the agent's folder to be in a git repository.`); }
  try { git("rev-parse", "--verify", `${ref}^{commit}`); } catch { throw new Error(`Variant ${name}: git has no ref "${ref}" in ${top}.`); }
  const root = join(work, `code-${name}`);
  git("worktree", "add", "--detach", root, ref);
  made.push({ root });
  const inside = relative(top, projectDir);
  // The checkout has only what git tracks: share the installed packages of the working tree.
  for (const rel of new Set(["", inside])) {
    const modules = join(top, rel, "node_modules");
    const target = join(root, rel, "node_modules");
    if (existsSync(modules) && !existsSync(target)) { mkdirSync(dirname(target), { recursive: true }); symlinkSync(modules, target); }
  }
  const dir = join(root, inside);
  if (!existsSync(dir)) throw new Error(`Variant ${name}: ${inside || "the agent's folder"} does not exist at ${ref}.`);
  return dir;
}
