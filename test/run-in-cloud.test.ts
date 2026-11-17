// covers: testing/src/run-in-cloud.ts testing/src/cli.ts testing/src/deploy.ts
// `flow test --run-in-cloud`, attach and stop (testing/src/run-in-cloud.ts) against a fake cloud in
// this process: what the manifest holds, that only the missing files go up, the run id printed and kept
// before anything is sent, the output followed and the exit status the run's, Ctrl-C leaving the run
// going and a terminated CI job stopping it, attach and stop, and the limits' messages. The fake cloud's
// runs move only when a test says so (gates), never on a timer.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import { cloudApi } from "../testing/src/deploy.ts";
import { buildManifest, cloudArgs, runCli, runDetached, type Hooks, type ManifestFile } from "../testing/src/run-in-cloud.ts";

const KEY = { kind: "ci_key" as const, name: "FLOW_FRAMEWORK_CLOUD_KEY", where: "the environment", value: "oci_cikeysecretvalue7Qw2" };
const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const folders: string[] = [];
const closers: Array<() => void> = [];
after(() => closers.forEach((close) => close()));

/** An agent's folder with a few files, including ones that never go. */
function agentFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-run-cloud-"));
  folders.push(dir);
  const put = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  put("package.json", '{"name":"cafe"}\n');
  put("src/agent.ts", "export const a = 1;\n");
  put("tests/scenarios/one.yaml", "id: one\n");
  put("tests/.env.test", "MENU_URL=https://example.com\n");
  put(".env", "OPENROUTER_API_KEY=secret\n");
  put(".env.local", "X=1\n");
  put("src/.env.production", "Y=2\n");
  put("node_modules/dep/index.js", "x\n");
  put("src/node_modules/inner/index.js", "x\n");
  put(".git/HEAD", "ref\n");
  put(".flow/last-session.json", "{}\n");
  put(".DS_Store", "x");
  return dir;
}

type Status = "uploading" | "building" | "running" | "finished" | "stopped" | "failed";
interface Chunk { i: number; stream: "out" | "err"; text: string }

/** A fake cloud: test-runs routes, signed uploads to itself, and a run that moves when the test says. */
async function cloud(options: { refuse?: { status: number; code: string; message: string; retryAfter?: number }; page?: number } = {}) {
  const blobs = new Map<string, Buffer>();
  const puts: Array<{ sha: string; bytes: Buffer; recordedFirst: boolean }> = [];
  const calls: string[] = [];
  const gets: number[] = [];
  const state = { status: "running" as Status, exit_code: null as number | null, error: null as string | null, report: null as Record<string, unknown> | null, chunks: [] as Chunk[], created: null as Record<string, unknown> | null, id: "trn_01TEST", dir: "", brokenGets: 0, startConflict: 0 };
  let wake: (() => void) | undefined;
  const changed = () => { const w = wake; wake = undefined; w?.(); };
  const run = () => ({ id: state.id, status: state.status, exit_code: state.exit_code, error: state.error });
  let base = "";
  const http = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => void res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
    const body: Buffer[] = [];
    req.on("data", (c) => body.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(body);
      calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname.startsWith("/blob/")) {
        const sha = url.pathname.slice(6);
        puts.push({ sha, bytes: raw, recordedFirst: existsSync(join(state.dir, `.flow/runs/${state.id}.json`)) });
        blobs.set(sha, raw);
        return void res.writeHead(200).end();
      }
      if (req.method === "POST" && url.pathname === "/v1/hosting/test-runs") {
        if (options.refuse) return json(options.refuse.status, { error: { code: options.refuse.code, message: options.refuse.message } }, options.refuse.retryAfter ? { "retry-after": String(options.refuse.retryAfter) } : {});
        const sent = JSON.parse(raw.toString()) as { files: ManifestFile[] };
        state.created = sent as unknown as Record<string, unknown>;
        const missing = [...new Set(sent.files.map((f) => f.sha256))].filter((h) => !blobs.has(h));
        return json(201, { run: run(), missing, uploads: Object.fromEntries(missing.map((h) => [h, `${base}/blob/${h}`])), limits: { runner_hours_left: 11, max_bundle_bytes: 50 * 1024 * 1024 } });
      }
      const m = /^\/v1\/hosting\/test-runs\/([^/]+)(\/start|\/stop)?$/.exec(url.pathname);
      if (!m || m[1] !== state.id) return json(404, { error: { code: "not_found", message: "No such run." } });
      if (m[2] === "/start") {
        if (state.startConflict-- > 0) { blobs.clear(); return json(409, { error: { code: "not_uploaded", message: "A file did not arrive." }, missing: ["x"], uploads: Object.fromEntries([...(state.created!.files as ManifestFile[])].map((f) => [f.sha256, `${base}/blob/${f.sha256}`])) }); }
        return json(202, { run: run() });
      }
      if (m[2] === "/stop") { if (state.status === "running") state.status = "stopped"; state.error = "stopped by you"; changed(); return json(200, { run: run() }); }
      // A look: answers at once with what is past `after`, else holds until the test moves the run.
      const after = Number(url.searchParams.get("after") ?? 0);
      gets.push(after);
      if (state.brokenGets > 0) { state.brokenGets--; return void req.socket.destroy(); }
      const answer = () => {
        const chunks = state.chunks.filter((c) => c.i >= after).slice(0, options.page ?? 500);
        const next = chunks.length ? chunks[chunks.length - 1]!.i + 1 : after;
        const terminal = state.status === "finished" || state.status === "stopped" || state.status === "failed";
        json(200, { run: run(), chunks, next, report: terminal ? state.report : null });
      };
      const pending = state.chunks.some((c) => c.i >= after) || state.status !== "running";
      if (pending) return answer();
      wake = answer;
    });
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  closers.push(() => { http.closeAllConnections(); http.close(); });
  return {
    url: base, state, puts, calls, gets, blobs,
    say(stream: "out" | "err", text: string) { state.chunks.push({ i: state.chunks.length, stream, text }); changed(); },
    end(status: Status, exit_code: number | null, extra: { error?: string; report?: Record<string, unknown> } = {}) { state.status = status; state.exit_code = exit_code; state.error = extra.error ?? null; state.report = extra.report ?? null; changed(); },
    api: cloudApi(base, KEY, { wait: async () => {}, note: () => {} }),
  };
}

/** Captured output, fake signals and no waiting. */
function harness(tty = false) {
  const streams = { out: "", err: "" };
  const signals = new EventEmitter();
  const waits: number[] = [];
  const hooks: Hooks = { io: { out: (t) => void (streams.out += t), err: (t) => void (streams.err += t) }, signals, tty, wait: async (ms) => void waits.push(ms), waits: { wait: async () => {}, note: () => {} } };
  return { streams, signals, hooks, waits };
}

const options = (c: Awaited<ReturnType<typeof cloud>>, dir: string, extra: Partial<Parameters<typeof runDetached>[0]> = {}) => ({ dir, cloud: c.url, api: c.api, args: ["--no-customer-data"], json: false, follow: true, ...extra });

test("the manifest lists the files that go: no dependencies, git, .flow or .env files, but tests/.env.test", () => {
  const dir = agentFolder();
  const manifest = buildManifest(dir);
  assert.deepEqual(manifest.map((f) => f.path), ["package.json", "src/agent.ts", "tests/.env.test", "tests/scenarios/one.yaml"]);
  const agent = manifest.find((f) => f.path === "src/agent.ts")!;
  assert.equal(agent.size, 20);
  assert.match(agent.sha256, /^[0-9a-f]{64}$/);
});

test("the India cell has no runners yet: one sentence, before anything is packed or sent", async () => {
  const c = await cloud();
  const dir = agentFolder();
  const h = harness();
  assert.equal(await runDetached(options(c, dir, { cloud: "https://flow.engineer/dashboard/in/" }), h.hooks), 1);
  assert.match(h.streams.err + h.streams.out, /not available in your region yet; it is coming\. Run flow test without --run-in-cloud/);
  assert.equal(c.puts.length, 0);
  assert.equal(c.state.created, null, "nothing was asked of the cloud");
});

test("the run id is printed first and kept before any upload, and only the files the cloud lacks go up", async () => {
  const c = await cloud();
  const dir = agentFolder();
  c.state.dir = dir;
  const h = harness();
  c.end("finished", 0);
  assert.equal(await runDetached(options(c, dir), h.hooks), 0);
  assert.match(h.streams.out.split("\n")[0]!, /^Run trn_01TEST$/);
  assert.match(h.streams.out, /Packing 4 files \(.* KB\): sending only 4 files \(/);
  assert.equal((c.state.created as { agent_name?: string }).agent_name, "cafe", "the package name is sent as the agent's name");
  assert.equal(c.puts.length, 4);
  assert.ok(c.puts.every((p) => p.recordedFirst), "the run was recorded in .flow/runs before the first file was sent");
  assert.equal(readFileSync(join(dir, ".flow/runs/last"), "utf8").trim(), "trn_01TEST");
  assert.equal(JSON.parse(readFileSync(join(dir, ".flow/runs/trn_01TEST.json"), "utf8")).id, "trn_01TEST");
  // The same folder with one line changed: one file, exactly its bytes.
  c.puts.length = 0;
  writeFileSync(join(dir, "src/agent.ts"), "export const a = 2;\n");
  c.state.status = "running";
  c.end("finished", 0);
  const again = harness();
  await runDetached(options(c, dir), again.hooks);
  assert.deepEqual(c.puts.map((p) => p.bytes.toString()), ["export const a = 2;\n"]);
  assert.match(again.streams.out, /sending only 1 file \(1 KB\)/);
  // And an unchanged folder sends nothing.
  c.puts.length = 0;
  c.state.status = "running";
  c.end("finished", 0);
  const none = harness();
  await runDetached(options(c, dir), none.hooks);
  assert.equal(c.puts.length, 0);
  assert.match(none.streams.out, /sending nothing/);
});

test("the output is followed: out to stdout, err to stderr, the report becomes last-session.json, the exit status is the run's", async () => {
  const c = await cloud();
  const dir = agentFolder();
  c.state.dir = dir;
  const h = harness();
  const done = runDetached(options(c, dir), h.hooks);
  // The run says nothing yet; the follow is holding a look until a chunk or the end comes.
  c.say("out", "scenario one: passed\n");
  c.say("err", "a warning\n");
  c.end("finished", 1, { report: { sessionId: "ses_1", runs: [] } });
  assert.equal(await done, 1);
  assert.match(h.streams.out, /scenario one: passed\n$/);
  assert.match(h.streams.err, /a warning\n$/);
  assert.equal(JSON.parse(readFileSync(join(dir, ".flow/last-session.json"), "utf8")).sessionId, "ses_1");
  assert.match(h.streams.out, /Started; following it\. Ctrl-C leaves it running: flow test attach trn_01TEST follows it, flow test stop trn_01TEST ends it\./);
});

test("--json: stdout is only the runner's output, the id and every other line go to stderr", async () => {
  const c = await cloud();
  const dir = agentFolder();
  c.state.dir = dir;
  const h = harness();
  c.say("out", '{"version":1,"outcome":"passed"}\n');
  c.end("finished", 0);
  assert.equal(await runDetached(options(c, dir, { json: true }), h.hooks), 0);
  assert.equal(h.streams.out, '{"version":1,"outcome":"passed"}\n');
  assert.match(h.streams.err, /^Run trn_01TEST\n/);
});

test("a run Flow could not run exits 1 with the reason, as one JSON failure with --json", async () => {
  const c = await cloud();
  const dir = agentFolder();
  c.state.dir = dir;
  c.end("failed", null, { error: "The build failed: npm ci found no lockfile" });
  const h = harness();
  assert.equal(await runDetached(options(c, dir), h.hooks), 1);
  assert.match(h.streams.err, /Run trn_01TEST failed: The build failed: npm ci found no lockfile\./);
  const j = harness();
  assert.equal(await runDetached(options(c, dir, { json: true }), j.hooks), 1);
  const doc = JSON.parse(j.streams.out);
  assert.equal(doc.ok, false);
  assert.equal(doc.error.code, "run_failed");
});

test("--no-follow returns once the run has started, without a single look at it", async () => {
  const c = await cloud();
  const dir = agentFolder();
  c.state.dir = dir;
  const h = harness();
  assert.equal(await runDetached(options(c, dir, { follow: false }), h.hooks), 0);
  assert.ok(c.calls.some((x) => x.endsWith("/start")));
  assert.ok(!c.calls.some((x) => x.startsWith("GET")));
  assert.match(h.streams.out, /Started\. flow test attach trn_01TEST follows it/);
  const j = harness();
  await runDetached(options(c, dir, { follow: false, json: true }), j.hooks);
  assert.deepEqual(JSON.parse(j.streams.out), { ok: true, run: { id: "trn_01TEST", status: "running" }, next: "flow test attach trn_01TEST" });
});

test("a blob the cloud says is missing at start is sent once more", async () => {
  const c = await cloud();
  const dir = agentFolder();
  c.state.dir = dir;
  c.state.startConflict = 1;
  c.end("finished", 0);
  const h = harness();
  assert.equal(await runDetached(options(c, dir), h.hooks), 0);
  assert.equal(c.puts.length, 8);
});

test("Ctrl-C stops following only: the run keeps going, and the two commands are printed (exit 130)", async () => {
  const c = await cloud();
  const dir = agentFolder();
  c.state.dir = dir;
  const h = harness(true);
  const done = runDetached(options(c, dir), h.hooks);
  c.say("out", "first\n");
  while (!h.streams.out.includes("first")) await new Promise((r) => setImmediate(r));
  h.signals.emit("SIGINT");
  assert.equal(await done, 130);
  assert.match(h.streams.err, /flow test attach trn_01TEST/);
  assert.match(h.streams.err, /flow test stop trn_01TEST/);
  assert.ok(!c.calls.some((x) => x.endsWith("/stop")), "the run was not stopped");
  assert.equal(c.state.status, "running");
});

test("a terminated process with no terminal stops the run; with a terminal it only stops following", async () => {
  for (const tty of [false, true]) {
    const c = await cloud();
    const dir = agentFolder();
    c.state.dir = dir;
    const h = harness(tty);
    const done = runDetached(options(c, dir), h.hooks);
    c.say("out", "first\n");
    while (!h.streams.out.includes("first")) await new Promise((r) => setImmediate(r));
    h.signals.emit("SIGTERM");
    assert.equal(await done, 143);
    assert.equal(c.calls.some((x) => x.endsWith("/stop")), !tty);
    assert.match(h.streams.err, tty ? /flow test attach/ : /run trn_01TEST was stopped/);
  }
});

test("attach with no id follows the folder's last run from the start and exits with its status", async () => {
  const c = await cloud({ page: 2 });
  const dir = agentFolder();
  c.state.dir = dir;
  c.end("finished", 3, { report: { sessionId: "ses_9" } });
  for (const [i, t] of ["a\n", "b\n", "c\n", "d\n", "e\n"].entries()) c.state.chunks.push({ i, stream: "out", text: t });
  const first = harness();
  await runDetached(options(c, dir, { follow: false }), first.hooks);
  c.gets.length = 0;
  const h = harness();
  assert.equal(await runCli("attach", [], { FLOW_FRAMEWORK_CLOUD: c.url, FLOW_FRAMEWORK_CLOUD_KEY: KEY.value }, h.hooks, dir), 3);
  assert.equal(h.streams.out, "a\nb\nc\nd\ne\n");
  assert.deepEqual(c.gets, [0, 2, 4, 5], "each look asks for the chunk the last answer said was next");
  assert.equal(JSON.parse(readFileSync(join(dir, ".flow/last-session.json"), "utf8")).sessionId, "ses_9");
});

test("attach with an id, and a run the cloud does not know says so", async () => {
  const c = await cloud();
  const dir = agentFolder();
  c.end("finished", 0);
  c.state.chunks.push({ i: 0, stream: "out", text: "all done\n" });
  const env = { FLOW_FRAMEWORK_CLOUD: c.url, FLOW_FRAMEWORK_CLOUD_KEY: KEY.value };
  const h = harness();
  assert.equal(await runCli("attach", ["trn_01TEST"], env, h.hooks, dir), 0);
  assert.equal(h.streams.out, "all done\n");
  const gone = harness();
  assert.equal(await runCli("attach", ["trn_gone"], env, gone.hooks, dir), 1);
  assert.match(gone.streams.err, /no run trn_gone/);
  const none = harness();
  assert.equal(await runCli("attach", [], env, none.hooks, dir), 1);
  assert.match(none.streams.err, /No run to attach: \.flow\/runs holds none/);
});

test("stop ends the run and says so in one line", async () => {
  const c = await cloud();
  const dir = agentFolder();
  c.state.dir = dir;
  const env = { FLOW_FRAMEWORK_CLOUD: c.url, FLOW_FRAMEWORK_CLOUD_KEY: KEY.value };
  const start = harness();
  await runDetached(options(c, dir, { follow: false }), start.hooks);
  const h = harness();
  assert.equal(await runCli("stop", [], env, h.hooks, dir), 0);
  assert.equal(h.streams.out, "Stopped run trn_01TEST.\n");
  assert.equal(c.state.status, "stopped");
});

test("a lost connection while following is retried with a backoff, and the output carries on", async () => {
  const c = await cloud();
  const dir = agentFolder();
  c.state.dir = dir;
  c.state.brokenGets = 4; // cloudCall tries each look twice, so two looks fail whole
  c.say("out", "still here\n");
  c.end("finished", 0);
  const h = harness();
  assert.equal(await runDetached(options(c, dir), h.hooks), 0);
  assert.match(h.streams.err, /Lost the connection to Flow's cloud; the run goes on there/);
  assert.deepEqual(h.waits, [1000, 2000]);
  assert.match(h.streams.out, /still here/);
});

test("a bundle over the cap and the runner-hours limit print the cloud's message and exit with the right status", async () => {
  const big = await cloud({ refuse: { status: 413, code: "bundle_too_large", message: "The folder is 61 MB, over the 50 MB cap. Leave large files out, or ask Flow support to raise it." } });
  const h = harness();
  assert.equal(await runDetached(options(big, agentFolder()), h.hooks), 1);
  assert.match(h.streams.err, /over the 50 MB cap\. Leave large files out, or ask Flow support to raise it\./);
  assert.ok(!big.calls.some((x) => x.startsWith("PUT")));
  const hours = await cloud({ refuse: { status: 429, code: "runner_hours", message: "This workspace has used its 12 runner-hours today. Ask Flow support to raise it.", retryAfter: 3600 } });
  const j = harness();
  assert.equal(await runDetached(options(hours, agentFolder(), { json: true }), j.hooks), 3);
  assert.match(j.streams.err, /12 runner-hours today\. Ask Flow support to raise it\./);
  assert.equal(JSON.parse(j.streams.out).error.code, "runner_hours");
});

test("cloudArgs repeats the flags that shape the run, and sends --failed and --changed as --only", () => {
  assert.deepEqual(cloudArgs({ runs: "3", quick: true, json: true, "fail-on-flaky": false, concurrency: "4", ref: "main" }, new Set(["a", "b"]), "95"), ["--no-customer-data", "--runs", "3", "--only", "a,b", "--quick", "--json", "--concurrency", "4", "--min-pass", "95", "--ref", "main"]);
  assert.deepEqual(cloudArgs({ runs: "1" }, undefined, undefined), ["--no-customer-data"]);
});

/** The flow command in dir; its exit and both streams. */
async function flow(args: string[], dir: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise<number | null>((done) => child.on("close", done));
  return { code, stdout, stderr };
}

test("--run-in-cloud is refused with --agent-url, --no-follow without it, and attach with no run says so", async () => {
  const dir = agentFolder();
  const env = { FLOW_FRAMEWORK_CLOUD_KEY: KEY.value };
  const both = await flow(["test", "--run-in-cloud", "--agent-url", "http://localhost:3000/flow", "--no-customer-data"], dir, env);
  assert.equal(both.code, 1);
  assert.match(both.stderr, /--run-in-cloud runs your agent on Flow's cloud, which cannot reach an agent you serve yourself/);
  const lone = await flow(["test", "--no-follow", "--no-customer-data"], dir, env);
  assert.equal(lone.code, 1);
  assert.match(lone.stderr, /--no-follow goes with --run-in-cloud/);
  const none = await flow(["test", "attach"], dir, env);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /No run to attach/);
  const help = await flow(["test", "--help"], dir);
  assert.match(help.stdout, /flow test attach \[<run-id>\]/);
  assert.match(help.stdout, /ask Flow support to raise it/);
});
