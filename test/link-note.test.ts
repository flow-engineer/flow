// covers: src/agent.ts src/conversation.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { LINK_NOTE_MAX } from "../src/conversation.ts";
import { WEB_APP, call, multi, respond, users } from "./helpers.ts";

/** Links a browser to an account (with or without a note), lets the account write, and returns what its history and next model call hold. */
async function linked(note: string | undefined, link: (agent: ReturnType<typeof multi>["agent"], input: { channel: string; address: string; key: string; note?: string }) => Promise<unknown> = (agent, input) => agent.linkIdentity(input)) {
  const h = multi({ channels: { app: { info: WEB_APP } } });
  h.agent.attachPlayground(() => {});
  const anonymous = await h.agent.simulateVisitor({ channel: "app", address: "browser-a", message: "I want a gym website" });
  (await h.nextCall(0)).answer(respond(call("send_app", { text: "Please sign in" })));
  await h.agent.conversation(anonymous!.conversationId)!.whenIdle();
  await link(h.agent, { channel: "app", address: "browser-a", key: "account-a", ...(note !== undefined ? { note } : {}) });
  const account = (await h.agent.visitorConversation("account-a"))!;
  assert.notEqual(account, anonymous!.conversationId, "anonymous history is not merged");
  await h.agent.simulateVisitor({ channel: "app", key: "account-a", address: "browser-a", message: "I'm in" });
  const next = await h.nextCall(1);
  next.answer(respond(call("send_app", { text: "Welcome" })));
  await h.agent.conversation(account)!.whenIdle();
  await h.agent.conversation(account)!.stored();
  const store = new Store(h.database, "default");
  const system = (id: string) => store.historyWithTimes(id).then((rows) => rows.flatMap(({ entry }) => (entry.role === "user" && entry.content.startsWith("[Chinwag] Context carried over") ? [entry.content] : [])));
  return { h, account, anonymous: anonymous!.conversationId, kept: await system(account), keptAnonymous: await system(anonymous!.conversationId), seen: users(next.request.messages) };
}

test("a note on linkIdentity lands as a system event in the account conversation only", async () => {
  const r = await linked("They want a gym website with mock details.");
  assert.deepEqual(r.kept, ["[Chinwag] Context carried over from the anonymous app chat: They want a gym website with mock details."]);
  assert.ok(r.seen.some((t) => t.includes("They want a gym website with mock details.")), "the agent sees it on its next turn");
  assert.deepEqual(r.keptAnonymous, [], "the anonymous transcript does not get it");
  const transcript = await r.h.agent.transcript(r.account);
  assert.ok(!transcript.some((e) => e.kind === "in" && e.text.includes("gym website")), "it is not a fabricated person message");
});

test("without a note nothing is carried over", async () => {
  for (const note of [undefined, "", "   "]) {
    const r = await linked(note);
    assert.deepEqual(r.kept, []);
    assert.ok(!r.seen.some((t) => t.includes("carried over")));
  }
});

test("a repeated link carries the note once, and a long note is trimmed and cut to the cap", async () => {
  const r = await linked(`  ${"x".repeat(LINK_NOTE_MAX + 500)}  `, async (agent, input) => { await agent.linkIdentity(input); await agent.linkIdentity(input); });
  assert.equal(r.kept.length, 1);
  const text = r.kept[0].split(": ").slice(1).join(": ");
  assert.equal(text.length, LINK_NOTE_MAX);
  assert.ok(text.endsWith("…"));
});

test("signInCompleted threads the note through, once across a retry", async () => {
  const completion = { channel: "app", address: "browser-a", key: "account-a", idempotencyKey: "login:1", via: "playground" as const, note: "Wants the gym site." };
  const r = await linked(undefined, async (agent) => { await agent.signInCompleted(completion); await agent.signInCompleted(completion); });
  assert.equal(r.kept.length, 1);
  assert.match(r.kept[0], /Wants the gym site\./);
});
