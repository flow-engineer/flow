// covers: src/model.ts
// The agent's model key: the first of OpenRouter, OpenAI, Anthropic and Gemini that has a value,
// else FLOW_MODEL_KEY (Flow's trial credit, at FLOW_MODEL_URL or the CLI's server), with MODEL
// overriding that provider's default id. A blank line is no key, and no key at all fails when the
// model is made, in one sentence naming .env and its lines with a next step, not on the first
// message, unless a base URL is named (a local server needs no key). Flow's typed errors (credit
// used up, ...) come back as its message and next step.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { flowModel, modelFromKeys, openAICompatible } from "../src/model.ts";

const MODEL_ENV = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "FLOW_MODEL_KEY", "FLOW_MODEL_URL", "FLOW_FRAMEWORK_LOGIN_URL", "CHINWAG_LOGIN_URL", "MODEL"];

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

test("FLOW_MODEL_KEY is used only when no provider key is set, at FLOW_MODEL_URL, else the CLI server's /llm/framework/v1, else flow.engineer's", () => {
  assert.deepEqual(modelFromKeys({ FLOW_MODEL_KEY: "fmk_1" }), { apiKey: "fmk_1", baseURL: "https://flow.engineer/llm/framework/v1", model: "anthropic/claude-haiku-5.5" });
  assert.equal(modelFromKeys({ FLOW_MODEL_KEY: "fmk_1", GEMINI_API_KEY: "gem" }).apiKey, "gem", "a provider key the owner adds wins");
  assert.equal(modelFromKeys({ FLOW_MODEL_KEY: "fmk_1", FLOW_FRAMEWORK_LOGIN_URL: "http://127.0.0.1:8000/" }).baseURL, "http://127.0.0.1:8000/llm/framework/v1");
  assert.equal(modelFromKeys({ FLOW_MODEL_KEY: "fmk_1", FLOW_FRAMEWORK_LOGIN_URL: "http://127.0.0.1:8000", FLOW_MODEL_URL: "https://staging.example/v1" }).baseURL, "https://staging.example/v1");
  assert.equal(modelFromKeys({ FLOW_MODEL_KEY: "fmk_1", MODEL: "google/gemini-3.8-flash" }).model, "google/gemini-3.8-flash");
});

test("with no key and no base URL the model fails when it is made: one sentence naming .env's lines and where to get a key, then the next step", () =>
  withEnv({}, () => {
    assert.throws(() => openAICompatible(), {
      message: "This agent has no model key: npx @flow-engineer/flow setup writes FLOW_MODEL_KEY, Flow's free trial key, into .env in the agent's folder, or put your own on one of the lines OPENROUTER_API_KEY=, OPENAI_API_KEY=, ANTHROPIC_API_KEY= or GEMINI_API_KEY= (an OpenRouter key is made at https://openrouter.ai/keys).\nNext: run npx @flow-engineer/flow setup to get Flow's free trial credit, or add your own key.",
      code: "no_model_key",
      next: "npx @flow-engineer/flow setup",
    });
    assert.throws(() => flowModel(), {
      message: "FLOW_MODEL_KEY is not set: npx @flow-engineer/flow setup writes it into .env in the agent's folder.\nNext: run npx @flow-engineer/flow setup.",
      code: "no_model_key",
      next: "npx @flow-engineer/flow setup",
    });
    assert.doesNotThrow(() => openAICompatible({ apiKey: "k" }));
    assert.doesNotThrow(() => openAICompatible({ baseURL: "http://127.0.0.1:11434/v1" }));
  }));

test("a model through Flow sends FLOW_MODEL_KEY and the default model, reads PDFs, and turns Flow's typed error into its message and next step", async (t) => {
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
  await withEnv({ FLOW_MODEL_KEY: "fmk_trial", FLOW_MODEL_URL: url }, async () => {
    const request = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], signal: new AbortController().signal };
    for (const model of [openAICompatible(), flowModel()]) {
      assert.deepEqual(model.reads, { images: true, pdfs: true });
      await assert.rejects(model.complete(request), {
        message: "Flow trial credit used: add your own model key to .env.\nNext: add your own model key to .env (OPENROUTER_API_KEY=..., https://openrouter.ai/keys)",
        code: "trial_credit_used",
        next: "add your own model key to .env (OPENROUTER_API_KEY=..., https://openrouter.ai/keys)",
        status: 402,
      });
    }
  });
  assert.deepEqual(seen, [{ auth: "Bearer fmk_trial", model: "anthropic/claude-haiku-5.5" }, { auth: "Bearer fmk_trial", model: "anthropic/claude-haiku-5.5" }], "a 402 is not tried again");
});
