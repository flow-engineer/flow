// `flow test --run-in-cloud`: the agent's whole test session runs on Flow's cloud, detached from this
// machine, and this command only sends the folder, starts it and follows its output.
//
//   flow test --run-in-cloud [flow test flags] [--no-follow]
//   flow test attach [<run-id>] [--cloud <url>] [--json]     what the run printed so far, then follows it
//   flow test stop [<run-id>] [--cloud <url>] [--json]       ends the run
//
// The sequence: the folder's files are listed (path, size, sha256, without PACK_EXCLUDES), the cloud
// answers with the run's id and which of those it lacks, the id is printed and recorded in
// .flow/runs/ before anything is sent, only the missing files are uploaded, the run is started and
// followed by long polls until it ends. The run never depends on this process: Ctrl-C only stops
// following. Routes: /v1/hosting/test-runs, with the agent's CI key as `flow deploy` uses it.
// Node's own modules only.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { RESULTS_DIR } from "../../src/names.ts";
import { CLOUDS, cloudCall, failureDocument, NetworkError, type Waits } from "./cloud-call.ts";
import { cloudOf, PACK_EXCLUDES, Refused, type Api } from "./deploy.ts";
import { LAST_SESSION } from "./show.ts";

const RUNS_DIR = join(RESULTS_DIR, "runs");
/** A file named by its bare name in the folder that is sent although .env.* is not (the committed test settings). */
const SENT_ENV = "tests/.env.test";
/** How many files go up at once, and how many times one is tried. */
const UPLOAD_AT_ONCE = 4;
const UPLOAD_TRIES = 3;
/** The longest one look waits on the server (its limit is 25). */
const WAIT_SECONDS = 25;
/** A follow that cannot reach the cloud this many times in a row gives up (the run goes on regardless). */
const LOST_TRIES = 12;
const LOST_MAX_MS = 15_000;
const TERMINAL = new Set(["finished", "stopped", "failed"]);

export const RUN_LINES = `  flow test --run-in-cloud [options]
                            Run the tests on Flow's cloud instead of this machine: the run goes on
                            if this terminal closes (flow test --help)
  flow test attach [<run-id>]
                            Print what a cloud run printed so far, then follow it (default: the last run)
  flow test stop [<run-id>]
                            Stop a cloud run (default: the last run)`;

export const RUN_OPTIONS = `Running in the cloud (flow test --run-in-cloud, or FLOW_TEST_RUN_IN_CLOUD=1):
  The folder is sent to Flow's cloud (every file except node_modules, .git, .flow and every .env*
  file but tests/.env.test, which is for the tests' committed, non-secret settings), built from its
  lockfile and run there with your other flags: --runs, --only, --failed and --changed (worked out here
  and sent as --only), --quick, --timing, --fail-on-flaky, --concurrency, --stop-failed-runs,
  --no-retry, --min-pass, --verbose, --agent-version, --ref, --environment and --json. The agent's model
  key is the one in its hosted secrets, else a Flow key made for the run. Only files the cloud does not
  already hold are uploaded, so a one-line change sends one file. Not with --agent-url: an agent you
  serve yourself is tested from your machine.
  --run-in-cloud           Run in the cloud (also FLOW_TEST_RUN_IN_CLOUD=1)
  --no-follow              Print the run id and return once it has started (exit 0); flow test
                           attach <id> follows it later
  The run id is printed first and kept in .flow/runs/, so flow test attach (no id: the last run)
  and flow test stop work from the folder. The output you see is the run's own; when it ends its
  result is written to .flow/last-session.json, so --failed and --changed work on it, and the exit
  status is the run's (a run Flow could not run, such as a failed build, exits 1 with the reason).
  Ctrl-C stops following only: the run goes on, and it prints how to attach and how to stop it
  (exit 130). A terminated process with no terminal (a cancelled CI job) stops the run, since
  nobody is left to attach (exit 143).
  Limits: the folder may hold up to 50 MB, a run lasts up to 60 minutes, and a workspace has 12
  runner-hours a day; past a limit the message says so: ask Flow support to raise it.
  Not available in the India cell yet: a workspace there (--cloud https://flow.engineer/dashboard/in) is told so.`;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** The process's signals, so a test can raise one. */
export interface Signals {
  once(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
}

export interface Hooks {
  io?: Io;
  signals?: Signals;
  /** Whether someone is at a terminal (default: stdin is a TTY). */
  tty?: boolean;
  /** Waits that many milliseconds (default a timer; tests do not sleep). */
  wait?: (ms: number) => Promise<void>;
  waits?: Waits;
}

const realIo: Io = { out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t) };
const sleep = (ms: number) => delay(ms).then(() => undefined);

/** The cloud's run, as far as this command reads it. */
interface Run {
  id: string;
  status: "uploading" | "building" | "running" | "finished" | "stopped" | "failed";
  exit_code: number | null;
  error: string | null;
}
interface Chunk {
  i: number;
  stream: "out" | "err";
  text: string;
}
interface Page {
  run: Run;
  chunks: Chunk[];
  next: number;
  report: Record<string, unknown> | null;
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

function excluded(name: string): boolean {
  return PACK_EXCLUDES.some((p) => (p.includes("*") ? new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(name) : p === name));
}

/**
 * The files of the folder that go to the cloud, sorted by path: regular files only, without
 * PACK_EXCLUDES at any depth (as the deploy's tar leaves them out), except tests/.env.test.
 */
export function buildManifest(dir: string): ManifestFile[] {
  const files: ManifestFile[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      const path = relative(dir, full).split(sep).join("/");
      if (excluded(entry.name) && path !== SENT_ENV) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const bytes = readFileSync(full);
        files.push({ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  };
  walk(dir);
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The flags `flow test` was given that the run in the cloud repeats; --failed and --changed arrive as --only. */
export function cloudArgs(values: Record<string, string | boolean | undefined>, only: Set<string> | undefined, minPass: string | undefined): string[] {
  const args: string[] = ["--no-customer-data"];
  if (values.runs !== undefined && values.runs !== "1") args.push("--runs", String(values.runs));
  if (only) args.push("--only", [...only].join(","));
  for (const flag of ["quick", "timing", "fail-on-flaky", "stop-failed-runs", "no-retry", "verbose", "json"]) if (values[flag]) args.push(`--${flag}`);
  if (values.concurrency !== undefined) args.push("--concurrency", String(values.concurrency));
  if (minPass !== undefined) args.push("--min-pass", minPass);
  for (const flag of ["agent-version", "ref", "environment"]) if (values[flag] !== undefined) args.push(`--${flag}`, String(values[flag]));
  return args;
}

/** The package.json name, which is the agent's name for the cloud as flow test uses it; nothing when there is none. */
function agentName(dir: string): { agent_name?: string } {
  try {
    const name = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }).name;
    return typeof name === "string" && name ? { agent_name: name } : {};
  } catch {
    return {};
  }
}

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a failed command says, as one JSON document on stdout with --json, always as text on stderr. */
function failer(io: Io, json: boolean) {
  return (code: string, message: string, exit: number, next?: string): number => {
    if (json) io.out(failureDocument(code, message, undefined, next));
    io.err(`${next ? `${message}\nNext: ${next}` : message}\n`);
    return exit;
  };
}

class Gone extends Error {}

/** The run's folder record: where its id is kept so attach and stop can find it. */
function recordRun(dir: string, id: string, cloud: string, args: string[]): void {
  const folder = join(dir, RUNS_DIR);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), `${JSON.stringify({ id, cloud, args, created_at: new Date().toISOString() }, null, 2)}\n`);
  writeFileSync(join(folder, "last"), `${id}\n`);
}

/** The run a command means: its argument, else the folder's last run. */
function pickRun(dir: string, given: string | undefined): { id: string; cloud?: string } | undefined {
  const folder = join(dir, RUNS_DIR);
  const id = given ?? (existsSync(join(folder, "last")) ? readFileSync(join(folder, "last"), "utf8").trim() : "");
  if (!id) return undefined;
  try {
    const record = JSON.parse(readFileSync(join(folder, `${id}.json`), "utf8")) as { cloud?: string };
    return { id, cloud: record.cloud };
  } catch {
    return { id };
  }
}

function saveReport(dir: string, report: Record<string, unknown>): void {
  const path = join(dir, LAST_SESSION);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** Resolves with the signal's name when the process gets SIGINT or SIGTERM; `off` takes the handlers away. */
function interruption(signals: Signals): { signalled: Promise<"SIGINT" | "SIGTERM">; off: () => void } {
  let onInt!: () => void;
  let onTerm!: () => void;
  const signalled = new Promise<"SIGINT" | "SIGTERM">((resolve) => {
    onInt = () => resolve("SIGINT");
    onTerm = () => resolve("SIGTERM");
    signals.once("SIGINT", onInt);
    signals.once("SIGTERM", onTerm);
  });
  return { signalled, off: () => (signals.off("SIGINT", onInt), signals.off("SIGTERM", onTerm)) };
}

interface Session {
  dir: string;
  api: Api;
  io: Io;
  json: boolean;
  wait: (ms: number) => Promise<void>;
}

/**
 * Prints what the run printed from chunk `from` and follows it to its end, retrying a lost connection
 * with a backoff (the run is on the server, not here). Writes the run's report to .flow/last-session.json
 * and returns the exit status; throws Gone for a run the cloud does not know.
 */
async function follow(s: Session, id: string, from: number): Promise<number> {
  let after = from;
  let failures = 0;
  for (;;) {
    let page: Page;
    try {
      page = await s.api<Page>("GET", `/v1/hosting/test-runs/${id}?after=${after}&wait=${WAIT_SECONDS}`);
    } catch (error) {
      if (error instanceof Refused && error.status === 404) throw new Gone();
      const lost = error instanceof NetworkError || (error instanceof Refused && error.status !== undefined && error.status >= 500);
      if (!lost) throw error;
      if (++failures >= LOST_TRIES) {
        s.io.err(`Could not reach Flow's cloud for a while. The run ${id} goes on there: flow test attach ${id} follows it again.\n`);
        return 2;
      }
      if (failures === 1) s.io.err(`Lost the connection to Flow's cloud; the run goes on there. Trying again...\n`);
      await s.wait(Math.min(LOST_MAX_MS, 1000 * 2 ** (failures - 1)));
      continue;
    }
    failures = 0;
    for (const chunk of page.chunks) {
      if (chunk.i < after) continue;
      (chunk.stream === "err" ? s.io.err : s.io.out)(chunk.text);
    }
    after = Math.max(after, page.next);
    if (page.report) saveReport(s.dir, page.report);
    // Ended and nothing left to read (an answer holds at most 500 chunks, so a long output takes several looks).
    if (TERMINAL.has(page.run.status) && page.chunks.length === 0) return ended(s, page.run);
  }
}

/** The exit status of an ended run; a run Flow could not run says why. */
function ended(s: Session, run: Run): number {
  if (run.status === "finished") return run.exit_code ?? 1;
  const why = run.error ?? (run.status === "stopped" ? "it was stopped" : "it did not finish");
  const message = `Run ${run.id} ${run.status === "stopped" ? "was stopped" : "failed"}: ${why.replace(/\.$/, "")}.`;
  if (s.json) s.io.out(failureDocument(run.status === "stopped" ? "stopped" : "run_failed", message));
  s.io.err(`${message}\n`);
  return 1;
}

/** An error of the cloud as a failure line and exit status. */
function refusal(fail: ReturnType<typeof failer>, error: unknown, id = ""): number {
  if (error instanceof Gone) return fail("not_found", `Flow's cloud has no run ${id}. It may belong to another agent or workspace, or be too old to be kept: flow test --run-in-cloud starts a new one.`, 1);
  if (error instanceof Refused) return fail(error.code, error.message, error.status === 413 ? 1 : 3);
  if (error instanceof NetworkError) return fail("network", `Could not reach the cloud: ${error.message}.${id ? ` The run ${id} goes on there: flow test attach ${id}.` : ""}`, 2);
  return fail("internal", `flow test failed: ${(error as Error).message}`, 1);
}

async function putFile(s: Session, abs: string, sha256: string, url: string, hooks: Hooks): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const bytes = readFileSync(abs);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Refused(`${abs} changed while it was being sent: run the command again.`, "changed", false);
    try {
      const answer = await cloudCall(url, { method: "PUT", body: bytes, timeoutMs: 120_000 }, hooks.waits);
      if (answer.status >= 200 && answer.status < 300) return;
      if (answer.status < 500 || attempt >= UPLOAD_TRIES) throw new Refused(`Uploading ${relative(s.dir, abs)} failed: ${answer.status}.`, "upload_failed", false, answer.status);
    } catch (error) {
      if (!(error instanceof NetworkError) || attempt >= UPLOAD_TRIES) throw error;
    }
    await s.wait(1000 * attempt);
  }
}

/** Uploads the files whose hashes are in `uploads`, a few at a time. */
async function upload(s: Session, files: ManifestFile[], uploads: Record<string, string>, hooks: Hooks): Promise<void> {
  const byHash = new Map<string, ManifestFile>();
  for (const f of files) if (uploads[f.sha256] && !byHash.has(f.sha256)) byHash.set(f.sha256, f);
  const queue = [...byHash.values()];
  const worker = async (): Promise<void> => {
    for (let f = queue.shift(); f; f = queue.shift()) await putFile(s, join(s.dir, f.path), f.sha256, uploads[f.sha256]!, hooks);
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_AT_ONCE, queue.length) }, worker));
}

export interface CloudRun {
  dir: string;
  cloud: string;
  api: Api;
  /** The flags the cloud's run repeats (cloudArgs). */
  args: string[];
  json: boolean;
  follow: boolean;
}

/** `flow test --run-in-cloud`: returns the exit status. */
export async function runDetached(options: CloudRun, hooks: Hooks = {}): Promise<number> {
  const io = hooks.io ?? realIo;
  const fail = failer(io, options.json);
  const say = (line: string) => (options.json ? io.err : io.out)(`${line}\n`);
  const s: Session = { dir: options.dir, api: options.api, io, json: options.json, wait: hooks.wait ?? sleep };
  const tty = hooks.tty ?? Boolean(process.stdin.isTTY);

  // The India cell has no runners yet: say so before anything is packed or sent.
  if (options.cloud.replace(/\/+$/, "") === CLOUDS.in) return fail("not_available", "Running tests in Flow's cloud is not available in your region yet; it is coming. Run flow test without --run-in-cloud: it runs the same tests on your machine.", 1);
  const files = buildManifest(options.dir);
  if (!files.length) return fail("usage", `Nothing to send: ${options.dir} holds no files.`, 1);
  let created: { run: Run; missing: string[]; uploads: Record<string, string> };
  try {
    created = await options.api("POST", "/v1/hosting/test-runs", { files, args: options.args, synthetic: true, ...agentName(options.dir) });
  } catch (error) {
    return refusal(fail, error);
  }
  const { run } = created;
  // The id comes first, and is kept, before anything is sent: whatever happens next, the run can be found again.
  say(`Run ${run.id}`);
  try {
    recordRun(options.dir, run.id, options.cloud, options.args);
  } catch (error) {
    say(`Could not write .flow/runs/${run.id}.json: ${(error as Error).message}. Note the id above.`);
  }
  const bySha = new Map(files.map((f) => [f.sha256, f]));
  const missing = [...new Set(created.missing)].map((h) => bySha.get(h)).filter((f): f is ManifestFile => Boolean(f));
  const total = files.reduce((n, f) => n + f.size, 0);
  const sent = missing.reduce((n, f) => n + f.size, 0);
  say(`Packing ${plural(files.length, "file")} (${fmtSize(total)}): ${missing.length ? `sending only ${plural(missing.length, "file")} (${fmtSize(sent)})` : "sending nothing, the cloud already has every file"}...`);

  const { signalled, off } = interruption(hooks.signals ?? process);
  let started = false;
  const work = async (): Promise<number> => {
    try {
      await upload(s, files, created.uploads, hooks);
      try {
        await options.api("POST", `/v1/hosting/test-runs/${run.id}/start`, {});
      } catch (error) {
        // The cloud lost or disliked a blob: it names what it still lacks, and those are sent once more.
        const body = error instanceof Refused ? error.body : undefined;
        if (!(error instanceof Refused) || error.code !== "not_uploaded") throw error;
        const again = (body?.uploads ?? {}) as Record<string, string>;
        if (!Object.keys(again).length) throw new Refused(`${error.message} Run the command again.`, "not_uploaded", false, error.status);
        await upload(s, files, again, hooks);
        await options.api("POST", `/v1/hosting/test-runs/${run.id}/start`, {});
      }
      started = true;
      const hint = `flow test attach ${run.id} follows it, flow test stop ${run.id} ends it`;
      if (!options.follow) {
        say(`Started. ${hint}.`);
        if (options.json) io.out(`${JSON.stringify({ ok: true, run: { id: run.id, status: "running" }, next: `flow test attach ${run.id}` })}\n`);
        return 0;
      }
      say(`Started; following it. Ctrl-C leaves it running: ${hint}.`);
      return await follow(s, run.id, 0);
    } catch (error) {
      return refusal(fail, error, run.id);
    }
  };
  try {
    const result = await Promise.race([work(), signalled]);
    if (typeof result === "number") return result;
    return await interrupted(s, fail, run.id, result, started, tty);
  } finally {
    off();
  }
}

/**
 * Ctrl-C leaves the run going (a person at a terminal can attach again or stop it), and says how. A
 * SIGTERM with no terminal is a cancelled CI job or a killed shell: nobody is left to attach, so the run is
 * stopped rather than left to use runner-hours for 60 minutes. A run that never started is stopped either
 * way, since there is nothing to follow.
 */
async function interrupted(s: Session, fail: ReturnType<typeof failer>, id: string, signal: "SIGINT" | "SIGTERM", started: boolean, tty: boolean): Promise<number> {
  const code = signal === "SIGINT" ? 130 : 143;
  if (!started || (signal === "SIGTERM" && !tty)) {
    try {
      await s.api("POST", `/v1/hosting/test-runs/${id}/stop`, {});
    } catch { /* the cloud ends an unstarted run itself */ }
    s.io.err(`${started ? "Terminated" : "Interrupted before the run started"}: run ${id} was stopped.\n`);
    return code;
  }
  s.io.err(`\nStopped following. The run ${id} goes on in Flow's cloud.\n  Follow it again: flow test attach ${id}\n  Stop it:         flow test stop ${id}\n`);
  return code;
}

/** `flow test attach [<run-id>]` and `flow test stop [<run-id>]`. */
export async function runCli(command: "attach" | "stop", argv: string[], env: NodeJS.ProcessEnv = process.env, hooks: Hooks = {}, dir = process.cwd()): Promise<number> {
  const io = hooks.io ?? realIo;
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { cloud: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  } catch (error) {
    return failer(io, argv.includes("--json"))("usage", `${(error as Error).message}\n\nUsage: flow test ${command} [<run-id>] [--cloud <url>] [--json]`, 1);
  }
  const json = Boolean(parsed.values.json);
  const fail = failer(io, json);
  if (parsed.values.help) {
    io.out(`Usage: flow test ${command} [<run-id>] [--cloud <url>] [--json]\n  ${command === "attach" ? "Prints what a cloud run printed so far, then follows it and exits with its status." : "Stops a cloud run."} Without an id: the last run of this folder (.flow/runs).\n`);
    return 0;
  }
  if (parsed.positionals.length > 1) return fail("usage", `flow test ${command} takes one run id.`, 1);
  const picked = pickRun(dir, parsed.positionals[0]);
  if (!picked) return fail("usage", `No run to ${command}: ${RUNS_DIR} holds none. Pass the run id (trn_...) that flow test --run-in-cloud printed.`, 1);
  const { key, api } = cloudOf(dir, env, parsed.values.cloud ?? picked.cloud, hooks.waits);
  if (!key) return fail("no_ci_key", "Set FLOW_FRAMEWORK_CLOUD_KEY to your agent's CI key (oci_...), in the environment or the agent's .env.", 2, "flow setup");
  const s: Session = { dir, api, io, json, wait: hooks.wait ?? sleep };
  try {
    if (command === "stop") {
      const { run } = await api<{ run: Run }>("POST", `/v1/hosting/test-runs/${picked.id}/stop`, {});
      const line = TERMINAL.has(run.status) && run.status !== "stopped" ? `Run ${run.id} had already ${run.status === "finished" ? "finished" : "failed"}.` : `Stopped run ${run.id}.`;
      if (json) {
        io.out(`${JSON.stringify({ ok: true, run: { id: run.id, status: run.status } })}\n`);
        io.err(`${line}\n`);
      } else io.out(`${line}\n`);
      return 0;
    }
    const { signalled, off } = interruption(hooks.signals ?? process);
    try {
      const result = await Promise.race([follow(s, picked.id, 0), signalled]);
      if (typeof result === "number") return result;
      return await interrupted(s, fail, picked.id, result, true, hooks.tty ?? Boolean(process.stdin.isTTY));
    } finally {
      off();
    }
  } catch (error) {
    return refusal(fail, error, picked.id);
  }
}
