// covers: src/conversation.ts src/model.ts src/agent.ts src/types.ts src/channels.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { format } from "node:util";
import { createAgent, describeVideoWith, openAICompatible, sqlite, type Attachment, type ChannelInfo, type ChatMessage, type Database, type DescribeVideo, type FlowEvent, type Media, type Model, type Outbound, type Transcribe } from "../src/index.ts";
import { call, gate, respond, say, scriptedModel } from "./helpers.ts";

function agentWith(options: { reads?: Model["reads"]; transcribe?: Transcribe; describeVideo?: DescribeVideo; videoReaction?: boolean | string; database?: Database; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  if (options.reads) scripted.model.reads = options.reads;
  const events: FlowEvent[] = [];
  const agent = createAgent({ dir, model: scripted.model, debounceMs: 0, transcribe: options.transcribe, describeVideo: options.describeVideo, videoReaction: options.videoReaction, database: options.database, events: [(e) => events.push(e)] });
  return { agent, dir, events, ...scripted };
}

const file = (kind: Attachment["kind"], mime: string, bytes: Uint8Array | number, name?: string, size?: number) => {
  const loaded = { count: 0 };
  const attachment: Attachment = {
    kind,
    mime,
    ...(name ? { name } : {}),
    ...(size !== undefined ? { size } : {}),
    data: async () => (loaded.count++, typeof bytes === "number" ? new Uint8Array(bytes) : bytes),
  };
  return Object.assign(attachment, { loaded });
};

const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
const lastUser = (messages: ChatMessage[]) => messages.filter((m) => m.role === "user").at(-1) as { content: string; media?: Media[] };

test("a photo reaches a model that reads images, its caption as the text", async () => {
  const t = agentWith({ reads: { images: true } });
  t.agent.receive("c1", { text: "is this ripe?", attachments: [file("image", "image/jpeg", PHOTO)] }, () => undefined);

  const first = await t.nextCall(0);
  assert.deepEqual(lastUser(first.request.messages), {
    role: "user",
    content: "[m1] [photo] is this ripe?",
    media: [{ kind: "image", mime: "image/jpeg", data: Buffer.from(PHOTO).toString("base64") }],
  });
  first.answer(respond(say("Yes, eat it today.")));
  await t.agent.conversation("c1")!.whenIdle();
});

test("a model that can't see photos is told, and the photo is never downloaded", async () => {
  const t = agentWith();
  const photo = file("image", "image/jpeg", PHOTO);
  t.agent.receive("c2", { text: "look", attachments: [photo] }, () => undefined);

  const first = await t.nextCall(0);
  assert.deepEqual(lastUser(first.request.messages), { role: "user", content: "[m1] [photo: you can't see photos] look" });
  assert.equal(photo.loaded.count, 0);
  first.answer(respond(say("I can't see photos here; could you describe it?")));
  await t.agent.conversation("c2")!.whenIdle();
});

test("a voice note is read as its transcript, and a message sent while it is transcribed comes after it", async () => {
  const transcribed = gate<string>();
  const heard: Array<{ mime: string; bytes: number }> = [];
  const t = agentWith({ transcribe: async (audio) => (heard.push({ mime: audio.mime, bytes: audio.data.length }), transcribed.promise) });
  t.agent.receive("c3", { text: "", attachments: [file("audio", "audio/ogg", 40)] }, () => undefined);
  t.agent.receive("c3", "also after 5pm", () => undefined);
  transcribed.open(" Book me in for Friday. ");

  const first = await t.nextCall(0);
  assert.deepEqual(lastUser(first.request.messages).content, "[m1] [voice note, transcribed] Book me in for Friday.\n[m2] also after 5pm");
  assert.deepEqual(heard, [{ mime: "audio/ogg", bytes: 40 }]);
  first.answer(respond(say("Friday after 5pm, got it.")));
  await t.agent.conversation("c3")!.whenIdle();
});

test("a voice note reports that it arrived before its transcript is ready", async () => {
  const transcribed = gate<string>();
  const dir = mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const events: string[] = [];
  const agent = createAgent({
    dir,
    model: scripted.model,
    debounceMs: 0,
    transcribe: () => transcribed.promise,
    events: [(e) => events.push(e.type)],
  });
  agent.receive("c3b", { text: "", attachments: [file("audio", "audio/ogg", 40)] }, () => undefined);
  assert.deepEqual(events, ["message.arrived"]);
  transcribed.open("Friday");
  const first = await scripted.nextCall(0);
  assert.ok(events.indexOf("message.arrived") < events.indexOf("message.in"));
  first.answer(respond(say("Friday.")));
  await agent.conversation("c3b")!.whenIdle();
});

test("without transcribe, the agent is told a voice note came that it can't listen to", async () => {
  const t = agentWith();
  t.agent.receive("c4", { text: "", attachments: [file("audio", "audio/ogg", 40)] }, () => undefined);

  const first = await t.nextCall(0);
  assert.equal(lastUser(first.request.messages).content, "[m1] [voice note: you can't listen to voice notes]");
  first.answer(respond(say("I can't listen to voice notes; could you type it?")));
  await t.agent.conversation("c4")!.whenIdle();
});

test("a PDF reaches a model that reads them; other documents and files over the limits are named with why", async () => {
  const t = agentWith({ reads: { images: true, pdfs: true } });
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  t.agent.receive(
    "c5",
    {
      text: "my invoices",
      attachments: [
        file("document", "application/pdf", pdf, "invoice.pdf"),
        file("document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 10, "notes.docx"),
        file("document", "application/pdf", 10 * 1_048_576 + 1, "scan.pdf"),
        file("image", "image/heic", PHOTO),
      ],
    },
    () => undefined,
  );

  const first = await t.nextCall(0);
  assert.deepEqual(lastUser(first.request.messages), {
    role: "user",
    content:
      '[m1] [document "invoice.pdf"] [document "notes.docx": you can only open PDFs] [document "scan.pdf": too large for you to read, over 10 MB] ' +
      "[photo: you can't see this type of image] my invoices",
    media: [{ kind: "document", mime: "application/pdf", name: "invoice.pdf", data: Buffer.from(pdf).toString("base64") }],
  });
  first.answer(respond(say("Got the invoice.")));
  await t.agent.conversation("c5")!.whenIdle();
});

test("only the latest three photos are shown, and their bytes are never stored: after a restart they are named, not shown", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "flow-")), "agent.db");
  const before = agentWith({ reads: { images: true }, database: sqlite(path) });
  await before.agent.resume();
  const photos = [1, 2, 3, 4].map((n) => file("image", "image/png", new Uint8Array([n])));
  before.agent.receive("c6", { text: "four angles", attachments: photos }, () => undefined);

  const first = await before.nextCall(0);
  const shown = lastUser(first.request.messages);
  assert.deepEqual(shown.media?.map((m) => m.data), ["Ag==", "Aw==", "BA=="]);
  assert.ok(shown.content.endsWith("\n[Chinwag] You are no longer shown the photos, videos or documents in these messages; ask them to send one again if you need it."));
  first.answer(respond(say("Thanks, looking.")));
  await before.agent.conversation("c6")!.whenIdle();

  const after = agentWith({ reads: { images: true }, database: sqlite(path), dir: before.dir });
  await after.agent.resume();
  after.agent.receive("c6", "so?", () => undefined);
  const next = await after.nextCall(0);
  const earlier = next.request.messages.find((m) => m.role === "user" && m.content.startsWith("[m1]"));
  assert.ok(earlier && earlier.role === "user");
  assert.equal(earlier.media, undefined);
  assert.ok(earlier.content.endsWith("ask them to send one again if you need it."));
  next.answer(respond(say("It looks fine.")));
  await after.agent.conversation("c6")!.whenIdle();
});

test("a video reaches a model that watches videos, and only the latest one stays shown", async () => {
  const t = agentWith({ reads: { images: true, videos: true } });
  t.agent.receive("v1", { text: "the leak, then the meter", attachments: [file("video", "video/mp4", new Uint8Array([1])), file("video", "video/quicktime", new Uint8Array([2]))] }, () => undefined);

  const first = await t.nextCall(0);
  const shown = lastUser(first.request.messages);
  assert.deepEqual(shown.media, [{ kind: "video", mime: "video/quicktime", data: "Ag==" }]);
  assert.ok(shown.content.startsWith("[m1] [video] [video] the leak, then the meter\n[Chinwag] You are no longer shown"));
  first.answer(respond(say("I see the leak.")));
  await t.agent.conversation("v1")!.whenIdle();
});

test("a video the model can't watch reaches it as describeVideo's text; one over the limit is never fetched", async () => {
  const described: Array<{ mime: string; bytes: number }> = [];
  const t = agentWith({ describeVideo: async (video) => (described.push({ mime: video.mime, bytes: video.data.length }), " A cracked phone screen,\n turned in the light. ") });
  const big = file("video", "video/mp4", 1, undefined, 10 * 1_048_576 + 1);
  t.agent.receive("v2", { text: "is this covered?", attachments: [file("video", "video/mp4", 40), big] }, () => undefined);

  const first = await t.nextCall(0);
  assert.deepEqual(lastUser(first.request.messages), {
    role: "user",
    content: "[m1] [video, described: A cracked phone screen, turned in the light.] [video: too large for you to read, over 10 MB] is this covered?",
  });
  assert.deepEqual(described, [{ mime: "video/mp4", bytes: 40 }]);
  assert.equal(big.loaded.count, 0);
  assert.equal(t.events.find((e) => e.type === "message.in")?.description, "A cracked phone screen, turned in the light.");
  first.answer(respond(say("Screen damage is covered.")));
  await t.agent.conversation("v2")!.whenIdle();
});

/** A channel with no reactions whose typing indicator lasts 1 s (sent again every 800 ms), as the platform's messages arrive: with their own ids. */
const TYPED: ChannelInfo = { reactions: false, status: false, typingLastsMs: 1000 };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a video on a channel with no reactions, or a voice note, with the platform's id types the moment it arrives, before it is downloaded and read, and typing is kept up while it is described", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const steps: string[] = [];
  const described = gate<string>();
  const transcribed = gate<string>();
  const a = agentWith({ describeVideo: () => (steps.push("describe"), described.promise), transcribe: () => (steps.push("transcribe"), transcribed.promise) });
  const deliver = (o: Outbound) => void steps.push(o.type === "typing" ? `typing ${o.on}` : o.type === "message" ? `message ${o.text}` : o.type);
  const loaded = (kind: Attachment["kind"], mime: string): Attachment => ({ kind, mime, data: async () => (steps.push("download"), new Uint8Array(40)) });

  a.agent.receive("v5", { text: "is this covered?", attachments: [loaded("video", "video/mp4")] }, deliver, { channel: TYPED, messageId: "wamid.V5" });
  assert.deepEqual(steps, ["typing true"], "typing goes before anything is read");
  await settle();
  assert.deepEqual(steps, ["typing true", "download", "describe"]);
  t.mock.timers.tick(800);
  await settle();
  assert.deepEqual(steps, ["typing true", "download", "describe", "typing true"], "kept up while the video is described");
  described.open("A dented rear bumper.");
  await settle();
  t.mock.timers.tick(0);
  const first = await a.nextCall(0);
  assert.equal(lastUser(first.request.messages).content, "[wamid.V5] [video, described: A dented rear bumper.] is this covered?");
  first.answer(respond(say("Bumper dents are covered.")));
  await a.agent.conversation("v5")!.whenIdle();
  assert.equal(steps.filter((s) => s === "typing true").length, 2, "typing was not sent again when the message was stored");
  assert.ok(steps.includes("message Bumper dents are covered."));

  steps.length = 0;
  a.agent.receive("v6", { text: "", attachments: [loaded("audio", "audio/ogg")] }, deliver, { channel: TYPED, messageId: "wamid.A6" });
  await settle();
  assert.deepEqual(steps, ["typing true", "download", "transcribe"]);
  transcribed.open("Book me in for Friday.");
  await settle();
  t.mock.timers.tick(0);
  (await a.nextCall(1)).answer(respond(say("Friday it is.")));
  await a.agent.conversation("v6")!.whenIdle();
});

test("a typing call that fails, or never answers, neither holds up describing a video nor stops the reply", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const refuse = gate<void>();
  const steps: string[] = [];
  const a = agentWith({ describeVideo: async () => (steps.push("describe"), "A dented rear bumper.") });
  const deliver = (o: Outbound) => {
    if (o.type === "message") steps.push(`message ${o.text}`);
    // Typing hangs until the test refuses it.
    if (o.type === "typing" && o.on) return refuse.promise.then(() => Promise.reject(new Error("invalid_request")));
  };
  a.agent.receive("v7", { text: "is this covered?", attachments: [file("video", "video/mp4", 40)] }, deliver, { channel: TYPED, messageId: "wamid.V7" });

  const first = await a.nextCall(0);
  assert.deepEqual(steps, ["describe"], "described while typing had no answer");
  assert.equal(lastUser(first.request.messages).content, "[wamid.V7] [video, described: A dented rear bumper.] is this covered?");
  refuse.open();
  first.answer(respond(say("Bumper dents are covered.")));
  await a.agent.conversation("v7")!.whenIdle();
  assert.deepEqual(steps, ["describe", "message Bumper dents are covered."]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(format(...warn.mock.calls[0].arguments), /typing on chat in conversation v7 failed, so no more typing this turn: invalid_request$/);
});

/** WhatsApp as Flow Messaging's channel shows it: reactions, blue ticks, and typing that lasts 25 s (sent again every 20 s). */
const WA: ChannelInfo = { platform: "whatsapp", reactions: true, status: false, readReceipts: true, typingLastsMs: 25_000 };
const outLine = (o: Outbound) => (o.type === "typing" ? `typing ${o.on}` : o.type === "reaction" ? `reaction ${o.emoji} ${o.messageId}` : o.type === "read" ? `read ${o.messageIds.join(" ")}` : o.type === "message" ? `message ${o.text}` : o.type);

test("a WhatsApp video gets its blue ticks and 👀 the moment it arrives, before it is downloaded, described or the model is called; with nothing from the agent 5 s on, it types from then until the reply, kept up as usual", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const steps: string[] = [];
  const described = gate<string>();
  const a = agentWith({ describeVideo: () => (steps.push("describe"), described.promise) });
  const video: Attachment = { kind: "video", mime: "video/mp4", data: async () => (steps.push("download"), new Uint8Array(40)) };
  a.agent.receive("r1", { text: "is this covered?", attachments: [video] }, (o) => void steps.push(outLine(o)), { channel: WA, messageId: "wamid.R1" });
  assert.deepEqual(steps, ["read wamid.R1", "reaction 👀 wamid.R1"], "the read receipt, without typing, and the reaction go before anything is read");
  await settle();
  t.mock.timers.tick(4_999);
  assert.deepEqual(steps, ["read wamid.R1", "reaction 👀 wamid.R1", "download", "describe"], "no typing in the first 5 s");
  t.mock.timers.tick(1);
  await settle();
  t.mock.timers.tick(20_000);
  assert.deepEqual(steps.slice(4), ["typing true", "typing true"], "typing from 5 s, sent again 20 s later");
  t.mock.timers.tick(5_000);
  described.open("A dented rear bumper.");
  await settle();
  t.mock.timers.tick(0);
  const first = await a.nextCall(0);
  assert.equal(lastUser(first.request.messages).content, "[wamid.R1] [video, described: A dented rear bumper.] is this covered?\n[Chinwag] wamid.R1 already has your 👀 reaction; don't react 👀 to it again.");
  first.answer(respond(call("lookup_policy", {})));
  (await a.nextCall(1)).answer(respond(say("Bumper dents are covered.")));
  await a.agent.conversation("r1")!.whenIdle();
  t.mock.timers.tick(60_000);
  assert.deepEqual(steps.slice(6), ["read wamid.R1", "message Bumper dents are covered.", "typing false"], "the reply hides it, and none is sent after");
  assert.deepEqual(a.events.filter((e) => e.type === "reaction").map(({ emoji, messageId, channel, arrival }) => ({ emoji, messageId, channel, arrival })), [{ emoji: "👀", messageId: "wamid.R1", channel: "chat", arrival: true }]);
});

test("a video answered within 5 s of arriving shows only the 👀: no typing, before the reply or after it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const steps: string[] = [];
  const a = agentWith({ describeVideo: async () => "A dented rear bumper." });
  a.agent.receive("r2", { text: "is this covered?", attachments: [file("video", "video/mp4", 40)] }, (o) => void steps.push(outLine(o)), { channel: WA, messageId: "wamid.R2" });
  await settle();
  t.mock.timers.tick(3_000);
  (await a.nextCall(0)).answer(respond(say("Bumper dents are covered.")));
  await a.agent.conversation("r2")!.whenIdle();
  t.mock.timers.tick(60_000);
  assert.deepEqual(steps, ["read wamid.R2", "reaction 👀 wamid.R2", "read wamid.R2", "message Bumper dents are covered."]);
});

test("only a video gets the reaction: a photo, and a video when videoReaction is false, type on arrival as before", async () => {
  const run = async (a: ReturnType<typeof agentWith>, id: string, attachment: Attachment) => {
    const steps: string[] = [];
    a.agent.receive(id, { text: "is this covered?", attachments: [attachment] }, (o) => void steps.push(outLine(o)), { channel: WA, messageId: `wamid.${id}` });
    (await a.nextCall(a.calls.length)).answer(respond(say("Yes.")));
    await a.agent.conversation(id)!.whenIdle();
    return steps;
  };
  const on = agentWith({ reads: { images: true } });
  assert.deepEqual(await run(on, "p1", file("image", "image/jpeg", PHOTO)), ["typing true", "read wamid.p1", "message Yes.", "typing false"]);
  const off = agentWith({ videoReaction: false, describeVideo: async () => "A dented rear bumper." });
  assert.deepEqual(await run(off, "v1", file("video", "video/mp4", 40)), ["typing true", "read wamid.v1", "message Yes.", "typing false"]);
});

test("the reaction goes where the channel takes its emoji: 👀 on iMessage and Telegram; on Telegram an emoji outside Telegram's reactions is not sent, and that video's turn types", async () => {
  const IMESSAGE: ChannelInfo = { platform: "imessage", reactions: true, status: false, readReceipts: true };
  const TELEGRAM: ChannelInfo = { platform: "telegram", reactions: true, status: false };
  const first = async (videoReaction: string | undefined, info: ChannelInfo) => {
    const a = agentWith({ videoReaction, describeVideo: async () => "A dented rear bumper." });
    const sent: string[] = [];
    a.agent.receive("c", { text: "", attachments: [file("video", "video/mp4", 40)] }, (o) => void sent.push(outLine(o)), { channel: info, messageId: "M1" });
    return sent.join(", ");
  };
  // iMessage's read receipt still goes when the turn takes the message, not on arrival.
  assert.equal(await first(undefined, IMESSAGE), "reaction 👀 M1");
  assert.equal(await first(undefined, TELEGRAM), "reaction 👀 M1");
  // Telegram's own reactions, as Flow Messaging matches them: ❤️ is its ❤, and 👍🏽 its 👍.
  assert.equal(await first("❤️", TELEGRAM), "reaction ❤️ M1");
  assert.equal(await first("👍🏽", TELEGRAM), "reaction 👍🏽 M1");
  assert.equal(await first("🫠", TELEGRAM), "typing true");
  assert.equal(await first("🫠", IMESSAGE), "reaction 🫠 M1");
});

test("a reaction that fails is logged, and the video's turn types instead and still answers", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const refused = gate<void>();
  const steps: string[] = [];
  const a = agentWith({ describeVideo: async () => "A dented rear bumper." });
  const deliver = (o: Outbound) => {
    steps.push(outLine(o));
    if (o.type === "reaction") return Promise.reject(new Error("invalid_request")).finally(() => refused.open());
  };
  a.agent.receive("f1", { text: "is this covered?", attachments: [file("video", "video/mp4", 40)] }, deliver, { channel: WA, messageId: "wamid.F1" });
  await refused.promise;
  const first = await a.nextCall(0);
  assert.equal(lastUser(first.request.messages).content, "[wamid.F1] [video, described: A dented rear bumper.] is this covered?", "not told it reacted");
  first.answer(respond(say("Bumper dents are covered.")));
  await a.agent.conversation("f1")!.whenIdle();
  assert.deepEqual(steps, ["read wamid.F1", "reaction 👀 wamid.F1", "typing true", "read wamid.F1", "message Bumper dents are covered.", "typing false"]);
  assert.deepEqual(a.events.filter((e) => e.type === "reaction"), [], "no reaction event for one that did not go");
  assert.match(format(...warn.mock.calls[0].arguments), /the reaction to a video on chat in conversation f1 failed, so its turn types instead: invalid_request$/);
});

test("with neither a video model nor describeVideo, the agent is told a video came that it can't watch, and it is never downloaded", async () => {
  const t = agentWith({ reads: { images: true } });
  const video = file("video", "video/mp4", 40);
  t.agent.receive("v3", { text: "see this", attachments: [video] }, () => undefined);

  const first = await t.nextCall(0);
  assert.equal(lastUser(first.request.messages).content, "[m1] [video: you can't watch videos] see this");
  assert.equal(video.loaded.count, 0);
  first.answer(respond(say("I can't watch videos here; could you describe it?")));
  await t.agent.conversation("v3")!.whenIdle();
});

/** A describer that also answers questions (DescribeVideo's ask), recording each one. */
function asker(answer = "Yes: a thin scratch just left of the charging port.") {
  const questions: Array<{ question: string; bytes: number }> = [];
  const describe: DescribeVideo = Object.assign(async () => "A black phone, turned in the light.", {
    ask: async (video: { mime: string; data: Uint8Array }, question: string) => (questions.push({ question, bytes: video.data.length }), answer),
  });
  return { describe, questions };
}

const tools = (request: { tools: Array<{ name: string }> }) => request.tools.map((t) => t.name);
const toolResult = (messages: ChatMessage[], id: string) => (messages.find((m) => m.role === "tool" && m.toolCallId === id) as { content: string } | undefined)?.content;

test("the agent can ask about a described video whenever it needs to: describeVideo's ask answers from the video fetched again by its ref, offered only once the conversation has one", async () => {
  const { describe, questions } = asker();
  const t = agentWith({ describeVideo: describe });
  const fetched: string[] = [];
  const again = async (ref: string) => (fetched.push(ref), new Uint8Array(40));
  t.agent.receive("q1", "hi, is this phone still for sale?", () => undefined, { file: again });
  const first = await t.nextCall(0);
  assert.equal(tools(first.request).includes("ask_about_video"), false);
  first.answer(respond(say("It is! Want a video of it?")));
  await t.agent.conversation("q1")!.whenIdle();

  const video = Object.assign(file("video", "video/mp4", 40), { ref: "file_v1" });
  t.agent.receive("q1", { text: "here's mine for the trade-in", attachments: [video] }, () => undefined, { file: again });
  const second = await t.nextCall(1);
  assert.ok(lastUser(second.request.messages).content.startsWith("[m2] [video, described: A black phone, turned in the light.]"));
  assert.ok(tools(second.request).includes("ask_about_video"));
  const ask = call("ask_about_video", { question: "Is there a scratch near the charging port?" });
  second.answer(respond(say("Let me look closer."), ask));

  const third = await t.nextCall(2);
  assert.deepEqual(JSON.parse(toolResult(third.request.messages, ask.id)!), { video: "m2", answer: "Yes: a thin scratch just left of the charging port." });
  assert.deepEqual(questions, [{ question: "Is there a scratch near the charging port?", bytes: 40 }]);
  // Read once as it arrived, then fetched again by its ref for the question.
  assert.deepEqual([video.loaded.count, fetched], [1, ["file_v1"]]);
  third.answer(respond(say("There is a small scratch by the port.")));
  await t.agent.conversation("q1")!.whenIdle();

  // A describer that only describes cannot answer, so the agent is not offered the tool.
  const only = agentWith({ describeVideo: async () => "A black phone." });
  only.agent.receive("q2", { text: "mine", attachments: [Object.assign(file("video", "video/mp4", 40), { ref: "file_v2" })] }, () => undefined, { file: again });
  const call0 = await only.nextCall(0);
  assert.equal(tools(call0.request).includes("ask_about_video"), false);
  call0.answer(respond(say("Thanks.")));
  await only.agent.conversation("q2")!.whenIdle();
});

test("questions about videos are capped per turn, and a video its channel no longer keeps is a failure the agent reads, with what to do", async () => {
  const { describe, questions } = asker("No.");
  const t = agentWith({ describeVideo: describe });
  let kept = true;
  const again = async () => (kept ? new Uint8Array(40) : null);
  t.agent.receive("q3", { text: "the dent", attachments: [Object.assign(file("video", "video/mp4", 40), { ref: "file_v3" })] }, () => undefined, { file: again });
  const first = await t.nextCall(0);
  const asks = [1, 2, 3, 4].map((n) => call("ask_about_video", { question: `Question ${n}?`, message: "m1" }));
  first.answer(respond(say("Looking."), ...asks));
  const second = await t.nextCall(1);
  const results = asks.map((a) => toolResult(second.request.messages, a.id)!);
  assert.equal(results.filter((r) => r === '{"video":"m1","answer":"No."}').length, 3);
  assert.equal(results.filter((r) => r.startsWith("Failed: Not asked: 3 questions about videos is the most a turn has.")).length, 1);
  assert.equal(questions.length, 3);
  second.answer(respond(say("No dent that I can see.")));
  await t.agent.conversation("q3")!.whenIdle();

  kept = false;
  t.agent.receive("q3", "look again at the corner?", () => undefined, { file: again });
  const third = await t.nextCall(2);
  const ask = call("ask_about_video", { question: "Is the corner dented?" });
  third.answer(respond(say("Checking."), ask));
  const fourth = await t.nextCall(3);
  assert.equal(toolResult(fourth.request.messages, ask.id), "Failed: The video in m1 is no longer kept by chat, so it can't be watched again. Ask them to send it again if you need it.");
  assert.ok(t.events.some((e) => e.type === "attachment.failed" && e.kind === "video" && e.messageId === "m1"));
  fourth.answer(respond(say("Could you send the video again?")));
  await t.agent.conversation("q3")!.whenIdle();
});

test("openAICompatible sends photos as image_url parts, PDFs as file parts and videos as video_url parts", async () => {
  let body: any = null;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const model = openAICompatible({ model: "m", apiKey: "k", baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  assert.deepEqual(model.reads, { images: true, pdfs: false, videos: false });
  await model.complete({
    system: "s",
    messages: [{ role: "user", content: "[m1] [photo] [document \"a.pdf\"] hi", media: [{ kind: "image", mime: "image/png", data: "AQ==" }, { kind: "document", mime: "application/pdf", name: "a.pdf", data: "Ag==" }, { kind: "video", mime: "video/quicktime", data: "Aw==" }] }],
    tools: [],
    signal: new AbortController().signal,
  });
  server.close();
  assert.deepEqual(body.messages[1].content, [
    { type: "text", text: '[m1] [photo] [document "a.pdf"] hi' },
    { type: "image_url", image_url: { url: "data:image/png;base64,AQ==" } },
    { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,Ag==" } },
    { type: "video_url", video_url: { url: "data:video/mov;base64,Aw==" } },
  ]);
  assert.deepEqual(openAICompatible({ model: "m", apiKey: "k", videos: true }).reads, { images: true, pdfs: true, videos: true });
});

test("describeVideoWith asks its model through the agent's key, to describe a video or answer a question about it: a video_url part on OpenRouter or Flow, generateContent on Gemini, and no key that reaches one is refused", async (t) => {
  const saved = Object.fromEntries(["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "FLOW_KEY"].map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    globalThis.fetch = realFetch;
  });
  for (const k of Object.keys(saved)) delete process.env[k];

  let body: any = null;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: " A dog on a beach. " } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const describe = describeVideoWith("google/gemini-3.8-flash", { apiKey: "k", baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  assert.equal(await describe({ mime: "video/mp4", data: new Uint8Array([1]) }), "A dog on a beach.");
  assert.equal(body.model, "google/gemini-3.8-flash");
  assert.deepEqual(body.messages[0].content[1], { type: "video_url", video_url: { url: "data:video/mp4;base64,AQ==" } });
  // Its ask puts the agent's question to the same model, with the video.
  assert.equal(await describe.ask!({ mime: "video/mp4", data: new Uint8Array([1]) }, "Is the dog wet?"), "A dog on a beach.");
  assert.ok(body.messages[0].content[0].text.endsWith("\nQuestion: Is the dog wet?"));
  assert.deepEqual(body.messages[0].content[1], { type: "video_url", video_url: { url: "data:video/mp4;base64,AQ==" } });

  process.env.OPENAI_API_KEY = "sk-openai";
  assert.throws(() => describeVideoWith("google/gemini-3.8-flash"), (e: Error & { code?: string }) => e.code === "no_video_key" && /OPENAI_API_KEY does not/.test(e.message) && /GEMINI_API_KEY=/.test(e.message));

  process.env.GEMINI_API_KEY = "gk";
  let asked: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    asked = { url: String(url), init };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "A dog " }, { text: "on a beach." }] } }] }), { status: 200 });
  }) as typeof fetch;
  assert.equal(await describeVideoWith("google/gemini-3.8-flash")({ mime: "video/quicktime", data: new Uint8Array([1]) }), "A dog on a beach.");
  assert.equal(asked!.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.equal((asked!.init.headers as Record<string, string>)["x-goog-api-key"], "gk");
  assert.deepEqual(JSON.parse(String(asked!.init.body)).contents[0].parts[1], { inlineData: { mimeType: "video/mov", data: "AQ==" } });
});
