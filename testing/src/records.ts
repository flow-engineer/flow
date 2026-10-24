// `flow records export`: every record the agent in this folder keeps (createAgent({ records })), as
// JSON Lines on stdout, one { collection, id, value, createdAt, updatedAt } per line, so they move
// with the agent to another store. It builds the agent from src/agent.ts as `flow chat` does, with
// a model that is never called (no model key needed), and reads the store buildAgent opens: the
// database it names (.env is loaded first), else nothing kept past the command. It starts no turn
// and sends nothing. Exit status: 0 done, 1 usage or the agent could not be built.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Agent, Model } from "../../src/index.ts";
import { loadEnv } from "./report.ts";

export const RECORDS_LINE = `  flow records export      Every record the agent in this folder keeps, as JSON Lines on stdout`;

const USAGE = `Usage:\n${RECORDS_LINE}

Reads the store src/agent.ts's buildAgent() opens (the database it names), never a hosted agent's.
Exit status: 0 done, 1 usage or the agent could not be built.`;

const noModel: Model = { complete: () => Promise.reject(new Error("flow records export calls no model")) };

/** Runs `flow records`; resolves to the exit status. */
export async function recordsCli(args: string[]): Promise<number> {
  let positionals: string[];
  let help: boolean | undefined;
  try {
    ({ positionals, values: { help } } = parseArgs({ args, strict: true, allowPositionals: true, options: { help: { type: "boolean", short: "h", default: false } } }));
  } catch (error) {
    console.error(`flow records: ${(error as Error).message.split(". ")[0]}\n\n${USAGE}`);
    return 1;
  }
  if (help) return console.log(USAGE), 0;
  if (positionals.join(" ") !== "export") return console.error(`flow records: the command is export\n\n${USAGE}`), 1;
  loadEnv(undefined);
  const file = join(process.cwd(), "src", "agent.ts");
  if (!existsSync(file)) return console.error("flow records: There is no src/agent.ts here: run it from your agent's folder."), 1;
  let agent: Agent;
  try {
    const module = await import(pathToFileURL(file).href);
    if (typeof module.buildAgent !== "function") throw new Error("src/agent.ts must export buildAgent({ model, events }).");
    agent = module.buildAgent({ model: noModel, events: [] });
  } catch (error) {
    return console.error(`flow records: ${(error as Error).message}`), 1;
  }
  let count = 0;
  for await (const record of agent.records.export()) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
    count++;
  }
  console.error(`Exported ${count} record${count === 1 ? "" : "s"}.`);
  return 0;
}
