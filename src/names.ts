// The Flow Framework's names on a machine: its settings in the environment, its config folder and an
// agent's results folder. Each is read under its name from before the rename (chinwag) too, so an
// install that moved from chinwag keeps working; everything new is written under Flow Framework's name.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A setting from the environment: FLOW_FRAMEWORK_<name>, else CHINWAG_<name> from before the rename. */
export function setting(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`FLOW_FRAMEWORK_${name}`] ?? env[`CHINWAG_${name}`];
}

/**
 * The command to print in a next step. `npx flow` would fetch another npm package wherever this one is
 * not installed, so a hint always names the package.
 */
export const RUN = "npx @flow-engineer/flow";

/** An agent's results folder, in the agent's folder: written here, and git-ignored by `flow new`. */
export const RESULTS_DIR = ".flow";
/** The results folder from before the rename, still read until a run writes {@link RESULTS_DIR}. */
export const OLD_RESULTS_DIR = ".chinwag";

const configBase = (env: NodeJS.ProcessEnv) => env.XDG_CONFIG_HOME || join(homedir(), ".config");

/** ~/.config/flow-framework (XDG_CONFIG_HOME when set): where this machine's files are written. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(configBase(env), "flow-framework");
}

/** ~/.config/chinwag (XDG_CONFIG_HOME when set): the config folder from before the rename, only read. */
export function oldConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(configBase(env), "chinwag");
}

/**
 * The file to read for a name in the config folder: ~/.config/flow-framework/<file>, else, while only it
 * exists, ~/.config/chinwag/<file>. Write to {@link configDir} whichever this returns.
 */
export function configFile(file: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = join(configDir(env), file);
  const old = join(oldConfigDir(env), file);
  return !existsSync(path) && existsSync(old) ? old : path;
}

/** The file to read in an agent's results folder: .flow/<file>, else, while only it exists, .chinwag/<file>. */
export function resultsFile(dir: string, file: string): string {
  const path = join(dir, RESULTS_DIR, file);
  const old = join(dir, OLD_RESULTS_DIR, file);
  return !existsSync(path) && existsSync(old) ? old : path;
}
