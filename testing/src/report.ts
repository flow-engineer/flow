// What `flow test --json` prints, how an error that stopped a session is classified into an
// outcome and an exit status, and the pieces `flow test` and `flow show` share.

import { existsSync } from "node:fs";
import { CloudEnded, isTransportFailure, PostError, SessionStopped, type SendPathProblem } from "./client.ts";
import type { RunOutcome, ScenarioSummary, SessionLimits } from "./protocol.ts";

/** How a `flow test` ended, one per exit status (0 passed; 1 failed, invalid; 2 errored, transport; 3 refused; 130 interrupted). */
export type Outcome = "passed" | "failed" | "errored" | "transport" | "refused" | "interrupted" | "invalid";

/** flaky: the run failed, and the cloud played it once more and it passed (it counts as failed only with --strict). */
export type Verdict = "passed" | "failed" | "flaky" | "errored" | "not_played";

export interface ReportError {
  message: string;
  /** The cloud's HTTP status, when it answered one. */
  status: number | null;
  /** The cloud's code for it, such as spend_cap or rate_limited. */
  type: string | null;
  retryAfterSeconds: number | null;
}

export interface ReportRun {
  runId: string | null;
  /** The scenario's file name without .yaml, as --only takes it. */
  scenario: string;
  channel: string;
  run: number;
  verdict: Verdict;
  /** passed, failed, credit or infra (runOutcome); null for a run never played. */
  outcome: RunOutcome | null;
  /** The cloud's code when it could not play or judge the run (judge_failed, spend_cap, ...); else null. */
  error: string | null;
  ended: string | null;
  turns: number | null;
  watch: string | null;
  failedChecks: Array<{ kind: string; text: string; reason: string }>;
  /** The scenario file the cloud could not play and what is wrong in it (error scenario_invalid); else null. */
  invalid: { path: string; reason: string } | null;
  /** The cloud's second play of this failed run; null when it played it once (it passed, or an older cloud). */
  rerun: { runId: string; passed: boolean; watch: string } | null;
  /** On a failed run played again: flaky when the second play passed, failing when it failed too; else null. */
  label: "flaky" | "failing" | null;
  /** How many person, tool and judge answers this run replayed from stored ones; null when the cloud said none. */
  replayed: { person: number; tools: number; judge: number } | null;
}

/** A scenario the cloud could not play, once per scenario. */
export interface InvalidScenario {
  scenario: string;
  path: string;
  reason: string;
}

/** The cloud ended the whole session scenario_invalid: what it said after the code (null when nothing),
 * whether that looks like a cloud older than this client, and the scenario files this session sent. */
export interface SessionInvalid {
  reason: string | null;
  olderCloud: boolean;
  sent: Array<{ scenario: string; path: string }>;
}

/** `flow test --json`: one document on stdout, whatever the exit. */
export interface JsonReport {
  version: 1;
  outcome: Outcome;
  exitCode: number;
  sessionId: string | null;
  /** The cloud's id for the agent, which `flow show` reads runs under. */
  agent: string | null;
  dashboard: string | null;
  suiteHash: string | null;
  error: ReportError | null;
  /** runs: the suite's runs (a cloud's second play of a failed run is not one of its own). failed: the runs
   * that failed, and with --strict the flaky ones too; flaky: the runs that failed once and passed when played again. */
  counts: { runs: number; passed: number; failed: number; flaky: number; errored: number; notPlayed: number; credit: number; infra: number };
  /** Each scenario's pass rate per channel, over its --runs times (credit and infra runs not counted). */
  scenarios: ScenarioSummary[];
  /** Messages that reached the cloud by another way than the agent's send, or that the agent said it sent and never did (testing/src/client.ts). */
  sendPath: SendPathProblem[];
  /** --strict: a flaky run counts as failed (outcome failed, exit 1). */
  strict: boolean;
  costUsd: { agent: number; test: number };
  runs: ReportRun[];
  /** Each scenario the cloud could not play; the other scenarios played. */
  invalid: InvalidScenario[];
  /** Set when the cloud ended the whole session scenario_invalid; else null. */
  sessionInvalid: SessionInvalid | null;
  /** The cloud's limits for the workspace (runs and sessions at once, the daily test budget); null when it sent none. */
  limits: SessionLimits | null;
}

/** Error codes that mean a model or the workspace's test budget was out of credit. */
const CREDIT_ERRORS = new Set(["spend_cap", "agent_credit"]);
const OUTCOMES = new Set<string>(["passed", "failed", "credit", "infra"]);

/** What a run came to: the cloud's `outcome` when it sent one, else from its error and result the same way.
 * A run the cloud played again keeps the first play's outcome (failed); its verdict says flaky. */
export function runOutcome(run: { passed: boolean; ended: string; error?: string; outcome?: string }): RunOutcome {
  if (run.outcome && OUTCOMES.has(run.outcome)) return run.outcome as RunOutcome;
  if (run.error && CREDIT_ERRORS.has(run.error)) return "credit";
  if (run.error || run.ended === "run_failed") return "infra";
  return run.passed ? "passed" : "failed";
}

/** What a credit or infra run's line says: the cloud's sentence, else one per kind. */
export function outcomeReason(run: { error?: string; ended: string; errorMessage?: string }, outcome: RunOutcome): string {
  if (run.errorMessage) return run.errorMessage;
  if (outcome === "credit") {
    return run.error === "spend_cap"
      ? "the workspace's daily test budget ran out, so this run says nothing about the agent"
      : "the agent's model refused its calls for credit, so this run says nothing about the agent: add a model key or top up, then run it again";
  }
  return `${run.error ?? run.ended}: the cloud could not play or judge this run, not the agent's fault`;
}

/** Each scenario's pass rate per channel, in the order the runs come, as the cloud's summary says it (protocol.ts ScenarioSummary):
 * runs counts the ones that passed or failed; flaky when some but not all passed, or a run failed and passed when the cloud played it again. */
export function scenarioRates(runs: Array<{ scenario: string; channel: string; verdict: Verdict; outcome: RunOutcome | null }>): ScenarioSummary[] {
  const out = new Map<string, ScenarioSummary & { mixed: boolean }>();
  for (const r of runs) {
    const key = `${r.scenario}\n${r.channel}`;
    let s = out.get(key);
    if (!s) out.set(key, (s = { scenario: r.scenario, channel: r.channel, runs: 0, passedRuns: 0, credit: 0, infra: 0, mixed: false }));
    if (r.outcome === "credit" || r.outcome === "infra") s[r.outcome]++;
    if (r.outcome === "passed" || r.outcome === "failed") {
      s.runs++;
      if (r.outcome === "passed") s.passedRuns++;
      if (r.verdict === "flaky") s.mixed = true;
    }
  }
  return [...out.values()].map(({ mixed, ...s }) => (mixed || (s.passedRuns > 0 && s.passedRuns < s.runs) ? { ...s, label: "flaky" as const } : s));
}

/** A run's verdict: errored when the cloud names an error for it or ended it run_failed, since the cloud
 * could not play or judge it and that says nothing about the agent (a judge_failed run can end goal_met);
 * flaky when it failed and passed when the cloud played it again. */
export function runVerdict(run: { passed: boolean; ended: string; error?: string; label?: string }): Exclude<Verdict, "not_played"> {
  if (run.error || run.ended === "run_failed") return "errored";
  if (run.passed) return "passed";
  return run.label === "flaky" ? "flaky" : "failed";
}

export const EXIT: Record<Outcome, number> = { passed: 0, failed: 1, invalid: 1, errored: 2, transport: 2, refused: 3, interrupted: 130 };

/** A session that ran to its summary: failed when a run failed (or, with `strict`, was flaky), errored when the
 * cloud could not play or judge a run (or never played it). A flaky run alone does not fail it. */
export function finishedOutcome(runs: Array<{ verdict: Verdict }>, strict = false): Outcome {
  if (runs.some((r) => r.verdict === "failed" || (strict && r.verdict === "flaky"))) return "failed";
  if (runs.some((r) => r.verdict !== "passed" && r.verdict !== "flaky")) return "errored";
  return "passed";
}

/** What stopped a session, or the open, as an outcome. `opened`: the session had opened. */
export function stoppedOutcome(error: unknown, opened: boolean): Outcome {
  if (error instanceof SessionStopped) return "transport";
  if (error instanceof CloudEnded) return error.code === "spend_cap" || error.code === "capacity" ? "refused" : "errored";
  const refusal = postErrorOf(error);
  if (refusal) {
    const why = refusal.type ?? refusal.code;
    if (refusal.status === 503 && why === "capacity") return "refused";
    if (refusal.status >= 400 && refusal.status < 500 && why) return "refused";
    return "transport";
  }
  if (isTransportFailure(error) || networkCode(error)) return "transport";
  // Something on this machine: the agent would not build before the open, or broke the session after it.
  return opened ? "failed" : "invalid";
}

/** The scenarios the cloud could not play, once each, from the runs it reported (a run per channel and --runs). */
export function invalidScenarios(runs: Array<{ scenario: string; invalid?: { path: string; reason: string } | null }>): InvalidScenario[] {
  const out = new Map<string, InvalidScenario>();
  for (const r of runs) if (r.invalid) out.set(`${r.scenario}\n${r.invalid.path}`, { scenario: r.scenario, path: r.invalid.path, reason: r.invalid.reason });
  return [...out.values()];
}

/** The lines that name each scenario the cloud could not play. */
export function invalidLines(invalid: InvalidScenario[]): string[] {
  if (!invalid.length) return [];
  const lines = [`${invalid.length} ${invalid.length === 1 ? "scenario" : "scenarios"} could not be played (fix ${invalid.length === 1 ? "it" : "them"} and run again):`];
  for (const i of invalid) lines.push(`  ${i.scenario}: ${i.path}: ${i.reason}${unsupported(i.reason)}`);
  return lines;
}

/** A reason naming a key the cloud does not know: the client may be newer than the cloud. */
export function unsupported(reason: string): string {
  return reason.startsWith("unsupported: ") ? " (the test cloud does not know this key; it may be older than this client)" : "";
}

/** A session the cloud ended scenario_invalid; null for any other stop. A tools/ or checks/ file with
 * its reason is the suite's own problem; anything else (no reason, or a scenario, which a current
 * cloud reports as that scenario's run) suggests a cloud older than this client. */
export function sessionInvalid(error: unknown, sent: Array<{ scenario: string; path: string }>): SessionInvalid | null {
  if (!(error instanceof CloudEnded)) return null;
  const match = /^scenario_invalid(?::\s*(.*))?$/s.exec(error.error.trim());
  if (!match) return null;
  const reason = match[1]?.trim() || null;
  const suiteFile = reason !== null && /^(?:\S*\/)?(?:tools|checks)\/[^:]+:\s*\S/.test(reason);
  return { reason, olderCloud: !suiteFile, sent };
}

/** The lines that say why the session ended scenario_invalid. */
export function sessionInvalidLines(info: SessionInvalid): string[] {
  const lines = [`The test cloud could not play this suite${info.reason ? `: ${info.reason}` : " and gave no reason."}`];
  if (info.olderCloud) lines.push("the test cloud may be older than this client");
  lines.push(`Scenarios sent: ${info.sent.map((s) => `${s.scenario} (${s.path})`).join(", ") || "none"}`);
  return lines;
}

/** The error as the JSON report says it: the cloud's status, code and Retry-After when it answered. */
export function reportError(error: unknown, message: string): ReportError {
  const refusal = postErrorOf(error);
  const type = refusal ? refusal.type ?? refusal.code ?? null : error instanceof CloudEnded ? error.code ?? null : null;
  const retry = refusal?.retryAfterMs;
  return { message, status: refusal?.status ?? null, type, retryAfterSeconds: retry === undefined ? null : Math.ceil(retry / 1000) };
}

function postErrorOf(error: unknown): PostError | undefined {
  let current = error;
  for (let guard = 0; current instanceof Error && guard < 6; guard++) {
    if (current instanceof PostError) return current;
    current = current.cause;
  }
  return undefined;
}

/** The connection's error code, from the error or what caused it. */
export function networkCode(error: unknown): string | undefined {
  let current = error;
  for (let guard = 0; current instanceof Error && guard < 6; guard++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ETIMEDOUT" || code === "ECONNRESET") return code;
    for (const inner of current instanceof AggregateError ? current.errors : []) {
      const innerCode = networkCode(inner);
      if (innerCode) return innerCode;
    }
    current = current.cause;
  }
  return undefined;
}

/** The agent folder's .env, or the --dotenv given; variables already set win, and no value is ever printed.
 * Returns what is wrong when a named file cannot be read. */
export function loadEnv(file: string | undefined): string | undefined {
  if (file === undefined) {
    if (existsSync(".env")) process.loadEnvFile(".env");
    return undefined;
  }
  if (!existsSync(file)) return `--dotenv ${file}: no such file.`;
  try {
    process.loadEnvFile(file);
  } catch (error) {
    return `--dotenv ${file} could not be read: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}.`;
  }
  return undefined;
}
