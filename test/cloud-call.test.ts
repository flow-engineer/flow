// covers: testing/src/cloud-call.ts
// The one call every cloud command makes (testing/src/cloud-call.ts): a 429 waited out as long as
// its Retry-After (never past 30 s), an idempotent call tried once more after a 5xx or a network
// error and a POST never, a network failure that names the address and says it is one, and a refused
// key explained by which key the command reads and what it found, by prefix and last 4 only.
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { cloudCall, keyHelp, keyLabel, NetworkError } from "../testing/src/cloud-call.ts";

/** A server that answers each request with the next of `answers` (the last one again once they run out); "drop" closes the connection. */
async function server(answers: Array<{ status: number; headers?: Record<string, string>; body?: string } | "drop">) {
  const seen: string[] = [];
  const http = createServer((req, res: ServerResponse) => {
    seen.push(`${req.method} ${req.url}`);
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (answer === "drop") return void req.socket.destroy();
    res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers }).end(answer.body ?? "{}");
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, seen, close: () => { http.closeAllConnections(); http.close(); } };
}

/** A wait that records what it was asked and returns at once, and the lines said. */
function waits() {
  const waited: number[] = [];
  const said: string[] = [];
  return { waited, said, waits: { wait: async (ms: number) => void waited.push(ms), note: (line: string) => void said.push(line) } };
}

test("a 429 is waited out for its Retry-After, up to 30 s, and said; a longer one is answered as it is", async () => {
  const fake = await server([{ status: 429, headers: { "retry-after": "7" } }, { status: 429 }, { status: 200, body: '{"ok":true}' }]);
  try {
    const w = waits();
    const answer = await cloudCall(`${fake.url}/v1/agent/conversations/c1`, {}, w.waits);
    assert.deepEqual({ status: answer.status, text: answer.text }, { status: 200, text: '{"ok":true}' });
    assert.deepEqual(w.waited, [7000, 1000], "its Retry-After, else a second");
    assert.equal(w.said.length, 2);
    assert.match(w.said[0]!, /rate limiting this key \(429\): waiting 7 s/);
    const long = await server([{ status: 429, headers: { "retry-after": "600" } }]);
    try {
      const l = waits();
      const refused = await cloudCall(`${long.url}/x`, { method: "POST" }, l.waits);
      assert.deepEqual({ status: refused.status, retryAfter: refused.retryAfter, waited: l.waited, asked: long.seen.length }, { status: 429, retryAfter: 600, waited: [], asked: 1 });
    } finally { long.close(); }
  } finally { fake.close(); }
});

test("a GET is tried once more after a 5xx or a dropped connection; a POST, or a 5xx that names its wait, is not", async () => {
  const fake = await server([{ status: 502, body: "bad gateway" }, { status: 200 }]);
  const dropped = await server(["drop", { status: 200 }]);
  const post = await server([{ status: 500 }, { status: 200 }]);
  const later = await server([{ status: 503, headers: { "retry-after": "30" } }, { status: 200 }]);
  try {
    const w = waits();
    assert.equal((await cloudCall(`${fake.url}/a`, {}, w.waits)).status, 200);
    assert.equal((await cloudCall(`${dropped.url}/b`, {}, w.waits)).status, 200);
    assert.equal((await cloudCall(`${post.url}/c`, { method: "POST", body: "{}" }, w.waits)).status, 500);
    assert.equal((await cloudCall(`${later.url}/d`, {}, w.waits)).status, 503);
    assert.deepEqual([fake.seen.length, dropped.seen.length, post.seen.length, later.seen.length], [2, 2, 1, 1]);
    assert.equal(w.said.length, 2);
  } finally { for (const s of [fake, dropped, post, later]) s.close(); }
  // Nothing listens there any more: a POST says it is a network error, never tried again.
  const gone = await server([{ status: 200 }]);
  gone.close();
  const w = waits();
  await assert.rejects(cloudCall(`${gone.url}/c`, { method: "POST" }, w.waits), (error: unknown) => error instanceof NetworkError && error.code === "ECONNREFUSED" && /nothing accepts connections/.test(error.message));
  assert.deepEqual(w.said, []);
});

test("a network failure names the address tried and says it is a network error, with the cells' addresses for a name that does not resolve", async () => {
  const w = waits();
  await assert.rejects(cloudCall("https://flow-cli-test.invalid/dashboard/in/v1/hosting/logs?environment=staging", {}, w.waits), (error: unknown) => {
    assert.ok(error instanceof NetworkError);
    assert.match(error.message, /^could not reach https:\/\/flow-cli-test\.invalid\/dashboard\/in\/v1\/hosting\/logs: network error (ENOTFOUND|EAI_AGAIN)/);
    if (error.code === "ENOTFOUND") assert.match(error.message, /US https:\/\/flow\.engineer\/observe, India https:\/\/flow\.engineer\/dashboard\/in/);
    return true;
  });
  assert.equal(w.said.length, 1, "a GET is tried once more first");
});

test("a refused key says which key the command reads, where it looked, what it found by prefix and last 4, and how to get the right one", () => {
  const value = "oci_supersecretvalue1a2B";
  const lines = keyHelp("flow conversations", { kind: "flow_key", name: "FLOW_KEY", where: "/agent/.env", value }, { status: 401, code: "bad_key" });
  assert.match(lines, /^flow conversations reads with the agent's Flow key, FLOW_KEY/);
  assert.match(lines, /It found FLOW_KEY=oci_…1a2B in \/agent\/\.env\. That is a CI key; this command reads FLOW_KEY\./);
  assert.match(lines, /Get the right one: npx @flow-engineer\/flow setup/);
  assert.ok(!lines.includes(value));
  const scope = keyHelp("flow conversations", { kind: "flow_key", name: "FLOW_KEY", where: "the environment", value: "flow_test_k1_abcdefgh9z9z" }, { status: 403, code: "scope" });
  assert.match(scope, /A test key reads staging only: add --env staging\. Production reads need a flow_live_ FLOW_KEY/);
  assert.equal(keyLabel("short"), "a key of another kind");
});
