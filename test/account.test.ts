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
import { currentToken, deleteCredentials, saveCredentials } from "../testing/src/flow-login.ts";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const TOKEN = "fcli_secret_token_1234";
const KEYS = { cloud_key: "oci_cloudsecretvalue9Qz1", traces_key: "otk_test_tracesecret7Lm2", messaging_key: "fk_test_messagingsecretk4Tt" };

interface Seen { method: string; path: string; auth?: string; body: Record<string, unknown> }

/**
 * A flow.engineer that answers /cli/token from `tokenAnswers` in turn (or from the function: null
 * holds the request unanswered), and records every request.
 */
async function flowServer(tokenAnswers: Array<Record<string, unknown>> | (() => Record<string, unknown> | null) = []) {
  const seen: Seen[] = [];
  const read = (req: IncomingMessage) => new Promise<string>((done) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => done(b)); });
  const server = createServer(async (req, res) => {
    const text = await read(req);
    const body = text ? JSON.parse(text) : {};
    seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, body });
    const send = (status: number, answer: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); };
    const bearer = req.headers.authorization?.startsWith("Bearer fcli_");
    if (req.url === "/cli/device") return send(200, { device_code: "fcd_1", user_code: "BCDF-GHJK", verification_uri: `${url}/cli/approve`, verification_uri_complete: `${url}/cli/approve?code=BCDF-GHJK`, interval: 0, expires_in: 600 });
    if (req.url === "/cli/token") {
      const a = typeof tokenAnswers === "function" ? tokenAnswers() : (tokenAnswers.shift() ?? { error: "expired_token" });
      return a ? send(a.access_token ? 200 : 400, a) : undefined;
    }
    if (!bearer) return send(401, { error: "not_signed_in" });
    if (req.url === "/cli/whoami") return send(200, { email: "dev@example.com", account: "uid_1" });
    if (req.url === "/cli/revoke") return send(200, {});
    if (req.url === "/cli/setup") {
      const have = new Set(body.have as string[]);
      const names: Record<string, string> = { cloud_key: "FLOW_FRAMEWORK_CLOUD_KEY", traces_key: "FLOW_FRAMEWORK_TRACES_KEY", messaging_key: "FLOW_MESSAGING_KEY" };
      const keys = Object.fromEntries(Object.entries(KEYS).filter(([field]) => !have.has(names[field]!)));
      return send(200, { agent_id: "agt_1", ...keys, telegram_sender: "snd_tg", join_code: "brave-otter-1" });
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
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).token, TOKEN);
  assert.ok(!result.out.includes(TOKEN) && !result.err.includes(TOKEN), "the token is never printed");
});

const WAIT_NEXT = "approve in the browser, then run: npx flow login --wait";

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
  assert.match(timedOut.err, /Not approved yet after 0 s.*Next: npx flow login --wait/);
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

test("--wait on an expired pending code says so and starts a new sign-in", async (t) => {
  const flow = await flowServer([{ access_token: TOKEN }]);
  t.after(flow.close);
  const config = temp();
  mkdirSync(join(config, "flow-framework"));
  writeFileSync(join(config, "flow-framework", "pending.json"), JSON.stringify({ device_code: "fcd_old", user_code: "OLDC-ODEX", verification_uri: `${flow.url}/cli/approve`, interval: 0, expires_in: 600, expires_at: Date.now() - 1000, url: flow.url }));
  const result = await run(["login", "--wait", "--no-browser", "--json"], { url: flow.url, config, cwd: temp() });
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /pending sign-in code has expired; starting a new sign-in/);
  assert.deepEqual({ code: result.lines[0]!.user_code, resumed: result.lines[0]!.resumed }, { code: "BCDF-GHJK", resumed: false });
  assert.deepEqual(flow.seen.filter((r) => r.path === "/cli/token").map((r) => r.body.device_code), ["fcd_1"]);
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
    assert.equal(result.lines.at(-1)!.error.next, "npx flow login");
    assert.ok(!existsSync(join(config, "flow-framework", "credentials.json")));
  }
});

test("whoami uses FLOW_FRAMEWORK_TOKEN over the file, and without either says to log in", async (t) => {
  const flow = await flowServer();
  t.after(flow.close);
  const config = temp();
  const none = await run(["whoami", "--json"], { url: flow.url, config, cwd: temp() });
  assert.equal(none.code, 1);
  assert.deepEqual(none.lines[0], { error: { code: "not_signed_in", message: "Not signed in to flow.engineer.", next: "npx flow login" } });
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
  assert.deepEqual(flow.seen.at(-1)!.body, { name: "cafe", hostname: flow.seen.at(-1)!.body.hostname, channels: ["telegram"], have: ["FLOW_MESSAGING_TELEGRAM_SENDER"] });
  const dotenv = readFileSync(join(cwd, ".env"), "utf8");
  assert.equal(dotenv, `OPENROUTER_API_KEY=sk-mine\nFLOW_MESSAGING_TELEGRAM_SENDER=snd_mine\nFLOW_FRAMEWORK_CLOUD_KEY=${KEYS.cloud_key}\nFLOW_FRAMEWORK_TRACES_KEY=${KEYS.traces_key}\nFLOW_MESSAGING_KEY=${KEYS.messaging_key}\nFLOW_FRAMEWORK_JOIN_CODE=brave-otter-1\n`);
  assert.deepEqual(first.lines[0]!.env_written[".env"], [
    { name: "FLOW_FRAMEWORK_CLOUD_KEY", action: "added", value: "oci_…9Qz1" },
    { name: "FLOW_FRAMEWORK_TRACES_KEY", action: "added", value: "otk_test_…7Lm2" },
    { name: "FLOW_MESSAGING_KEY", action: "added", value: "fk_test_…k4Tt" },
    { name: "FLOW_MESSAGING_TELEGRAM_SENDER", action: "kept", value: "snd_mine" },
    { name: "FLOW_FRAMEWORK_JOIN_CODE", action: "added", value: "brave-otter-1" },
  ]);
  for (const key of Object.values(KEYS)) assert.ok(!first.out.includes(key) && !first.err.includes(key), "no key is printed");

  const second = await run(["setup", "--json"], { url: flow.url, config, cwd, env });
  assert.equal(second.code, 0, second.err);
  assert.equal((flow.seen.at(-1)!.body.have as string[]).length, 5, "every name already in .env is said, so no new key is made");
  assert.deepEqual(second.lines[0]!.env_written[".env"].map((w: { action: string }) => w.action), ["kept", "unchanged"]);
  assert.equal(readFileSync(join(cwd, ".env"), "utf8"), dotenv);

  const replaced = await run(["setup", "--replace"], { url: flow.url, config, cwd, env });
  assert.equal(replaced.code, 0, replaced.err);
  assert.match(readFileSync(join(cwd, ".env"), "utf8"), /^FLOW_MESSAGING_TELEGRAM_SENDER=snd_tg$/m);
});

test("link prints the Telegram try link for the join code in .env, and without one says to run setup", async (t) => {
  const flow = await flowServer();
  t.after(flow.close);
  const cwd = temp();
  const missing = await run(["link", "--json"], { url: flow.url, config: temp(), cwd });
  assert.equal(missing.code, 1);
  assert.equal(missing.lines[0]!.error.next, "npx flow setup");
  writeFileSync(join(cwd, ".env"), "FLOW_FRAMEWORK_JOIN_CODE=brave-otter-1\n");
  const result = await run(["link", "--json"], { url: flow.url, config: temp(), cwd });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.lines[0]!.url, `${flow.url}/try/brave-otter-1?c=telegram`);
});

test("a sign-in under ~/.config/chinwag is read and deleted while ~/.config/flow-framework has none; a new one goes to flow-framework", () => {
  const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "flow-config-")) };
  mkdirSync(join(env.XDG_CONFIG_HOME, "chinwag"));
  writeFileSync(join(env.XDG_CONFIG_HOME, "chinwag", "credentials.json"), JSON.stringify({ token: "fcli_old", url: "https://flow.engineer" }));
  assert.deepEqual(currentToken(env), { token: "fcli_old", from: "file" });
  assert.equal(saveCredentials({ token: "fcli_new", url: "https://flow.engineer" }, env), join(env.XDG_CONFIG_HOME, "flow-framework", "credentials.json"));
  assert.deepEqual(currentToken(env), { token: "fcli_new", from: "file" });
  assert.equal(deleteCredentials(env), true);
  assert.deepEqual(currentToken(env), { token: "fcli_old", from: "file" });
  assert.equal(deleteCredentials(env), true);
  assert.equal(currentToken(env), undefined);
});
