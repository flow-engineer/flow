// `flow test pull`: the test drafts Flow made from the hosted agent's conversations that went wrong
// (the business kept, its people made up), written to tests/drafts/<file> for the developer to read:
//   GET  {cloud}/v1/agent/test-drafts                { drafts: [{ id, file, yaml, check, made_on, pulled }] }
//   POST {cloud}/v1/agent/test-drafts/{id}/pulled    204, once its file is written
// With the agent's CI key (FLOW_FRAMEWORK_CLOUD_KEY) and the cloud flow test uses. Drafts never run or
// gate: flow test reads only tests/scenarios and tests/tools (suite.ts loadSuite); a draft moved into
// tests/scenarios/ is a test. Exit status: 0 every draft written or left as asked, 1 anything else.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OBSERVE_URL, setting } from "../../src/traces.ts";
import { Failed, get, parse, table } from "./conversations.ts";
import { loadEnv } from "./report.ts";
import { parseScenario } from "./suite.ts";

export const PULL_LINE = `  flow test pull [--force] [--dry-run] [--json]
                            Write the test drafts Flow made from conversations that went wrong
                            into tests/drafts/; they never run until moved into tests/scenarios/`;

const USAGE = `Usage:
  flow test pull [options]

Writes each test draft Flow made from the hosted agent's conversations that went wrong (made-up
people, your business as it is) to tests/drafts/<file>, from the agent's folder, and tells Flow it
was pulled. A draft already pulled, or whose file is there already, is not written again. Each is
checked as a scenario first; one that does not parse is named and not written.
Drafts never run or gate: flow test reads only tests/scenarios and tests/tools. Read a draft, and
move it into tests/scenarios/ to keep it as a test.

Options:
  --force                  Write every draft, those pulled before too, over a file already there
  --dry-run                List what it would write; write nothing and tell Flow nothing
  --json                   One JSON report on stdout: each draft's file, title, check and what was done
  --cloud <url>            Flow's address (default: FLOW_FRAMEWORK_CLOUD, else ${OBSERVE_URL})
  --dotenv <path>          Read the environment from this file instead of the folder's .env
  -h, --help               Show this help

Reads with the agent's CI key, FLOW_FRAMEWORK_CLOUD_KEY (oci_...: flow setup writes it into .env);
it is never printed.
Exit status: 0 every draft written or left as told, 1 a wrong flag, no key, a draft that does not
parse, or the server refused or could not be reached (its message is printed).`;

interface Draft { id?: unknown; file?: unknown; yaml?: unknown; check?: unknown; made_on?: unknown; pulled?: unknown }
/** What was done with one draft. */
type Done = "written" | "would_write" | "unchanged" | "exists" | "pulled_before" | "invalid";
interface Row { id: string; file: string; title: string | null; check: string | null; done: Done; problem?: string }

/** A draft's file name: a plain .yaml name, never a path. */
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.yaml$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Runs `flow test pull ...`; resolves to the exit status. */
export async function pullCli(args: string[]): Promise<number> {
  const name = "flow test pull";
  const parsed = parse(name, args, { force: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false } }, USAGE);
  if (!parsed) return 1;
  const { values, positionals } = parsed;
  if (values.help) return console.log(USAGE), 0;
  if (positionals.length) return console.error(`${name} takes no arguments.\n\n${USAGE}`), 1;
  const envProblem = loadEnv(values.dotenv);
  if (envProblem) return console.error(envProblem), 1;
  const key = setting("CLOUD_KEY")?.trim();
  if (!key) return console.error(`${name} reads with the agent's CI key: set FLOW_FRAMEWORK_CLOUD_KEY (flow setup writes it into .env).`), 1;
  const cloud = (values.cloud || setting("CLOUD") || OBSERVE_URL).replace(/\/+$/, "");
  const say = values.json ? (line: string) => console.error(line) : (line: string) => console.log(line);

  let drafts: Draft[];
  try {
    const { body } = await get(name, cloud, key, "/v1/agent/test-drafts");
    if (!Array.isArray(body.drafts)) throw new Failed(`${name}: ${cloud} answered without a list of drafts.`);
    drafts = body.drafts as Draft[];
  } catch (error) {
    return console.error(refusal(name, error)), 1;
  }

  const dir = join(process.cwd(), "tests", "drafts");
  const rows: Row[] = [];
  let failed = false;
  for (const draft of drafts) {
    const id = typeof draft.id === "string" ? draft.id : "";
    const file = typeof draft.file === "string" ? draft.file : "";
    const row: Row = { id, file: `tests/drafts/${file}`, title: null, check: null, done: "invalid" };
    rows.push(row);
    if (!ID.test(id) || !FILE.test(file) || typeof draft.yaml !== "string") {
      row.problem = `not a draft Flow should send (id ${JSON.stringify(id)}, file ${JSON.stringify(file)}): nothing written`;
      failed = true;
      continue;
    }
    try {
      const scenario = parseScenario({ path: row.file, content: draft.yaml });
      row.title = scenario.title ?? scenario.id;
      row.check = scenario.origin?.check ?? null;
    } catch (error) {
      row.problem = (error as Error).message;
      failed = true;
      continue;
    }
    const path = join(dir, file);
    const there = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (!values.force && draft.pulled === true) row.done = "pulled_before";
    else if (!values.force && there !== undefined) row.done = there === draft.yaml ? "unchanged" : "exists";
    else row.done = values["dry-run"] ? "would_write" : "written";
    if (values["dry-run"] || row.done === "pulled_before" || row.done === "exists") continue;
    if (row.done === "written") {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, draft.yaml);
    }
    if (draft.pulled === true) continue;
    try {
      await get(name, cloud, key, `/v1/agent/test-drafts/${id}/pulled`, "POST");
    } catch (error) {
      row.problem = `written, but Flow was not told it was pulled: ${refusal(name, error)}`;
      failed = true;
    }
  }

  if (values.json) process.stdout.write(`${JSON.stringify({ drafts: rows })}\n`);
  for (const line of lines(rows, values["dry-run"]!)) say(line);
  return failed ? 1 : 0;
}

/** What to print for a refused or failed call: a blocked export as the server wrote it, a key not accepted in plain words. */
function refusal(name: string, error: unknown): string {
  if (!(error instanceof Failed)) throw error;
  if (error.status === 403 && error.code === "export_blocked" && error.said) return error.said;
  if (error.status === 401) return `${name}: FLOW_FRAMEWORK_CLOUD_KEY was not accepted (401): use the agent's CI key (oci_...: flow setup writes it, or make one at ${OBSERVE_URL}, your agent, Developers).`;
  return error.message;
}

const SAID: Record<Done, string> = {
  written: "written",
  would_write: "would write",
  unchanged: "already there",
  exists: "kept yours",
  pulled_before: "pulled before",
  invalid: "not written",
};

/** One line per draft (its file, what was done, its title), a problem under its draft, then what drafts are. */
function lines(rows: Row[], dryRun: boolean): string[] {
  if (!rows.length) return ["No test drafts."];
  const cells = rows.map((r) => [r.file, SAID[r.done], r.title ? `${r.title}${r.check === "not_checked" ? " (not yet checked)" : ""}` : ""]);
  const [header, ...body] = table(["FILE", "STATUS", "TITLE"], cells);
  const out = [header!];
  body.forEach((line, i) => {
    out.push(line);
    if (rows[i]!.problem) out.push(...rows[i]!.problem!.split("\n").map((p) => `    ${p}`));
  });
  out.push("");
  if (rows.some((r) => r.done === "exists")) out.push("A file already in tests/drafts/ with other content is kept: --force writes over it.");
  if (rows.some((r) => r.done === "pulled_before")) out.push("Drafts pulled before are not written again: --force writes them.");
  out.push(`${dryRun ? "Nothing was written (--dry-run). " : ""}Drafts never run or gate: flow test reads only tests/scenarios and tests/tools. Read each one, and move it into tests/scenarios/ to keep it as a test.`);
  return out;
}
