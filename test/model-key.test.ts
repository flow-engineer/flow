// covers: src/model.ts
// The agent's model key: the first of OpenRouter, OpenAI, Anthropic and Gemini that has a value,
// else FLOW_KEY (Flow's trial credit, at FLOW_MODEL_URL or the CLI's server), with MODEL
// overriding that provider's default id. A blank line is no key, and no key at all fails when the
// model is made, in one sentence naming .env and its lines with a next step, not on the first
// message, unless a base URL is named (a local server needs no key). Flow's typed errors (credit
// used up, ...) come back as its message and next step. flowTranscribe posts the audio to Flow's
// /audio/transcriptions with the same key and address, and reports Flow's errors the same way.
// Under `flow test`, calls to Flow's address (and only there) carry the test cloud's session id.
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { describeVideoWith, flowModel, flowTranscribe, modelFromKeys, openAICompatible } from "../src/model.ts";

/** Fake Flow keys in FLOW_KEY's format (flow_test_<kid>_<secret>), obviously not real. */
const FAKE = "flow_test_FAKEkid000_0000000000FAKE0000000000FAKE000000abcd";
const FAKE_TRIAL = "flow_test_FAKEkid001_0000000000FAKE0000000000FAKE000000wxyz";

const MODEL_ENV = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "FLOW_KEY", "FLOW_MODEL_URL", "FLOW_FRAMEWORK_LOGIN_URL", "CHINWAG_LOGIN_URL", "MODEL", "FLOW_FRAMEWORK_RUN_KIND", "CHINWAG_RUN_KIND", "FLOW_FRAMEWORK_TEST_SESSION", "CHINWAG_TEST_SESSION"];

/** Runs `body` with only `env` set of the model's environment names, then puts them back. */
async function withEnv(env: Record<string, string>, body: () => unknown): Promise<void> {
  const saved = MODEL_ENV.map((name) => [name, process.env[name]] as const);
  for (const name of MODEL_ENV) delete process.env[name];
  Object.assign(process.env, env);
  try {
    await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("the first key with a value picks the provider, and MODEL overrides its default", () => {
  assert.deepEqual(modelFromKeys({}), { baseURL: "https://openrouter.ai/api/v1", model: "anthropic/claude-haiku-5.5" });
  assert.deepEqual(modelFromKeys({ OPENAI_API_KEY: "sk-openai" }), { apiKey: "sk-openai", baseURL: "https://api.openai.com/v1", model: "gpt-6-luna" });
  assert.deepEqual(modelFromKeys({ ANTHROPIC_API_KEY: "sk-ant" }), { apiKey: "sk-ant", baseURL: "https://api.anthropic.com/v1/", model: "claude-haiku-5-5" });
  assert.deepEqual(modelFromKeys({ GEMINI_API_KEY: "gem" }), { apiKey: "gem", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3.8-flash" });
  assert.equal(modelFromKeys({ OPENAI_API_KEY: "sk-openai", MODEL: "gpt-6.1-sol" }).model, "gpt-6.1-sol");
  assert.equal(modelFromKeys({ OPENROUTER_API_KEY: "sk-or", OPENAI_API_KEY: "sk-openai" }).baseURL, "https://openrouter.ai/api/v1");
  assert.equal(modelFromKeys({ OPENROUTER_API_KEY: "  ", OPENAI_API_KEY: "sk-openai" }).apiKey, "sk-openai");
});

test("FLOW_KEY is used only when no provider key is set, at FLOW_MODEL_URL, else the CLI server's /llm/framework/v1, else flow.engineer's", () => {
  assert.deepEqual(modelFromKeys({ FLOW_KEY: FAKE }), { apiKey: FAKE, baseURL: "https://flow.engineer/llm/framework/v1", model: "anthropic/claude-haiku-5.5" });
  assert.equal(modelFromKeys({ FLOW_KEY: FAKE, GEMINI_API_KEY: "gem" }).apiKey, "gem", "a provider key the owner adds wins");
  assert.equal(modelFromKeys({ FLOW_KEY: FAKE, FLOW_FRAMEWORK_LOGIN_URL: "http://127.0.0.1:8000/" }).baseURL, "http://127.0.0.1:8000/llm/framework/v1");
  assert.equal(modelFromKeys({ FLOW_KEY: FAKE, FLOW_FRAMEWORK_LOGIN_URL: "http://127.0.0.1:8000", FLOW_MODEL_URL: "https://staging.example/v1" }).baseURL, "https://staging.example/v1");
  assert.equal(modelFromKeys({ FLOW_KEY: FAKE, MODEL: "google/gemini-3.8-flash" }).model, "google/gemini-3.8-flash");
});

test("with no key and no base URL the model fails when it is made: one sentence naming .env's lines and where to get a key, then the next step", () =>
  withEnv({}, () => {
    assert.throws(() => openAICompatible(), {
      message: "This agent has no model key: npx @flow-engineer/flow setup writes FLOW_KEY, the agent's Flow key (with the account's free trial model credit), into .env in the agent's folder, or put your own on one of the lines OPENROUTER_API_KEY=, OPENAI_API_KEY=, ANTHROPIC_API_KEY= or GEMINI_API_KEY= (an OpenRouter key is made at https://openrouter.ai/keys).\nNext: run npx @flow-engineer/flow setup to get Flow's free trial credit, or add your own key.",
      code: "no_model_key",
      next: "npx @flow-engineer/flow setup",
    });
    assert.throws(() => flowModel(), {
      message: "FLOW_KEY is not set: npx @flow-engineer/flow setup writes it into .env in the agent's folder.\nNext: run npx @flow-engineer/flow setup.",
      code: "no_model_key",
      next: "npx @flow-engineer/flow setup",
    });
    assert.doesNotThrow(() => openAICompatible({ apiKey: "k" }));
    assert.doesNotThrow(() => openAICompatible({ baseURL: "http://127.0.0.1:11434/v1" }));
  }));

test("a model through Flow sends FLOW_KEY and the default model, reads PDFs, and turns Flow's typed error into its message and next step", async (t) => {
  const seen: Array<{ auth?: string; model: string }> = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => { text += c; });
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, model: JSON.parse(text).model });
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Flow trial credit used: add your own model key to .env.", type: "insufficient_quota", code: "trial_credit_used", next: "add your own model key to .env (OPENROUTER_API_KEY=..., https://openrouter.ai/keys)" } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/llm/framework/v1`;
  await withEnv({ FLOW_KEY: FAKE_TRIAL, FLOW_MODEL_URL: url }, async () => {
    const request = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], signal: new AbortController().signal };
    for (const model of [openAICompatible(), flowModel()]) {
      assert.deepEqual(model.reads, { images: true, pdfs: true, videos: false });
      await assert.rejects(model.complete(request), {
        message: "Flow trial credit used: add your own model key to .env.\nNext: add your own model key to .env (OPENROUTER_API_KEY=..., https://openrouter.ai/keys)",
        code: "trial_credit_used",
        next: "add your own model key to .env (OPENROUTER_API_KEY=..., https://openrouter.ai/keys)",
        status: 402,
      });
    }
  });
  assert.deepEqual(seen, [{ auth: `Bearer ${FAKE_TRIAL}`, model: "anthropic/claude-haiku-5.5" }, { auth: `Bearer ${FAKE_TRIAL}`, model: "anthropic/claude-haiku-5.5" }], "a 402 is not tried again");
});

test("flowTranscribe posts the audio and language as multipart with FLOW_KEY, returns { text }, and reports Flow's typed error with its next step", async (t) => {
  const sent: Array<{ url: string; auth?: string; file: File; language: FormDataEntryValue | null }> = [];
  const answers = [
    new Response(JSON.stringify({ text: "see you at 6" }), { status: 200 }),
    new Response(JSON.stringify({ text: "" }), { status: 200 }),
    new Response(JSON.stringify({ error: { message: "The audio is over 15 MB.", type: "invalid_request_error", code: "file_too_large", next: "send a shorter recording" } }), { status: 413 }),
  ];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const form = init.body as FormData;
    sent.push({ url, auth: (init.headers as Record<string, string>).authorization, file: form.get("file") as File, language: form.get("language") });
    return answers.shift()!;
  });
  await withEnv({ FLOW_KEY: FAKE, FLOW_FRAMEWORK_LOGIN_URL: "http://127.0.0.1:8000/" }, async () => {
    assert.deepEqual(await flowTranscribe(new Uint8Array([1, 2, 3]), { language: "pt-BR" }), { text: "see you at 6" });
    assert.deepEqual(await flowTranscribe(new Blob([new Uint8Array([4])], { type: "audio/mpeg" }), { filename: "note.mp3" }), { text: "" });
    await assert.rejects(flowTranscribe(new ArrayBuffer(1), { mimeType: "audio/wav" }), {
      message: "The audio is over 15 MB.\nNext: send a shorter recording",
      code: "file_too_large",
      next: "send a shorter recording",
      status: 413,
    });
  });
  assert.deepEqual(sent.map((s) => [s.url, s.auth, s.file.name, s.file.type, s.file.size, s.language]), [
    ["http://127.0.0.1:8000/llm/framework/v1/audio/transcriptions", `Bearer ${FAKE}`, "audio.ogg", "", 3, "pt-BR"],
    ["http://127.0.0.1:8000/llm/framework/v1/audio/transcriptions", `Bearer ${FAKE}`, "note.mp3", "audio/mpeg", 1, null],
    ["http://127.0.0.1:8000/llm/framework/v1/audio/transcriptions", `Bearer ${FAKE}`, "audio.ogg", "audio/wav", 1, null],
  ]);
  await withEnv({}, () => assert.rejects(flowTranscribe(new Uint8Array([1])), { code: "no_model_key", next: "npx @flow-engineer/flow setup" }));
});

/** A test cloud session's id in its shape (tse_ and 26 Crockford base32), made up. */
const SESSION = "tse_01JFAKE0SESS10N00000000000";

/** A streamed answer ("ok", then usage), as OpenRouter and Flow send it. */
function answerStream(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(200, { "content-type": "text/event-stream", ...headers });
  res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

/** A local model server that answers every call and records each path with its Flow-Test-Session header. */
async function gateway(t: { after: (fn: () => void) => void }) {
  const seen: Array<[string, string | undefined]> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const streamed = body.startsWith("{") && JSON.parse(body).stream === true;
      seen.push([req.url!.replace(/^.*\/v1/, ""), req.headers["flow-test-session"] as string | undefined]);
      if (req.url!.endsWith("/chat/completions") && streamed) return answerStream(res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url!.endsWith("/audio/transcriptions")
        ? { text: "hi" }
        : { id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

test("under flow test a model call to Flow's address carries the session id, read when the call is made; never to another address, outside flow test, or with an id not shaped like a session's", async (t) => {
  const { base, seen } = await gateway(t);
  await withEnv({ FLOW_KEY: FAKE, FLOW_MODEL_URL: `${base}/llm/framework/v1/`, FLOW_FRAMEWORK_RUN_KIND: "test" }, async () => {
    const request = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], signal: new AbortController().signal };
    const flow = flowModel();
    const other = openAICompatible({ apiKey: "k", baseURL: `${base}/other/v1` });
    process.env.FLOW_FRAMEWORK_TEST_SESSION = SESSION;
    await flow.complete(request);
    await other.complete(request);
    process.env.FLOW_FRAMEWORK_TEST_SESSION = "tse_123";
    await flow.complete(request);
    process.env.FLOW_FRAMEWORK_TEST_SESSION = SESSION;
    delete process.env.FLOW_FRAMEWORK_RUN_KIND;
    await flow.complete(request);
  });
  assert.deepEqual(seen, [
    ["/chat/completions", SESSION],
    ["/chat/completions", undefined],
    ["/chat/completions", undefined],
    ["/chat/completions", undefined],
  ]);
});

test("under flow test flowTranscribe and describeVideoWith (describing and asking) through Flow carry the session id too", async (t) => {
  const { base, seen } = await gateway(t);
  await withEnv({ FLOW_KEY: FAKE, FLOW_MODEL_URL: `${base}/llm/framework/v1`, FLOW_FRAMEWORK_RUN_KIND: "test", FLOW_FRAMEWORK_TEST_SESSION: SESSION }, async () => {
    assert.deepEqual(await flowTranscribe(new Uint8Array([1])), { text: "hi" });
    const describe = describeVideoWith("google/gemini-3.8-flash");
    assert.equal(await describe({ mime: "video/mp4", data: new Uint8Array([1]) }), "ok");
    assert.equal(await describe.ask!({ mime: "video/mp4", data: new Uint8Array([1]) }, "What colour is it?"), "ok");
  });
  assert.deepEqual(seen, [["/audio/transcriptions", SESSION], ["/chat/completions", SESSION], ["/chat/completions", SESSION]]);
});

// ---------- prompt caching and where a call's time goes ----------

/** A model server that records each chat request's body and answers with `answer`. */
async function recording(t: { after: (fn: () => void) => void }, answer: (res: ServerResponse, body: { stream?: boolean }, call: number) => void) {
  const bodies: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => { text += c; });
    req.on("end", () => {
      const body = JSON.parse(text);
      bodies.push(body);
      answer(res, body, bodies.length);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

const ASK = { system: "Be brief.\n\nRules.\n\n[Flow] It is now 14:02.", stableSystem: "Be brief.\n\nRules.", messages: [{ role: "user" as const, content: "hi" }], tools: [], signal: new AbortController().signal };

test("a Claude model's stable system text and last message carry cache_control, what changes per call follows them, and the cache numbers the provider reports come back", async (t) => {
  const { base, bodies } = await recording(t, (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 15 } } }));
  });
  const claude = openAICompatible({ apiKey: "k", baseURL: base, model: "anthropic/claude-haiku-5.5" });
  const answer = await claude.complete({ ...ASK, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "look", arguments: "{}" }] }, { role: "tool", toolCallId: "t1", content: "found" }] });
  assert.deepEqual(answer.usage, { inputTokens: 100, outputTokens: 2, cacheReadTokens: 80, cacheWriteTokens: 15 });
  const [system, user, assistant, tool, rest] = bodies[0].messages;
  assert.deepEqual(system.content, [{ type: "text", text: "Be brief.\n\nRules.", cache_control: { type: "ephemeral" } }]);
  assert.equal(user.content, "hi");
  assert.equal(assistant.content, "");
  assert.deepEqual(tool, { role: "tool", tool_call_id: "t1", content: [{ type: "text", text: "found", cache_control: { type: "ephemeral" } }] });
  assert.deepEqual(rest, { role: "user", content: "[Flow] It is now 14:02." }, "what changes with the call follows the conversation, unmarked, and the text is the same");
});

test("a model that needs no marker, or with promptCaching off, gets the plain messages; a provider that reports no cache numbers leaves them out", async (t) => {
  const { base, bodies } = await recording(t, (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2 } }));
  });
  const plain = { apiKey: "k", baseURL: base };
  assert.deepEqual((await openAICompatible({ ...plain, model: "openai/gpt-6-luna" }).complete(ASK)).usage, { inputTokens: 100, outputTokens: 2 });
  await openAICompatible({ ...plain, model: "anthropic/claude-haiku-5.5", promptCaching: false }).complete(ASK);
  await openAICompatible({ ...plain, model: "my-claude", promptCaching: true }).complete(ASK);
  assert.deepEqual(bodies[0].messages, [{ role: "system", content: ASK.system }, { role: "user", content: "hi" }]);
  assert.deepEqual(bodies[1].messages, bodies[0].messages);
  assert.equal(bodies[2].messages[0].content[0].cache_control.type, "ephemeral");
});

test("through Flow a call is streamed and its time split: the wait (a retry and Flow's queue), the first token, the rest; tool calls and usage are put together", async (t) => {
  const { base, bodies } = await recording(t, (res, body, call) => {
    if (call === 1) {
      res.writeHead(429, { "content-type": "application/json", "retry-after-ms": "60" });
      return void res.end(JSON.stringify({ error: { message: "busy", type: "rate_limit_error", code: "rate_limit_exceeded" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "server-timing": "flow-queue;dur=25" });
    const chunk = (delta: object, extra: object = {}) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "anthropic/claude-haiku-5.5", choices: [{ index: 0, delta, ...extra }] })}\n\n`);
    chunk({ role: "assistant", content: "" });
    chunk({ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "look", arguments: '{"q"' } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }, { index: 1, id: "t2", type: "function", function: { name: "other", arguments: "" } }] });
    res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "anthropic/claude-haiku-5.5", choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, cost: 0.001, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await withEnv({ FLOW_KEY: FAKE, FLOW_MODEL_URL: `${base}/llm/framework/v1` }, async () => {
    const answer = await flowModel().complete(ASK);
    assert.equal(bodies[1].stream, true);
    assert.deepEqual(answer.toolCalls, [{ id: "t1", name: "look", arguments: '{"q":"x"}' }, { id: "t2", name: "other", arguments: "{}" }]);
    assert.deepEqual(answer.usage, { inputTokens: 50, outputTokens: 7, costUsd: 0.001, cacheReadTokens: 0 }, "reported and none cached: 0, not left out");
    const { queuedMs, ttftMs, generationMs } = answer.timing!;
    assert.ok(queuedMs >= 60 + 25, `the retry's wait and Flow's queue are queued: ${queuedMs}`);
    assert.ok(Number.isInteger(ttftMs) && ttftMs >= 0 && Number.isInteger(generationMs) && generationMs >= 0);
  });
});

test("a streamed request answered with no stream is an error, not an empty reply", async (t) => {
  const { base } = await recording(t, (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await withEnv({ FLOW_KEY: FAKE, FLOW_MODEL_URL: `${base}/llm/framework/v1` }, () => assert.rejects(flowModel().complete(ASK), /no stream/));
});

test("model calls started together are all sent at once, none waits for another's answer", async (t) => {
  // Node 26's built-in fetch sends HTTP/2 requests with a body one at a time per connection, so calls made together queued behind each other.
  const open: ServerResponse[] = [];
  let allArrived!: () => void;
  const all = new Promise<void>((resolve) => { allArrived = resolve; });
  const { base } = await recording(t, (res) => {
    open.push(res);
    if (open.length === 3) allArrived();
  });
  const model = openAICompatible({ model: "m", apiKey: "k", baseURL: base });
  const calls = [1, 2, 3].map(() => model.complete(ASK));
  await all; // all three reached the server while none has been answered
  for (const res of open) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
  }
  assert.deepEqual((await Promise.all(calls)).map((c) => c.text), ["ok", "ok", "ok"]);
});

test("an abort while a streamed answer is arriving ends the call with an error instead of waiting for the rest", async (t) => {
  let started!: () => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const { base } = await recording(t, (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": started\n\n");
    started();
  });
  const controller = new AbortController();
  const call = openAICompatible({ model: "m", apiKey: "k", baseURL: base }).complete({ ...ASK, signal: controller.signal });
  await begun;
  controller.abort();
  await assert.rejects(call);
});
