// covers: testing/src/account.ts testing/src/flow-login.ts testing/src/cli.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { currentToken, deleteCredentials, retryAfterSeconds, saveCredentials } from "../testing/src/flow-login.ts";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const TOKEN = "fcli_secret_token_1234";
const KEYS = { cloud_key: "oci_cloudsecretvalue9Qz1", traces_key: "otk_test_tracesecret7Lm2", messaging_key: "fk_test_messagingsecretk4Tt" };

interface Seen { method: string; path: string; auth?: string; accept?: string; body: Record<string, unknown> }

/**
 * A flow.engineer as its CLI sign-in contract has it, that answers /cli/token from `tokenAnswers`
 * in turn (or from the function: null holds the request unanswered), /cli/setup with `setupStatus`
 * (a 502 carries what worked, as the real one does) and `options.setup` merged into its 200, the
 * try page as open for `options.tryOpen` (default Telegram), the model API's GET /credit with
 * `options.credit` (default 404), and records every request.
 */
async function flowServer(tokenAnswers: Array<Record<string, unknown>> | (() => Record<string, unknown> | null) = [], setupStatus = 200, options: { setup?: Record<string, unknown>; tryOpen?: string[]; setupError?: { status: number; body: Record<string, unknown>; headers?: Record<string, string> }; credit?: { status: number; body: Record<string, unknown> } } = {}) {
  const seen: Seen[] = [];
  const read = (req: IncomingMessage) => new Promise<string>((done) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => done(b)); });
  const server = createServer(async (req, res) => {
    const text = await read(req);
    const body = text ? JSON.parse(text) : {};
    seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, ...(req.url!.startsWith("/try/") ? { accept: req.headers.accept } : {}), body });
    const send = (status: number, answer: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); };
    // The try page: Telegram is open; another channel answers the server's error with its next step.
    if (req.url!.startsWith("/try/")) {
      if ((options.tryOpen ?? ["telegram"]).includes(new URL(req.url!, url).searchParams.get("c")!)) return void res.writeHead(200, { "content-type": "text/html" }).end("<p>Open</p>");
      return send(404, { error: "channel_not_open", error_description: "WhatsApp is not open on the sandbox yet.", next: "npx @flow-engineer/flow link --channel telegram" });
    }
    if (req.url === "/llm/framework/v1/credit") return send(options.credit?.status ?? 404, options.credit?.body ?? {});
    const bearer = req.headers.authorization?.startsWith("Bearer fcli_");
    if (req.url === "/cli/device") return send(200, { device_code: "fcd_1", user_code: "BCDF-GHJK", verification_uri: `${url}/cli/approve`, verification_uri_complete: `${url}/cli/approve?code=BCDF-GHJK`, interval: 0, expires_in: 600 });
    if (req.url === "/cli/token") {
      const a = typeof tokenAnswers === "function" ? tokenAnswers() : (tokenAnswers.shift() ?? { error: "expired_token" });
      return a ? send(a.access_token ? 200 : 400, a) : undefined;
    }
    if (!bearer) return send(401, { error: "invalid_token", error_description: "Sign in again.", next: "npx @flow-engineer/flow login" });
    if (req.url === "/cli/whoami") return send(200, { email: "dev@example.com", account: "uid_1" });
    if (req.url === "/cli/revoke") return send(200, {});
    if (req.url === "/cli/setup") {
      const have = new Set(body.have as string[]);
      const names: Record<string, string> = { cloud_key: "FLOW_FRAMEWORK_CLOUD_KEY", traces_key: "FLOW_FRAMEWORK_TRACES_KEY", messaging_key: "FLOW_MESSAGING_KEY" };
      if (options.setupError) return void res.writeHead(options.setupError.status, { "content-type": "application/json", ...options.setupError.headers }).end(JSON.stringify(options.setupError.body));
      const keys = Object.fromEntries(Object.entries(KEYS).filter(([field]) => !have.has(names[field]!)));
      if (setupStatus !== 200) return send(setupStatus, { error: "messaging_failed", error_description: "Messaging is down.", next: "npx @flow-engineer/flow setup", agent_id: "agt_1", cloud_key: keys.cloud_key, traces_key: keys.traces_key });
      return send(200, {
        agent_id: "agt_1", ...keys, telegram_sender: "snd_tg", join_code: "brave-otter-1", account: { account: "uid_1", email: "dev@example.com" }, app_id: "app_1",
        dashboard_url: `${url}/dashboard/agents/agt_1/overview`, try_url: `${url}/try/brave-otter-1?c=telegram`, telegram_link: "https://t.me/FlowSandboxBot?start=brave-otter-1",
        minted: Object.keys(keys), next: ["npx @flow-engineer/flow link --channel telegram"], ...options.setup,
      });
    }
    send(404, {});
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => { server.closeAllConnections(); server.close(); } };
}

/** Runs the CLI in `cwd` with its own config folder; resolves to its exit status, stdout and stderr. */
function run(args: string[], options: { url: string; config: string; cwd: string; env?: Record<string, string> }) {
  const child = start(args, options);
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  return new Promise<{ code: number | null; out: string; err: string; lines: Array<Record<string, any>> }>((done) =>
    child.on("close", (code) => done({ code, out, err, lines: args.includes("--json") ? out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [] })),
  );
}

/** Starts the CLI with no terminal: stdin is a pipe left open and never written. */
function start(args: string[], options: { url: string; config: string; cwd: string; env?: Record<string, string> }) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: options.config, XDG_CONFIG_HOME: options.config, FLOW_FRAMEWORK_LOGIN_URL: options.url, ...options.env };
  return spawn(process.execPath, [cli, ...args], { cwd: options.cwd, env });
}

/**
 * A folder for PATH holding a fake browser opener under every name login tries (open, xdg-open,
 * wslview), each writing the page it was given to `log`; `opened` resolves once it has.
 */
function fakeOpener() {
  const bin = temp();
  const log = join(bin, "opened.log");
  for (const name of ["open", "xdg-open", "wslview"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$1" >> "${log}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const opened = new Promise<string>((done) => {
    const check = () => { if (existsSync(log) && readFileSync(log, "utf8").endsWith("\n")) { watcher.close(); done(readFileSync(log, "utf8")); } };
    const watcher = watch(bin, check);
    check();
  });
  return { env: { PATH: bin, DISPLAY: ":0" }, log, opened };
}

const temp = () => mkdtempSync(join(tmpdir(), "flow-account-"));
const NO_KEY = "This agent has no model key: npx @flow-engineer/flow setup writes FLOW_MODEL_KEY, Flow's free trial key, into .env in the agent's folder, or put your own on one of the lines OPENROUTER_API_KEY=, OPENAI_API_KEY=, ANTHROPIC_API_KEY= or GEMINI_API_KEY= (an OpenRouter key is made at https://openrouter.ai/keys).";
/** A folder that is an agent's: it has a package.json. */
const agentDir = (name = "cafe") => {
  const dir = temp();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  return dir;
};

test("login prints the code as a pending line, waits through pending and slow_down, then saves the token at mode 0600", async (t) => {
  const flow = await flowServer([{ error: "authorization_pending" }, { error: "slow_down" }, { access_token: TOKEN, expires_at: "2027-01-01T00:00:00Z" }]);
  t.after(flow.close);
  const config = temp();
  const result = await run(["login", "--no-browser", "--json"], { url: flow.url, config, cwd: temp() });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.lines[0], { status: "pending", verification_uri: `${flow.url}/cli/approve`, verification_uri_complete: `${flow.url}/cli/approve?code=BCDF-GHJK`, user_code: "BCDF-GHJK", expires_in: 600, opened_browser: false, resumed: false, next: WAIT_NEXT });
  const file = join(config, "flow-framework", "credentials.json");
  assert.deepEqual(result.lines[1], { status: "signed_in", account: { email: "dev@example.com", account: "uid_1" }, token_path: file });
  assert.equal(flow.seen.filter((r) => r.path === "/cli/token").length, 3);
  assert.match(String(flow.seen[0]!.body.client_name), /^flow \d+\.\d+\.\d+/, "the approval page shows the version");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).token, TOKEN);
  assert.ok(!result.out.includes(TOKEN) && !result.err.includes(TOKEN), "the token is never printed");
});

const WAIT_NEXT = "approve in the browser, then run: npx @flow-engineer/flow login --wait";

test("with no terminal and CI=1, login opens the browser itself and prints the pending line before it waits", async (t) => {
  const flow = await flowServer(() => null);
  t.after(flow.close);
  const opener = fakeOpener();
  const child = start(["login", "--json"], { url: flow.url, config: temp(), cwd: temp(), env: { ...opener.env, CI: "1" } });
  t.after(() => child.kill());
  const first = await new Promise<Record<string, unknown>>((done) => {
    let out = "";
    child.stdout.on("data", (c) => { out += c; if (out.includes("\n")) done(JSON.parse(out.slice(0, out.indexOf("\n")))); });
  });
  assert.equal(first.status, "pending");
  assert.equal(first.user_code, "BCDF-GHJK");
  assert.equal(first.opened_browser, true);
  assert.equal(first.next, WAIT_NEXT);
  assert.equal(await opener.opened, `${flow.url}/cli/approve?code=BCDF-GHJK\n`);
  assert.equal(child.exitCode, null, "it is still waiting, with the line already out");
});

test("--no-wait and a --timeout that runs out exit 4 with the code kept at 0600; --wait polls that same code, with no new code or browser tab", async (t) => {
  let approved = false;
  const flow = await flowServer(() => (approved ? { access_token: TOKEN } : { error: "authorization_pending" }));
  t.after(flow.close);
  const opener = fakeOpener();
  const config = temp();
  const pendingFile = join(config, "flow-framework", "pending.json");
  const started = await run(["login", "--no-wait", "--json"], { url: flow.url, config, cwd: temp(), env: opener.env });
  assert.equal(started.code, 4, started.err);
  assert.equal(started.lines[0]!.opened_browser, true);
  assert.deepEqual(started.lines.at(-1), { status: "pending", user_code: "BCDF-GHJK", verification_uri: `${flow.url}/cli/approve`, waited_s: 0, next: WAIT_NEXT });
  assert.equal(flow.seen.filter((r) => r.path === "/cli/token").length, 0, "--no-wait returns before polling");
  assert.equal(statSync(pendingFile).mode & 0o777, 0o600);
  await opener.opened;

  const timedOut = await run(["login", "--wait", "--timeout", "0", "--json"], { url: flow.url, config, cwd: temp(), env: opener.env });
  assert.equal(timedOut.code, 4, timedOut.err);
  assert.equal(timedOut.lines[0]!.resumed, true);
  assert.equal(timedOut.lines.at(-1)!.status, "pending");
  assert.match(timedOut.err, /Not approved yet after 0 s.*Next: npx @flow-engineer\/flow login --wait/);
  assert.ok(existsSync(pendingFile));

  approved = true;
  const done = await run(["login", "--wait", "--json"], { url: flow.url, config, cwd: temp(), env: opener.env });
  assert.equal(done.code, 0, done.err);
  assert.deepEqual({ resumed: done.lines[0]!.resumed, opened: done.lines[0]!.opened_browser }, { resumed: true, opened: false });
  assert.equal(done.lines.at(-1)!.status, "signed_in");
  assert.equal(flow.seen.filter((r) => r.path === "/cli/device").length, 1, "one code for all three runs");
  assert.ok(flow.seen.filter((r) => r.path === "/cli/token").every((r) => r.body.device_code === "fcd_1"));
  assert.equal(readFileSync(opener.log, "utf8").split("\n").filter(Boolean).length, 1, "one browser tab");
  assert.ok(!existsSync(pendingFile), "the used code is forgotten");
});

test("--wait polls a pending code past its expires_at, and when the server says expired_token it starts one new sign-in", async (t) => {
  const flow = await flowServer([{ error: "expired_token" }, { access_token: TOKEN }]);
  t.after(flow.close);
  const config = temp();
  mkdirSync(join(config, "flow-framework"));
  writeFileSync(join(config, "flow-framework", "pending.json"), JSON.stringify({ device_code: "fcd_old", user_code: "OLDC-ODEX", verification_uri: `${flow.url}/cli/approve`, interval: 0, expires_in: 600, expires_at: Date.now() - 1000, url: flow.url }));
  const result = await run(["login", "--wait", "--no-browser", "--json"], { url: flow.url, config, cwd: temp() });
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /pending sign-in code has expired; starting a new sign-in/);
  assert.deepEqual({ code: result.lines[0]!.user_code, resumed: result.lines[0]!.resumed }, { code: "OLDC-ODEX", resumed: true });
  assert.deepEqual({ code: result.lines[1]!.user_code, resumed: result.lines[1]!.resumed }, { code: "BCDF-GHJK", resumed: false });
  assert.deepEqual(flow.seen.filter((r) => r.path === "/cli/token").map((r) => r.body.device_code), ["fcd_old", "fcd_1"], "the server decided the old code had expired");
});

test("with no browser opener here, login says so and goes on to sign in", async (t) => {
  const flow = await flowServer([{ access_token: TOKEN }]);
  t.after(flow.close);
  const result = await run(["login", "--json"], { url: flow.url, config: temp(), cwd: temp(), env: { PATH: temp(), DISPLAY: ":0" } });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.lines[0]!.opened_browser, false);
  assert.match(result.err, /Could not open a browser here; open http/);
});

test("signed in already, login says so and exits 0 without a code; --force signs in again", async (t) => {
  const flow = await flowServer([{ access_token: TOKEN }]);
  t.after(flow.close);
  const config = temp();
  const env = { FLOW_FRAMEWORK_TOKEN: "fcli_from_env" };
  const again = await run(["login", "--json"], { url: flow.url, config, cwd: temp(), env });
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(again.lines[0], { status: "signed_in", already: true, account: { email: "dev@example.com", account: "uid_1" } });
  assert.equal(flow.seen.filter((r) => r.path === "/cli/device").length, 0);
  const forced = await run(["login", "--force", "--no-browser", "--json"], { url: flow.url, config, cwd: temp(), env });
  assert.equal(forced.code, 0, forced.err);
  assert.equal(forced.lines.at(-1)!.status, "signed_in");
  assert.equal(flow.seen.filter((r) => r.path === "/cli/device").length, 1);
});

test("a code denied in the browser, or one that expired, exits 3 with its error and saves nothing", async (t) => {
  for (const error of ["access_denied", "expired_token"]) {
    const flow = await flowServer([{ error }]);
    t.after(flow.close);
    const config = temp();
    const result = await run(["login", "--no-browser", "--json"], { url: flow.url, config, cwd: temp() });
    assert.equal(result.code, 3);
    assert.deepEqual(result.lines.at(-1)!.error.code, error);
    assert.equal(result.lines.at(-1)!.error.next, "npx @flow-engineer/flow login");
    assert.ok(!existsSync(join(config, "flow-framework", "credentials.json")));
  }
});

test("whoami uses FLOW_FRAMEWORK_TOKEN over the file, and without either says to log in", async (t) => {
  const flow = await flowServer();
  t.after(flow.close);
  const config = temp();
  const none = await run(["whoami", "--json"], { url: flow.url, config, cwd: temp() });
  assert.equal(none.code, 1);
  assert.deepEqual(none.lines[0], { error: { code: "not_signed_in", message: "Not signed in to flow.engineer.", next: "npx @flow-engineer/flow login" } });
  const result = await run(["whoami", "--json"], { url: flow.url, config, cwd: temp(), env: { FLOW_FRAMEWORK_TOKEN: "fcli_from_env" } });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.lines[0], { email: "dev@example.com", account: "uid_1" });
  assert.equal(flow.seen.at(-1)!.auth, "Bearer fcli_from_env");
});

test("logout revokes the token on the server and deletes the file", async (t) => {
  const flow = await flowServer([{ access_token: TOKEN }]);
  t.after(flow.close);
  const config = temp();
  assert.equal((await run(["login", "--no-browser"], { url: flow.url, config, cwd: temp() })).code, 0);
  const result = await run(["logout", "--json"], { url: flow.url, config, cwd: temp() });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(flow.seen.at(-1), { method: "POST", path: "/cli/revoke", auth: `Bearer ${TOKEN}`, body: {} });
  assert.ok(!existsSync(join(config, "flow-framework", "credentials.json")));
});

test("setup merges the keys into .env, keeps the owner's lines and values, prints no key, and a second run changes nothing", async (t) => {
  const flow = await flowServer();
  t.after(flow.close);
  const config = temp();
  const cwd = temp();
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "cafe" }));
  writeFileSync(join(cwd, ".env"), "OPENROUTER_API_KEY=sk-mine\nFLOW_MESSAGING_TELEGRAM_SENDER=snd_mine\n");
  const env = { FLOW_FRAMEWORK_TOKEN: TOKEN };
  const first = await run(["setup", "--json"], { url: flow.url, config, cwd, env });
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(flow.seen.at(-1)!.body, { name: "cafe", hostname: flow.seen.at(-1)!.body.hostname, channels: ["telegram", "whatsapp", "imessage"], have: ["FLOW_MESSAGING_TELEGRAM_SENDER", "OPENROUTER_API_KEY"] });
  const dotenv = readFileSync(join(cwd, ".env"), "utf8");
  assert.equal(dotenv, `OPENROUTER_API_KEY=sk-mine\nFLOW_MESSAGING_TELEGRAM_SENDER=snd_mine\nFLOW_FRAMEWORK_CLOUD_KEY=${KEYS.cloud_key}\nFLOW_FRAMEWORK_TRACES_KEY=${KEYS.traces_key}\nFLOW_MESSAGING_KEY=${KEYS.messaging_key}\nFLOW_FRAMEWORK_JOIN_CODE=brave-otter-1\nFLOW_FRAMEWORK_TRY_URL=${flow.url}/try/brave-otter-1?c=telegram\n`);
  assert.deepEqual(first.lines[0]!.env_written[".env"], [
    { name: "FLOW_FRAMEWORK_CLOUD_KEY", action: "added", value: "oci_…9Qz1" },
    { name: "FLOW_FRAMEWORK_TRACES_KEY", action: "added", value: "otk_test_…7Lm2" },
    { name: "FLOW_MESSAGING_KEY", action: "added", value: "fk_test_…k4Tt" },
    { name: "FLOW_MESSAGING_TELEGRAM_SENDER", action: "kept", value: "snd_mine" },
    { name: "FLOW_FRAMEWORK_JOIN_CODE", action: "added", value: "brave-otter-1" },
    { name: "FLOW_FRAMEWORK_TRY_URL", action: "added", value: `${flow.url}/try/brave-otter-1?c=telegram` },
  ]);
  assert.deepEqual(first.lines[0]!.next, ["npm start", "npx @flow-engineer/flow link --channel telegram"], "a first run's order: the playground, then the server's link step");
  for (const key of Object.values(KEYS)) assert.ok(!first.out.includes(key) && !first.err.includes(key), "no key is printed");

  const second = await run(["setup", "--json"], { url: flow.url, config, cwd, env });
  assert.equal(second.code, 0, second.err);
  assert.equal((flow.seen.at(-1)!.body.have as string[]).length, 6, "every name already in .env is said, so no new key is made");
  assert.deepEqual(second.lines[0]!.env_written[".env"].map((w: { action: string }) => w.action), ["kept", "unchanged", "unchanged"]);
  assert.equal(readFileSync(join(cwd, ".env"), "utf8"), dotenv);

  const replaced = await run(["setup", "--replace"], { url: flow.url, config, cwd, env });
  assert.equal(replaced.code, 0, replaced.err);
  assert.match(readFileSync(join(cwd, ".env"), "utf8"), /^FLOW_MESSAGING_TELEGRAM_SENDER=snd_tg$/m);
});

test("link in a folder not set up signs in, resuming a code already waiting, runs setup for the channel, checks the try page and prints the link", async (t) => {
  let approved = false;
  const flow = await flowServer(() => (approved ? { access_token: TOKEN } : { error: "authorization_pending" }));
  t.after(flow.close);
  const config = temp();
  const cwd = agentDir();
  const waiting = await run(["link", "--no-browser", "--timeout", "0", "--json"], { url: flow.url, config, cwd });
  assert.equal(waiting.code, 4, waiting.err);
  assert.equal(waiting.lines.at(-1)!.next, "approve in the browser, then run: npx @flow-engineer/flow link");
  assert.match(waiting.err, /Next: npx @flow-engineer\/flow link$/m);

  approved = true;
  const result = await run(["link", "--no-browser", "--json"], { url: flow.url, config, cwd });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.lines.map((l) => l.status ?? (l.agent ? "setup" : "link")), ["pending", "signed_in", "setup", "link"]);
  assert.equal(result.lines[0]!.resumed, true);
  assert.equal(flow.seen.filter((r) => r.path === "/cli/device").length, 1, "the waiting code was used, not a new one");
  assert.deepEqual(flow.seen.find((r) => r.path === "/cli/setup")!.body.channels, ["telegram", "whatsapp", "imessage"]);
  assert.match(readFileSync(join(cwd, ".env"), "utf8"), /^FLOW_FRAMEWORK_JOIN_CODE=brave-otter-1$/m);
  assert.deepEqual(result.lines.at(-1), {
    url: `${flow.url}/try/brave-otter-1?c=telegram`, channel: "telegram", join_code: "brave-otter-1", reply_only: false, say_to_person: `Open this on your phone and send the message Telegram fills in: ${flow.url}/try/brave-otter-1?c=telegram`,
    model_key: { set: false, env: null, flow_credit: null, message: NO_KEY }, next: "add your own model key to .env (flow.engineer gave no trial credit)",
  });
  assert.ok(!("next" in result.lines[2]!), "setup's next list is not given as well: one next per run");
  assert.match(result.err, /answers only once \.env has a model key/, "with no model key it does not say the phone chats with it");
  assert.ok(!/that phone chats with this agent/.test(result.err));
  assert.equal(flow.seen.at(-1)!.accept, "application/json", "the try page is asked for JSON, so a refusal comes with its next step");
  for (const key of Object.values(KEYS)) assert.ok(!result.out.includes(key) && !result.err.includes(key), "no key is printed");
});

test("link in a folder set up already needs no sign-in: it prints the server's try_url for that channel, else builds one; a channel the server cannot open yet is said once with the open channels' links, and exits 3 only when none is open", async (t) => {
  const flow = await flowServer();
  t.after(flow.close);
  const cwd = temp();
  writeFileSync(join(cwd, ".env"), `FLOW_MESSAGING_KEY=${KEYS.messaging_key}\nFLOW_MESSAGING_WHATSAPP_SENDER=snd_wa\nFLOW_FRAMEWORK_JOIN_CODE=brave-otter-1\nFLOW_FRAMEWORK_TRY_URL=${flow.url}/try/brave-otter-1?c=telegram&from=setup\n`);
  const served = await run(["link", "--json"], { url: flow.url, config: temp(), cwd });
  assert.equal(served.code, 0, served.err);
  assert.equal(served.lines[0]!.url, `${flow.url}/try/brave-otter-1?c=telegram&from=setup`);
  assert.equal(flow.seen.filter((r) => r.path.startsWith("/cli/")).length, 0, "no sign-in and no setup");

  // WhatsApp's sender is in .env but the try page says it is closed: said once, with Telegram's link instead.
  const closed = await run(["link", "--channel", "whatsapp", "--json"], { url: flow.url, config: temp(), cwd });
  assert.equal(closed.code, 0, closed.err);
  assert.ok(flow.seen.some((r) => r.path === "/try/brave-otter-1?c=whatsapp"));
  assert.equal(closed.lines[0]!.url, `${flow.url}/try/brave-otter-1?c=telegram&from=setup`);
  assert.equal(closed.lines[0]!.not_open, "whatsapp");
  assert.deepEqual(closed.lines[0]!.links, { telegram: `${flow.url}/try/brave-otter-1?c=telegram&from=setup` });
  assert.equal(closed.err.split("\n").filter((l) => /WhatsApp/.test(l)).length, 1, "the closed channel is said once");
  assert.match(closed.err, /^WhatsApp isn't open yet; here is your Telegram link\.$/m);

  const nothing = await flowServer([], 200, { tryOpen: [] });
  t.after(nothing.close);
  writeFileSync(join(cwd, ".env"), `FLOW_MESSAGING_KEY=${KEYS.messaging_key}\nFLOW_MESSAGING_WHATSAPP_SENDER=snd_wa\nFLOW_FRAMEWORK_JOIN_CODE=brave-otter-1\n`);
  const refused = await run(["link", "--channel", "whatsapp", "--json"], { url: nothing.url, config: temp(), cwd });
  assert.equal(refused.code, 3, "with no channel open at all it is still a refusal");
  assert.deepEqual(refused.lines[0], { error: { code: "channel_not_open", message: "WhatsApp is not open on the sandbox yet.", next: "npx @flow-engineer/flow link --channel telegram" } });
  assert.equal((await run(["link", "--channel", "sms"], { url: flow.url, config: temp(), cwd })).code, 1, "an unknown channel is a usage error");
});

test("a setup that fails in one product still writes the keys it minted, then exits 3 with the server's next step", async (t) => {
  const flow = await flowServer([], 502);
  t.after(flow.close);
  const cwd = agentDir();
  const result = await run(["setup", "--json"], { url: flow.url, config: temp(), cwd, env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
  assert.equal(result.code, 3);
  assert.deepEqual(result.lines.at(-1)!.error.code, "messaging_failed");
  assert.equal(result.lines.at(-1)!.error.next, "npx @flow-engineer/flow setup");
  assert.equal(readFileSync(join(cwd, ".env"), "utf8"), `FLOW_FRAMEWORK_CLOUD_KEY=${KEYS.cloud_key}\nFLOW_FRAMEWORK_TRACES_KEY=${KEYS.traces_key}\n`);
  assert.ok(!result.out.includes(KEYS.cloud_key) && !result.err.includes(KEYS.cloud_key), "no key is printed");
});

test("every next step and hint the account commands print names the package, never a bare npx flow (another npm package)", async (t) => {
  const flow = await flowServer(() => ({ error: "authorization_pending" }));
  t.after(flow.close);
  const config = temp();
  const printed = [
    await run(["whoami", "--json"], { url: flow.url, config, cwd: temp() }),
    await run(["link", "--no-browser", "--timeout", "0", "--json"], { url: flow.url, config, cwd: agentDir() }),
    await run(["setup", "--ci", "--json"], { url: flow.url, config, cwd: temp() }),
    await run(["login", "--no-browser", "--timeout", "0", "--json"], { url: flow.url, config, cwd: temp() }),
    await run(["setup", "--json"], { url: flow.url, config, cwd: agentDir(), env: { FLOW_FRAMEWORK_TOKEN: TOKEN } }),
    await run(["login", "--help"], { url: flow.url, config, cwd: temp() }),
  ].map((r) => r.out + r.err).join("\n");
  assert.doesNotMatch(printed, /npx flow\b/);
  for (const command of ["login", "login --wait", "setup", "link", "test --synthetic"]) assert.ok(printed.includes(`npx @flow-engineer/flow ${command}`), command);
});

test("a sign-in under ~/.config/chinwag is read and deleted while ~/.config/flow-framework has none; a new one goes to flow-framework", () => {
  const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "flow-config-")) };
  mkdirSync(join(env.XDG_CONFIG_HOME, "chinwag"));
  writeFileSync(join(env.XDG_CONFIG_HOME, "chinwag", "credentials.json"), JSON.stringify({ token: "fcli_old", url: "https://flow.engineer" }));
  assert.deepEqual(currentToken(env), { token: "fcli_old", from: "file", url: "https://flow.engineer" });
  assert.equal(saveCredentials({ token: "fcli_new", url: "https://flow.engineer" }, env), join(env.XDG_CONFIG_HOME, "flow-framework", "credentials.json"));
  assert.deepEqual(currentToken(env), { token: "fcli_new", from: "file", url: "https://flow.engineer" });
  assert.equal(deleteCredentials(env), true);
  assert.deepEqual(currentToken(env), { token: "fcli_old", from: "file", url: "https://flow.engineer" });
  assert.equal(deleteCredentials(env), true);
  assert.equal(currentToken(env), undefined);
});

test("setup fills names that .env has with no value (cp .env.example .env) in place, as missing, and sets an existing .env to 0600", async (t) => {
  const flow = await flowServer();
  t.after(flow.close);
  const cwd = agentDir();
  writeFileSync(join(cwd, ".env"), `OPENROUTER_API_KEY=sk-mine\nFLOW_FRAMEWORK_CLOUD_KEY=\nFLOW_MESSAGING_KEY=""\n# the rest\n`, { mode: 0o644 });
  chmodSync(join(cwd, ".env"), 0o644);
  const result = await run(["setup", "--json"], { url: flow.url, config: temp(), cwd, env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(flow.seen.at(-1)!.body.have, ["OPENROUTER_API_KEY"], "an empty value is not had, so the server mints it");
  const lines = readFileSync(join(cwd, ".env"), "utf8").split("\n");
  assert.deepEqual(lines.slice(0, 4), ["OPENROUTER_API_KEY=sk-mine", `FLOW_FRAMEWORK_CLOUD_KEY=${KEYS.cloud_key}`, `FLOW_MESSAGING_KEY=${KEYS.messaging_key}`, "# the rest"], "each fills its own line");
  assert.equal(lines.filter((l) => l.startsWith("FLOW_FRAMEWORK_CLOUD_KEY=")).length, 1);
  const actions = Object.fromEntries(result.lines[0]!.env_written[".env"].map((w: { name: string; action: string }) => [w.name, w.action]));
  assert.equal(actions.FLOW_FRAMEWORK_CLOUD_KEY, "added");
  assert.equal(actions.FLOW_MESSAGING_KEY, "added");
  assert.equal(statSync(join(cwd, ".env")).mode & 0o777, 0o600);
});

test("a 200 setup with no join code still writes the keys it minted, then exits 3 with the server's next step", async (t) => {
  const flow = await flowServer([], 200, { setup: { join_code: undefined, next: ["npx @flow-engineer/flow setup"] } });
  t.after(flow.close);
  const cwd = agentDir();
  const result = await run(["setup", "--json"], { url: flow.url, config: temp(), cwd, env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
  assert.equal(result.code, 3, result.err);
  assert.equal(result.lines.at(-1)!.error.code, "no_join_code");
  assert.equal(result.lines.at(-1)!.error.next, "npx @flow-engineer/flow setup");
  const dotenv = readFileSync(join(cwd, ".env"), "utf8");
  for (const key of Object.values(KEYS)) assert.ok(dotenv.includes(key), "every minted key is kept");
  assert.ok(!result.out.includes(KEYS.cloud_key) && !result.err.includes(KEYS.cloud_key), "no key is printed");
});

test("a saved token goes only to the server that issued it, and never over http to another machine", async (t) => {
  const issuer = await flowServer();
  const other = await flowServer();
  t.after(issuer.close);
  t.after(other.close);
  const config = temp();
  saveCredentials({ token: TOKEN, url: issuer.url }, { XDG_CONFIG_HOME: config });
  const elsewhere = await run(["whoami", "--json"], { url: other.url, config, cwd: temp() });
  assert.equal(elsewhere.code, 1, elsewhere.err);
  assert.equal(elsewhere.lines[0]!.error.code, "signed_in_elsewhere");
  assert.equal(elsewhere.lines[0]!.error.next, "npx @flow-engineer/flow login --force");
  const setupElsewhere = await run(["setup", "--json"], { url: other.url, config, cwd: agentDir() });
  assert.equal(setupElsewhere.lines[0]!.error.code, "signed_in_elsewhere");
  assert.equal(other.seen.length, 0, "the other server never saw the token");
  assert.equal((await run(["whoami"], { url: issuer.url, config, cwd: temp() })).code, 0, "the issuer still takes it");

  for (const url of ["http://flow.example", "ftp://flow.example"]) {
    const insecure = await run(["whoami", "--json"], { url, config: temp(), cwd: temp(), env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
    assert.equal(insecure.code, 1, insecure.err);
    assert.equal(insecure.lines[0]!.error.code, "insecure_login_url");
    assert.ok(insecure.lines[0]!.error.next);
  }
});

test("a server with no /cli/ routes (a bare 404) is server_unsupported with a next step", async (t) => {
  const server = createServer((_req, res) => void res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const result = await run(["login", "--no-browser", "--json"], { url, config: temp(), cwd: temp() });
  assert.equal(result.code, 3, result.err);
  assert.equal(result.lines.at(-1)!.error.code, "server_unsupported");
  assert.match(result.lines.at(-1)!.error.message, /has no \/cli\/device/);
  assert.match(result.lines.at(-1)!.error.next, /unset FLOW_FRAMEWORK_LOGIN_URL/);
});

test("a poll the server never answers is cut off by --timeout: the code stays pending (exit 4)", async (t) => {
  const flow = await flowServer(() => null);
  t.after(flow.close);
  const config = temp();
  const result = await run(["login", "--no-browser", "--timeout", "1", "--json"], { url: flow.url, config, cwd: temp() });
  assert.equal(result.code, 4, result.err);
  assert.equal(result.lines.at(-1)!.status, "pending");
  assert.ok(existsSync(join(config, "flow-framework", "pending.json")));
});

test("--wait on a code past its expires_at that the server approved signs in; a code from another login URL is said so and replaced", async (t) => {
  const flow = await flowServer([{ access_token: TOKEN }, { access_token: TOKEN }]);
  t.after(flow.close);
  const config = temp();
  const pendingFile = join(config, "flow-framework", "pending.json");
  mkdirSync(join(config, "flow-framework"));
  const pending = (url: string) => JSON.stringify({ device_code: "fcd_late", user_code: "LATE-CODE", verification_uri: `${url}/cli/approve`, interval: 0, expires_in: 600, expires_at: Date.now() - 60_000, url });
  writeFileSync(pendingFile, pending(flow.url));
  const late = await run(["login", "--wait", "--no-browser", "--json"], { url: flow.url, config, cwd: temp() });
  assert.equal(late.code, 0, late.err);
  assert.deepEqual(flow.seen.filter((r) => r.path === "/cli/token").map((r) => r.body.device_code), ["fcd_late"]);
  assert.equal(late.lines.at(-1)!.status, "signed_in");

  writeFileSync(pendingFile, pending("https://flow.example"));
  const moved = await run(["login", "--wait", "--force", "--no-browser", "--json"], { url: flow.url, config, cwd: temp() });
  assert.equal(moved.code, 0, moved.err);
  assert.match(moved.err, /waiting sign-in code is from https:\/\/flow\.example, not http:\/\/127\.0\.0\.1:\d+; starting a new sign-in/);
  assert.equal(moved.lines[0]!.user_code, "BCDF-GHJK");
});

test("setup and link refuse a folder with no package.json before signing in or minting anything", async (t) => {
  const flow = await flowServer();
  t.after(flow.close);
  for (const command of ["setup", "link"]) {
    const cwd = temp();
    const result = await run([command, "--json"], { url: flow.url, config: temp(), cwd, env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
    assert.equal(result.code, 1, result.err);
    assert.equal(result.lines.at(-1)!.error.code, "not_an_agent_folder");
    assert.match(result.lines.at(-1)!.error.next, /npx @flow-engineer\/flow init/);
    assert.ok(!existsSync(join(cwd, ".env")));
  }
  assert.equal(flow.seen.length, 0);
});

test("setup saves each open channel's sender and prints its link; link --channel imessage says the agent replies only after you write", async (t) => {
  const channels = {
    whatsapp_sender: "snd_wa", whatsapp_link: "https://wa.me/15550100001?text=join%20brave-otter-1",
    imessage_sender: "snd_im", imessage_link: "sms:+15550100002?&body=join%20brave-otter-1",
    trial: { telegram: { limit: null, used: 0 }, whatsapp: { limit: 300, used: 12 }, imessage: { limit: 100, used: 0 } },
  };
  const flow = await flowServer([], 200, { setup: { ...channels, try_urls: undefined }, tryOpen: ["telegram", "whatsapp", "imessage"] });
  t.after(flow.close);
  const cwd = agentDir();
  const env = { FLOW_FRAMEWORK_TOKEN: TOKEN };
  const set = await run(["setup", "--json"], { url: flow.url, config: temp(), cwd, env });
  assert.equal(set.code, 0, set.err);
  const dotenv = readFileSync(join(cwd, ".env"), "utf8");
  assert.match(dotenv, /^FLOW_MESSAGING_WHATSAPP_SENDER=snd_wa$/m);
  assert.match(dotenv, /^FLOW_MESSAGING_IMESSAGE_SENDER=snd_im$/m);
  assert.equal(set.lines[0]!.imessage_link, channels.imessage_link);
  assert.equal(set.lines[0]!.try_urls.imessage, `${flow.url}/try/brave-otter-1?c=imessage`);
  assert.deepEqual(set.lines[0]!.trial, channels.trial);
  assert.match(set.err, /On WhatsApp: .*\?c=whatsapp \(free trial: 12 of 300 messages used\)/);

  const imessage = await run(["link", "--channel", "imessage", "--json"], { url: flow.url, config: temp(), cwd });
  assert.equal(imessage.code, 0, imessage.err);
  assert.equal(imessage.lines[0]!.reply_only, true);
  assert.match(imessage.lines[0]!.say_to_person, /only reply after you write to it first/);
  assert.match(imessage.err, /cannot message you first/);
});

test("link --channel whatsapp in a folder set up before it had a WhatsApp sender runs setup again, minting nothing; with WhatsApp not open it says so", async (t) => {
  const flow = await flowServer([], 200, { setup: { whatsapp_sender: "snd_wa" }, tryOpen: ["telegram", "whatsapp"] });
  t.after(flow.close);
  const cwd = agentDir();
  writeFileSync(join(cwd, ".env"), `FLOW_FRAMEWORK_CLOUD_KEY=${KEYS.cloud_key}\nFLOW_FRAMEWORK_TRACES_KEY=${KEYS.traces_key}\nFLOW_MESSAGING_KEY=${KEYS.messaging_key}\nFLOW_FRAMEWORK_JOIN_CODE=brave-otter-1\n`);
  const result = await run(["link", "--channel", "whatsapp", "--json"], { url: flow.url, config: temp(), cwd, env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.lines.at(-2)!.minted, [], "every key was had");
  assert.match(readFileSync(join(cwd, ".env"), "utf8"), /^FLOW_MESSAGING_WHATSAPP_SENDER=snd_wa$/m);
  assert.equal(result.lines.at(-1)!.url, `${flow.url}/try/brave-otter-1?c=whatsapp`);
  assert.match(result.err, /within 24 hours of your last message/);
  assert.match(result.err, /^If npm start is running, restart it to add WhatsApp\.$/m, "only the channel that is new");

  // iMessage is not open: no sender comes back, so link says so once and gives the open channels' links, exit 0.
  const closed = await flowServer([], 200, { setup: { whatsapp_sender: "snd_wa" }, tryOpen: ["telegram", "whatsapp"] });
  t.after(closed.close);
  const none = await run(["link", "--channel", "imessage", "--json"], { url: closed.url, config: temp(), cwd, env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
  assert.equal(none.code, 0, none.err);
  assert.equal(none.lines.at(-1)!.not_open, "imessage");
  assert.deepEqual(Object.keys(none.lines.at(-1)!.links), ["telegram", "whatsapp"]);
  assert.match(none.err, /^iMessage isn't open yet; here are your Telegram and WhatsApp links\.$/m);
  assert.equal(none.err.split("\n").filter((l) => /iMessage/.test(l)).length, 1, "said once");
  assert.ok(!/restart it/.test(none.err), "no channel is new, so no restart is asked for");
});

test("a setup the server asks to wait on (429 slow_down) prints the wait and next, exits 4 like a waiting sign-in, and gives retry_after and the warnings in --json", async (t) => {
  const flow = await flowServer([], 200, { setupError: { status: 429, headers: { "retry-after": "30" }, body: { error: "slow_down", error_description: "Too many setups from this account.", next: "npx @flow-engineer/flow setup", warnings: ["Setup was run 6 times in a minute."] } } });
  t.after(flow.close);
  const result = await run(["setup", "--json"], { url: flow.url, config: temp(), cwd: agentDir(), env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
  assert.equal(result.code, 4, result.err);
  assert.deepEqual(result.lines.at(-1), {
    error: { code: "slow_down", message: "/cli/setup answered 429 slow_down: Too many setups from this account. Wait 30 s before trying again.", next: "npx @flow-engineer/flow setup", retry_after: 30 },
    warnings: ["Setup was run 6 times in a minute."],
  });
  assert.match(result.err, /^Setup was run 6 times in a minute\.$/m);
  assert.match(result.err, /Wait 30 s before trying again\. Next: npx @flow-engineer\/flow setup$/m);

  const human = await run(["setup"], { url: flow.url, config: temp(), cwd: agentDir(), env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
  assert.equal(human.code, 4);
  assert.match(human.err, /Wait 30 s/);
});

test("Retry-After is read as seconds or as an HTTP date", () => {
  assert.equal(retryAfterSeconds("12"), 12);
  assert.equal(retryAfterSeconds(new Date(Date.UTC(2030, 0, 1, 0, 0, 45)).toUTCString(), Date.UTC(2030, 0, 1)), 45);
  assert.equal(retryAfterSeconds(new Date(Date.UTC(2020, 0, 1)).toUTCString()), 0, "a date gone by is no wait");
  assert.equal(retryAfterSeconds(null), undefined);
  assert.equal(retryAfterSeconds("soon"), undefined);
});

test("a trial limit (403) whose next is a sentence prints that sentence as it came, on its own line, and exits 3", async (t) => {
  const next = "You have used this account's free sandbox messages. Ask in the dashboard for more, or use your own sender.";
  const flow = await flowServer([], 200, { setupError: { status: 403, body: { error: "sandbox_allowance_used", error_description: "The free trial's messages are used up.", next } } });
  t.after(flow.close);
  const result = await run(["setup", "--json"], { url: flow.url, config: temp(), cwd: agentDir(), env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
  assert.equal(result.code, 3, result.err);
  assert.equal(result.lines.at(-1)!.error.code, "sandbox_allowance_used");
  assert.equal(result.lines.at(-1)!.error.next, next);
  assert.ok(!("retry_after" in result.lines.at(-1)!.error), "retry_after only for a 429");
  assert.ok(result.err.split("\n").includes(next), "the sentence is a line of its own");
  assert.ok(!result.err.includes("Next: You have used"), "a sentence is not given as a command");
});

test("setup prints each of the server's warnings on stderr (at most 20, strings only), gives them in --json, and shows iMessage's people", async (t) => {
  const warnings = Array.from({ length: 25 }, (_, i) => `Warning ${i + 1}.`);
  const trial = { telegram: { limit: null, used: 0 }, imessage: { limit: 100, used: 3, contacts: { limit: 2, used: 1 } } };
  const flow = await flowServer([], 200, { setup: { warnings: [...warnings.slice(0, 2), 7, ...warnings.slice(2)], imessage_sender: "snd_im", trial } });
  t.after(flow.close);
  const env = { FLOW_FRAMEWORK_TOKEN: TOKEN };
  const result = await run(["setup", "--json"], { url: flow.url, config: temp(), cwd: agentDir(), env });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.lines[0]!.warnings, warnings.slice(0, 20));
  assert.deepEqual(result.lines[0]!.trial.imessage.contacts, { limit: 2, used: 1 });
  for (const w of warnings.slice(0, 20)) assert.ok(result.err.split("\n").includes(w), w);
  assert.ok(!result.err.includes("Warning 21."));
  assert.match(result.err, /^iMessage: 1 of 2 people$/m);

  const human = await run(["setup"], { url: flow.url, config: temp(), cwd: agentDir(), env });
  assert.equal(human.code, 0, human.err);
  assert.match(human.err, /^Warning 1\.$/m, "warnings go to stderr");
  assert.ok(!human.out.includes("Warning 1."));
  assert.match(human.out, /^iMessage: 1 of 2 people$/m);

  const none = await flowServer();
  t.after(none.close);
  const plain = await run(["setup", "--json"], { url: none.url, config: temp(), cwd: agentDir(), env });
  assert.deepEqual(plain.lines[0]!.warnings, []);
});

const TRIAL = "fmk_flowtrialsecretQ7w3";
const MINTED = { env: "FLOW_MODEL_KEY", value: TRIAL, limit_usd: 2, left_usd: 1.87, minted: true, base_url: "https://flow.engineer/llm/framework/v1" };

test("setup writes Flow's trial model key as FLOW_MODEL_KEY at 0600 and prints only the credit left; a provider key of the owner's is named as had, so none is made", async (t) => {
  const flow = await flowServer([], 200, { setup: { model_key: MINTED, minted: ["model_key"] } });
  t.after(flow.close);
  const env = { FLOW_FRAMEWORK_TOKEN: TOKEN };
  const cwd = agentDir();
  writeFileSync(join(cwd, ".env"), "OPENROUTER_API_KEY=\nFLOW_MODEL_KEY=\n", { mode: 0o644 });
  chmodSync(join(cwd, ".env"), 0o644);
  const result = await run(["setup", "--json"], { url: flow.url, config: temp(), cwd, env });
  assert.equal(result.code, 0, result.err);
  assert.ok(!(flow.seen.at(-1)!.body.have as string[]).some((n) => n.endsWith("_API_KEY") || n === "FLOW_MODEL_KEY"), "no model key here, so Flow's is asked for");
  assert.deepEqual(readFileSync(join(cwd, ".env"), "utf8").split("\n").slice(0, 2), ["OPENROUTER_API_KEY=", `FLOW_MODEL_KEY=${TRIAL}`], "it takes its own empty line");
  assert.equal(statSync(join(cwd, ".env")).mode & 0o777, 0o600);
  assert.deepEqual(result.lines[0]!.model_key, { set: true, env: "FLOW_MODEL_KEY", flow_credit: { limit_usd: 2, left_usd: 1.87, minted: true } });
  assert.equal(result.lines[0]!.next[0], "npm start");
  assert.match(result.err, /^Model: Flow trial credit \(\$1\.87 left\)$/m);
  assert.match(result.err, /^ {2}FLOW_MODEL_KEY=fmk_…Q7w3 {2}added$/m, "only its prefix and last 4");
  assert.ok(!result.out.includes(TRIAL) && !result.err.includes(TRIAL), "the model key is never printed");

  // Set up again: the key there is named as had.
  assert.equal((await run(["setup", "--json"], { url: flow.url, config: temp(), cwd, env })).code, 0);
  assert.ok((flow.seen.at(-1)!.body.have as string[]).includes("FLOW_MODEL_KEY"));

  // The owner's own OpenAI key: only the names actually set are said as had.
  const own = agentDir();
  writeFileSync(join(own, ".env"), "OPENAI_API_KEY=sk-mine-openai\n");
  const kept = await run(["setup", "--json"], { url: flow.url, config: temp(), cwd: own, env });
  assert.equal(kept.code, 0, kept.err);
  assert.deepEqual(flow.seen.at(-1)!.body.have, ["OPENAI_API_KEY"]);
  assert.match(kept.err, /^Model: OPENAI_API_KEY is set$/m);
});

test("with no model key after setup, it says why in one sentence and puts the way to get one first in its one next list", async (t) => {
  const env = { FLOW_FRAMEWORK_TOKEN: TOKEN };
  // Refused (or an older server): no model_key, and a warning.
  const older = await flowServer([], 200, { setup: { warnings: ["Flow's trial credit is not available for this account."] } });
  t.after(older.close);
  const plain = await run(["setup"], { url: older.url, config: temp(), cwd: agentDir(), env });
  assert.equal(plain.code, 0, plain.err);
  assert.ok(plain.out.split("\n").includes(NO_KEY));
  assert.deepEqual(plain.out.split("\n").filter((l) => l.startsWith("Next:")), ["Next: add your own model key to .env (flow.engineer gave no trial credit), then npm start, then npx @flow-engineer/flow link --channel telegram"]);

  // The account's credit is used up: no key made.
  const spent = await flowServer([], 200, { setup: { model_key: { env: "FLOW_MODEL_KEY", limit_usd: 2, left_usd: 0, minted: false } } });
  t.after(spent.close);
  const out = await run(["setup", "--json"], { url: spent.url, config: temp(), cwd: agentDir(), env });
  assert.equal(out.lines[0]!.model_key.set, false);
  assert.equal(out.lines[0]!.model_key.message, "This account's Flow trial credit is used up.");
  assert.equal(out.lines[0]!.next[0], "add your own model key to .env");
});

test("a trial model key made in a call that then fails is written to .env before the error, as the other keys are", async (t) => {
  const flow = await flowServer([], 200, { setupError: { status: 502, body: { error: "messaging_failed", error_description: "Messaging is down.", next: "npx @flow-engineer/flow setup", model_key: MINTED, minted: ["model_key"] } } });
  t.after(flow.close);
  const cwd = agentDir();
  const result = await run(["setup", "--json"], { url: flow.url, config: temp(), cwd, env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
  assert.equal(result.code, 3);
  assert.equal(readFileSync(join(cwd, ".env"), "utf8"), `FLOW_MODEL_KEY=${TRIAL}\n`);
  assert.ok(!result.out.includes(TRIAL) && !result.err.includes(TRIAL));
});

test("setup --rotate makes the named keys again: model sends rotate [\"model_key\"] and replaces only FLOW_MODEL_KEY, the others leave rotate out, all sends true", async (t) => {
  const flow = await flowServer([], 200, { setup: { model_key: MINTED } });
  t.after(flow.close);
  const env = { FLOW_FRAMEWORK_TOKEN: TOKEN };
  const cwd = agentDir();
  writeFileSync(join(cwd, ".env"), "OPENROUTER_API_KEY=sk-or-mine\nFLOW_MODEL_KEY=fmk_old\nFLOW_FRAMEWORK_CLOUD_KEY=oci_old\n");
  const model = await run(["setup", "--rotate", "model"], { url: flow.url, config: temp(), cwd, env });
  assert.equal(model.code, 0, model.err);
  assert.deepEqual(flow.seen.at(-1)!.body.rotate, ["model_key"]);
  assert.ok(!(flow.seen.at(-1)!.body.have as string[]).includes("FLOW_MODEL_KEY"));
  assert.match(readFileSync(join(cwd, ".env"), "utf8"), new RegExp(`^FLOW_MODEL_KEY=${TRIAL}$`, "m"));
  assert.match(readFileSync(join(cwd, ".env"), "utf8"), /^OPENROUTER_API_KEY=sk-or-mine$/m, "the owner's key is never written over");
  assert.match(readFileSync(join(cwd, ".env"), "utf8"), /^FLOW_FRAMEWORK_CLOUD_KEY=oci_old$/m, "only what was named");

  const cloud = await run(["setup", "--rotate", "cloud"], { url: flow.url, config: temp(), cwd, env });
  assert.equal(cloud.code, 0, cloud.err);
  assert.ok(!("rotate" in flow.seen.at(-1)!.body), "an older server takes this one: the name is left out of have");
  assert.ok(!(flow.seen.at(-1)!.body.have as string[]).includes("FLOW_FRAMEWORK_CLOUD_KEY"));
  assert.match(readFileSync(join(cwd, ".env"), "utf8"), new RegExp(`^FLOW_FRAMEWORK_CLOUD_KEY=${KEYS.cloud_key}$`, "m"));

  assert.equal((await run(["setup", "--rotate", "all"], { url: flow.url, config: temp(), cwd, env })).code, 0);
  assert.equal(flow.seen.at(-1)!.body.rotate, true);
  assert.equal((await run(["setup", "--rotate", "everything"], { url: flow.url, config: temp(), cwd, env })).code, 1, "an unknown name is a usage error");
});

test("setup drops Telegram's bot parameters from the other channels' try links, and shows only open channels' trial counts", async (t) => {
  const sig = "&bot=FlowSandboxBot&bs=abc123";
  const flow = await flowServer([], 200, {
    setup: {
      whatsapp_sender: "snd_wa",
      try_urls: { telegram: "https://flow.engineer/try/brave-otter-1?c=telegram" + sig, whatsapp: "https://flow.engineer/try/brave-otter-1?c=whatsapp" + sig },
      trial: { telegram: { limit: null, used: 0 }, whatsapp: { limit: 300, used: 1 }, imessage: { limit: 100, used: 0, contacts: { limit: 2, used: 1 } } },
    },
  });
  t.after(flow.close);
  const result = await run(["setup", "--json"], { url: flow.url, config: temp(), cwd: agentDir(), env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.lines[0]!.try_urls, { telegram: "https://flow.engineer/try/brave-otter-1?c=telegram" + sig, whatsapp: "https://flow.engineer/try/brave-otter-1?c=whatsapp" });
  assert.deepEqual(Object.keys(result.lines[0]!.trial), ["telegram", "whatsapp"], "iMessage is closed: its counts are not shown");
  assert.ok(!/iMessage/.test(result.err), result.err);
});

const OWN = "sk-or-v1-ownersecretK8p2";

test("status says what the folder has and lacks, never a key's value; signed in, it adds which channels are open and their trial counts, minting nothing", async (t) => {
  const flow = await flowServer([], 200, { setup: { whatsapp_sender: "snd_wa", trial: { telegram: { limit: null, used: 0 }, whatsapp: { limit: 300, used: 12 } } } });
  t.after(flow.close);
  const cwd = agentDir();
  writeFileSync(join(cwd, ".env"), `OPENROUTER_API_KEY=${OWN}\nFLOW_MESSAGING_KEY=${KEYS.messaging_key}\nFLOW_MESSAGING_TELEGRAM_SENDER=snd_tg\nFLOW_FRAMEWORK_JOIN_CODE=brave-otter-1\n`);
  const before = readFileSync(join(cwd, ".env"), "utf8");

  const out = await run(["status", "--json"], { url: flow.url, config: temp(), cwd });
  assert.equal(out.code, 0, out.err);
  assert.equal(flow.seen.length, 0, "not signed in: nothing is asked of flow.engineer");
  assert.equal(out.lines[0]!.signed_in, false);
  assert.deepEqual(out.lines[0]!.model_key, { set: true, env: "OPENROUTER_API_KEY", flow_credit: null });
  assert.deepEqual(out.lines[0]!.channels.whatsapp, { sender: false, open: null, trial: null });

  const signed = await run(["status", "--json"], { url: flow.url, config: temp(), cwd, env: { FLOW_FRAMEWORK_TOKEN: TOKEN } });
  assert.equal(signed.code, 0, signed.err);
  assert.deepEqual(signed.lines[0]!.signed_in, { email: "dev@example.com", account: "uid_1" });
  assert.deepEqual(signed.lines[0]!.channels.whatsapp, { sender: false, open: true, trial: { limit: 300, used: 12 } });
  assert.equal(signed.lines[0]!.channels.imessage.open, false);
  assert.deepEqual(signed.lines[0]!.next, ["npm start", "npx @flow-engineer/flow link --channel whatsapp"]);
  const asked = flow.seen.find((r) => r.path === "/cli/setup")!;
  for (const name of ["FLOW_FRAMEWORK_CLOUD_KEY", "FLOW_FRAMEWORK_TRACES_KEY", "FLOW_MESSAGING_KEY", "OPENROUTER_API_KEY"]) assert.ok((asked.body.have as string[]).includes(name), `${name} named as had, so nothing is made`);
  assert.equal(readFileSync(join(cwd, ".env"), "utf8"), before, "status writes nothing");
  for (const secret of [OWN, KEYS.messaging_key]) assert.ok(!signed.out.includes(secret) && !signed.err.includes(secret));

  const human = await run(["status"], { url: flow.url, config: temp(), cwd: agentDir() });
  assert.equal(human.code, 0, human.err);
  assert.ok(human.out.split("\n").includes(NO_KEY));
  assert.match(human.out, /^Next: run npx @flow-engineer\/flow setup to get Flow's free trial credit, or add your own key, then npx @flow-engineer\/flow link$/m);
});

test("status with FLOW_MODEL_KEY the active key asks Flow's GET /credit for what is left; a key Flow does not know gets --rotate model, and Flow not reachable never fails status", async (t) => {
  const flow = await flowServer([], 200, { credit: { status: 200, body: { limit_usd: 2, spent_usd: 0.13, left_usd: 1.87, default_model: "anthropic/claude-haiku-5.5", models: ["anthropic/claude-haiku-5.5"] } } });
  t.after(flow.close);
  const cwd = agentDir();
  writeFileSync(join(cwd, ".env"), `FLOW_MODEL_KEY=${TRIAL}\n`);
  const out = await run(["status", "--json"], { url: flow.url, config: temp(), cwd });
  assert.equal(out.code, 0, out.err);
  assert.deepEqual(flow.seen.map((r) => [r.method, r.path, r.auth]), [["GET", "/llm/framework/v1/credit", `Bearer ${TRIAL}`]], "only the model API, with the model key; nothing else is asked signed out");
  assert.deepEqual(out.lines[0]!.model_key, { set: true, env: "FLOW_MODEL_KEY", flow_credit: { limit_usd: 2, spent_usd: 0.13, left_usd: 1.87 } });
  assert.match(out.err, /^Model: Flow trial credit \(\$1\.87 left\)$/m);
  assert.ok(!out.out.includes(TRIAL) && !out.err.includes(TRIAL));

  // A provider key set too: it is the active one, and Flow is not asked.
  writeFileSync(join(cwd, ".env"), `OPENAI_API_KEY=${OWN}\nFLOW_MODEL_KEY=${TRIAL}\n`);
  const own = await run(["status"], { url: flow.url, config: temp(), cwd });
  assert.match(own.out, /^Model: OPENAI_API_KEY is set$/m);
  assert.equal(flow.seen.length, 1);
  writeFileSync(join(cwd, ".env"), `FLOW_MODEL_KEY=${TRIAL}\n`);

  const spent = await flowServer([], 200, { credit: { status: 200, body: { limit_usd: 2, spent_usd: 2, left_usd: 0 } } });
  t.after(spent.close);
  const used = await run(["status", "--json"], { url: spent.url, config: temp(), cwd });
  assert.equal(used.lines[0]!.model_key.message, "This account's Flow trial credit is used up.");
  assert.equal(used.lines[0]!.next[0], "add your own model key to .env");
  assert.ok(!used.lines[0]!.next.includes("npm start"));

  const revoked = await flowServer([], 200, { credit: { status: 401, body: { error: { message: "This model key is not valid.", type: "invalid_request_error", code: "invalid_api_key", next: "npx @flow-engineer/flow setup --rotate model" } } } });
  t.after(revoked.close);
  const bad = await run(["status", "--json"], { url: revoked.url, config: temp(), cwd });
  assert.equal(bad.code, 0, bad.err);
  assert.equal(bad.lines[0]!.next[0], "npx @flow-engineer/flow setup --rotate model");
  assert.match(bad.err, /^FLOW_MODEL_KEY is not a key Flow knows/m);

  revoked.close();
  const offline = await run(["status"], { url: revoked.url, config: temp(), cwd });
  assert.equal(offline.code, 0, offline.err);
  assert.match(offline.out, /^Model: Flow trial credit \(credit left unknown: Flow could not be reached\)$/m);
});
