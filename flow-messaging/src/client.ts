// A small client for Flow Messaging (api.flow.engineer), against its OpenAPI spec, version
// 2026-11-01: plain fetch, only the calls the channels and the webhook make.
//
// Every POST carries an Idempotency-Key, and a retry repeats the same key, so a send is never made
// twice. A 429 or a 5xx is tried again in place after its Retry-After when that is short; a longer
// wait, or any other error, is raised as FlowMessagingError (the spec's typed error). Keys and
// message text are never logged.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const API_VERSION = "2026-11-01";
const TRIES = 3;
/** The longest Retry-After waited out in place (seconds); a longer one is the caller's. */
const MAX_WAIT = 10;
const TIMEOUT_MS = 20_000;
/** How far a webhook's signed timestamp may be from now (seconds), as the spec says. */
const SIGNATURE_TOLERANCE = 300;

/** The spec's typed error ({"error": {type, message, channel_code, retry_after, ...}}), or "network". */
export class FlowMessagingError extends Error {
  readonly status: number;
  readonly type: string;
  readonly channelCode?: string;
  readonly retryAfter?: number;

  constructor(status: number, type: string, message: string, extra: { channelCode?: string; retryAfter?: number } = {}) {
    super(message);
    this.name = "FlowMessagingError";
    this.status = status;
    this.type = type;
    this.channelCode = extra.channelCode;
    this.retryAfter = extra.retryAfter;
  }

  /** Worth trying again later: rate limits, Flow's or the channel's 5xx, no answer. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500 || (this.type === "idempotency_conflict" && this.channelCode === "in_progress");
  }
}

/**
 * One of Flow's object IDs as a URL path segment: `<prefix>_` and letters, digits, `_` or `-` (Flow
 * makes `<prefix>_<ULID>`). IDs come from inbound events and callers, and every request carries the
 * key, so anything else (a `/`, `..`, `?`) is refused rather than sent to another path.
 */
export function idSegment(prefix: string, id: unknown): string {
  if (typeof id !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(id)) {
    throw new Error(`not a Flow Messaging ${prefix}_ id: ${JSON.stringify(String(id)).slice(0, 80)}`);
  }
  return encodeURIComponent(id);
}

export class Client {
  private readonly apiKey: string;
  readonly baseUrl: string;

  constructor(options: { apiKey: string; baseUrl: string }) {
    this.apiKey = options.apiKey;
    let end = options.baseUrl.length;
    while (end > 0 && options.baseUrl[end - 1] === "/") end--;
    this.baseUrl = options.baseUrl.slice(0, end);
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /** A file's bytes: GET /v1/files/{id} answers them or redirects to a signed URL, which fetch follows without the key. */
  async download(fileId: string): Promise<Uint8Array> {
    const path = `/v1/files/${idSegment("file", fileId)}`;
    if (!this.apiKey) throw new Error("set FLOW_MESSAGING_KEY (or pass apiKey) to reach Flow Messaging");
    const response = await fetch(this.baseUrl + path, { headers: { authorization: `Bearer ${this.apiKey}`, "flow-version": API_VERSION }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw await errorOf(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** A POST with its own Idempotency-Key, kept across the retries of this one call; `tries: 1` for courtesies. */
  post<T>(path: string, body: unknown, tries = TRIES): Promise<T> {
    return this.request<T>("POST", path, body, randomUUID(), tries);
  }

  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string, tries = TRIES): Promise<T> {
    if (!this.apiKey) throw new Error("set FLOW_MESSAGING_KEY (or pass apiKey) to reach Flow Messaging");
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, "flow-version": API_VERSION };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let last: FlowMessagingError | undefined;
    for (let attempt = 1; attempt <= tries; attempt++) {
      let response: Response;
      try {
        response = await fetch(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (error) {
        last = new FlowMessagingError(0, "network", `no answer from Flow Messaging (${error instanceof Error ? error.name : "error"})`);
        if (attempt < tries) await wait(2 ** (attempt - 1));
        continue;
      }
      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      last = await errorOf(response);
      const pause = last.retryAfter ?? 2 ** (attempt - 1);
      if (!last.retryable || attempt === tries || pause > MAX_WAIT) throw last;
      await wait(pause);
    }
    throw last!;
  }
}

async function errorOf(response: Response): Promise<FlowMessagingError> {
  let body: { type?: string; message?: string; channel_code?: string; retry_after?: number } = {};
  try {
    const parsed = (await response.json()) as { error?: typeof body };
    if (parsed && typeof parsed.error === "object") body = parsed.error;
  } catch {}
  const header = Number(response.headers.get("retry-after"));
  const retryAfter = typeof body.retry_after === "number" ? body.retry_after : Number.isFinite(header) && response.headers.has("retry-after") ? header : undefined;
  const type = body.type ?? (response.status >= 500 ? "api_error" : "invalid_request");
  return new FlowMessagingError(response.status, type, body.message ?? `Flow Messaging answered ${response.status}`, { channelCode: body.channel_code, retryAfter });
}

const wait = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Flow-Signature: `t=<unix seconds>,v1=<hex>[,v1=<hex>]`. Each v1 is HMAC-SHA256, under one of the
 * endpoint's signing secrets, of `t.<t>.<raw body>`; any match within five minutes of now passes
 * (two secrets overlap while one is rotated).
 */
export function verifySignature(body: Buffer, header: string | undefined, secrets: string[], nowSeconds = Date.now() / 1000): boolean {
  let stamp = "";
  const given: string[] = [];
  for (const part of (header ?? "").split(",")) {
    const [key, value = ""] = part.trim().split("=", 2);
    if (key === "t") stamp = value;
    else if (key === "v1" && value) given.push(value);
  }
  if (!/^\d+$/.test(stamp) || !given.length || Math.abs(nowSeconds - Number(stamp)) > SIGNATURE_TOLERANCE) return false;
  const signed = Buffer.concat([Buffer.from(`t.${stamp}.`), body]);
  return secrets.some((secret) => {
    const expected = Buffer.from(createHmac("sha256", secret).update(signed).digest("hex"));
    return given.some((value) => value.length === expected.length && timingSafeEqual(Buffer.from(value), expected));
  });
}
