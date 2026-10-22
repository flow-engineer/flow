// Tools are plain functions with a zod input. The runtime decides at call time whether one runs
// in the reply or carries on in the background; tool authors mark nothing.

import { z } from "zod";
import type { ToolSpec } from "./types.ts";

export interface ToolContext {
  conversationId: string;
  /**
   * Who the person is, as Flow Framework verified it, in one of three forms: `key:<resolve's value>` when
   * the owner's `resolve` knew them, else `phone:<E.164>` (`phone:+15551234567`) for a number a
   * phone channel verified, else `<channel>:<address>`. It is the stable id to key a person's data
   * by, never an id the model passed. To look them up in your own backend, use `key`.
   */
  person: string;
  /** Exactly what the owner's `resolve` returned for this person (no `key:`), or null when they are known only by phone or channel and address. */
  key: string | null;
  /** The channel of their latest message. */
  channel: string;
  /** Provider/server-issued address on a chat channel; absent for standalone MCP calls. */
  address?: string;
  /** The model's id for this call, as the history keeps it. */
  callId: string;
  /**
   * The same for the same tool with the same input in the same turn, also when that turn runs
   * again after a restart (a cut-off call is not rerun, but the agent may call it again): pass it
   * to your backend so a booking or payment happens once.
   */
  idempotencyKey: string;
  /** Aborted when the conversation closes (the person was forgotten): stop and drop the work. */
  signal: AbortSignal;
  /** Server-side backend access for this verified person. Never supplied by the model or serialized into history or traces. */
  credentials?: Credentials;
  /**
   * Small values kept for this person in the agent's store (an onboarding step, a chosen plan):
   * read live, written at once. The model sees them only where your instructions or tools show
   * them. Absent outside a conversation (a standalone MCP call). Never serialized into traces.
   */
  values?: PersonValues;
}

/** A person's values: JSON, at most 64 per person, 4 KB each, names like `onboarding.step`. A refused set throws, in words the model can read. */
export interface PersonValues {
  get<T = unknown>(name: string): Promise<T | undefined>;
  /** null deletes it. */
  set(name: string, value: unknown): Promise<void>;
  all(): Promise<Record<string, unknown>>;
}

/** A business supplies named backend credentials or clients, resolved afresh for the verified person. */
export type CredentialProvider = (name: string, context: Readonly<Omit<ToolContext, "credentials">>) => unknown | Promise<unknown>;

export interface Credentials {
  /** The business decides how to obtain, refresh and revoke access. The name is written by the tool author, not an account id from the model. */
  get<T = unknown>(name: string): Promise<T>;
}

/** Server-side identity at a chat tool boundary. No credentials or model-supplied account ids. */
export interface ChatAuthContext {
  conversationId: string;
  person: string;
  key: string | null;
  channel: string;
  address: string;
  tool: string;
  signal: AbortSignal;
}

/** Brand-owned login: OAuth, an existing login page, verified phone, or a custom challenge. */
export interface ChatAuth {
  /** Recheck a resolved account's current access. Without this, a non-null resolved key is enough. */
  verify?: (context: Readonly<ChatAuthContext>) => boolean | Promise<boolean>;
  /** Called only when a protected operation needs authentication. A custom in-chat prompt needs no URL. */
  signIn: (context: Readonly<ChatAuthContext>) => { message: string; url?: string } | Promise<{ message: string; url?: string }>;
}

/** Bind backend access without putting secrets on an enumerable context or in any event. */
export function toolContext(context: Omit<ToolContext, "credentials">, provider?: CredentialProvider): ToolContext {
  const identity = Object.freeze({ ...context });
  if (provider) Object.defineProperty(context, "credentials", {
    value: Object.freeze({ get: <T = unknown>(name: string) => Promise.resolve().then(() => provider(name, identity)) as Promise<T> }),
    enumerable: false,
  });
  return context;
}

export interface Tool<Input = any> {
  name: string;
  description: string;
  input: z.ZodType<Input>;
  run(input: Input, context: ToolContext): Promise<unknown> | unknown;
  /** The longest the reply waits for this tool before it moves to the background (default: the agent's, 60 s). */
  deadlineMs?: number;
  // Metadata shared with other surfaces (MCP, the CLI).
  /** A name for people ("Place an order"); derived from `name` when absent. */
  title?: string;
  /** The result's shape. Over MCP the result is checked against it and sent as structured content too. */
  output?: z.ZodType;
  /** Short lines a host shows while the tool runs and once it is done (at most 64 characters each). */
  status?: { running?: string; done?: string };
  /**
   * Whether the person must be signed in. "required" (the default) refuses a call without sign-in,
   * "optional" runs either way, "none" never needs it. Enforced where sign-in is configured:
   * createAgent({ auth }) for chat, or mcpServer({ auth }) for MCP. Existing agents without auth
   * keep their current behaviour.
   */
  signIn?: SignIn;
  /** How the tool behaves, for hosts to decide what to ask the person first. Nothing enforces them. */
  hints?: ToolHints;
}

export type SignIn = "required" | "optional" | "none";

export interface ToolHints {
  /** It changes nothing (default false: a tool counts as a write). */
  readOnly?: boolean;
  /** A write that may delete or overwrite (default true for writes; always false for reads). */
  destructive?: boolean;
  /** Calling it again with the same input changes nothing more (default false). */
  idempotent?: boolean;
  /** It reaches things outside the business's own systems, such as the web (default true). */
  openWorld?: boolean;
}

/**
 * Marks a tool the test cloud plays in place of a built-in (get_user_profile): it is offered only
 * to an agent that has that built-in, and then instead of it, so a test never runs the real one.
 */
export const STAND_IN = Symbol("chinwag.standIn");

export function tool<Input>(definition: Tool<Input>): Tool<Input> {
  return definition;
}

/**
 * Marks a tool whose input schema is given as JSON Schema (a tool another MCP server defines): the
 * model is shown that schema exactly, not one rebuilt from the zod that validates it.
 */
export const INPUT_SCHEMA = Symbol("chinwag.inputSchema");

export function toSpec(t: Tool): ToolSpec {
  const given = (t as { [INPUT_SCHEMA]?: Record<string, unknown> })[INPUT_SCHEMA];
  const { $schema: _ignored, ...parameters } = given ?? (z.toJSONSchema(t.input) as Record<string, unknown>);
  return { name: t.name, description: t.description, parameters };
}

/** A tool's output as the model reads it. */
export function render(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output ?? null);
  } catch {
    return String(output);
  }
}
