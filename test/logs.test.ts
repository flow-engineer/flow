// covers: src/events.ts
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { log, logFields } from "../src/events.ts";

/** Every console method's calls, with K_SERVICE set (as on Cloud Run) or unset for the test. */
function capture(t: TestContext, cloudRun: boolean) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  for (const method of ["debug", "info", "warn", "error"] as const) t.mock.method(console, method, (...args: unknown[]) => void calls.push({ method, args }));
  const saved = { K_SERVICE: process.env.K_SERVICE, CLOUD_RUN_JOB: process.env.CLOUD_RUN_JOB };
  delete process.env.CLOUD_RUN_JOB;
  if (cloudRun) process.env.K_SERVICE = "agent";
  else delete process.env.K_SERVICE;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  return calls;
}

const write = () => {
  log("DEBUG", "flow: typing on %s failed", "web");
  log("INFO", "flow: agent version %s", "1.2.0");
  log("WARNING", "flow: the traces endpoint refused traces (HTTP %d)", 403);
  log("ERROR", "flow: message %s was not delivered", "msg_1");
  logFields("INFO", { chinwag: "nudge", id: "n_1" });
};

// Cloud Logging read Flow's own lines as plain text, so every one was DEFAULT and no severity filter found them.
test("on Cloud Run each of Flow's lines is one JSON entry with its severity, through console's method for it", (t) => {
  const hosted = capture(t, true);
  write();
  assert.ok(hosted.every((c) => c.args.length === 1 && !String(c.args[0]).includes("\n")), "one line, one argument, each");
  assert.deepEqual(hosted.map((c) => [c.method, JSON.parse(String(c.args[0]))]), [
    ["debug", { severity: "DEBUG", message: "flow: typing on web failed" }],
    ["info", { severity: "INFO", message: "flow: agent version 1.2.0" }],
    ["warn", { severity: "WARNING", message: "flow: the traces endpoint refused traces (HTTP 403)" }],
    ["error", { severity: "ERROR", message: "flow: message msg_1 was not delivered" }],
    ["info", { severity: "INFO", chinwag: "nudge", id: "n_1" }],
  ]);
});

// The JSON is for Cloud Logging only: a developer's terminal keeps the text console printed before.
test("off Cloud Run the same lines are console's own text, as before", (t) => {
  const local = capture(t, false);
  write();
  assert.deepEqual(local.map((c) => [c.method, ...c.args]), [
    ["debug", "flow: typing on %s failed", "web"],
    ["info", "flow: agent version %s", "1.2.0"],
    ["warn", "flow: the traces endpoint refused traces (HTTP %d)", 403],
    ["error", "flow: message %s was not delivered", "msg_1"],
    ["info", '{"chinwag":"nudge","id":"n_1"}'],
  ]);
});

// A stack printed as text reached Cloud Logging as one DEFAULT entry per line of it.
test("on Cloud Run an Error's stack is inside its one entry, under the line's own words", (t) => {
  const hosted = capture(t, true);
  log("WARNING", "flow: scheduled messages:", new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  assert.equal(hosted.length, 1);
  const entry = JSON.parse(String(hosted[0]!.args[0]));
  assert.equal(entry.severity, "WARNING");
  const [first, ...rest] = String(entry.message).split("\n");
  assert.equal(first, "flow: scheduled messages: DOMException [TimeoutError]: The operation was aborted due to timeout");
  assert.ok(rest.some((l) => /^\s+at /.test(l)), entry.message);
});
