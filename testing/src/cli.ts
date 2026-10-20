#!/usr/bin/env node
// The flow command. `flow new <name>` makes ./<name>/, an agent started from the café example, and
// `flow init` the same agent in the current folder (testing/src/new.ts). `flow chat` talks to the
// agent in this folder from the terminal (testing/src/chat.ts). `flow test`, or `flow` with flags, runs an agent's tests in the cloud,
// from the agent's folder:
//   flow test [--cloud https://flow.engineer/observe] [--runs 3] [--only late-order,refund | --failed] [--json]
// A hosted cloud (any --cloud off this machine, the default included) needs the
// agent's CI key in FLOW_FRAMEWORK_CLOUD_KEY and --synthetic, the attestation that the test files hold no real
// customer or member data. --agent-version (else GITHUB_SHA), --ref (else GitHub's branch) and
// --environment (staging or production) are kept with the session.
// The agent's src/agent.ts exports buildAgent({ model, events, tools }) and its tools; its tests are
// in tests/scenarios and tests/tools. An agent built on anything else is tested through its HTTP
// endpoint instead, with --agent-url (testing/src/http-agent.ts): its own tools run for real.
// `flow check-endpoint <url>` checks such an endpoint against spec/ first (testing/src/check-endpoint.ts).
// Once a session has opened, its results go to .flow/last-session.json in the agent's folder
// (what each run ended as and the judge's reasons, never the messages), and --failed runs again the
// scenarios that did not pass. --json prints one report (testing/src/report.ts) on stdout at every exit,
// and `flow show <run>` prints one run's record from the cloud (testing/src/show.ts).
// `flow login`, `logout`, `whoami`, `setup` and `link` sign in to flow.engineer and get the agent's
// keys and its phone link (testing/src/account.ts). `flow deploy` puts the agent on Flow's hosting
// (testing/src/deploy.ts).

import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { hasModelKey } from "../../src/model.ts";
import { PLUGIN_LINE, pluginCli } from "./plugin.ts";
import { OBSERVE_URL, setting } from "../../src/traces.ts";
import { cloudHeaders, runInCloud, SessionStopped, type ConnectOptions } from "./client.ts";
import type { SessionLimits } from "./protocol.ts";
import { runPrinter } from "./print-run.ts";
import { checkEndpointCli } from "./check-endpoint.ts";
import { CHECK_LINE as TOOLS_CHECK_LINE, checkCli, mcpUpdateCli } from "./check.ts";
import { ACCOUNT_COMMANDS, ACCOUNT_LINES, accountCli } from "./account.ts";
import { CHAT_LINE, chatCli } from "./chat.ts";
import { DEPLOY_LINE, deployCli, logsCli } from "./deploy.ts";
import { httpAgent } from "./http-agent.ts";
import { createInterface } from "node:readline/promises";
import { displayNameOf, folderName, initHere, newStandalone, packageRoot } from "./new.ts";
import { EXIT, finishedOutcome, invalidLines, invalidScenarios, loadEnv, networkCode, reportError, runVerdict, sessionInvalid, sessionInvalidLines, stoppedOutcome, type JsonReport, type Outcome, type ReportRun, type SessionInvalid, type Verdict } from "./report.ts";
import { LAST_SESSION, lastSessionIn, SHOW_LINE, showCli, type LastSession } from "./show.ts";
import { loadSuite, parseScenario, parseToolFile, suiteHash } from "./suite.ts";
import type { RunSummary } from "./protocol.ts";

const NEW_LINE = `  flow new <name> [--display-name <name>]
                            Make ./<name>/, a new agent started from the café example
  flow init [--display-name <name>]
                            Make that agent in the current folder, named after it.
                            --display-name is what people call it, such as "FlatX agent": a
                            phone reaches it with "Hi FlatX agent (ref <code>)" (asked for when
                            run in a terminal; else the folder's name in words)`;
const TEST_LINE = `  flow test [options]       Run the agent's tests in a test cloud, from the agent's folder
                            (src/agent.ts exports buildAgent({ model, events, tools }) and tools;
                            the tests are in tests/scenarios and tests/tools)`;
const CHECK_LINE = `  flow check-endpoint <url> [--token-env NAME] [--json]
                            Check an agent's HTTP endpoint against the contract, for --agent-url
                            (flow check-endpoint --help)`;
const MCP_LINE = `  flow mcp update        Write the tools of the MCP servers the agent uses (mcpTools) to
                            mcp.lock.json, from the agent's folder; commit it after the tests`;
const CLI_LINE = `  flow cli --server <url> <command>
                            Any MCP server's tools as commands (flow cli --server <url> --help)`;
const NEW_USAGE = `Usage:\n${NEW_LINE}\n\n  -h, --help                Show this help`;
const TEST_OPTIONS = `Options for test:
  --cloud <url>            The test cloud (default: FLOW_FRAMEWORK_CLOUD, else https://flow.engineer/observe)
  --runs <n>               Runs per scenario (default: 1)
  --only <ids>             Only these scenarios, comma-separated (file names without .yaml)
  --failed                 Only the scenarios that failed, errored or never played in the last
                           session (.flow/last-session.json), on every channel each plays.
                           Goes with --runs, not with --only
  --synthetic              Attest the test files hold no real customer data (a hosted cloud needs it)
  --json                   Print one JSON report on stdout when it ends, whatever the exit; every
                           other line goes to stderr
  --dotenv <path>          Read the environment from this file instead of the folder's .env
  --verbose                Also print slow event uploads
  --agent-version <v>      Kept with the session (default: GITHUB_SHA)
  --ref <ref>              Kept with the session (default: GitHub's branch)
  --environment <name>     staging or production, kept with the session
  --agent-url <url>        Test an agent you already have, on any framework, through its HTTP
                           endpoint (it may be http://localhost): each message is a POST to it from
                           this machine, and no src/agent.ts is loaded
  --channel <name>         With --agent-url: the channel every message names (default: the
                           platform each run plays, such as whatsapp or sms)
  --agent-timeout <s>      With --agent-url: how long one message waits for its answer (default: 60)
  -h, --help               Show this help

Limits: a hosted cloud plays a set number of runs at once per session, allows a number of
sessions at once per workspace, and has a daily test budget (the last 24 hours of test and
grading spend). They depend on the workspace; when the session opens the CLI prints them on one
line ("Up to 8 runs at once · daily test budget: $5 ($3.75 left) · 2 sessions at once on this
workspace") and --json reports them as limits (null from a cloud that does not send them).
A suite with more runs than that plays them in turn, so its time grows with the run count.

Exit status:
  0    Every run passed
  1    A run failed. Or nothing was sent: a wrong flag, a test file that does not parse,
       no FLOW_FRAMEWORK_CLOUD_KEY. The message is printed on its own
  2    The connection, the tunnel or the stream failed (before or after the session opened),
       the cloud answered 5xx or no JSON, the cloud ended the session for its own failure, or
       runs errored (the cloud could not play or judge them) and none failed. After the open:
       the runs that had finished, then "N of M runs finished before: <reason>" and the dashboard
  3    The cloud refused: the open (a bad or wrong key 401/403, an invalid request 400, busy
       429 rate_limited, the spend cap 429 spend_cap, 503 capacity), or it ended the session
       for the spend cap or capacity. A busy open with Retry-After up to 60 s is sent once more
  130  Interrupted (Ctrl-C). The same partial report as exit 2. The cloud keeps
       playing until it is stopped from the dashboard

Results: once the session has opened, every exit writes .flow/last-session.json in the agent's
folder: the session id, the cloud's agent id, dashboard link, suite hash and time, and per run its
scenario, channel, number, run id, verdict (passed, failed, errored or not_played) and failed checks
with the judge's reasons (and, for a scenario the cloud could not play, its file and what is wrong). Never the messages. The folder is git-ignored and the suite synthetic.

Environment (also read from the agent folder's .env, or --dotenv; variables already set win;
the CHINWAG_ names from before the rename still work):
  FLOW_FRAMEWORK_CLOUD     The test cloud, when --cloud is not given
  FLOW_FRAMEWORK_CLOUD_KEY The agent's CI key, for a hosted cloud (oci_...: flow setup
                           writes it, or make one at https://flow.engineer/observe, your agent, Developers)
  FLOW_FRAMEWORK_AGENT_TOKEN
                           With --agent-url: sent to it as authorization: Bearer <token>
  OPENROUTER_API_KEY       The agent's model key, or OPENAI_API_KEY, ANTHROPIC_API_KEY or
                           GEMINI_API_KEY: the first with a value is used, else FLOW_KEY
                           (the agent's Flow key, on its trial credit; flow setup writes it)`;
const TEST_USAGE = `Usage:\n${TEST_LINE}\n\n${TEST_OPTIONS}`;
const USAGE = `Usage:\n${NEW_LINE}\n${CHAT_LINE}\n${TEST_LINE}\n${SHOW_LINE}\n${CHECK_LINE}\n${TOOLS_CHECK_LINE}\n${MCP_LINE}\n${CLI_LINE}
${PLUGIN_LINE}\n${ACCOUNT_LINES}\n${DEPLOY_LINE}\n  flow --version         Show the version\n\n${TEST_OPTIONS}`;

/** What to do after new or init, from step 2; a model key comes first when none is set here. */
function nextSteps(): string {
  // link signs in and writes the keys first, FLOW_KEY (the model, on Flow's free trial credit) among
  // them, so npm start comes after it and has the model key and the channels from its first start.
  const steps = [
    `npx @flow-engineer/flow link --channel telegram (or whatsapp, imessage): signs in, writes the keys\n     into .env (FLOW_KEY pays for the model on Flow's free trial credit; ${hasModelKey(process.env) ? "your own model key in .env still wins" : "or put your own model key in .env"}) and prints the link for your phone`,
    `npm start, and open the link it prints: try it in the playground as its test people, channels side by side;\n     keep it running and text it from your phone`,
    `Tell your coding agent what to build: its skills are in .claude/skills/`,
  ];
  return steps.map((step, i) => `  ${i + 2}. ${step}`).join("\n");
}

checkNode(process.versions.node);

if (process.argv[2] === "plugin") process.exit(pluginCli(process.argv.slice(3)));

if (process.argv[2] === "check-endpoint") {
  // Its token may be in the agent folder's .env; no value is ever printed.
  loadEnv(undefined);
  process.exit(await checkEndpointCli(process.argv.slice(3)));
}
if (process.argv[2] === "show") process.exit(await showCli(process.argv.slice(3)));
if (process.argv[2] === "check") process.exit(await checkCli(process.argv.slice(3)));
if (process.argv[2] === "mcp") {
  if (process.argv[3] !== "update") {
    console.error(MCP_LINE.trim());
    process.exit(1);
  }
  process.exit(await mcpUpdateCli());
}
if (process.argv[2] === "cli") {
  // Loaded only here: @flow-engineer/flow/cli needs @modelcontextprotocol/client, an optional peer.
  const { defineCli, runCli } = await import("../../cli/src/index.ts");
  process.exit(await runCli(defineCli({ name: "flow" }), process.argv.slice(3)));
}
if (process.argv[2] === "deploy") process.exit(await deployCli(process.argv.slice(3)));
if (process.argv[2] === "logs") process.exit(await logsCli(process.argv.slice(3)));
if (process.argv[2] === "chat") process.exit(await chatCli(process.argv.slice(3)));
if (ACCOUNT_COMMANDS.has(process.argv[2] ?? "")) process.exit(await accountCli(process.argv[2]!, process.argv.slice(3)));

const TEST_FLAGS = {
  cloud: { type: "string" },
  runs: { type: "string", default: "1" },
  /** Only these scenarios (file names without .yaml, comma-separated); every tool file still goes. */
  only: { type: "string" },
  /** Only the scenarios that did not pass in .flow/last-session.json. */
  failed: { type: "boolean", default: false },
  synthetic: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  dotenv: { type: "string" },
  verbose: { type: "boolean", default: false },
  "agent-version": { type: "string" },
  ref: { type: "string" },
  environment: { type: "string" },
  "agent-url": { type: "string" },
  channel: { type: "string" },
  "agent-timeout": { type: "string", default: "60" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", default: false },
} as const satisfies ParseArgsOptionsConfig;

const { values, positionals } = parseCommandLine();
const [command, ...rest] = positionals;

if (values.version) {
  console.log(JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version);
  process.exit(0);
}
if (values.help || process.argv.length <= 2) {
  console.log(command === "new" || command === "init" ? NEW_USAGE : command === "test" ? TEST_USAGE : USAGE);
  process.exit(0);
}

/** --display-name, else asked for in a terminal (Enter takes the folder's name in words), else that default. */
async function askDisplayName(given: string | undefined, packageName: string): Promise<string | undefined> {
  if (given !== undefined || !process.stdin.isTTY || !process.stdout.isTTY) return given;
  const fallback = displayNameOf(undefined, packageName);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`What should people call your agent? Their phone says "Hi <it>" (Enter for "${fallback}"): `)).trim() || undefined;
  } finally {
    rl.close();
  }
}

const namedLine = (dir: string) => {
  const displayName = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { displayName?: string }).displayName;
  return `People call it "${displayName}" (package.json displayName, and its prompt agent/AGENTS.md): a phone reaches it with "Hi ${displayName} (ref <code>)".`;
};

const displayNameFlag = (values as { "display-name"?: string })["display-name"];

if (command === "new") {
  const name = rest.length === 1 ? rest[0]! : "";
  let dir: string;
  try {
    if (!name) throw new Error("Usage: flow new <name> [--display-name <name>]");
    dir = newStandalone(name, { displayName: await askDisplayName(displayNameFlag, name) });
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  console.log(`Made ./${name}/ from the café example. ${namedLine(dir)} Next:
  1. cd ${name} && npm install
${nextSteps()}`);
  process.exit(0);
}

if (command === "init") {
  let name: string;
  try {
    if (rest.length) throw new Error("Usage: flow init [--display-name <name>] (it makes the agent in the current folder; flow new <name> makes a folder for it)");
    name = initHere(process.cwd(), { displayName: await askDisplayName(displayNameFlag, folderName(process.cwd())) });
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  loadEnv(undefined); // a .env already here may hold a model key
  console.log(`Made ${name}, started from the café example, in this folder. ${namedLine(process.cwd())} Next:
  1. npm install
${nextSteps()}`);
  process.exit(0);
}

/** Every human line of `flow test`: stdout, or stderr with --json, where stdout is the report. */
const say = values.json ? (line: string) => console.error(line) : (line: string) => console.log(line);

// What the report says; filled in as the command gets that far.
let files: ReturnType<typeof loadSuite> = [];
let picked: Set<string> | undefined;
let perScenario = 1;
let sessionId = "";
let dashboard = "";
/** The cloud's limits for this workspace, from the open (none from an older cloud). */
let limits: SessionLimits | null = null;
let agentId = "";
const seen: RunSummary[] = [];
/** Set when the cloud ended the whole session scenario_invalid. */
let endedInvalid: SessionInvalid | null = null;

if (command !== undefined && (command !== "test" || rest.length)) invalid(`flow: unknown command "${positionals.join(" ")}".\n\n${USAGE}`);

const envProblem = loadEnv(values.dotenv);
if (envProblem) invalid(envProblem);

const runs = checkRuns(values.runs);
const cloud = values.cloud || setting("CLOUD") || OBSERVE_URL;
const ciKey = setting("CLOUD_KEY") || undefined;

let openHeaders: Record<string, string> = {};
try {
  openHeaders = cloudHeaders({
    cloud,
    ciKey,
    synthetic: values.synthetic!,
    agentVersion: values["agent-version"] || process.env.GITHUB_SHA || undefined,
    ref: values.ref || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || undefined,
    environment: values.environment,
  });
} catch (error) {
  const where = !ciKey && cloud.replace(/\/+$/, "") === OBSERVE_URL ? " Run npx @flow-engineer/flow login, then npx @flow-engineer/flow setup, to get one into .env." : "";
  invalid(`${(error as Error).message}${where}`);
}

const dir = process.cwd();
const agentUrl = values["agent-url"];
if (!agentUrl && values.channel) invalid("--channel goes with --agent-url.");
// The package name keeps the agent's history together; an agent tested by its URL may have none.
const packageJson = join(dir, "package.json");
const name = (existsSync(packageJson) ? (JSON.parse(readFileSync(packageJson, "utf8")) as { name?: string }).name : undefined) ?? (agentUrl ? basename(dir) : "agent");
// The agent's name for people: the first heading of its prompt (agent/AGENTS.md), such as "Pip".
const prompt = join(dir, "agent/AGENTS.md");
const title = existsSync(prompt) ? /^#\s+(.+)$/m.exec(readFileSync(prompt, "utf8"))?.[1]?.trim() : undefined;

let agent: Pick<ConnectOptions, "tools" | "build">;
if (agentUrl) {
  const timeout = Number(values["agent-timeout"]);
  if (!/^https?:\/\/[^/]/.test(agentUrl) || !URL.canParse(agentUrl)) invalid("--agent-url must be an http:// or https:// URL, such as http://localhost:3000/flow.");
  if (!(timeout > 0)) invalid("--agent-timeout must be a number of seconds above 0.");
  const token = setting("AGENT_TOKEN") || undefined;
  agent = { tools: [], build: ({ events }) => httpAgent({ url: agentUrl, token, channel: values.channel, timeoutMs: timeout * 1000, events }) };
} else {
  if (!existsSync(join(dir, "src/agent.ts"))) {
    invalid(`No src/agent.ts in ${dir}. Run flow test from your agent's folder, where src/agent.ts exports buildAgent({ model, events, tools }) and tools, or pass --agent-url to test an agent on another framework by its HTTP endpoint.`);
  }
  // Flow Framework runs the agent here, so its traces are marked as a test's (src/traces.ts).
  process.env.FLOW_FRAMEWORK_RUN_KIND = "test";
  const module = await import(pathToFileURL(join(dir, "src/agent.ts")).href);
  if (typeof module.buildAgent !== "function" || !Array.isArray(module.tools)) {
    invalid("src/agent.ts must export buildAgent({ model, events, tools }) and tools, or pass --agent-url to test an agent by its HTTP endpoint.");
  }
  // A business run's agent also gets its channels and clock (testing/src/business.ts); buildAgent passes them on to createAgent.
  agent = { tools: module.tools, build: ({ tools, events, channels, testing }) => module.buildAgent({ tools, events, ...(channels ? { channels, testing } : {}) }) };
}

/** With --agent-url the agent's own tools run for real: the suite's tool simulators do not apply. */
function forUrl(files: ReturnType<typeof loadSuite>) {
  if (!agentUrl) return files;
  const toolFiles = files.filter((f) => f.path.startsWith("tools/"));
  if (toolFiles.length) console.warn(`Not sent: ${toolFiles.map((f) => f.path).join(", ")}. Tool simulators play a Flow Framework agent's tools; your agent's own tools run for real.`);
  for (const f of files.filter((f) => f.path.startsWith("scenarios/"))) {
    const scenario = parseScenario(f); // checkSuite has read it already
    if (scenario.world || scenario.expect.outcome?.length) {
      console.warn(`${scenario.id}: its world and outcome checks are for simulated tools; your agent's tools run on its side, so the judge sees no tool calls. Running it anyway.`);
    }
  }
  return files.filter((f) => !f.path.startsWith("tools/"));
}

function only(files: ReturnType<typeof loadSuite>, ids: Set<string> | undefined) {
  if (!ids) return files;
  const kept = files.filter((f) => !f.path.startsWith("scenarios/") || ids.has(f.path.slice("scenarios/".length, -".yaml".length)));
  const missing = [...ids].filter((id) => !kept.some((f) => f.path === `scenarios/${id}.yaml`));
  if (missing.length) invalid(`No scenario named ${missing.join(", ")}.`);
  return kept;
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const printRun = runPrinter(say);
const suite = loadSuite(join(dir, "tests"));
picked = values.failed ? failedLastTime(suite) : values.only ? new Set(values.only.split(",").map((s) => s.trim())) : undefined;
const chosen = only(suite, picked);
checkSuite(chosen);
files = forUrl(chosen);
if (agentUrl) await checkAgentReachable(agentUrl);
perScenario = runs;
const expected = expectedRuns(files, perScenario);

function reportStop(done: RunSummary[], reason: string, link: string, ended: Ended) {
  for (const run of done) printRun(run);
  console.error(`${done.length} of ${expected} runs finished before: ${reason}`);
  if (link) console.error(link);
  if (ended === "interrupted" && link) console.error(`the cloud keeps playing; stop it from the dashboard: ${link}`);
  saveSession(ended, done, link, console.error);
}

process.on("SIGINT", () => {
  reportStop(seen, "interrupted", dashboard, "interrupted");
  end("interrupted", { received: seen, error: reportError(undefined, "interrupted") });
});

let summary: Awaited<ReturnType<typeof runInCloud>>;
try {
  summary = await runInCloud({
    cloud,
    name,
    title,
    ...agent,
    files,
    testsDir: join(dir, "tests"),
    runs: perScenario,
    openHeaders,
    log: say,
    verbose: values.verbose,
    onRun: (run) => { seen.push(run); printRun(run); },
    onLimits: (sent) => { limits = sent; },
    onDashboard: (url, id, cloudAgent) => { dashboard = url; sessionId = id; agentId = cloudAgent ?? agentId; process.env.FLOW_FRAMEWORK_TEST_SESSION = id; },
  });
} catch (error) {
  const reason = stoppedReason(error, cloud);
  if (error instanceof SessionStopped) {
    dashboard = error.dashboard || dashboard;
    reportStop(error.runs, reason, dashboard, "stopped");
    end("transport", { received: error.runs, error: reportError(error, reason) });
  }
  console.error(reason);
  endedInvalid = sessionInvalid(error, files.filter((f) => f.path.startsWith("scenarios/")).map((f) => ({ scenario: f.path.slice("scenarios/".length, -".yaml".length), path: f.path })));
  if (endedInvalid) for (const line of sessionInvalidLines(endedInvalid)) console.error(line);
  // The cloud stopped a session that had opened: what finished is kept, the rest is not_played.
  saveSession("stopped", seen, dashboard, console.error);
  end(stoppedOutcome(error, sessionId !== ""), { received: seen, error: reportError(error, reason) });
}

say("");
for (const r of summary.runs) printRun(r);
const passed = summary.runs.filter((r) => runVerdict(r) === "passed").length;
const errored = summary.runs.filter((r) => runVerdict(r) === "errored").length;
const total = (pick: (r: (typeof summary.runs)[number]) => number) => summary.runs.reduce((n, r) => n + pick(r), 0);
const agentModels = [...new Set(summary.runs.flatMap((r) => r.agentModels))].join(", ") || "unknown";
const noModel = summary.runs.filter((r) => r.agentModels.length === 0 && r.agentUsage.input + r.agentUsage.output === 0).length;
const modelCalls = noModel ? `${noModel} ${noModel === 1 ? "run never called" : "runs never called"} the agent's model.` : "Every run called the agent's model.";
const checkFails = summary.runs.filter((r) => runVerdict(r) === "failed" && r.checks.some((c) => !c.pass)).length;
const erroredLine = errored ? ` ${errored} errored (the cloud could not play or judge ${errored === 1 ? "it" : "them"}).` : "";
const tokens = (n: number) => n.toLocaleString("en-US");
say(`\n${passed} of ${summary.runs.length} runs passed.${erroredLine} ${modelCalls} ${checkFails} failed a check. Agent: ${agentModels}; person, tools and judge: ${summary.testModel}.`);
for (const channel of [...new Set(summary.runs.map((r) => r.channel))]) {
  const runs = summary.runs.filter((r) => r.channel === channel);
  say(`  ${channel}: ${runs.filter((r) => runVerdict(r) === "passed").length} of ${runs.length} passed`);
}
for (const line of invalidLines(invalidScenarios(mergedRuns(summary.runs).map((m) => ({ scenario: m.scenario, invalid: m.summary?.invalid }))))) say(line);
if (summary.lost) say(`The cloud lost session ${summary.lost.sessionId} part way; a second session played its unfinished runs. The first: ${summary.lost.dashboard}`);
say(`Cost: ${usd(total((r) => r.agentUsage.costUsd))} agent (${tokens(total((r) => r.agentUsage.input))} in, ${tokens(total((r) => r.agentUsage.output))} out) + ${usd(total((r) => r.testUsage.costUsd))} test models.\n${summary.dashboard}`);
sessionId = summary.sessionId || sessionId;
dashboard = summary.dashboard || dashboard;
saveSession("finished", summary.runs, dashboard, say);
end(finishedOutcome(mergedRuns(summary.runs)), { received: summary.runs });

/** How a session ended: its summary came, it broke off or the cloud stopped it, or Ctrl-C. */
type Ended = LastSession["ended"];

/** One run the session was to play, with what the cloud reported for it (none: it was never played). */
interface Merged {
  scenario: string;
  channel: string;
  run: number;
  verdict: Verdict;
  summary?: RunSummary;
}

/** Each run sent (scenario file, channel, number) with its report; a run that never came is not_played. */
function mergedRuns(received: RunSummary[]): Merged[] {
  const sent = files.filter((f) => f.path.startsWith("scenarios/"));
  const fileOf = new Map<string, string>();
  const byRun = new Map<string, RunSummary>();
  const key = (scenario: string, channel: string, run: number) => `${scenario}\n${channel}\n${run}`;
  for (const r of received) byRun.set(key(r.scenario, r.channel, r.run), r);
  const merged = (scenario: string, r: RunSummary): Merged => ({
    scenario,
    channel: r.channel,
    run: r.run,
    // An error or run_failed: the cloud could not play or judge the run, which says nothing about the agent.
    verdict: runVerdict(r),
    summary: r,
  });
  const out: Merged[] = [];
  for (const file of sent) {
    const scenario = parseScenario(file);
    const id = file.path.slice("scenarios/".length, -".yaml".length);
    fileOf.set(scenario.id, id);
    for (let run = 1; run <= perScenario; run++) {
      for (const channel of scenario.channels) {
        // A scenario the cloud could not read is named by its file, not its id.
        const r = byRun.get(key(scenario.id, channel, run)) ?? byRun.get(key(id, channel, run));
        byRun.delete(key(scenario.id, channel, run));
        if (r) byRun.delete(key(r.scenario, channel, run));
        out.push(r ? merged(id, r) : { scenario: id, channel, run, verdict: "not_played" });
      }
    }
  }
  // A run the cloud numbered or named differently is still kept, never lost.
  for (const r of byRun.values()) out.push(merged(fileOf.get(r.scenario) ?? r.scenario, r));
  return out;
}

/** The failed checks, with the judge's reasons: the reason can quote the conversation, which the suite attests is synthetic. */
function failedChecks(r?: RunSummary) {
  return (r?.checks ?? []).filter((c) => !c.pass).map((c) => ({ kind: c.kind, text: c.text, reason: c.reason }));
}

/** Writes the session's results, once it has opened, and prints where. */
function saveSession(ended: Ended, received: RunSummary[], link: string, print: (line: string) => void): void {
  if (!sessionId) return;
  const last: LastSession = {
    sessionId,
    ...(agentId ? { agent: agentId } : {}),
    dashboard: link,
    suiteHash: suiteHash(files),
    endedAt: new Date().toISOString(),
    ended,
    only: picked ? [...picked] : null,
    runs: mergedRuns(received).map((m) => ({
      scenario: m.scenario,
      channel: m.channel,
      run: m.run,
      runId: m.summary?.runId ?? null,
      verdict: m.verdict,
      failedChecks: failedChecks(m.summary),
      ...(m.summary?.invalid ? { invalid: m.summary.invalid } : {}),
    })),
    ...(endedInvalid ? { sessionInvalid: endedInvalid } : {}),
  };
  const path = join(dir, LAST_SESSION);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(last, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    print(`Could not write ${LAST_SESSION}: ${(error as Error).message}`);
    return;
  }
  print(`Results: ${LAST_SESSION} (flow test --failed runs again what did not pass)`);
}

/** Exits with the outcome's status, printing the JSON report on stdout first with --json. */
function end(outcome: Outcome, options: { received?: RunSummary[]; error?: JsonReport["error"] } = {}): never {
  const exitCode = EXIT[outcome];
  if (values.json) {
    const received = options.received ?? [];
    const runs: ReportRun[] = sessionId ? mergedRuns(received).map((m) => ({
      runId: m.summary?.runId ?? null,
      scenario: m.scenario,
      channel: m.channel,
      run: m.run,
      verdict: m.verdict,
      error: m.summary?.error || null,
      ended: m.summary?.ended ?? null,
      turns: m.summary?.turns ?? null,
      watch: m.summary?.watch || null,
      failedChecks: failedChecks(m.summary),
      invalid: m.summary?.invalid ?? null,
    })) : [];
    const count = (verdict: Verdict) => runs.filter((r) => r.verdict === verdict).length;
    const cost = (pick: (r: RunSummary) => number) => received.reduce((n, r) => n + pick(r), 0);
    const report: JsonReport = {
      version: 1,
      outcome,
      exitCode,
      sessionId: sessionId || null,
      agent: agentId || null,
      dashboard: dashboard || null,
      suiteHash: files.length ? suiteHash(files) : null,
      error: options.error ?? null,
      counts: { runs: runs.length, passed: count("passed"), failed: count("failed"), errored: count("errored"), notPlayed: count("not_played") },
      costUsd: { agent: cost((r) => r.agentUsage.costUsd), test: cost((r) => r.testUsage.costUsd) },
      runs,
      invalid: invalidScenarios(runs),
      sessionInvalid: endedInvalid,
      limits,
    };
    writeAll(`${JSON.stringify(report)}\n`);
  }
  process.exit(exitCode);
}

/** Nothing was sent: prints what is wrong and exits 1 (with --json, after the report). */
function invalid(message: string): never {
  console.error(message);
  end("invalid", { error: reportError(undefined, message) });
}

/** stdout in full before the exit, even when it is a pipe the reader is slow to empty. */
function writeAll(text: string): void {
  let bytes = Buffer.from(text);
  while (bytes.length) {
    try {
      bytes = bytes.subarray(writeSync(1, bytes));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    }
  }
}

/** The scenarios that did not pass in the last session, or exits: 0 when nothing failed, 1 when there is no last session. */
function failedLastTime(suite: ReturnType<typeof loadSuite>): Set<string> {
  if (values.only) invalid("--failed picks its scenarios from the last session and does not go with --only: run one or the other.");
  const path = lastSessionIn(dir);
  if (!existsSync(path)) invalid(`No ${LAST_SESSION} in ${dir}: run flow test first, then flow test --failed runs again what did not pass.`);
  let last: LastSession;
  try {
    last = JSON.parse(readFileSync(path, "utf8")) as LastSession;
    if (!Array.isArray(last.runs)) throw new Error("it has no runs");
  } catch (error) {
    invalid(`${LAST_SESSION} could not be read (${(error as Error).message}): run flow test again.`);
  }
  const ids = [...new Set(last.runs.filter((r) => r.verdict !== "passed").map((r) => r.scenario))];
  if (!ids.length) {
    say(`Nothing failed in the last session (${last.sessionId}).`);
    if (last.only) say(`It ran only ${last.only.join(", ")}: run flow test for the whole suite.`);
    end("passed");
  }
  const have = new Set(suite.filter((f) => f.path.startsWith("scenarios/")).map((f) => f.path.slice("scenarios/".length, -".yaml".length)));
  const gone = ids.filter((id) => !have.has(id));
  const kept = ids.filter((id) => have.has(id));
  if (gone.length) console.warn(`No longer in tests/scenarios, skipped: ${gone.join(", ")}.`);
  if (!kept.length) invalid(`None of the scenarios that did not pass in session ${last.sessionId} are still in tests/scenarios: run flow test.`);
  say(`Running again what did not pass in session ${last.sessionId}, on every channel each plays: ${kept.join(", ")}.`);
  return new Set(kept);
}

/** Scenarios actually sent, times the channels each one plays, times --runs. */
function expectedRuns(sent: ReturnType<typeof loadSuite>, runs: number): number {
  if (!(runs > 0)) return 0;
  let count = 0;
  for (const file of sent) {
    if (!file.path.startsWith("scenarios/")) continue;
    count += parseScenario(file).channels.length * runs;
  }
  return count;
}

/** Why the session stopped or never opened; a network failure names the address and its code. */
function stoppedReason(error: unknown, cloud: string): string {
  const code = networkCode(error);
  if (!code) return error instanceof Error ? error.message : String(error);
  return `Could not reach ${cloud}: ${code}.`;
}

/** The command's flags, or exits 1 with what is wrong and that command's usage. */
function parseCommandLine() {
  const isNew = process.argv[2] === "new" || process.argv[2] === "init";
  const options = isNew ? { help: TEST_FLAGS.help, version: TEST_FLAGS.version, "display-name": { type: "string" } } : TEST_FLAGS;
  try {
    return parseArgs({ allowPositionals: true, strict: true, options: options as typeof TEST_FLAGS });
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    const unknown = code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /'([^']+)'/.exec(message)?.[1] : undefined;
    const usage = isNew ? NEW_USAGE : process.argv[2] === "test" ? TEST_USAGE : USAGE;
    console.error(`flow: ${unknown ? `unknown option ${unknown}` : message.split(". ")[0]}\n\n${usage}`);
    process.exit(1);
  }
}

/** --runs as a whole number above 0, or exits 1. */
function checkRuns(runs: string): number {
  if (/^[1-9]\d*$/.test(runs)) return Number(runs);
  invalid(`--runs must be a whole number above 0, such as 3 (got "${runs}").`);
}

/** Every scenario and tool file read as the cloud reads it, before anything is sent; exits 1 with each problem at its line. */
function checkSuite(sent: ReturnType<typeof loadSuite>): void {
  const problems: string[] = [];
  for (const file of sent) {
    const named = { path: join("tests", file.path), content: file.content };
    try {
      if (file.path.startsWith("scenarios/")) parseScenario(named);
      else if (!agentUrl) parseToolFile(named);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (!problems.length) return;
  invalid(`${problems.join("\n")}\n\nNothing was sent: fix the test files above.`);
}

/** One HEAD request to the agent's URL, which a turn never is: any HTTP answer means it is listening. */
async function checkAgentReachable(url: string): Promise<void> {
  const request = url.startsWith("https:") ? httpsRequest : httpRequest;
  const problem = await new Promise<string | undefined>((resolve) => {
    const req = request(url, { method: "HEAD", agent: false, timeout: 10_000 }, (response) => {
      response.resume();
      resolve(undefined);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("no answer in 10 s"), { code: "ETIMEDOUT" })));
    req.on("error", (error) => resolve(networkCode(error) ?? error.message));
    req.end();
  });
  if (!problem) return;
  invalid(`Could not reach your agent at ${url}: ${problem}. Start it first, or check --agent-url.`);
}

/** Flow Framework runs agents' TypeScript as it is, which needs Node 22.18 or newer. */
function checkNode(version: string): void {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 18)) return;
  console.error(`Flow Framework needs Node 22.18 or newer (you have ${version}).`);
  process.exit(1);
}
