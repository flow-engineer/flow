// covers: src/conversation.ts src/model.ts src/agent.ts src/types.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, describeVideoWith, openAICompatible, sqlite, type Attachment, type ChatMessage, type Database, type DescribeVideo, type FlowEvent, type Media, type Model, type Transcribe } from "../src/index.ts";
import { gate, respond, say, scriptedModel } from "./helpers.ts";

function agentWith(options: { reads?: Model["reads"]; transcribe?: Transcribe; describeVideo?: DescribeVideo; database?: Database; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "flow-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  if (options.reads) scripted.model.reads = options.reads;
  const events: FlowEvent[] = [];
  const agent = createAgent({ dir, model: scripted.model, debounceMs: 0, transcribe: options.transcribe, describeVideo: options.describeVideo, database: options.database, events: [(e) => events.push(e)] });
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

test("describeVideoWith asks its model through the agent's key: a video_url part on OpenRouter or Flow, generateContent on Gemini, and no key that reaches one is refused", async (t) => {
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
