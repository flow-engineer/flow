// INTERNAL: text overrides for one test session, so two wordings of an agent's instructions or of Flow
// Framework's own model-facing lines can be compared without editing a file. Not exported from the
// package: `flow test compare` (testing/src/compare.ts) sets them in the child process it starts and
// nothing else does. They refuse to be set outside a test run (FLOW_FRAMEWORK_RUN_KIND=test, which
// the `flow test` command sets itself, never an agent), so a stray setting in production does nothing.

import { setting } from "./names.ts";
import type { AgentFiles } from "./skills.ts";

/** Replace `find` (exact text) with `replace`. */
export interface TextEdit {
  find: string;
  replace: string;
}

export interface TestOverrides {
  /** The agent's own instructions (AGENTS.md): replaced whole by `text`, then each edit applied. */
  instructions?: { text?: string; edits?: TextEdit[] };
  /** Flow Framework's own lines for the model (src/talk.ts, the notes in src/conversation.ts): each edit applied wherever its text is sent. */
  builtIn?: TextEdit[];
}

interface State {
  overrides: TestOverrides;
  matched: Map<TextEdit, number>;
}

// On globalThis, so a second copy of this file (an agent loaded from another checkout) shares one state.
const KEY = Symbol.for("flow.framework.test-overrides");
const global = globalThis as { [KEY]?: State };

/** Turns the overrides on for this process. Throws unless this is a `flow test` run. */
export function useTestOverrides(overrides: TestOverrides, env: NodeJS.ProcessEnv = process.env): void {
  if (setting("RUN_KIND", env) !== "test") throw new Error("flow: text overrides are for a test run only (flow test compare); they are never applied to a running agent.");
  global[KEY] = { overrides, matched: new Map() };
}

function apply(text: string, edits: TextEdit[] | undefined, state: State): string {
  let out = text;
  for (const edit of edits ?? []) {
    if (!edit.find || !out.includes(edit.find)) continue;
    state.matched.set(edit, (state.matched.get(edit) ?? 0) + 1);
    out = out.split(edit.find).join(edit.replace);
  }
  return out;
}

/** The agent's files with the instructions override applied; the same files when none is set. */
export function overrideInstructions(files: AgentFiles): AgentFiles {
  const state = global[KEY];
  const spec = state?.overrides.instructions;
  if (!state || !spec) return files;
  const base = spec.text ?? files["AGENTS.md"] ?? "";
  const edits = spec.edits ?? [];
  // Edits are checked against the text they apply to now, so one that matches nothing is named at the end.
  return { ...files, "AGENTS.md": apply(base, edits, state) };
}

/** A line of Flow Framework's own text for the model, with the built-in overrides applied; the same text when none is set. */
export function overrideBuiltIn(text: string): string {
  const state = global[KEY];
  return state?.overrides.builtIn?.length ? apply(text, state.overrides.builtIn, state) : text;
}

/** The edits that never matched any text in this process: the override did nothing, so a result from it says nothing. */
export function unmatchedEdits(): TextEdit[] {
  const state = global[KEY];
  if (!state) return [];
  const all = [...(state.overrides.instructions?.edits ?? []), ...(state.overrides.builtIn ?? [])];
  return all.filter((edit) => !state.matched.has(edit));
}
