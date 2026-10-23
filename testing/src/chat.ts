// `flow chat`: talk to the agent in this folder from the terminal, with no account and no channel.
// It builds the agent from src/agent.ts (buildAgent({ events }), as `flow test` does) with the
// model key in .env, and writes as the agent's first test person, the way the playground does
// (agent.simulate). Each line read from stdin is one message; the agent's replies are printed once
// its turn is over, so it works typed by a person or piped by a coding agent:
//   printf 'hi\nA latte please\n' | npx @flow-engineer/flow chat
// --json prints each thing the agent sends as one JSON line, and an error as
// {"error":{"code","message","next"}} (no_model_key, no_agent, not_built, no_test_people,
// no_channel). The conversation lives only as long as the command. Exit status: 0 done (stdin
// ended), 1 usage or the agent could not be built.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Agent, FlowEvent, Outbound, Photo } from "../../src/index.ts";
import { replyButton } from "../../src/channels.ts";
import { NO_MODEL_KEY } from "../../src/model.ts";
import { loadEnv } from "./report.ts";

export const CHAT_LINE = `  flow chat [--channel <name>] [--person <phone>] [--json]
                            Talk to the agent in this folder from the terminal: one message per line
                            of stdin, no account needed (only the model key in .env)`;

const USAGE = `Usage:\n${CHAT_LINE}

Writes as the agent's first test person (createAgent({ testPeople })) on its first channel, unless
--person or --channel says otherwise. Exit status: 0 done, 1 usage or the agent could not be built.`;

/** Runs `flow chat`; resolves to the exit status. */
export async function chatCli(args: string[], input: NodeJS.ReadableStream = process.stdin): Promise<number> {
  let values: { channel?: string; person?: string; json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({ args, strict: true, options: { channel: { type: "string" }, person: { type: "string" }, json: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } } }));
  } catch (error) {
    console.error(`flow chat: ${(error as Error).message.split(". ")[0]}\n\n${USAGE}`);
    return 1;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  loadEnv(undefined);
  const json = values.json === true;
  /** Stops with exit 1: the sentence on stderr, and with --json the error as one JSON line on stdout. */
  const fail = (code: string, message: string, next?: string, nextLine = next ? `Next: ${next}` : undefined) => {
    console.error(`flow chat: ${message}${nextLine ? `\n${nextLine}` : ""}`);
    if (json) process.stdout.write(`${JSON.stringify({ error: { code, message, next: next ?? null } })}\n`);
    return 1;
  };
  const file = join(process.cwd(), "src", "agent.ts");
  if (!existsSync(file)) return fail("no_agent", "There is no src/agent.ts here: run it from your agent's folder.", "npx @flow-engineer/flow init", "Next: npx @flow-engineer/flow init makes one in an empty folder.");
  const turns: Array<(event: FlowEvent) => void> = [];
  let agent: Agent;
  try {
    const module = await import(pathToFileURL(file).href);
    if (typeof module.buildAgent !== "function") throw new Error("src/agent.ts must export buildAgent({ events }).");
    agent = module.buildAgent({ events: [(event: FlowEvent) => turns.forEach((listener) => listener(event))] });
  } catch (error) {
    if ((error as { code?: unknown }).code === NO_MODEL_KEY.code) return fail(NO_MODEL_KEY.code, NO_MODEL_KEY.message, NO_MODEL_KEY.next, NO_MODEL_KEY.nextLine);
    return fail("not_built", (error as Error).message);
  }
  const person = values.person ? agent.testPeople().find((p) => p.phone.replace(/\D/g, "") === values.person!.replace(/\D/g, "")) : agent.testPeople()[0];
  const channel = values.channel ? agent.channels().find((c) => c.name === values.channel) : agent.channels()[0];
  if (!person) return fail("no_test_people", `${values.person ? `${values.person} is not one of the agent's testPeople` : "the agent has no testPeople"}; declare them in createAgent({ testPeople: [{ name, phone }] }).`);
  if (!channel) return fail("no_channel", `${values.channel ? `no channel named ${values.channel}` : "the agent has no channels"}; it has ${agent.channels().map((c) => c.name).join(", ") || "none"}.`);

  // The agent's messages get ids (a1, a2, ...), so on a channel with edits it can name one to change.
  let sent = 0;
  agent.attachPlayground(({ outbound }) => {
    const id = outbound.type === "message" || outbound.type === "carousel" || outbound.type === "template" ? `a${++sent}` : undefined;
    print(outbound, channel.name, json, id);
    return id ? { status: "sent" as const, messageId: id } : undefined;
  });
  turns.push((event) => {
    if (event.type === "model.error") console.error(`flow chat: the model failed: ${String(event.error ?? event.message ?? "error")}`);
  });
  const prompt = (process.stdin as NodeJS.ReadStream).isTTY && input === process.stdin;
  if (!json) console.error(`Talking to the agent on ${channel.name} as ${person.name} (${person.phone}). Ctrl-D ends.`);
  const lines = createInterface({ input, terminal: false });
  if (prompt) process.stderr.write("you: ");
  let conversationId: string | undefined;
  for await (const line of lines) {
    const text = line.trim();
    if (text) {
      const taken = await agent.simulate({ person: person.phone, channel: channel.name, message: text });
      if (taken) await agent.conversation((conversationId = taken.conversationId))?.whenIdle();
    }
    if (prompt) process.stderr.write("you: ");
  }
  // A tool still running in the background answers in a turn of its own: wait for it before leaving.
  while (conversationId && agent.status().backgroundTasks > 0) {
    await new Promise<void>((done) => turns.push((event) => event.type === "task.done" && done()));
    await agent.conversation(conversationId)?.whenIdle();
  }
  await agent.flushTraces();
  return 0;
}

const photoText = (image: Photo) => ("url" in image ? image.url : image.fileId);

/** One thing the agent sent, as a person would read it (or one JSON line); `id` is the message's own. */
function print(outbound: Outbound, channel: string, json: boolean, id?: string): void {
  if (outbound.type === "typing" || outbound.type === "status" || outbound.type === "read") return;
  if (json) return void process.stdout.write(`${JSON.stringify({ channel, ...outbound, ...(id ? { id } : {}) })}\n`);
  if (outbound.type === "reaction") return void process.stdout.write(`agent reacted ${outbound.emoji}\n`);
  if (outbound.type === "edit") return void process.stdout.write(`agent edited a message: ${outbound.text}\n`);
  if (outbound.type === "unsend") return void process.stdout.write("agent unsent a message\n");
  if (outbound.type === "template") return void process.stdout.write(`agent: [template ${outbound.name}]\n`);
  if (outbound.type === "carousel") {
    const cards = outbound.cards.map((c) => `[card ${photoText(c.image)}${c.text ? ` ${c.text}` : ""}${c.link ? ` [${c.link.label}: ${c.link.url}]` : ""}${c.buttons ? ` ${c.buttons.map((b) => `[${replyButton(b).label}]`).join(" ")}` : ""}]`);
    return void process.stdout.write(`agent: ${[outbound.text, ...cards].join(" ")}\n`);
  }
  const extra = [
    outbound.image && `[photo ${photoText(outbound.image)}]`,
    outbound.link && `[${outbound.link.label}: ${outbound.link.url}]`,
    outbound.buttons?.map((b) => `[${replyButton(b).label}]`).join(" "),
    outbound.list && `[${outbound.list.button}: ${outbound.list.rows.map((r) => r.title).join(" | ")}]`,
  ].filter(Boolean);
  process.stdout.write(`agent: ${[outbound.text, ...extra].filter(Boolean).join(" ")}\n`);
}
