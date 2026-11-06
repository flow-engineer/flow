// covers: testing/src/conversations.ts testing/src/templates.ts testing/src/deploy.ts testing/src/flow-tools.ts testing/src/cli.ts
// The read commands as they printed before they ran on Flow's read tools (0.16.0's code, captured
// once): every command's stdout, stderr and exit status against one scripted cloud, byte for byte;
// and the same commands with --server against a hosted Flow MCP over that cloud print the same.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mcpServer } from "../mcp/src/server.ts";
import { flowReadTools, type FlowAgentAccess } from "../testing/src/flow-tools.ts";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const FLOW_KEY = "flow_test_k1_secretvalue";
const CI_KEY = "oci_ci_secretvalue";
const BAD = "flow_test_bad_refusedvalue";
const BAD_CI = "oci_bad_refusedvalue";
const OLD = "flow_test_old_olderflowvalue";
const OLD_CI = "oci_old_olderflowvalue";
const LINE = (n: number, severity: string, text: string) => ({ time: `2026-11-04T09:00:0${n}Z`, severity, text });

/** What the scripted cloud answers, by path: Go's escapes and an indented body kept, so --json shows it prints Flow's own text. */
function answer(req: IncomingMessage): { status: number; text: string } {
  const url = new URL(req.url!, "http://x");
  const json = (body: unknown) => ({ status: 200, text: `${JSON.stringify(body)}\n` });
  if (req.headers.authorization === `Bearer ${BAD}` || req.headers.authorization === `Bearer ${BAD_CI}`) return { status: 401, text: '{"error":{"code":"bad_key","message":"This key is not valid."}}\n' };
  // An older Flow, without these routes.
  if (req.headers.authorization === `Bearer ${OLD}` || req.headers.authorization === `Bearer ${OLD_CI}`) return { status: 404, text: "404 page not found\n" };
  switch (url.pathname) {
    case "/v1/agent/conversations":
      return json({ conversations: [
        { id: "cnv_1", environment: "staging", channel: "whatsapp", contact: "Contact 0100", messages: 4, last_message_at: "2026-11-04T09:00:00Z", agent_version: "v7", grades: { good: 1, unhelpful: 0, wrong: 2, not_graded: 1 } },
        { id: "cnv_2", environment: "staging", channel: "telegram", contact: "Contact 9e35", messages: 2, last_message_at: "2026-11-03T09:00:00Z", agent_version: null, grades: null },
      ], next_cursor: null, text_mode: "deidentified" });
    case "/v1/agent/conversations/cnv_1":
      return { status: 200, text: '{"id":"cnv_1","environment":"staging","channel":"whatsapp","text_mode":"deidentified","messages":[{"id":"m1","role":"person","at":"2026-11-04T09:00:00Z","text":"is 2 \\u003c 3 \\u0026 \\u003e 1?"},{"id":"m2","role":"agent","at":"2026-11-04T09:00:02Z","text":"Yes.","tools":[{"name":"lookup","ms":12,"ok":false,"error":"timeout"}],"delivery":{"state":"failed","code":"131047"},"grade":{"label":"wrong","rule":"facts","reason":"It guessed.","quote":"Yes."}}],"issues":[{"id":"iss_1","title":"Guesses"}]}\n' };
    case "/v1/agent/issues":
      return { status: 200, text: `{\n  "issues": [\n    {"id": "iss_1", "status": "open", "conversations": 3, "last_seen": "2026-11-04T09:00:00Z", "title": "Guesses \\u003cfacts\\u003e", "suggested_fix": "Look it up first."}\n  ]\n}\n` };
    case "/v1/agent/feedback":
      return json({ feedback: [{ id: "fb_1", kind: "check_outdated", reason: "The menu changed.", scenario: "late-order", check: "includes", at: "2026-11-02T09:00:00Z" }] });
    case "/v1/agent/issues/iss_1/test-case":
      return { status: 200, text: '{"test_case":{"issue":"iss_1","rule_id":"facts","from":{"conversation":"cnv_1","message":"m2"},"expectations":{"includes":["look"],"must_not":["Yes."],"expect":["It checks before answering."]}},"text_mode":"deidentified"}' };
    case "/v1/agent/insights":
      return { status: 200, text: '{"state":"on","days":7,"text_mode":"deidentified","findings":[{"id":"f_1","signal":"re_ask","status":"open","topic":{"id":"t1","name":"Prices \\u0026 offers"},"conversations":4,"previous":9},{"id":"f_2","signal":"no_reply","status":"fixed","topic":null,"conversations":1,"previous":null}]}\n' };
    case "/v1/agent/insights/findings/f_1/conversations":
      return { status: 200, text: '{"finding":{"id":"f_1","signal":"re_ask"},"text_mode":"deidentified","data":[{"conversation":"cnv_1","at":"2026-11-04T09:00:00Z","cause":"asked twice","quote":"how much \\u003e?","window":[{"role":"person","text":"how much?"},{"role":"agent","text":"Which one?"}]}]}\n' };
    case "/v1/agent/templates":
      return { status: 200, text: '{"synced_at":"2026-11-04T09:00:00Z","templates":[{"name":"order_ready","language":"en","category":"UTILITY","status":"approved","body":"Hi {{1}}, order \\u003c{{2}}\\u003e is ready.","buttons":[],"values":{"body":["{{1}}","{{2}}"]},"send_order":"body[0], body[1]"},{"name":"promo","language":"en","category":"MARKETING","status":"rejected","body":"Sale!","buttons":[]}]}\n' };
    case "/v1/hosting/logs":
      return url.searchParams.get("after") === "c1"
        ? json({ lines: [], next: "c1", from: null })
        : json({ lines: [LINE(1, "INFO", "booted"), LINE(2, "DEFAULT", "Error: boom"), LINE(3, "WARNING", "slow < reply")], next: "c1", from: null });
    case "/v1/hosting/deploys":
      return json({ framework: { version: "0.16.0" }, traces: { staging: { state: "ok", accepted_at: "2026-11-04T09:00:00Z", refused: null } }, deploys: url.searchParams.get("environment") === "staging"
        ? [{ id: "dep_2", status: "building", version: "v8", created_at: "2026-11-04T10:00:00Z" }, { id: "dep_1", status: "live", version: "v7", created_at: "2026-11-03T10:00:00Z", url: "https://agent.example/", framework: { package: "@flow-engineer/flow", version: "0.16.0" } }]
        : [] });
    default:
      return { status: 404, text: "404 page not found\n" };
  }
}

async function scriptedCloud() {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url!);
    const { status, text } = answer(req);
    res.writeHead(status, { "content-type": "application/json" }).end(text);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((done) => server.close(done)) };
}

interface Printed { code: number; stdout: string; stderr: string }

/** One flow command in `dir` with only `env` beyond PATH and HOME; the cloud's address and the folder put back as <cloud> and <dir>. */
function flow(args: string[], dir: string, env: Record<string, string>, cloud: string): Promise<Printed> {
  return new Promise((done) => {
    execFile(process.execPath, [cli, ...args], { cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, NO_COLOR: "1", ...env } }, (error, stdout, stderr) => {
      const plain = (s: string) => s.split(cloud).join("<cloud>").split(DOWN).join("<cloud>").split(realpathSync(dir)).join("<dir>").split(dir).join("<dir>");
      done({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout: plain(stdout), stderr: plain(stderr) });
    });
  });
}

/** Every read command, its --json and its help, plus the ways one fails: by name, its arguments and the folder it runs in. */
type Folder = "keys" | "none" | "bad" | "badci" | "old" | "down";
const CASES: Record<string, { args: string[]; folder?: Folder; hosted?: boolean }> = {
  "conversations": { args: ["conversations"], hosted: true },
  "conversations --json": { args: ["conversations", "--json"], hosted: true },
  "conversations --contact --limit": { args: ["conversations", "--contact", "9e35", "--limit", "150", "--grade", "wrong", "--json"], hosted: true },
  "conversations show": { args: ["conversations", "show", "cnv_1"], hosted: true },
  "conversations show --json": { args: ["conversations", "show", "cnv_1", "--json"], hosted: true },
  "conversations show missing": { args: ["conversations", "show", "cnv_9", "--json"], hosted: true },
  "conversations --limit wrong": { args: ["conversations", "--limit", "x", "--json"] },
  "conversations --help": { args: ["conversations", "--help"] },
  "issues": { args: ["issues"], hosted: true },
  "issues --json": { args: ["issues", "--json"], hosted: true },
  "issues test-case": { args: ["issues", "test-case", "iss_1"], hosted: true },
  "issues test-case --json": { args: ["issues", "test-case", "iss_1", "--json"], hosted: true },
  "issues --help": { args: ["issues", "--help"] },
  "insights": { args: ["insights"], hosted: true },
  "insights --json": { args: ["insights", "--json"], hosted: true },
  "insights --status all": { args: ["insights", "--status", "all"], hosted: true },
  "insights show": { args: ["insights", "show", "f_1"], hosted: true },
  "insights show --json": { args: ["insights", "show", "f_1", "--json"], hosted: true },
  "insights --help": { args: ["insights", "--help"] },
  "templates": { args: ["templates"], hosted: true },
  "templates --json": { args: ["templates", "--json"], hosted: true },
  "templates --all": { args: ["templates", "--all"], hosted: true },
  "templates --declare": { args: ["templates", "--declare"], hosted: true },
  "templates --help": { args: ["templates", "--help"] },
  "logs": { args: ["logs"], hosted: true },
  "logs --json --severity ERROR": { args: ["logs", "--json", "--severity", "ERROR"], hosted: true },
  "logs --grep": { args: ["logs", "--grep", "BOOT"], hosted: true },
  "logs --follow": { args: ["logs", "--until", "1m", "--follow"] },
  "logs --help": { args: ["logs", "--help"] },
  "deploy status": { args: ["deploy", "status"], hosted: true },
  "deploy status --json": { args: ["deploy", "status", "--json"], hosted: true },
  "deploy status --env production": { args: ["deploy", "status", "--env", "production", "--json"], hosted: true },
  "no key: conversations --json": { args: ["conversations", "--json"], folder: "none" },
  "no key: insights": { args: ["insights"], folder: "none" },
  "no key: logs --json": { args: ["logs", "--json"], folder: "none" },
  "refused: issues --json": { args: ["issues", "--json"], folder: "bad" },
  "refused: templates": { args: ["templates"], folder: "bad" },
  "refused: conversations show": { args: ["conversations", "show", "cnv_1"], folder: "bad" },
  "refused: deploy status --json": { args: ["deploy", "status", "--json"], folder: "badci" },
  "refused: logs": { args: ["logs"], folder: "badci" },
  "older flow: templates": { args: ["templates"], folder: "old" },
  "older flow: insights --json": { args: ["insights", "--json"], folder: "old" },
  "older flow: issues": { args: ["issues"], folder: "old" },
  "older flow: deploy status": { args: ["deploy", "status"], folder: "old" },
  "older flow: logs --json": { args: ["logs", "--json"], folder: "old" },
  "cloud down: conversations --json": { args: ["conversations", "--json"], folder: "down" },
  "cloud down: deploy status": { args: ["deploy", "status"], folder: "down" },
};

/** An agent's folder whose .env points at the cloud (or at one that is down), with the keys, none, refused ones, or an older Flow's. */
function folder(cloud: string, kind: Folder): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-read-"));
  const [flowKey, ciKey] = { keys: [FLOW_KEY, CI_KEY], none: [], bad: [BAD, CI_KEY], badci: [FLOW_KEY, BAD_CI], old: [OLD, OLD_CI], down: [FLOW_KEY, CI_KEY] }[kind];
  const keys = flowKey ? `FLOW_KEY=${flowKey}\nFLOW_FRAMEWORK_CLOUD_KEY=${ciKey}\n` : "";
  writeFileSync(join(dir, ".env"), `${keys}FLOW_FRAMEWORK_CLOUD=${kind === "down" ? DOWN : cloud}\n`);
  return dir;
}

/** A cloud no one answers at (a port nothing listens on), said as <cloud> too. */
const DOWN = "http://127.0.0.1:9";

/** Runs the cases a few at a time; each one's output by name. */
async function runAll(run: (name: string) => Promise<Printed>, names: string[]): Promise<Record<string, Printed>> {
  const out: Record<string, Printed> = {};
  const queue = [...names];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) out[name] = await run(name);
  }));
  return Object.fromEntries(names.map((n) => [n, out[n]!]));
}

/** What 0.16.0's code printed for each case (captured once, before the commands ran on the tools). */
const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./read-commands.golden.json", import.meta.url)), "utf8")) as Record<string, Printed>;

test("each read command prints what 0.16.0 printed against the same cloud: stdout, stderr and exit status, byte for byte", { timeout: 240_000 }, async () => {
  const cloud = await scriptedCloud();
  try {
    const dirs = Object.fromEntries((["keys", "none", "bad", "badci", "old", "down"] as const).map((k) => [k, folder(cloud.url, k)])) as Record<Folder, string>;
    const printed = await runAll(async (name) => {
      const c = CASES[name]!;
      const dir = dirs[c.folder ?? "keys"];
      return flow(c.args, dir, {}, cloud.url);
    }, Object.keys(CASES));
    for (const name of Object.keys(CASES)) assert.deepEqual(printed[name], GOLDEN[name], name);
  } finally {
    await cloud.close();
  }
});

/** One person with one agent, whose key the hosted server's credentials give: the folder's own Flow key, on the same cloud. */
const ACCESS: FlowAgentAccess = {
  agents: async () => [{ flow_agent_id: "agt_1", name: "shop", workspace_id: "acc_1" }],
  key: async () => ({ value: FLOW_KEY, flow_agent_id: "agt_1", name: "shop" }),
};

test("with --server, each read command prints what it prints locally for the same data: a hosted Flow MCP's tools carry the cloud's own JSON text", { timeout: 240_000 }, async () => {
  const cloud = await scriptedCloud();
  const { tools, instructions } = flowReadTools({ hosted: { cloud: cloud.url } });
  const handle = mcpServer({
    name: "flow", version: "1", tools, instructions, feedback: false, traces: false,
    auth: { issuer: "https://issuer.invalid", verify: (token) => (token === "person" ? { key: "person-1", client: { id: "flow-cli", kind: "cli" }, credentials: (name) => (name === "flow" ? ACCESS : undefined) } : null) },
  });
  const server = createServer((req, res) => void handle.node(req, res));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  try {
    const dir = folder(cloud.url, "none");
    const names = Object.keys(CASES).filter((n) => CASES[n]!.hosted);
    const printed = await runAll((name) => flow(CASES[name]!.args, dir, { FLOW_MCP_SERVER: url, FLOW_MCP_TOKEN: "person" }, cloud.url), names);
    for (const name of names) assert.deepEqual(printed[name], GOLDEN[name], name);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await cloud.close();
  }
});
