// What every command that calls Flow's cloud shares (flow conversations, issues, templates, show,
// deploy, logs): one call that waits out a 429 and tries an idempotent request once more after a
// network error or a 5xx, a network failure that names the address and says it is one, a refused key
// explained as which key the command reads, where it looked and what it found (prefix and last 4,
// never the value), and --json's failure document. Node's own modules only.

import { setTimeout as delay } from "node:timers/promises";
import { RUN } from "../../src/names.ts";

/** Flow's cloud in each cell: the US one is the default; an agent in the India cell names its own. */
export const CLOUDS = { us: "https://flow.engineer/observe", in: "https://flow.engineer/dashboard/in" } as const;

/** The longest Retry-After waited out; a longer one is a failure that names the wait. */
export const MAX_WAIT_MS = 30_000;
/** How many 429s in a row one call waits out before it fails. */
const MAX_429 = 3;
/** The wait before the one retry after a network error or a 5xx. */
const RETRY_MS = 1000;

/** How a call waits and where it says so; tests give their own wait, so nothing sleeps. */
export interface Waits {
  /** Waits that many milliseconds (default: a timer). */
  wait?: (ms: number) => Promise<void>;
  /** Where a wait or a retry is said (default: stderr). */
  note?: (line: string) => void;
}

/** No answer came from the address: no connection, a name that does not resolve, a broken or timed-out connection. */
export class NetworkError extends Error {
  readonly code: string;
  readonly url: string;
  constructor(url: string, code: string, why: string) {
    super(`could not reach ${url}: network error ${code} (${why})`);
    this.code = code;
    this.url = url;
  }
}

/** What each network code means, for the message. */
const NETWORK_WHY: Record<string, string> = {
  ENOTFOUND: `the host name does not resolve: check --cloud or FLOW_FRAMEWORK_CLOUD (US ${CLOUDS.us}, India ${CLOUDS.in})`,
  EAI_AGAIN: "the host name could not be looked up just now: check this machine's network",
  ECONNREFUSED: "nothing accepts connections at that address",
  ECONNRESET: "the connection broke off",
  ETIMEDOUT: "the connection timed out",
  TIMEOUT: "no answer in time",
};

/** The error's network code (also on its cause), or undefined when it is not a network failure. */
function codeOf(error: unknown): string | undefined {
  let current = error;
  for (let guard = 0; current instanceof Error && guard < 6; guard++) {
    if (current.name === "TimeoutError") return "TIMEOUT";
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string" && /^E[A-Z_]+$/.test(code)) return code;
    for (const inner of current instanceof AggregateError ? current.errors : []) {
      const found = codeOf(inner);
      if (found) return found;
    }
    current = current.cause;
  }
  // fetch's own "fetch failed" with no code is still a network failure.
  return error instanceof TypeError && /fetch failed/.test(error.message) ? "EFETCH" : undefined;
}

/** Retry-After as seconds: delta-seconds or an HTTP date; undefined when absent or unreadable. */
export function retryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/** An answer: its status, Retry-After in seconds when it sent one, and its body as text. */
export interface Answer {
  status: number;
  retryAfter: number | undefined;
  text: string;
}

const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE"]);

/**
 * One call to the cloud. A 429 is waited out (its Retry-After, else 1 s; at most {@link MAX_WAIT_MS},
 * up to 3 in a row; a longer wait is answered as the 429 it is) and sent again, since the cloud did
 * nothing with it; an idempotent call (GET, HEAD, PUT, DELETE) is sent once more after a network
 * error or a 5xx without a Retry-After. Each wait is said on stderr. Throws {@link NetworkError} when no answer came.
 */
export async function cloudCall(url: string, init: RequestInit & { timeoutMs?: number } = {}, waits: Waits = {}): Promise<Answer> {
  const wait = waits.wait ?? ((ms: number) => delay(ms).then(() => undefined));
  const note = waits.note ?? ((line: string) => console.error(line));
  const method = (init.method ?? "GET").toUpperCase();
  const where = url.replace(/\?.*$/, "");
  let limited = 0;
  let retried = false;
  for (;;) {
    let answer: Answer;
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
      answer = { status: response.status, retryAfter: retryAfter(response.headers.get("retry-after")), text: await response.text() };
    } catch (error) {
      const code = codeOf(error);
      if (!code) throw error;
      if (IDEMPOTENT.has(method) && !retried) {
        retried = true;
        note(`${method} ${where}: network error ${code}; trying once more.`);
        await wait(RETRY_MS);
        continue;
      }
      const cause = ((error as Error).cause as Error | undefined)?.message;
      throw new NetworkError(where, code, code === "TIMEOUT" ? `no answer in ${Math.round((init.timeoutMs ?? 60_000) / 1000)} s` : NETWORK_WHY[code] ?? cause ?? "no answer from the address");
    }
    if (answer.status === 429 && limited < MAX_429) {
      const seconds = answer.retryAfter ?? 1;
      if (seconds * 1000 > MAX_WAIT_MS) return answer;
      limited++;
      note(`${new URL(url).host} is rate limiting this key (429): waiting ${seconds} s, then trying again.`);
      await wait(seconds * 1000);
      continue;
    }
    // A 5xx with a Retry-After asks to come back later: it is answered as it is, with its wait.
    if (answer.status >= 500 && answer.retryAfter === undefined && IDEMPOTENT.has(method) && !retried) {
      retried = true;
      note(`${method} ${where} answered ${answer.status}; trying once more.`);
      await wait(RETRY_MS);
      continue;
    }
    return answer;
  }
}

/** Which key a command reads. */
export type KeyKind = "flow_key" | "ci_key";

/** The key a command found: its name, where it was, and its value (never printed: only its prefix and last 4). */
export interface FoundKey {
  kind: KeyKind;
  name: string;
  /** "the environment", or the .env file it came from. */
  where: string;
  value: string;
}

/** A key as it may be printed: its known prefix and last 4, "flow_test_…1a2b". */
export function keyLabel(value: string): string {
  const prefix = /^(flow_test_|flow_live_|oci_|otk_test_|otk_live_|otk_|fk_test_|fk_live_|fk_|flow_api_|sk-or-|sk-)/.exec(value)?.[1];
  const last4 = value.length > 8 ? value.slice(-4) : "";
  return prefix ? `${prefix}…${last4}` : `a key of another kind${last4 ? ` ending ${last4}` : ""}`;
}

/** What each key is, as the errors and the help say it. */
const WANTS: Record<KeyKind, string> = {
  flow_key: "the agent's Flow key, FLOW_KEY (flow_test_... reads staging; flow_live_... reads staging and production)",
  ci_key: "the agent's CI key, FLOW_FRAMEWORK_CLOUD_KEY (oci_..., staging and production for deploys, staging for tests)",
};

/** Where to get the right key. */
export const GET_KEY = `${RUN} setup writes both into .env (FLOW_KEY as a flow_test_ key), or copy them from your agent's Developers page on the dashboard (https://flow.engineer/dashboard)`;

/**
 * The lines that follow a refused key (401, 403, bad_key, scope): which key `command` reads, where it
 * looked, what it found there, and how to get the right one.
 */
export function keyHelp(command: string, found: FoundKey, refusal?: { status: number; code?: string }): string {
  const wrongKind =
    found.kind === "flow_key" && found.value.startsWith("oci_") ? " That is a CI key; this command reads FLOW_KEY." :
    found.kind === "ci_key" && found.value.startsWith("flow_") ? " That is a Flow key (FLOW_KEY); this command reads the CI key." :
    found.kind === "flow_key" && /^(otk_|fk_)/.test(found.value) ? " That is a traces or messaging key, which does not read here." : "";
  const scope = refusal?.code === "scope" || refusal?.status === 403
    ? found.value.startsWith("flow_test_") || found.value.startsWith("oci_")
      ? " A test key reads staging only: add --env staging. Production reads need a flow_live_ FLOW_KEY with the traces scope, which flow setup does not make today: ask Flow for one."
      : ""
    : "";
  return [
    `${command} reads with ${WANTS[found.kind]}.`,
    `It found ${found.name}=${keyLabel(found.value)} in ${found.where}.${wrongKind}${scope}`,
    `Get the right one: ${GET_KEY}.`,
  ].join("\n");
}

/** Whether a refusal is about the key. */
export function keyRefused(status: number, code: string | undefined): boolean {
  return status === 401 || status === 403 || code === "bad_key" || code === "scope" || code === "unauthorized" || code === "forbidden";
}

/** The key story for every command's --help: which command reads which key, and each cell's cloud. */
export const KEYS_HELP = `Keys (the environment wins over the agent's .env; errors name a key by its prefix and last 4 only):
  FLOW_KEY                  flow_test_... reads staging, flow_live_... staging and production:
                            flow conversations, flow issues, flow templates. flow setup makes a
                            flow_test_ one; for production reads, ask Flow for a flow_live_ one.
                            flow insights (and insights show) needs the live one, flow_live_...:
                            flow setup writes only a test key today
  FLOW_FRAMEWORK_CLOUD_KEY  The CI key, oci_...: flow test, flow show, flow deploy (every
                            subcommand), flow logs, flow cli publish|rollback|status
  ${GET_KEY}.
Cloud (--cloud, else FLOW_FRAMEWORK_CLOUD): ${CLOUDS.us} (US, the default; /dashboard
  is the same) or ${CLOUDS.in} (an agent in the India cell).`;

/** --json's failure: one document on stdout, `{ ok: false, error: { code, message, hint? }, next }`. */
export function failureDocument(code: string, message: string, hint?: string, next?: string): string {
  return `${JSON.stringify({ ok: false, error: { code, message, ...(hint ? { hint } : {}) }, next: next ?? null })}\n`;
}
