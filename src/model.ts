// Models over the OpenAI-compatible chat API: OpenRouter by default; OpenAI, Gemini, Anthropic or a
// local server by changing the base URL; or Flow, with the agent's FLOW_KEY that `flow setup` writes,
// which needs no provider key and spends the account's Flow trial credit. Flow also turns audio into
// text with the same key (flowTranscribe), and describeVideoWith has a video model describe a video
// for one that can't watch it, through the same key.

import { Buffer } from "node:buffer";
import OpenAI from "openai";
import { setting } from "./names.ts";
import type { ChatMessage, DescribeVideo, Model, ModelRequest, ModelResponse } from "./types.ts";

export interface OpenAICompatibleOptions {
  /** The provider's model id. When omitted, the key in the environment picks a default. */
  model?: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  /** The model sees photos (OpenAI-style image_url parts). Default true; false for a text-only model. */
  images?: boolean;
  /** The model reads PDFs (file parts). Default true on OpenRouter, which reads them for any model; false elsewhere. */
  pdfs?: boolean;
  /**
   * The model watches videos (OpenRouter's video_url parts, a base64 data URL): true for one that
   * does, such as google/gemini-3.8-flash through OpenRouter or Flow. Default false.
   */
  videos?: boolean;
  /** Its context window in tokens, so the history sent is kept within it. */
  contextTokens?: number;
  /**
   * The most tokens one reply may use. Unset, a provider such as OpenRouter takes the model's own
   * maximum and holds credit for it on every call.
   */
  maxTokens?: number;
}

/** Flow's OpenAI-compatible model API, reached with FLOW_KEY. */
export const FLOW_MODEL_URL = "https://flow.engineer/llm/framework/v1";

/**
 * Where FLOW_KEY is sent for the model: FLOW_MODEL_URL when set, else the origin of the Flow server the CLI
 * signs in to (FLOW_FRAMEWORK_LOGIN_URL) with /llm/framework/v1, else flow.engineer's.
 */
export function flowModelURL(env: Record<string, string | undefined> = process.env): string {
  const named = env.FLOW_MODEL_URL?.trim();
  if (named) return named;
  const login = URL.parse(setting("LOGIN_URL", env)?.trim() ?? "");
  return login ? `${login.origin}/llm/framework/v1` : FLOW_MODEL_URL;
}

/**
 * The first of these with a value is the agent's model. `MODEL` overrides that provider's default id.
 * Flow's key is last, so a provider key the owner adds wins over the FLOW_KEY setup wrote.
 */
const KEYS = [
  { env: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1", model: "anthropic/claude-haiku-5.5" },
  { env: "OPENAI_API_KEY", baseURL: "https://api.openai.com/v1", model: "gpt-6-luna" },
  { env: "ANTHROPIC_API_KEY", baseURL: "https://api.anthropic.com/v1/", model: "claude-haiku-5-5" },
  { env: "GEMINI_API_KEY", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3.8-flash" },
  { env: "FLOW_KEY", baseURL: FLOW_MODEL_URL, model: "anthropic/claude-haiku-5.5" },
] as const;

/** The .env names a model key may be on, in the order they are read. */
export const MODEL_KEY_NAMES: readonly string[] = KEYS.map((k) => k.env);

/**
 * What to tell the owner when no model key is set, said the same way by `chat`, `npm start`,
 * `init`, `setup` and `link`: one sentence, and `next` as a command (`nextLine` is how it is printed).
 */
export const NO_MODEL_KEY = {
  code: "no_model_key",
  message: `This agent has no model key: npx @flow-engineer/flow setup writes FLOW_KEY, the agent's Flow key (with the account's free trial model credit), into .env in the agent's folder, or put your own on one of the lines ${KEYS.slice(0, -2).map((k) => `${k.env}=`).join(", ")} or ${KEYS.at(-2)!.env}= (an OpenRouter key is made at https://openrouter.ai/keys).`,
  next: "npx @flow-engineer/flow setup",
  nextLine: "Next: run npx @flow-engineer/flow setup to get Flow's free trial credit, or add your own key.",
} as const;

/** True when the environment names a model key with a value. */
export const hasModelKey = (env: Record<string, string | undefined>) => KEYS.some((k) => Boolean(env[k.env]?.trim()));

/** Which key, address and model an omitted `apiKey` / `baseURL` resolve to. */
export function modelFromKeys(env: Record<string, string | undefined>): { apiKey?: string; baseURL: string; model: string } {
  const named = env.MODEL?.trim();
  for (const provider of KEYS) {
    const apiKey = env[provider.env]?.trim();
    if (apiKey) return { apiKey, baseURL: provider.env === "FLOW_KEY" ? flowModelURL(env) : provider.baseURL, model: named || provider.model };
  }
  return { baseURL: KEYS[0].baseURL, model: named || KEYS[0].model };
}

export function openAICompatible(options: OpenAICompatibleOptions = {}): Model {
  // An explicit key or address is that provider. Otherwise the first key in the environment wins.
  const fromEnv = options.apiKey !== undefined || options.baseURL !== undefined ? undefined : modelFromKeys(process.env);
  const baseURL = options.baseURL ?? fromEnv?.baseURL ?? KEYS[0].baseURL;
  const apiKey = options.apiKey ?? fromEnv?.apiKey ?? (process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());
  // A server at a base URL you name (a local one) may need no key; the client still sends one.
  // Code that builds its model itself can also pass apiKey, or baseURL for a server that needs none.
  if (!apiKey && options.baseURL === undefined) {
    throw Object.assign(new Error(`${NO_MODEL_KEY.message}\n${NO_MODEL_KEY.nextLine}`), { code: NO_MODEL_KEY.code, next: NO_MODEL_KEY.next });
  }
  const client = new OpenAI({
    apiKey: apiKey || "none",
    baseURL,
    maxRetries: 1,
  });
  const model = options.model?.trim() || fromEnv?.model || KEYS[0].model;
  // Flow reads PDFs for every model it offers, as OpenRouter (behind it) does.
  const readsPdfs = baseURL.startsWith("https://openrouter.ai/") || baseURL === flowModelURL(process.env);
  return {
    reads: { images: options.images ?? true, pdfs: options.pdfs ?? readsPdfs, videos: options.videos ?? false },
    ...(options.contextTokens ? { contextTokens: options.contextTokens } : {}),
    async complete(request: ModelRequest): Promise<ModelResponse> {
      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await client.chat.completions.create(
          {
            model,
            temperature: options.temperature,
            ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
            messages: [{ role: "system", content: request.system }, ...request.messages.map(toWire)],
            ...(request.tools.length
              ? { tools: request.tools.map((t) => ({ type: "function" as const, function: t })) }
              : {}),
          },
          { signal: request.signal, headers: testSessionHeader(baseURL) },
        );
      } catch (error) {
        throw flowError(error) ?? error;
      }
      const message = completion.choices[0]?.message;
      return {
        text: message?.content?.trim() || null,
        toolCalls: (message?.tool_calls ?? [])
          .filter((call) => call.type === "function")
          .map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" })),
        usage: completion.usage ? { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens, ...costOf(completion.usage) } : undefined,
        model: completion.model,
      };
    },
  };
}

/**
 * The model through Flow: FLOW_KEY (written by `flow setup`) at {@link flowModelURL}, the
 * account's Flow trial credit paying. `model` is one Flow offers (default anthropic/claude-haiku-5.5;
 * GET /models lists them). With no key it fails when made, with a next step.
 */
export function flowModel(options: Omit<OpenAICompatibleOptions, "baseURL"> = {}): Model {
  const apiKey = flowKey(options.apiKey);
  return openAICompatible({ ...options, apiKey, baseURL: flowModelURL(process.env), model: options.model?.trim() || process.env.MODEL?.trim() || KEYS.at(-1)!.model });
}

/** A test cloud session's id: tse_ and 26 Crockford base32 characters. */
const TEST_SESSION_ID = /^tse_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Under `flow test`, a call to Flow's gateway carries the test cloud's session id (Flow-Test-Session),
 * which Flow confirms with the test cloud before it counts the call as test spend. Read when the call
 * is made, since the CLI sets the id once the session opens, after the model is made; never sent to
 * any other address.
 */
function testSessionHeader(baseURL: string): Record<string, string> | undefined {
  const session = setting("TEST_SESSION");
  if (setting("RUN_KIND") !== "test" || !session || !TEST_SESSION_ID.test(session)) return undefined;
  const bare = (url: string) => url.replace(/\/+$/, "");
  return bare(baseURL) === bare(flowModelURL(process.env)) ? { "Flow-Test-Session": session } : undefined;
}

/** The key sent to Flow: the one given, else FLOW_KEY; with neither it fails with the next step. */
function flowKey(given?: string): string {
  const apiKey = given?.trim() || process.env.FLOW_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(new Error(`FLOW_KEY is not set: npx @flow-engineer/flow setup writes it into .env in the agent's folder.\nNext: run ${NO_MODEL_KEY.next}.`), { code: NO_MODEL_KEY.code, next: NO_MODEL_KEY.next });
  }
  return apiKey;
}

export interface FlowTranscribeOptions {
  /** The language spoken, as a code ("en", "hi", "pt-BR"); when omitted it is detected. */
  language?: string;
  /** The file's name sent with it, whose extension tells its format. Default "audio.ogg". */
  filename?: string;
  /** The file's media type ("audio/ogg"), used when `audio` is not already a Blob that has one. */
  mimeType?: string;
}

/**
 * A voice note or other audio as text, through Flow: FLOW_KEY at {@link flowModelURL}'s
 * /audio/transcriptions, the account's Flow credit paying. Files are at most 15 MB. Resolves to
 * `{ text }` (empty when nothing was said); Flow's typed errors (file_too_large, trial_credit_used,
 * rate_limit_exceeded, ...) reject with their message and next step, and `code` and `status` on the
 * error. With no key it fails at once, as flowModel does.
 */
export async function flowTranscribe(audio: Blob | ArrayBuffer | Uint8Array, options: FlowTranscribeOptions = {}): Promise<{ text: string }> {
  const apiKey = flowKey();
  const file = audio instanceof Blob && !options.mimeType ? audio : new Blob([audio as BlobPart], { type: options.mimeType ?? (audio instanceof Blob ? audio.type : "") });
  const form = new FormData();
  form.append("file", file, options.filename ?? (typeof File !== "undefined" && audio instanceof File && audio.name ? audio.name : "audio.ogg"));
  if (options.language?.trim()) form.append("language", options.language.trim());
  const url = flowModelURL(process.env);
  const response = await fetch(`${url.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, ...testSessionHeader(url) },
    body: form,
  });
  const body = (await response.json().catch(() => undefined)) as { text?: unknown; error?: { message?: unknown; code?: unknown; next?: unknown } } | undefined;
  if (response.ok && typeof body?.text === "string") return { text: body.text };
  const error = body?.error;
  const message = typeof error?.message === "string" && error.message.trim() ? error.message.trim() : `Flow could not transcribe the audio (HTTP ${response.status}).`;
  const next = typeof error?.next === "string" && error.next ? error.next : undefined;
  throw Object.assign(new Error(next ? `${message}\nNext: ${next}` : message), {
    code: typeof error?.code === "string" ? error.code : `http_${response.status}`,
    ...(next ? { next } : {}),
    status: response.status,
  });
}

/**
 * A typed error from Flow's model API ({"error": {message, type, code, next}}: trial_credit_used,
 * invalid_api_key, rate_limit_exceeded, ...) as an Error with its message and next step; undefined
 * for any other error, which is thrown as it came.
 */
function flowError(error: unknown): Error | undefined {
  if (!(error instanceof OpenAI.APIError)) return undefined;
  const body = error.error as { message?: unknown; code?: unknown; next?: unknown } | undefined;
  if (typeof body?.next !== "string" || !body.next || typeof body.message !== "string") return undefined;
  const sentence = body.message.trim();
  return Object.assign(new Error(`${sentence}\nNext: ${body.next}`, { cause: error }), {
    code: typeof body.code === "string" ? body.code : `http_${error.status}`,
    next: body.next,
    status: error.status,
  });
}

function toWire(message: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  if (message.role === "user") {
    const media = (message.media ?? []).filter((m) => m.data);
    if (!media.length) return { role: "user", content: message.content };
    return {
      role: "user",
      content: [
        { type: "text", text: message.content },
        ...media.map((m): OpenAI.Chat.ChatCompletionContentPart => {
          if (m.kind === "video") return videoPart(m.mime, m.data!);
          const url = `data:${m.mime};base64,${m.data}`;
          return m.kind === "image" ? { type: "image_url", image_url: { url } } : { type: "file", file: { filename: m.name ?? "document.pdf", file_data: url } };
        }),
      ],
    };
  }
  return {
    role: "assistant",
    content: message.content,
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  };
}

/** OpenRouter's video part (not in the OpenAI SDK's types): the video as a base64 data URL. */
function videoPart(mime: string, base64: string): OpenAI.Chat.ChatCompletionContentPart {
  return { type: "video_url", video_url: { url: `data:${videoMime(mime)};base64,${base64}` } } as unknown as OpenAI.Chat.ChatCompletionContentPart;
}

/** A video's type as OpenRouter and Gemini name it: QuickTime is video/mov. */
const videoMime = (mime: string) => (mime === "video/quicktime" ? "video/mov" : mime);

/** What the video model is asked (model-facing text, kept short). */
const DESCRIBE_VIDEO = "Describe this video for an assistant that cannot watch it, in a few sentences: what it shows, any text on screen, and what is said in it (word for word when it is short). Say only what is in the video.";

/** What a video model is asked for ask_about_video (model-facing text, kept short): the agent's question, as data. */
export function videoQuestion(question: string): string {
  return `An assistant that cannot watch this video asks the question below. Answer it in a few sentences from what the video shows and what is said in it. If the video does not show the answer, say so; say only what is in the video.\nQuestion: ${question}`;
}

export interface DescribeVideoOptions {
  /** The key, and the address it goes to; when both are omitted, the agent's model key in the environment. */
  apiKey?: string;
  baseURL?: string;
}

/** The keys a video model is reached with, in the order the agent's model reads them: OpenAI's and Anthropic's APIs take no video. */
const VIDEO_KEYS = KEYS.filter((k) => k.env !== "OPENAI_API_KEY" && k.env !== "ANTHROPIC_API_KEY");
const GEMINI = "https://generativelanguage.googleapis.com/";

/**
 * Flow Framework's own `describeVideo`: `model` (a video model, such as google/gemini-3.8-flash)
 * describes each video the agent's model can't watch, what it shows and what is said, and the agent
 * reads that text in its place. It goes through the agent's model key, so it needs no other: Flow's
 * FLOW_KEY or an OpenRouter key (video_url parts), or a Gemini key (Gemini's generateContent, the
 * model's id without "google/"). With only an OpenAI or Anthropic key it fails when made, naming the
 * key to add. Its `ask(video, question)` answers the agent's questions about a video with the same
 * model (ask_about_video). The video is sent with each call, as base64; nothing is kept.
 */
export function describeVideoWith(model: string, options: DescribeVideoOptions = {}): DescribeVideo {
  const id = model.trim();
  if (!id) throw new Error("describeVideoWith: name a model that watches videos, such as google/gemini-3.8-flash.");
  let { apiKey, baseURL } = options;
  if (apiKey === undefined && baseURL === undefined) {
    const found = VIDEO_KEYS.find((k) => process.env[k.env]?.trim());
    if (!found) {
      const has = MODEL_KEY_NAMES.find((name) => process.env[name]?.trim());
      throw Object.assign(
        new Error(`describeVideoWith needs a key that reaches a video model${has ? ` (${has} does not: OpenAI's and Anthropic's APIs take no video)` : ""}: FLOW_KEY (npx @flow-engineer/flow setup writes it), OPENROUTER_API_KEY= or GEMINI_API_KEY= in the agent's .env.\nNext: run ${NO_MODEL_KEY.next}, or add one of those keys.`),
        { code: "no_video_key", next: NO_MODEL_KEY.next },
      );
    }
    apiKey = process.env[found.env]!.trim();
    baseURL = found.env === "FLOW_KEY" ? flowModelURL(process.env) : found.baseURL;
  }
  const url = baseURL ?? KEYS[0].baseURL;
  const watch = url.startsWith(GEMINI) ? geminiWatcher(id.replace(/^google\//, ""), apiKey ?? "") : openAIWatcher(id, url, apiKey);
  return Object.assign((video: { mime: string; data: Uint8Array }) => watch(DESCRIBE_VIDEO, video), {
    ask: (video: { mime: string; data: Uint8Array }, question: string) => watch(videoQuestion(question), video),
  });
}

/** A video model asked one thing about a video: the text, then the video. */
type Watch = (prompt: string, video: { mime: string; data: Uint8Array }) => Promise<string>;

/** On FLOW_KEY or OpenRouter (or any OpenAI-compatible server): a video_url part. */
function openAIWatcher(model: string, url: string, apiKey: string | undefined): Watch {
  const client = new OpenAI({ apiKey: apiKey || "none", baseURL: url, maxRetries: 1, timeout: 120_000 });
  return async (prompt, video) => {
    let completion: OpenAI.Chat.ChatCompletion;
    try {
      completion = await client.chat.completions.create({
        model,
        max_tokens: 1_024,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, videoPart(video.mime, Buffer.from(video.data).toString("base64"))] }],
      }, { headers: testSessionHeader(url) });
    } catch (error) {
      throw flowError(error) ?? error;
    }
    return completion.choices[0]?.message?.content?.trim() ?? "";
  };
}

/** On a Gemini key: Gemini's own generateContent with the video inline (its OpenAI-compatible API takes no video). */
function geminiWatcher(model: string, apiKey: string): Watch {
  return async (prompt, video) => {
    const response = await fetch(`${GEMINI}v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: videoMime(video.mime), data: Buffer.from(video.data).toString("base64") } }] }] }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json().catch(() => undefined)) as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>; error?: { message?: unknown } } | undefined;
    if (!response.ok) throw new Error(`Gemini could not watch the video (HTTP ${response.status})${typeof body?.error?.message === "string" ? `: ${body.error.message}` : "."}`);
    return (body?.candidates?.[0]?.content?.parts ?? []).map((p) => (typeof p.text === "string" ? p.text : "")).join("").trim();
  };
}

/** OpenRouter adds the call's cost in US dollars to usage; other providers leave it out. */
function costOf(usage: object): { costUsd?: number } {
  const cost = (usage as { cost?: unknown }).cost;
  return typeof cost === "number" ? { costUsd: cost } : {};
}
