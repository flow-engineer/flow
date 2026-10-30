// covers: testing/src/templates.ts testing/src/conversations.ts testing/src/cli.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fillTemplate, type TemplateDefinition } from "../src/index.ts";
import { templateDifferences } from "../testing/src/templates.ts";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const KEY = "flow_test_k1_secretvalue";

/** The dashboard's answer: a numbered template with every part, a named one, and one still pending. */
const listed = {
  templates: [
    {
      name: "order_update", language: "en", category: "utility", status: "approved", source: "flow", channel: "whatsapp", sender: "snd_1", id: "tpl_1",
      header: { kind: "text", text: "Order {{1}}" },
      body: "Hi {{1}}, your order {{2}} has shipped.", footer: "Example Market",
      buttons: [{ type: "url", text: "Track it", url: "https://shop.example.com/track/{{1}}" }, { type: "quick_reply", text: "Not now" }, { type: "phone", text: "Call us", phone: "+15550001111" }],
      values: { header: "{{1}}", body: ["{{1}}", "{{2}}"], buttons: [{ index: 0, variable: "{{1}}" }] },
      send_order: "header = {{1}}, body[0] = {{1}}, body[1] = {{2}}, buttons[0] = {{1}}",
    },
    {
      name: "seller_answered", language: "en", category: "utility", status: "approved", source: "whatsapp_manager", channel: "whatsapp", sender: "snd_1", id: "tpl_2",
      header: { kind: "image" },
      body: "The seller answered about {{listing}}: {{answer}}. Ask more about {{listing}} here.",
      buttons: [],
      values: { body: ["{{listing}}", "{{answer}}"] },
      send_order: "body[0] = {{listing}}, body[1] = {{answer}}",
    },
    {
      name: "spring_sale", language: "en", category: "marketing", status: "pending", source: "flow", channel: "whatsapp", sender: "snd_1", id: "tpl_3",
      body: "Our spring sale starts today.", buttons: [], values: { body: [] }, send_order: "",
    },
  ],
  synced_at: "2026-10-30T12:00:00Z",
};

/** A fake flow.engineer: the agent read API's templates (404 when `templates` is false, as an older dashboard), and a test session that passes. */
async function server(templates: unknown = listed) {
  const asked: Array<{ url: string; authorization?: string }> = [];
  const http = createServer((req, res) => {
    asked.push({ url: req.url!, authorization: req.headers.authorization });
    const json = (status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/v1/agent/templates") return templates === false ? json(404, { error: { code: "not_found", message: "Not found." } }) : json(200, templates);
    if (req.url === "/api/sessions") return req.resume().on("end", () => json(200, { sessionId: "s1", token: "t", missing: [], dashboard: "http://dash/s1" }));
    if (req.url?.endsWith("/stream")) {
      const run = { runId: "r1", scenario: "hello", run: 1, channel: "sms", passed: true, checks: [], ended: "goal", turns: 1, messagesIn: 1, messagesOut: 1, toolCalls: 0, slowestAckMs: null,
        agentUsage: { input: 0, output: 0, costUsd: 0 }, agentModels: [], testUsage: { input: 0, output: 0, costUsd: 0 }, watch: "http://watch/r1" };
      return void res.writeHead(200, { "content-type": "text/event-stream" }).end(`data: ${JSON.stringify({ type: "finished", summary: { sessionId: "s1", suiteHash: "h", testModel: "m", runs: [run], dashboard: "http://dash/s1" } })}\n\n`);
    }
    req.resume();
    json(200, {});
  });
  const url = await new Promise<string>((done) => http.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(http.address() as AddressInfo).port}`)));
  return { url, asked, close: () => { http.closeAllConnections(); http.close(); } };
}

/** The flow command in dir, with no key, cloud or version from this machine; its exit and both streams. */
async function flow(args: string[], dir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["FLOW_KEY", "FLOW_FRAMEWORK_CLOUD", "FLOW_FRAMEWORK_CLOUD_KEY", "CHINWAG_CLOUD", "FLOW_AGENT_VERSION", "GITHUB_SHA", "NO_COLOR"]) delete env[name];
  const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-templates-"));
  writeFileSync(join(dir, ".env"), `FLOW_KEY=${KEY}\n`);
  return dir;
}

/** An agent folder whose agent declares these templates, with one scenario. */
function testedAgent(declared: unknown[]): string {
  const dir = agentDir();
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "tests", "scenarios"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  writeFileSync(join(dir, "tests", "scenarios", "hello.yaml"), "id: hello\nchannels: [sms]\nperson:\n  persona: a\n  goal: b\nopening:\n  - say: hi\n");
  writeFileSync(join(dir, "src", "agent.ts"), `export const tools = [];\nexport function buildAgent() {\n  return { channels: () => [], receive: () => "m", reacted: () => {}, templates: () => ${JSON.stringify(declared)} };\n}\n`);
  return dir;
}
const WELCOME = { name: "welcome", language: "en", category: "utility", body: "Welcome!" };

const DECLARE = `// The approved WhatsApp templates, exactly as Meta has them: paste into createAgent({ ... }).
templates: [
  {
    name: "order_update",
    language: "en",
    category: "utility",
    header: { kind: "text", text: "Order {{1}}" },
    body: "Hi {{1}}, your order {{2}} has shipped.",
    footer: "Example Market",
    buttons: [{ type: "url", text: "Track it", url: "https://shop.example.com/track/{{1}}" }, { type: "quick_reply", text: "Not now" }, { type: "phone", text: "Call us", phone: "+15550001111" }],
  },
  {
    name: "seller_answered",
    language: "en",
    category: "utility",
    header: { kind: "image" },
    body: "The seller answered about {{listing}}: {{answer}}. Ask more about {{listing}} here.",
  },
],

// A send of each gives its values by position, in this order:
// order_update (en): header = {{1}}, body[0] = {{1}}, body[1] = {{2}}, buttons[0] = {{1}}
// await agent.nudge({ to, template: { name: "order_update", language: "en", header: { kind: "text", text: "<1>" }, body: ["<1>", "<2>"], buttons: [{ index: 0, value: "<1>" }] } });
// seller_answered (en): body[0] = {{listing}}, body[1] = {{answer}}
// await agent.nudge({ to, template: { name: "seller_answered", language: "en", header: { kind: "image", url: "https://…" }, body: ["<listing>", "<answer>"] } });
`;

test("flow templates lists the approved templates with their send order (--all every status, --json the server's answer), and --declare prints them ready to paste", { timeout: 15_000 }, async () => {
  const fake = await server();
  try {
    const dir = agentDir();
    const listedOut = await flow(["templates", "--cloud", fake.url], dir);
    assert.equal(listedOut.code, 0, listedOut.stderr);
    assert.deepEqual(fake.asked[0], { url: "/v1/agent/templates", authorization: `Bearer ${KEY}` });
    assert.equal(listedOut.stdout, [
      "NAME             LANGUAGE  CATEGORY  STATUS    SEND ORDER",
      "order_update     en        utility   approved  header = {{1}}, body[0] = {{1}}, body[1] = {{2}}, buttons[0] = {{1}}",
      "seller_answered  en        utility   approved  body[0] = {{listing}}, body[1] = {{answer}}",
      "",
      "Declare them: flow templates --declare",
      "",
    ].join("\n"));
    assert.match((await flow(["templates", "--all", "--cloud", fake.url], dir)).stdout, /^spring_sale +en +marketing +pending +-$/m);
    assert.deepEqual(JSON.parse((await flow(["templates", "--json", "--cloud", fake.url], dir)).stdout), listed);

    const declared = await flow(["templates", "--declare", "--cloud", fake.url], dir);
    assert.equal(declared.code, 0, declared.stderr);
    assert.equal(declared.stdout, DECLARE);
    // Pasted, it is code: the templates Meta approved, each filled by its send's order.
    const block = declared.stdout.split("\n").filter((l) => !l.startsWith("//")).join("\n");
    const templates = new Function(`return { ${block} }`)().templates as TemplateDefinition[];
    assert.equal(fillTemplate(templates[1]!, { name: "seller_answered", header: { kind: "image", url: "https://example.com/bike.png" }, body: ["Blue bike", "Yes"] }).body, "The seller answered about Blue bike: Yes. Ask more about Blue bike here.");
    assert.deepEqual(templateDifferences(templates, listed.templates), [], "what --declare prints is what is approved");
  } finally { fake.close(); }
});

test("a dashboard without the templates route: flow templates says it does not serve them yet, and flow test says nothing", { timeout: 15_000 }, async () => {
  const fake = await server(false);
  try {
    const listedOut = await flow(["templates", "--cloud", fake.url], agentDir());
    assert.equal(listedOut.code, 1);
    assert.equal(listedOut.stderr, `flow templates: the dashboard does not serve templates yet (${fake.url} answered 404).\n`);
    const tested = await flow(["test", "--cloud", fake.url], testedAgent([WELCOME]));
    assert.equal(tested.code, 0, tested.stderr);
    assert.ok(fake.asked.some((a) => a.url === "/v1/agent/templates"));
    assert.doesNotMatch(tested.stdout + tested.stderr, /WhatsApp templates/);
  } finally { fake.close(); }
});

test("a declared template is compared with the dashboard's: missing, not approved, and each part that differs is named", () => {
  const order: TemplateDefinition = { name: "order_update", language: "en", category: "utility", header: { kind: "text", text: "Order #{{1}}" }, body: "Hi {{1}}, order {{2}} shipped.",
    buttons: [{ type: "url", text: "Track it", url: "https://shop.example.com/track/{{1}}" }, { type: "quick_reply", text: "Not now" }, { type: "phone", text: "Call us", phone: "+15550001111" }] };
  const seller: TemplateDefinition = { name: "seller_answered", language: "en", category: "utility", header: { kind: "image" }, body: "The seller answered about {{listing}}: {{answer}}. Ask more about {{listing}} here." };
  assert.deepEqual(templateDifferences([
    order,
    seller,
    { name: "spring_sale", language: "en", category: "marketing", body: "Our spring sale starts today." },
    WELCOME as TemplateDefinition,
  ], listed.templates), [
    'order_update (en): header text: declared "Order #{{1}}", approved "Order {{1}}"',
    'order_update (en): body: declared "Hi {{1}}, order {{2}} shipped.", approved "Hi {{1}}, your order {{2}} has shipped."',
    'order_update (en): footer: declared none, approved "Example Market"',
    "spring_sale (en): pending, not approved: its sends fail until Meta approves it",
    "welcome (en): missing, not on the dashboard",
  ]);
  assert.deepEqual(templateDifferences([{ ...seller, buttons: [{ type: "quick_reply", text: "Ask" }] }], listed.templates), ['seller_answered (en): buttons: declared [{ type: "quick_reply", text: "Ask" }], approved []']);
});

test("flow test warns, and still passes, when the agent declares a template the dashboard does not have as approved", { timeout: 20_000 }, async () => {
  const fake = await server();
  try {
    const order = { name: "order_update", language: "en", category: "utility", header: { kind: "text", text: "Order {{1}}" }, body: "Hi {{1}}, your order {{2}} has shipped.", footer: "Example Market", buttons: listed.templates[0]!.buttons };
    const result = await flow(["test", "--cloud", fake.url], testedAgent([order, WELCOME]));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Declared WhatsApp templates that are not the approved ones \(warning; flow templates --declare prints the approved ones to paste\):\n {2}welcome \(en\): missing, not on the dashboard\n/);
    assert.ok(fake.asked.some((a) => a.url === "/v1/agent/templates" && a.authorization === `Bearer ${KEY}`));
  } finally { fake.close(); }
});
