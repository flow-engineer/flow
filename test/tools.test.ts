// covers: src/conversation.ts src/tools.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { tool } from "../src/index.ts";
import { WEB, WEB_APP, WHATSAPP, call, gate, harness, last, multi, respond, say, users } from "./helpers.ts";

// Existing chat tests have no MCP deferral flags and cannot catch an accidental cross-surface filter.
test("MCP-deferred tools stay directly available to WhatsApp agents", async () => {
  let ran = false;
  const lookup = tool({ name: "lookup", description: "Look up a record.", input: z.object({}), signIn: "none", mcp: { deferred: true }, run: () => { ran = true; return "found"; } });
  const h = multi({ channels: { whatsapp: { info: WHATSAPP } }, tools: [lookup] });
  const taken = await h.message("whatsapp", "+15555550101", "find my record");
  const first = await h.nextCall(0);
  assert.ok(first.request.tools.some(t => t.name === "lookup"));
  assert.ok(!first.request.tools.some(t => t.name === "search_tools" || t.name === "execute_tool"));
  first.answer(respond(call("send_whatsapp", { text: "Checking." }), call("lookup")));
  (await h.nextCall(1)).answer(respond(call("send_whatsapp", { text: "Found it." })));
  await h.agent.conversation(taken!.conversationId)!.whenIdle();
  assert.equal(ran, true);
});

// Other tool tests have no chat auth adapter; MCP tests do not run the chat execution path.
test("chat refuses protected tools and sends one real login message for parallel calls", async () => {
  let executions = 0, challenges = 0;
  const secret = tool({ name: "private_data", description: "Private data.", signIn: "required", input: z.object({}), run: () => ++executions });
  const h = multi({ channels: { web: { info: { ...WEB_APP, linkButton: { labelMax: 20 } } } }, tools: [secret], auth: { signIn: (ctx) => {
    assert.equal(ctx.key, null); assert.equal(ctx.address, "visitor-1"); challenges++;
    return { message: "Please sign in to see your account.", url: "https://brand.example/login" };
  } } });
  const taken = await h.message("web", "visitor-1", "show my account");
  const first = await h.nextCall(0);
  assert.match(first.request.tools.find((t) => t.name === "private_data")!.description, /Requires sign-in/);
  first.answer(respond(call("send_web", { text: "Let me check." }), call("private_data"), call("private_data")));
  await h.agent.conversation(taken!.conversationId)!.whenIdle();
  assert.equal(executions, 0); assert.equal(challenges, 1); assert.equal(h.calls.length, 1);
  const prompt = h.out.find((o) => o.outbound.type === "message" && o.outbound.link);
  assert.deepEqual(prompt?.outbound, { type: "message", authentication: true, text: "Please sign in to see your account.", link: { label: "Sign in", url: "https://brand.example/login" } });
  const transcript = await h.agent.transcript(taken!.conversationId);
  assert.ok(transcript.some((t) => t.kind === "out" && t.text === "Please sign in to see your account."));
});

// Existing deadline tests cover backend work, not an auth check that outlasts a tool deadline.
test("authentication cannot detach or execute a protected operation while verification is pending", async () => {
  const entered = gate<void>(), verified = gate<boolean>();
  let ran = false;
  const secret = tool({ name: "secret", description: "Private.", deadlineMs: 0, input: z.object({}), run: () => { ran = true; } });
  const h = multi({ channels: { web: { info: WEB_APP } }, resolve: () => "account-1", tools: [secret], auth: {
    verify: () => { entered.open(); return verified.promise; }, signIn: () => ({ message: "Please sign in again." }),
  } });
  const taken = await h.message("web", "visitor-1", "my data");
  (await h.nextCall(0)).answer(respond(call("send_web", { text: "Checking." }), call("secret")));
  await entered.promise;
  assert.equal(ran, false);
  assert.equal(h.events.some(e => e.type === "tool.detached"), false);
  verified.open(false);
  await h.agent.conversation(taken!.conversationId)!.whenIdle();
  assert.equal(ran, false);
  assert.equal(h.events.some(e => e.type === "tool.detached"), false);
  assert.ok(h.out.some(o => o.outbound.type === "message" && o.outbound.authentication));
});

test("public and optional chat tools run signed out, with no login challenge", async () => {
  const seen: Array<string | null> = [];
  const tools = (["none", "optional"] as const).map((signIn) => tool({ name: signIn, description: signIn, signIn, input: z.object({}), run: (_i, ctx) => { seen.push(ctx.key); return "public result"; } }));
  const h = multi({ channels: { web: { info: WEB_APP } }, tools, auth: { signIn: () => { throw new Error("Must not ask for login"); } } });
  const taken = await h.message("web", "visitor-1", "hello");
  (await h.nextCall(0)).answer(respond(call("send_web", { text: "Hello." }), call("none"), call("optional")));
  (await h.nextCall(1)).answer(respond(call("send_web", { text: "Public result." })));
  await h.agent.conversation(taken!.conversationId)!.whenIdle();
  assert.deepEqual(seen, [null, null]);
  assert.equal(h.events.filter((e) => e.type === "auth.required").length, 0);
});

test("verified-phone accounts run protected chat tools directly; revoked optional access loses credentials", async () => {
  let active = true;
  const keys: Array<string | null> = [];
  const required = tool({ name: "required", description: "Private.", input: z.object({}), run: (_i, ctx) => { keys.push(ctx.key); return "private result"; } });
  const optional = tool({ name: "optional", description: "Optional.", signIn: "optional", input: z.object({}), run: async (_i, ctx) => { keys.push(ctx.key); return ctx.credentials!.get("account"); } });
  const h = multi({ channels: { whatsapp: { info: WHATSAPP, phone: true } }, resolve: () => "account-1", tools: [required, optional],
    credentials: (_name, ctx) => ctx.key ? "private credential" : "public access", auth: { verify: () => active, signIn: () => ({ message: "Sign in again." }) } });
  const taken = await h.message("whatsapp", "+15555550101", "my account");
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Checking." }), call("required")));
  (await h.nextCall(1)).answer(respond(call("send_whatsapp", { text: "Done." })));
  await h.agent.conversation(taken!.conversationId)!.whenIdle();
  assert.deepEqual(keys, ["account-1"]);
  active = false;
  await h.message("whatsapp", "+15555550101", "try optional");
  (await h.nextCall(2)).answer(respond(call("send_whatsapp", { text: "Checking." }), call("optional")));
  const result = await h.nextCall(3);
  assert.ok(JSON.stringify(result.request.messages).includes("public access"));
  assert.ok(!JSON.stringify(result.request.messages).includes("private credential"));
  result.answer(respond(call("send_whatsapp", { text: "Public only." })));
  await h.agent.conversation(taken!.conversationId)!.whenIdle();
  assert.deepEqual(keys, ["account-1", null]);
});

test("tools in one response run together, and messages go out while they run", async () => {
  const a = gate<string>();
  const b = gate<string>();
  const started: string[] = [];
  const toolA = tool({ name: "a", description: "", input: z.object({}), deadlineMs: 60_000, run: () => (started.push("a"), a.promise) });
  const toolB = tool({ name: "b", description: "", input: z.object({}), deadlineMs: 60_000, run: () => (started.push("b"), b.promise) });
  const h = harness([toolA, toolB]);
  h.send("c5", "do both");
  (await h.nextCall(0)).answer(respond(say("On it."), call("a"), call("b")));
  while (started.length < 2) await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.sent(), ["On it."], "the message is out before the tools finish");
  a.open("A done");
  b.open("B done");
  const second = await h.nextCall(1);
  const results = second.request.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
  assert.deepEqual(results, [JSON.stringify({ delivered: true, channel: "chat" }), "A done", "B done"]);
  second.answer(respond(say("Both done.")));
  await h.agent.conversation("c5")!.whenIdle();
});

test("with nothing new from them, the reply waits for its tool and gets the result itself", async () => {
  const done = gate<string>();
  const book = tool({ name: "book", description: "", input: z.object({}), run: () => done.promise });
  const h = harness([book], 60_000);
  h.send("c4", "move my session to Friday");
  (await h.nextCall(0)).answer(respond(say("Booking Friday."), call("book")));
  while (!h.events.some((e) => e.type === "tool.start")) await new Promise((r) => setImmediate(r));
  done.open("booked Friday 2pm");
  const second = await h.nextCall(1);
  assert.equal(last(second.request.messages).content, "booked Friday 2pm");
  second.answer(respond(say("Done: Friday at 2pm.")));
  await h.agent.conversation("c4")!.whenIdle();
  assert.ok(!h.events.some((e) => e.type === "tool.detached"), "nothing went to the background");
  assert.deepEqual(h.sent(), ["Booking Friday.", "Done: Friday at 2pm."]);
});

test("a tool still running a while after another finished: the finished result goes back now", async () => {
  const slow = gate<string>();
  const plan = tool({ name: "get_plan", description: "", input: z.object({}), deadlineMs: 60_000, run: () => "DASH plan" });
  const labs = tool({ name: "get_labs", description: "", input: z.object({}), deadlineMs: 60_000, run: () => slow.promise });
  const h = harness([plan, labs]);
  h.send("c3", "my plan and my labs");
  (await h.nextCall(0)).answer(respond(say("Getting both."), call("get_plan"), call("get_labs")));
  const second = await h.nextCall(1);
  const results = second.request.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
  assert.equal(results[1], "DASH plan");
  assert.match(results[2], /get_labs started and is still running in the background \(task_1\).*The other results are in: tell them this now only if it answers what they asked; the rest is coming\./);
  second.answer(respond(say("Your plan: DASH. Labs are coming.")));
  slow.open("A1c 6.1");
  (await h.nextCall(2)).answer(respond(say("Your A1c is 6.1.")));
  await h.agent.conversation("c3")!.whenIdle();
  assert.ok(h.events.some((e) => e.type === "tool.detached" && e.why === "partial"));
});

test("a tool past its own limit moves to the background and its result comes back into the chat", async () => {
  const done = gate<string>();
  const book = tool({ name: "book", description: "", input: z.object({}), run: () => done.promise });
  const h = harness([book], 10);
  h.send("c6", "move my session to Friday");

  (await h.nextCall(0)).answer(respond(say("Booking Friday."), call("book")));
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /still running in the background \(task_1\)\. Do not call book again/);
  second.answer(respond());

  assert.equal(h.agent.status().backgroundTasks, 1);
  assert.equal(h.agent.status().busy, true);
  done.open("booked Friday 2pm");

  const third = await h.nextCall(2);
  assert.match(users(third.request.messages).at(-1)!, /Background result: book .* booked Friday 2pm/);
  third.answer(respond(say("Done: Friday at 2pm.")));

  await h.agent.conversation("c6")!.whenIdle();
  assert.deepEqual(h.sent(), ["Booking Friday.", "Done: Friday at 2pm."]);
  assert.equal(h.agent.status().busy, false);
});

test("a background result the agent answers in plain text is sent back once, with its send tool named", async () => {
  const done = gate<string>();
  const book = tool({ name: "book", description: "", input: z.object({}), run: () => done.promise });
  const h = harness([book], 10);
  h.send("c7", "move my session to Friday");
  (await h.nextCall(0)).answer(respond(say("Booking Friday."), call("book")));
  (await h.nextCall(1)).answer(respond());
  done.open("booked Friday 2pm");
  (await h.nextCall(2)).answer({ text: "Done: Friday at 2pm.", toolCalls: [] });
  const reminder = await h.nextCall(3);
  assert.match(last(reminder.request.messages).content, /^\[Chinwag\] INTERNAL MESSAGE, not from them: they have not heard from you since the result above.*without mentioning this note/);
  assert.match(reminder.request.system, /Lines starting \[Chinwag\] are INTERNAL MESSAGES/);
  reminder.answer(respond(say("Done: Friday at 2pm.")));
  await h.agent.conversation("c7")!.whenIdle();
  assert.deepEqual(h.sent(), ["Booking Friday.", "Done: Friday at 2pm."]);
  assert.equal(h.calls.length, 4);
});

test("a tool result the agent answers in plain text, after acknowledging, is sent back once", async () => {
  const log = tool({ name: "log_order", description: "", input: z.object({}), run: () => "logged order 1042" });
  const h = harness([log], 60_000);
  h.send("c2", "the latte was wrong today");
  (await h.nextCall(0)).answer(respond(say("Logging that now."), call("log_order")));
  (await h.nextCall(1)).answer({ text: "Logged order 1042; the café will sort it today.", toolCalls: [] });
  const reminder = await h.nextCall(2);
  assert.match(last(reminder.request.messages).content, /^\[Chinwag\] INTERNAL MESSAGE, not from them: they have not heard from you since the result above/);
  reminder.answer(respond(say("Logged order 1042; the café will sort it today.")));
  await h.agent.conversation("c2")!.whenIdle();
  assert.deepEqual(h.sent(), ["Logging that now.", "Logged order 1042; the café will sort it today."]);
  assert.equal(h.calls.length, 3);
});

test("plain text that repeats a message already sent in the turn is not sent back", async () => {
  const log = tool({ name: "log_order", description: "", input: z.object({}), run: () => "logged order 1042" });
  const h = harness([log], 60_000);
  h.send("c1", "the latte was wrong today");
  (await h.nextCall(0)).answer(respond(say("Logged; the café will sort it today."), call("log_order")));
  (await h.nextCall(1)).answer({ text: "Logged; the café will sort it today.", toolCalls: [] });
  await h.agent.conversation("c1")!.whenIdle();
  assert.deepEqual(h.sent(), ["Logged; the café will sort it today."]);
  assert.equal(h.calls.length, 2, "no reminder: it already said that");
});

test("a reply of only messages after a tool was used ends the turn: no extra step", async () => {
  const done = gate<string>();
  const book = tool({ name: "book", description: "", input: z.object({}), run: () => done.promise });
  const h = harness([book], 10, WEB, "manual");
  h.send("c8", "move my session to Friday");
  (await h.nextCall(0)).answer(respond(say("Booking Friday."), call("book")));
  (await h.nextCall(1)).answer(respond(say("Still on it.")));
  done.open("booked Friday 2pm");
  const next = await h.nextCall(2);
  assert.match(users(next.request.messages).at(-1)!, /Background result: book/, "the next call is the result's turn, not a follow-up");
  next.answer(respond(say("Done: Friday at 2pm.")));
  await h.agent.conversation("c8")!.whenIdle();
  assert.equal(h.calls.length, 3);
});

test("a call identical to one still running in the background is not run again", async () => {
  const done = gate<string>();
  let runs = 0;
  const plan = tool({ name: "get_plan", description: "", input: z.object({ week: z.number() }), run: () => (runs++, done.promise) });
  const h = harness([plan], 10);
  h.send("c9", "send me my plan");
  (await h.nextCall(0)).answer(respond(say("Getting your plan."), call("get_plan", { week: 3 })));
  const second = await h.nextCall(1);
  second.answer(respond(call("get_plan", { week: 3 }), call("get_plan", { week: 4 })));
  const third = await h.nextCall(2);
  const results = third.request.messages.slice(-2).map((m) => (m as { content: string }).content);
  assert.match(results[0], /Not run: get_plan with this input is already running in the background \(task_1\)/);
  assert.match(results[1], /still running in the background \(task_2\)/, "a different input runs");
  assert.equal(runs, 2);
  third.answer(respond());
  done.open("DASH plan");
  (await h.nextCall(3)).answer(respond(say("Your plan: DASH.")));
  await h.agent.conversation("c9")!.whenIdle();
  assert.ok(h.events.some((e) => e.type === "tool.repeated"));
});
