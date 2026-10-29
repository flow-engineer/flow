// covers: testing/src/conversations.ts testing/src/cli.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const KEY = "flow_test_k1_secretvalue";

/** The flow command in dir, with no FLOW_KEY or cloud from this machine; its exit and both streams. */
async function flow(args: string[], dir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["FLOW_KEY", "FLOW_FRAMEWORK_CLOUD", "CHINWAG_CLOUD", "NO_COLOR"]) delete env[name];
  const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

const conversation = (id: string, wrong: number, version: string | null = "5f056b6") => ({
  id, environment: "production", channel: "whatsapp", contact: "Contact 0100", started_at: "2026-10-29T09:00:00.123Z",
  last_message_at: "2026-10-29T09:05:00Z", messages: 4, grades: { good: 1, unhelpful: 0, wrong, not_graded: 1 },
  version, version_source: version ? "trace" : null, version_changed: false,
});
const detail = {
  conversation: { ...conversation("cnv_1", 1), channels: ["whatsapp", "sms"] },
  messages: [
    { id: "m1", role: "person", at: "2026-10-29T09:00:00Z", text: "Can I get a refund?", tools: [], grade: null },
    { id: "m2", role: "agent", at: "2026-10-29T09:00:04Z", text: "Yes, I've refunded you.\nAnything else?", tools: [{ name: "find_order" }],
      grade: { label: "wrong", rule: "no-made-up-actions", reason: "It says it refunded, but no refund tool ran.", quote: "I've refunded you", graded_at: "2026-10-29T09:10:00Z" } },
    { id: "m3", role: "person", at: "2026-10-29T09:01:00Z", text: "thanks", tools: [], grade: null },
    { id: "m4", role: "agent", at: "2026-10-29T09:01:02Z", text: "Any time!", tools: [], grade: { label: "good", verdict: "good", rule: null, reason: null, quote: null, graded_at: "2026-10-29T09:10:00Z" } },
    { id: "m5", role: "your_code", at: "2026-10-29T09:02:00Z", text: "Your order has shipped.", text_state: "shown", tools: [], grade: null },
    { id: "m6", role: "person", at: "2026-10-29T09:03:00Z", text: null, text_state: "withheld", tools: [], grade: null },
    { id: "m7", role: "agent", at: "2026-10-29T09:03:05Z", text: null, text_state: "deleted", tools: [], grade: { label: "unhelpful", verdict: "unhelpful", rule: null, reason: null, quote: null, graded_at: "2026-10-29T09:10:00Z" } },
  ],
  issues: [{ id: "iss_1", title: "Claims actions it did not take" }],
};
const issues = { issues: [
  { id: "iss_1", title: "Claims actions it did not take", status: "open", conversations: 3, first_seen: "2026-10-27T10:00:00Z", last_seen: "2026-10-29T09:00:04Z", suggested_fix: "Only say a refund is done after refund_order returns ok." },
  { id: "iss_2", title: "Answers in English to Hindi", status: "open", conversations: 1, first_seen: "2026-10-28T10:00:00Z", last_seen: "2026-10-28T10:00:00Z", suggested_fix: null },
] };

const feedback = { days: 30, words_withheld: false, feedback: [
  { id: "jf_2", kind: "test_check", reason: "check_out_of_date", todo: "Change this check in the scenario file.", note: "We stopped asking for the order number.", at: "2026-10-29T08:00:00Z",
    scenario: "scenarios/refund.yaml", channel: "whatsapp", check: "Asks for the order number", check_index: 1, run: "run_1", session: "ses_1", message: null, conversation: null, rules: null },
  { id: "jf_1", kind: "reply_grade", reason: "grader_wrong", todo: "The reply was fine: do not change the agent for it.", note: null, at: "2026-10-28T08:00:00Z",
    scenario: null, channel: null, check: null, check_index: null, run: null, session: null, message: "m2", conversation: "cnv_1", rules: ["no-made-up-actions", "tone"] },
] };

/** A fake flow.engineer: pages of conversations (at most 100 asked, as Flow's), one conversation, the issues (none resolved),
 * the team's feedback only when given one (else 404, as an older Flow), and a refusal for cnv_bad. */
async function server(options: { feedback?: unknown } = {}) {
  const asked: Array<{ url: string; authorization?: string }> = [];
  const http = createServer((req, res) => {
    asked.push({ url: req.url!, authorization: req.headers.authorization });
    const url = new URL(req.url!, "http://x");
    const json = (status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { code: "bad_key", message: "That key is not a Flow key.", hint: "Run flow setup --rotate key." } });
    if (url.pathname === "/v1/agent/conversations") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      if (!(limit >= 1 && limit <= 100)) return json(400, { error: { code: "invalid_request", type: "invalid_request", message: "limit must be 1 to 100" } });
      const cursor = url.searchParams.get("cursor");
      if (cursor === "c3") return json(200, { conversations: [], next_cursor: null });
      return cursor === "c2"
        ? json(200, { conversations: [{ ...conversation("cnv_3", 0, null), grades: null }], next_cursor: "c3" })
        : json(200, { conversations: [conversation("cnv_1", 1), conversation("cnv_2", 2)], next_cursor: "c2" });
    }
    if (url.pathname === "/v1/agent/conversations/cnv_1") return json(200, detail);
    if (url.pathname === "/v1/agent/issues") return json(200, url.searchParams.get("status") === "resolved" ? { issues: [] } : issues);
    if (url.pathname === "/v1/agent/feedback" && options.feedback) return json(200, options.feedback);
    if (url.pathname === "/v1/agent/conversations/cnv_busy") {
      res.setHeader("retry-after", "30");
      return json(503, { error: { code: "insights_unavailable", type: "unavailable", message: "Grades cannot be read right now.", hint: "Try again shortly." } });
    }
    json(404, { error: { code: "not_found", message: "No conversation cnv_bad for this agent.", hint: "List them with flow conversations." } });
  });
  const url = await new Promise<string>((done) => http.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(http.address() as AddressInfo).port}`)));
  return { url, asked, close: () => { http.closeAllConnections(); http.close(); } };
}

function agentDir(key = KEY): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-conversations-"));
  writeFileSync(join(dir, ".env"), `FLOW_KEY=${key}\n`);
  return dir;
}

test("flow conversations lists with the .env's FLOW_KEY, following next_cursor up to --limit, as a table or the server's JSON", { timeout: 15_000 }, async () => {
  const fake = await server();
  try {
    const dir = agentDir();
    const listed = await flow(["conversations", "--grade", "wrong", "--environment", "production", "--since", "2026-10-28T00:00:00Z", "--limit", "3", "--cloud", fake.url], dir);
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(fake.asked, [
      { url: "/v1/agent/conversations?environment=production&grade=wrong&since=2026-10-28T00%3A00%3A00Z&limit=3", authorization: `Bearer ${KEY}` },
      { url: "/v1/agent/conversations?environment=production&grade=wrong&since=2026-10-28T00%3A00%3A00Z&limit=1&cursor=c2", authorization: `Bearer ${KEY}` },
    ]);
    assert.equal(listed.stdout, [
      "ID     LAST MESSAGE          CHANNEL   VERSION  CONTACT       MESSAGES  WRONG  UNHELPFUL",
      "cnv_1  2026-10-29 09:05:00Z  whatsapp  5f056b6  Contact 0100  4         1      0",
      "cnv_2  2026-10-29 09:05:00Z  whatsapp  5f056b6  Contact 0100  4         2      0",
      "cnv_3  2026-10-29 09:05:00Z  whatsapp  -        Contact 0100  4         -      -",
      "",
      "3 conversations (more: raise --limit); - is grades unavailable. Read one: flow conversations show <id>",
      "",
    ].join("\n"));
    const json = await flow(["conversations", "--limit", "2", "--json", "--cloud", fake.url], dir);
    assert.equal(json.code, 0, json.stderr);
    // No --environment: none is sent, and the server picks it from the key.
    assert.equal(fake.asked[2]!.url, "/v1/agent/conversations?limit=2");
    assert.deepEqual(JSON.parse(json.stdout), { conversations: [conversation("cnv_1", 1), conversation("cnv_2", 2)], next_cursor: "c2" });
    // Over 100: 100 a page (the server's most), following next_cursor until --limit or the last page.
    const many = await flow(["conversations", "--limit", "200", "--json", "--cloud", fake.url], dir);
    assert.equal(many.code, 0, many.stderr);
    assert.deepEqual(fake.asked.slice(3).map((a) => a.url), [
      "/v1/agent/conversations?limit=100",
      "/v1/agent/conversations?limit=100&cursor=c2",
      "/v1/agent/conversations?limit=100&cursor=c3",
    ]);
    assert.deepEqual(JSON.parse(many.stdout).conversations.map((c: { id: string }) => c.id), ["cnv_1", "cnv_2", "cnv_3"]);
    assert.ok(![listed, json, many].some((r) => (r.stdout + r.stderr).includes(KEY)));
  } finally { fake.close(); }
});

test("flow conversations show prints the transcript with each graded reply's label, rule, reason and quote; --json is the server's", { timeout: 15_000 }, async () => {
  const fake = await server();
  try {
    const dir = agentDir();
    const shown = await flow(["conversations", "show", "cnv_1", "--cloud", fake.url], dir);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(shown.stdout, [
      "Conversation cnv_1: production, whatsapp,sms, Contact 0100",
      "  started 2026-10-29 09:00:00Z, last message 2026-10-29 09:05:00Z, 4 messages",
      "  version 5f056b6 (from its traces)",
      "  replies: 1 wrong, 0 unhelpful, 1 good, 1 not graded",
      "",
      "2026-10-29 09:00:00Z  person: Can I get a refund?",
      "2026-10-29 09:00:04Z  agent: Yes, I've refunded you.",
      "                             Anything else?",
      "                             [tools: find_order]",
      "                             WRONG  rule: no-made-up-actions",
      "                               why: It says it refunded, but no refund tool ran.",
      "                               quote: \"I've refunded you\"",
      "2026-10-29 09:01:00Z  person: thanks",
      "2026-10-29 09:01:02Z  agent: Any time!",
      "                             GOOD",
      "2026-10-29 09:02:00Z  your code: Your order has shipped.",
      "2026-10-29 09:03:00Z  person: (text withheld)",
      "2026-10-29 09:03:05Z  agent: (deleted by retention)",
      "                             UNHELPFUL",
      "                               (rule, reason and quote withheld)",
      "",
      "Issues:",
      "  iss_1  Claims actions it did not take",
      "",
    ].join("\n"));
    const json = await flow(["conversations", "show", "cnv_1", "--json", "--cloud", fake.url], dir);
    assert.equal(json.stdout, JSON.stringify(detail));
  } finally { fake.close(); }
});

test("flow issues lists each issue with its suggested fix; an older Flow without the feedback route adds nothing", { timeout: 15_000 }, async () => {
  const fake = await server();
  try {
    const listed = await flow(["issues", "--status", "all", "--cloud", fake.url], agentDir());
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(fake.asked.map((a) => a.url), ["/v1/agent/issues?status=all", "/v1/agent/feedback?days=30"]);
    assert.equal(listed.stdout, [
      "ID     STATUS  CONVERSATIONS  LAST SEEN             TITLE",
      "iss_1  open    3              2026-10-29 09:00:04Z  Claims actions it did not take",
      "    fix: Only say a refund is done after refund_order returns ok.",
      "iss_2  open    1              2026-10-28 10:00:00Z  Answers in English to Hindi",
      "",
    ].join("\n"));
  } finally { fake.close(); }
});

test("flow issues prints the team's feedback under the issues, and when there are none; --json is the issues' JSON only", { timeout: 15_000 }, async () => {
  const fake = await server({ feedback });
  try {
    const dir = agentDir();
    const listed = await flow(["issues", "--cloud", fake.url], dir);
    assert.equal(listed.code, 0, listed.stderr);
    const team = [
      "",
      "Feedback from your team (last 30 days): 2",
      "  check out of date  scenarios/refund.yaml (whatsapp), check 2: Asks for the order number",
      "    note: We stopped asking for the order number.",
      "    todo: Change this check in the scenario file.",
      "  grade marked wrong  conversation cnv_1, reply m2, rules no-made-up-actions, tone",
      "    todo: The reply was fine: do not change the agent for it.",
      "",
    ];
    assert.equal(listed.stdout, [
      "ID     STATUS  CONVERSATIONS  LAST SEEN             TITLE",
      "iss_1  open    3              2026-10-29 09:00:04Z  Claims actions it did not take",
      "    fix: Only say a refund is done after refund_order returns ok.",
      "iss_2  open    1              2026-10-28 10:00:00Z  Answers in English to Hindi",
      ...team,
    ].join("\n"));
    const none = await flow(["issues", "--status", "resolved", "--cloud", fake.url], dir);
    assert.equal(none.stdout, ["No resolved issues.", ...team].join("\n"));
    const asked = fake.asked.length;
    const json = await flow(["issues", "--json", "--cloud", fake.url], dir);
    assert.equal(json.stdout, JSON.stringify(issues));
    assert.equal(fake.asked.length, asked + 1);
  } finally { fake.close(); }
});

test("a refusal prints the server's message, Retry-After and hint and exits 1; no FLOW_KEY says how to get one", { timeout: 15_000 }, async () => {
  const fake = await server();
  try {
    const missing = await flow(["conversations", "show", "cnv_bad", "--cloud", fake.url], agentDir());
    assert.deepEqual(missing, { code: 1, stdout: "", stderr: "flow conversations: No conversation cnv_bad for this agent. (not_found, 404)\nList them with flow conversations.\n" });
    const busy = await flow(["conversations", "show", "cnv_busy", "--cloud", fake.url], agentDir());
    assert.deepEqual(busy, { code: 1, stdout: "", stderr: "flow conversations: Grades cannot be read right now. (insights_unavailable, 503) Try again in 30 s.\nTry again shortly.\n" });
    const badKey = await flow(["issues", "--cloud", fake.url], agentDir("flow_test_wrong"));
    assert.deepEqual(badKey, { code: 1, stdout: "", stderr: "flow issues: That key is not a Flow key. (bad_key, 401)\nRun flow setup --rotate key.\n" });
    const noKey = await flow(["conversations", "--cloud", fake.url], mkdtempSync(join(tmpdir(), "flow-conversations-")));
    assert.equal(noKey.code, 1);
    assert.match(noKey.stderr, /set FLOW_KEY \(flow setup writes it into \.env\)/);
  } finally { fake.close(); }
});
