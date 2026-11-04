// covers: testing/src/conversations.ts testing/src/cli.ts testing/src/cloud-call.ts
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
  version, version_source: version ? "trace" : null, version_changed: false, run_kind: "production",
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
/** A newer server's conversation: each tool call's time, outcome, input and output, each reply's delivery, and a message whose text was not sent. */
const withToolsAndDelivery = {
  conversation: conversation("cnv_2", 0),
  messages: [
    { id: "m1", role: "person", at: "2026-10-29T09:00:00Z", text: null, text_state: "not_sent", tools: [], delivery: null, grade: null },
    { id: "m2", role: "agent", at: "2026-10-29T09:00:04Z", text: "Booked for 6pm.", text_state: "shown", grade: null,
      tools: [
        { name: "find_slot", ms: 120, ok: true, input: { day: "today" }, output: { slots: ["18:00"] } },
        { name: "book", ms: 3400, ok: false, error: { code: "timeout", message: "the booking API did not answer" }, truncated: true },
      ],
      delivery: { state: "failed", code: "131042", error_type: "permission", at: "2026-10-29T09:00:06Z" } },
    { id: "m3", role: "agent", at: "2026-10-29T09:00:10Z", text: "Sorry, try again?", text_state: "shown", grade: null, tools: [], delivery: { state: "queued", at: "2026-10-29T09:00:10Z" } },
  ],
  issues: [],
};
const issues = { issues: [
  { id: "iss_1", title: "Claims actions it did not take", status: "open", conversations: 3, first_seen: "2026-10-27T10:00:00Z", last_seen: "2026-10-29T09:00:04Z", suggested_fix: "Only say a refund is done after refund_order returns ok." },
  { id: "iss_2", title: "Answers in English to Hindi", status: "open", conversations: 1, first_seen: "2026-10-28T10:00:00Z", last_seen: "2026-10-28T10:00:00Z", suggested_fix: null },
] };

const testCase = { read_only: true, test_case: { issue: "iss_1", rule_id: "no-made-up-actions", from: { conversation: "cnv_1", message: "m2" },
  expectations: { includes: [], must_not: ["I've refunded you"], expect: ["Says a refund is done only after refund_order returns ok"], rubrics: ["no-made-up-actions"] } } };

const feedback = { days: 30, words_withheld: false, feedback: [
  { id: "jf_2", kind: "test_check", reason: "check_out_of_date", todo: "Change this check in the scenario file.", note: "We stopped asking for the order number.", at: "2026-10-29T08:00:00Z",
    scenario: "scenarios/refund.yaml", channel: "whatsapp", check: "Asks for the order number", check_index: 1, run: "run_1", session: "ses_1", message: null, conversation: null, rules: null },
  { id: "jf_1", kind: "reply_grade", reason: "grader_wrong", todo: "The reply was fine: do not change the agent for it.", note: null, at: "2026-10-28T08:00:00Z",
    scenario: null, channel: null, check: null, check_index: null, run: null, session: null, message: "m2", conversation: "cnv_1", rules: ["no-made-up-actions", "tone"] },
] };

/** A fake flow.engineer: pages of conversations (at most 100 asked, as Flow's), one conversation (cnv_t a test one), the issues
 * (none resolved), the team's feedback only when given one (else 404, as an older Flow), Insights' answers when given them
 * by "<path> <days>" (else 404 not_found, as a workspace Insights is not open to; 403 scope with insightsScope, as for a test
 * key), and a refusal for cnv_bad. */
async function server(options: { feedback?: unknown; insights?: Record<string, unknown>; insightsScope?: boolean } = {}) {
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
        ? json(200, { conversations: [{ ...conversation("cnv_3", 0, null), grades: null, contact: "Contact 9e35" }], next_cursor: "c3" })
        : json(200, { conversations: [conversation("cnv_1", 1), conversation("cnv_2", 2)], next_cursor: "c2" });
    }
    if (url.pathname === "/v1/agent/conversations/cnv_1") return json(200, detail);
    if (url.pathname === "/v1/agent/conversations/cnv_2") return json(200, withToolsAndDelivery);
    // Rate limited once, as Flow's 60 reads a minute per key: the CLI waits Retry-After and asks again.
    if (url.pathname === "/v1/agent/conversations/cnv_limited" && asked.filter((a) => a.url === req.url).length === 1) {
      res.setHeader("retry-after", "0");
      return json(429, { error: { code: "rate_limited", message: "too many reads", hint: "retry after the Retry-After seconds" } });
    }
    if (url.pathname === "/v1/agent/conversations/cnv_limited") return json(200, detail);
    if (url.pathname === "/v1/agent/issues/iss_1/test-case") return json(200, testCase);
    if (url.pathname.endsWith("/test-case")) return json(404, { error: { code: "not_found", message: "no such issue for this agent" } });
    if (url.pathname === "/v1/agent/conversations/cnv_t") return json(200, { ...detail, conversation: { ...detail.conversation, id: "cnv_t", run_kind: "test" }, messages: [], issues: [] });
    if (url.pathname === "/v1/agent/insights" || url.pathname.startsWith("/v1/agent/insights/")) {
      if (options.insightsScope) return json(403, { error: { code: "scope", message: "this key may not read Insights", hint: "Use the agent's live key." } });
      const answer = options.insights?.[`${url.pathname} ${url.searchParams.get("days")}`];
      if (answer) return json(200, answer);
      return json(404, { error: { code: "not_found", message: "not found", hint: "Ask Flow to open Insights to your workspace." } });
    }
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
      "ID     LAST MESSAGE          CHANNEL   KIND        VERSION  CONTACT       MESSAGES  WRONG  UNHELPFUL",
      "cnv_1  2026-10-29 09:05:00Z  whatsapp  production  5f056b6  Contact 0100  4         1      0",
      "cnv_2  2026-10-29 09:05:00Z  whatsapp  production  5f056b6  Contact 0100  4         2      0",
      "cnv_3  2026-10-29 09:05:00Z  whatsapp  production  -        Contact 9e35  4         -      -",
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
    assert.equal(json.stdout, `${JSON.stringify(detail)}\n`);
  } finally { fake.close(); }
});

test("flow conversations show says a test conversation is never graded and never in Insights, so its counts do not read as graded", { timeout: 15_000 }, async () => {
  const fake = await server();
  try {
    const shown = await flow(["conversations", "show", "cnv_t", "--cloud", fake.url], agentDir());
    assert.equal(shown.code, 0, shown.stderr);
    assert.deepEqual(shown.stdout.split("\n").slice(3, 5), [
      "  replies: 1 wrong, 0 unhelpful, 1 good, 1 not graded",
      "  A test conversation (flow chat, the playground or flow test): never graded, never in Insights",
    ]);
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
    assert.equal(json.stdout, `${JSON.stringify(issues)}\n`);
    assert.equal(fake.asked.length, asked + 1);
  } finally { fake.close(); }
});

test("flow issues test-case prints the proposed test case's fields and how to make a scenario of them; an unknown issue prints the server's refusal", { timeout: 15_000 }, async () => {
  const fake = await server();
  try {
    const dir = agentDir();
    const shown = await flow(["issues", "test-case", "iss_1", "--cloud", fake.url], dir);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(shown.stdout, [
      "issue: iss_1",
      "rule: no-made-up-actions",
      "from: conversation cnv_1, reply m2",
      "must_not:",
      "  - \"I've refunded you\"",
      "expect:",
      "  - \"Says a refund is done only after refund_order returns ok\"",
      "rubrics:",
      "  - \"no-made-up-actions\"",
      "",
      "These are Flow's fields, not a scenario file: a scenario also needs the person, the opening and the channels.",
      "Write tests/scenarios/<name>.yaml from them and flow conversations show cnv_1 (expect as its expect.judge), then run flow test --only <name>.",
      "",
    ].join("\n"));
    const missing = await flow(["issues", "test-case", "iss_9", "--cloud", fake.url], dir);
    assert.equal(missing.code, 1);
    assert.deepEqual(missing, { code: 1, stdout: "", stderr: "flow issues: no such issue for this agent (not_found, 404)\n" });
  } finally { fake.close(); }
});

test("a refusal prints the server's message, Retry-After and hint and exits 1; no FLOW_KEY says how to get one", { timeout: 30_000 }, async () => {
  const fake = await server();
  try {
    const missing = await flow(["conversations", "show", "cnv_bad", "--cloud", fake.url], agentDir());
    assert.deepEqual(missing, { code: 1, stdout: "", stderr: "flow conversations: No conversation cnv_bad for this agent. (not_found, 404)\nList them with flow conversations.\n" });
    const busy = await flow(["conversations", "show", "cnv_busy", "--cloud", fake.url], agentDir());
    assert.deepEqual(busy, { code: 1, stdout: "", stderr: "flow conversations: Grades cannot be read right now. (insights_unavailable, 503) Try again in 30 s.\nTry again shortly.\n" });
    const badKey = await flow(["issues", "--cloud", fake.url], agentDir("flow_test_wrongkey1"));
    assert.deepEqual({ code: badKey.code, stdout: badKey.stdout }, { code: 1, stdout: "" });
    assert.equal(badKey.stderr, [
      "flow issues: That key is not a Flow key. (bad_key, 401)",
      "Run flow setup --rotate key.",
      "flow issues reads with the agent's Flow key, FLOW_KEY (flow_test_... reads staging; flow_live_... reads staging and production).",
      "It found FLOW_KEY=flow_test_…key1 in .env in this folder.",
      "Get the right one: npx @flow-engineer/flow setup writes both into .env (FLOW_KEY as a flow_test_ key), or copy them from your agent's Developers page on the dashboard (https://flow.engineer/dashboard).",
      "",
    ].join("\n"));
    const noKey = await flow(["conversations", "--cloud", fake.url], mkdtempSync(join(tmpdir(), "flow-conversations-")));
    assert.equal(noKey.code, 1);
    assert.match(noKey.stderr, /set FLOW_KEY \(flow setup writes it into \.env\)/);
  } finally { fake.close(); }
});

test("show prints each tool call's time, outcome, input and output, each reply's delivery, and why a text was not sent; --json passes them through", { timeout: 15_000 }, async () => {
  const fake = await server();
  try {
    const dir = agentDir();
    const shown = await flow(["conversations", "show", "cnv_2", "--env", "staging", "--cloud", fake.url], dir);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(shown.stdout.split("\n").slice(5).join("\n"), [
      "2026-10-29 09:00:00Z  person: (text not sent to Flow)",
      "                                its trace carried no text: the agent traced metadata only (FLOW_FRAMEWORK_TRACES_CONTENT off), or the message had none (a photo, video or voice note without a caption); never graded",
      "2026-10-29 09:00:04Z  agent: Booked for 6pm.",
      "                             tool find_slot 120 ms ok",
      '                               input: {"day":"today"}',
      '                               output: {"slots":["18:00"]}',
      "                             tool book 3400 ms FAILED: timeout: the booking API did not answer (cut by Flow)",
      "                             delivery: FAILED 131042 (permission) at 2026-10-29 09:00:06Z",
      "2026-10-29 09:00:10Z  agent: Sorry, try again?",
      "                             delivery: queued (Flow took it; the channel has not said it was sent) at 2026-10-29 09:00:10Z",
      "",
    ].join("\n"));
    const json = await flow(["conversations", "show", "cnv_2", "--json", "--cloud", fake.url], dir);
    assert.deepEqual(JSON.parse(json.stdout), withToolsAndDelivery);
  } finally { fake.close(); }
});

test("--contact keeps one contact's conversations, by its label or its code, over every page; --environment is --env", { timeout: 15_000 }, async () => {
  const fake = await server();
  try {
    const dir = agentDir();
    for (const label of ["Contact 9e35", "9E35"]) {
      const found = await flow(["conversations", "--contact", label, "--environment", "production", "--json", "--cloud", fake.url], dir);
      assert.equal(found.code, 0, found.stderr);
      assert.deepEqual(JSON.parse(found.stdout).conversations.map((c: { id: string }) => c.id), ["cnv_3"]);
    }
    assert.deepEqual(fake.asked.slice(0, 3).map((a) => a.url), [
      "/v1/agent/conversations?environment=production&limit=100",
      "/v1/agent/conversations?environment=production&limit=100&cursor=c2",
      "/v1/agent/conversations?environment=production&limit=100&cursor=c3",
    ]);
    const both = await flow(["conversations", "--env", "staging", "--environment", "production", "--json", "--cloud", fake.url], dir);
    assert.equal(both.code, 2);
    assert.equal(JSON.parse(both.stdout).error.code, "usage");
  } finally { fake.close(); }
});

test("a read Flow rate limits (429) is waited out for its Retry-After and asked again, said on stderr", { timeout: 15_000 }, async () => {
  const fake = await server();
  try {
    const shown = await flow(["conversations", "show", "cnv_limited", "--json", "--cloud", fake.url], agentDir());
    assert.equal(shown.code, 0, shown.stderr);
    assert.deepEqual(JSON.parse(shown.stdout), detail);
    assert.equal(fake.asked.filter((a) => a.url === "/v1/agent/conversations/cnv_limited").length, 2);
    assert.match(shown.stderr, /rate limiting this key \(429\): waiting 0 s, then trying again/);
  } finally { fake.close(); }
});

const finding = (id: string, signal: string, conversations: number, previous: number | null, extra: Record<string, unknown> = {}) => ({
  id, signal, kind: "letdown", topic: { id: "tpc_1", name: "Refunds" }, conversations, share_of_topic: null, previous, severity: 3,
  status: "open", tag_only: false, first_seen: "2026-10-28T10:00:00Z", last_seen: "2026-10-29T09:00:00Z", evidence: [], ...extra,
});
const small = { rates_min_sessions: 20, topic_rate_min: 10, topic_min_contacts: 3 };
const insightsOn = {
  state: "on", window_days: 7, closed_sessions: 132, people: 87, since: "2026-10-28T00:00:00Z",
  findings: [
    finding("fnd_1", "annoyed_wrong_fact", 4, 9),
    finding("fnd_2", "couldnt_answer", 3, null, { topic: null }),
    finding("fnd_3", "frustrated", 5, 2, { tag_only: true }),
    finding("fnd_4", "re_ask", 2, 2, { status: "fixed" }),
  ],
  topics: [], other_share: null, small_numbers: small, messages_without_text: 0,
};
const insightsNoData = { state: "no_data", window_days: 30, closed_sessions: 0, people: 0, since: "2026-10-05T00:00:00Z", findings: [], topics: [], other_share: null, small_numbers: small };
const findingConversations = {
  finding: { id: "fnd_2", signal: "couldnt_answer", topic: { id: "tpc_1", name: "Refunds" }, status: "open", conversations: 2, previous: 5, annoyed: 1 },
  data: [
    { conversation: "cnv_1", session: "ses_1", at: "2026-10-29T09:00:00.5Z", message: "m1", annoyed: true, annoyed_message: "m3", after: "m2",
      cause: "wrong_fact", bucket: null, quote: "That's not my order", text_state: "shown", contact: "Contact 0100" },
    { conversation: "cnv_2", session: "ses_2", at: "2026-10-28T10:00:00Z", message: "m9", annoyed: false, annoyed_message: null, after: null,
      cause: null, bucket: null, quote: null, text_state: "withheld", contact: "Contact 0200" },
  ],
};
const insights = {
  "/v1/agent/insights 7": insightsOn,
  "/v1/agent/insights 30": insightsNoData,
  "/v1/agent/insights/findings/fnd_2/conversations 7": findingConversations,
};

test("flow insights lists the open findings ranked as sent, with the window before's count and tags named under them; no_data says what makes data", { timeout: 15_000 }, async () => {
  const fake = await server({ insights });
  try {
    const dir = agentDir();
    const listed = await flow(["insights", "--cloud", fake.url], dir);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.stdout, [
      "ID     STATUS  CONVERSATIONS  TOPIC    FINDING",
      "fnd_1  open    4 (was 9)      Refunds  Got annoyed when the agent got a fact wrong",
      "fnd_2  open    3              -        Unanswered",
      "",
      "Last 7 days: 132 closed sessions from 87 people.",
      "Low-confidence tags, left out above: fnd_3 Frustrated (5).",
      "Read one: flow insights show <finding>",
      "",
    ].join("\n"));
    const none = await flow(["insights", "--days", "30", "--cloud", fake.url], dir);
    assert.equal(none.stdout, [
      "Last 30 days: 0 closed sessions from 0 people.",
      "Nothing graded yet: Insights grades only closed (24 h quiet) production conversations on a live key.",
      "Test-key traffic, flow chat, the playground and flow test conversations are never graded.",
      "",
    ].join("\n"));
    const json = await flow(["insights", "--json", "--cloud", fake.url], dir);
    assert.equal(json.stdout, `${JSON.stringify(insightsOn)}\n`);
    assert.deepEqual(fake.asked.map((a) => a.url), ["/v1/agent/insights?days=7", "/v1/agent/insights?days=30", "/v1/agent/insights?days=7"]);
  } finally { fake.close(); }
});

test("flow insights show prints each conversation of a finding with why it was flagged, the person's words and the command to read it", { timeout: 15_000 }, async () => {
  const fake = await server({ insights });
  try {
    const shown = await flow(["insights", "show", "fnd_2", "--cloud", fake.url], agentDir());
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(shown.stdout, [
      "fnd_2  open  Unanswered · Refunds: 2 (was 5) conversations in the last 7 days",
      "",
      "cnv_1  2026-10-29 09:00:00Z  Unanswered; Got annoyed when the agent got a fact wrong",
      "    \"That's not my order\"",
      "    next: flow conversations show cnv_1",
      "cnv_2  2026-10-28 10:00:00Z  Unanswered",
      "    next: flow conversations show cnv_2",
      "",
    ].join("\n"));
  } finally { fake.close(); }
});

test("flow insights says Insights is not open to this workspace yet, with the server's hint, and exits 1 when the route answers not_found", { timeout: 15_000 }, async () => {
  const fake = await server();
  try {
    const closed = await flow(["insights", "--cloud", fake.url], agentDir());
    assert.deepEqual(closed, { code: 1, stdout: "", stderr: "flow insights: Insights is not open to this workspace yet.\nAsk Flow to open Insights to your workspace.\n" });
  } finally { fake.close(); }
});

test("flow insights and insights show say a test key cannot read Insights, with the server's hint, and exit 1 when refused with scope", { timeout: 15_000 }, async () => {
  const fake = await server({ insightsScope: true });
  try {
    const stderr = "flow insights: Insights reads production conversations, so it needs a live key: npx @flow-engineer/flow setup --live writes the live key FLOW_LIVE_KEY, which Insights then reads with (flow setup writes only a test key, flow_test_).\nUse the agent's live key.\n";
    assert.deepEqual(await flow(["insights", "--cloud", fake.url], agentDir()), { code: 1, stdout: "", stderr });
    assert.deepEqual(await flow(["insights", "show", "fnd_2", "--cloud", fake.url], agentDir()), { code: 1, stdout: "", stderr });
  } finally { fake.close(); }
});

const READ = "flow_live_FAKElive00_0000FAKE0000live0000R3ad";

/**
 * A fake flow.engineer for the live key: FLOW_KEY (KEY) reads staging and finds no production
 * conversation (404, as Flow answers a test key); the live key (READ) reads both, with text
 * de-identified, said by the Flow-Text header only (no text_mode in the body); `expired` refuses the
 * live key as Flow does once it expired, went unused 7 days or was revoked.
 */
async function liveServer(options: { expired?: boolean } = {}) {
  const asked: Array<{ url: string; authorization?: string }> = [];
  const http = createServer((req, res) => {
    asked.push({ url: req.url!, authorization: req.headers.authorization });
    const url = new URL(req.url!, "http://x");
    const read = req.headers.authorization === `Bearer ${READ}`;
    const json = (status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json", ...(read && status === 200 ? { "flow-text": "deidentified" } : {}) }).end(JSON.stringify(body));
    if (read && options.expired) return json(401, { error: { code: "bad_key", message: "This key is not valid." } });
    if (!read && req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { code: "bad_key", message: "This key is not valid." } });
    if (url.pathname === "/v1/agent/conversations") return json(200, { conversations: [conversation(read ? "cnv_p" : "cnv_s", 0)], next_cursor: null });
    if (url.pathname === "/v1/agent/conversations/cnv_p" && read) return json(200, { ...detail, conversation: { ...detail.conversation, id: "cnv_p" }, messages: [], issues: [] });
    if (url.pathname.startsWith("/v1/agent/conversations/")) return json(404, { error: { code: "not_found", message: "No such conversation for this agent." } });
    if (url.pathname === "/v1/agent/insights" && read) return json(200, { state: "collecting", window_days: 7, closed_sessions: 3, people: 2, findings: [], small_numbers: small });
    json(403, { error: { code: "scope", message: "this key may not read Insights" } });
  });
  const url = await new Promise<string>((done) => http.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(http.address() as AddressInfo).port}`)));
  return { url, asked, close: () => { http.closeAllConnections(); http.close(); } };
}

/** An agent folder whose .env has FLOW_KEY and the live key. */
function liveDir(): string {
  const dir = agentDir();
  writeFileSync(join(dir, ".env"), `FLOW_KEY=${KEY}\nFLOW_LIVE_KEY=${READ}\n`);
  return dir;
}

test("production reads (conversations --env production, insights) read with FLOW_LIVE_KEY when .env has it; staging and unnamed reads read with FLOW_KEY", { timeout: 15_000 }, async () => {
  const fake = await liveServer();
  try {
    const dir = liveDir();
    for (const args of [["conversations", "--env", "production"], ["insights"], ["conversations", "--env", "staging"], ["conversations"]]) {
      const result = await flow([...args, "--json", "--cloud", fake.url], dir);
      assert.equal(result.code, 0, result.stderr);
    }
    assert.deepEqual(fake.asked.map((a) => a.authorization), [`Bearer ${READ}`, `Bearer ${READ}`, `Bearer ${KEY}`, `Bearer ${KEY}`]);
    // Without the live key, production reads with FLOW_KEY as before.
    await flow(["conversations", "--env", "production", "--cloud", fake.url], agentDir());
    assert.equal(fake.asked.at(-1)!.authorization, `Bearer ${KEY}`);
  } finally { fake.close(); }
});

test("each read prints one Text: line first from Flow-Text, and --json keeps text_mode, added from the header when the body has none", { timeout: 15_000 }, async () => {
  const fake = await liveServer();
  try {
    const dir = liveDir();
    const listed = await flow(["conversations", "--env", "production", "--cloud", fake.url], dir);
    assert.equal(listed.stdout.split("\n")[0], "Text: de-identified (names, phones, emails, ids, addresses are placeholders)");
    assert.equal(listed.stdout.match(/^Text: /gm)!.length, 1);
    const json = await flow(["conversations", "--env", "production", "--json", "--cloud", fake.url], dir);
    assert.equal(json.stdout.trim().split("\n").length, 1, "one document");
    assert.equal(JSON.parse(json.stdout).text_mode, "deidentified");
    const insights = await flow(["insights", "--json", "--cloud", fake.url], dir);
    assert.equal(JSON.parse(insights.stdout).text_mode, "deidentified");
  } finally { fake.close(); }
});

test("conversations show reads with FLOW_KEY and, when it does not find the id, once more with FLOW_LIVE_KEY; --env production reads with the live key first", { timeout: 15_000 }, async () => {
  const fake = await liveServer();
  try {
    const dir = liveDir();
    const shown = await flow(["conversations", "show", "cnv_p", "--cloud", fake.url], dir);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^Text: de-identified .*\nConversation cnv_p: /);
    assert.deepEqual(fake.asked.map((a) => a.authorization), [`Bearer ${KEY}`, `Bearer ${READ}`]);
    const direct = await flow(["conversations", "show", "cnv_p", "--env", "production", "--json", "--cloud", fake.url], dir);
    assert.equal(direct.code, 0, direct.stderr);
    assert.deepEqual(fake.asked.slice(2).map((a) => a.authorization), [`Bearer ${READ}`]);
    // With no live key, FLOW_KEY's not found is the answer: no second try.
    const missing = await flow(["conversations", "show", "cnv_p", "--cloud", fake.url], agentDir());
    assert.equal(missing.code, 1);
    assert.deepEqual(fake.asked.slice(3).map((a) => a.authorization), [`Bearer ${KEY}`]);
  } finally { fake.close(); }
});

test("a live key Flow refuses (401) says it expired, went unused 7 days or was revoked and how to get one; a production read with no key names FLOW_LIVE_KEY", { timeout: 15_000 }, async () => {
  const fake = await liveServer({ expired: true });
  try {
    const refused = await flow(["insights", "--cloud", fake.url], liveDir());
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /It found FLOW_LIVE_KEY=flow_live_…R3ad in \.env in this folder\. It has expired, gone unused for 7 days or been revoked: run npx @flow-engineer\/flow setup --live again for a new one\./);
    assert.match(refused.stderr, /Get the right one: npx @flow-engineer\/flow setup --live writes FLOW_LIVE_KEY/);
    assert.doesNotMatch(refused.stderr, /0000FAKE0000live/);
    const none = await flow(["insights", "--json", "--cloud", fake.url], mkdtempSync(join(tmpdir(), "flow-conversations-")));
    assert.equal(JSON.parse(none.stdout).error.code, "no_live_key");
    assert.equal(JSON.parse(none.stdout).next, "npx @flow-engineer/flow setup --live");
  } finally { fake.close(); }
});

test("flow insights show prints the messages around each flagged one when Flow sends them", { timeout: 15_000 }, async () => {
  const window = [
    { id: "m0", role: "agent", at: "2026-10-29T08:59:00Z", text: "Which order is it?", text_state: "shown" },
    { id: "m1", role: "person", at: "2026-10-29T09:00:00Z", text: "The one from [DATE_1]", text_state: "shown" },
    { id: "m2", role: "person", at: "2026-10-29T09:00:30Z", text: null, text_state: "not_sent" },
  ];
  const withWindow = { ...findingConversations, data: [{ ...findingConversations.data[0], window }] };
  const fake = await server({ insights: { "/v1/agent/insights/findings/fnd_2/conversations 7": withWindow } });
  try {
    const shown = await flow(["insights", "show", "fnd_2", "--cloud", fake.url], agentDir());
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(shown.stdout, [
      "fnd_2  open  Unanswered · Refunds: 2 (was 5) conversations in the last 7 days",
      "",
      "cnv_1  2026-10-29 09:00:00Z  Unanswered; Got annoyed when the agent got a fact wrong",
      "    \"That's not my order\"",
      "    around it:",
      "      2026-10-29 08:59:00Z  agent: Which order is it?",
      "      2026-10-29 09:00:00Z  person: The one from [DATE_1]",
      "      2026-10-29 09:00:30Z  person: (text not sent to Flow)",
      "    next: flow conversations show cnv_1",
      "",
    ].join("\n"));
  } finally { fake.close(); }
});
