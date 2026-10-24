// An agent run on this machine (`npm start`, `npm run mcp`): the port it listens on, and the marker
// in .flow/ that says it is running, which `flow link` reads to say whether to start it or restart it.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { RESULTS_DIR } from "./names.ts";

/** How many ports above the default are tried before giving up. */
const SCAN = 50;

/** True when nothing listens on 127.0.0.1:`port` (the address the playground and the MCP server bind). */
export function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

async function firstFree(from: number, to: number): Promise<number | undefined> {
  for (let port = from; port <= Math.min(to, 65535); port++) if (await portFree(port)) return port;
  return undefined;
}

/**
 * The port to listen on. `env[name]` set: that port, or an error naming a free one when it is taken
 * (the caller prints its message and exits, so no stack). Not set: `fallback`, else the next free
 * port above it, with `note` saying so. `command` is how the agent is started, for the error's
 * "Run: PORT=8798 npm start".
 */
export async function choosePort(name: string, fallback: number, options: { command: string; env?: Record<string, string | undefined> }): Promise<{ port: number; note?: string }> {
  const given = (options.env ?? process.env)[name]?.trim();
  if (given) {
    const port = Number(given);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} must be a port number, such as ${name}=${fallback}; it is "${given}".`);
    if (port === 0 || (await portFree(port))) return { port };
    const free = await firstFree(port + 1, port + SCAN);
    throw new Error(`Port ${port} is in use. ${free ? `Run: ${name}=${free} ${options.command}` : `Set ${name} to a free port: ${name}=<port> ${options.command}`}`);
  }
  if (await portFree(fallback)) return { port: fallback };
  const free = await firstFree(fallback + 1, fallback + SCAN);
  if (!free) throw new Error(`Ports ${fallback} to ${fallback + SCAN} are in use. Set ${name} to a free port: ${name}=<port> ${options.command}`);
  return { port: free, note: `Port ${fallback} is in use, so this runs on ${free} (${name}=<port> picks one).` };
}

const RUNNING = "running.json";

/** Writes .flow/running.json in `dir` (this process and its URL) and removes it when the process exits. */
export function markRunning(url: string, dir = process.cwd()): void {
  const file = join(dir, RESULTS_DIR, RUNNING);
  mkdirSync(join(dir, RESULTS_DIR), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ pid: process.pid, url })}\n`);
  process.once("exit", () => {
    try {
      if ((JSON.parse(readFileSync(file, "utf8")) as { pid?: number }).pid === process.pid) rmSync(file);
    } catch {}
  });
}

/** The agent running from `dir` (its marker names a live process), or undefined. */
export function runningAgent(dir = process.cwd()): { pid: number; url: string } | undefined {
  const file = join(dir, RESULTS_DIR, RUNNING);
  if (!existsSync(file)) return undefined;
  let marker: { pid?: unknown; url?: unknown };
  try {
    marker = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const { pid, url } = marker;
  if (typeof pid !== "number" || typeof url !== "string") return undefined;
  try {
    process.kill(pid, 0); // signal 0 only asks whether the process is there
  } catch (error) {
    // EPERM: it is there, run by another user; ESRCH: it has gone (killed without removing its marker).
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  return { pid, url };
}
