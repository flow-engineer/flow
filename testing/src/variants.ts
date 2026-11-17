// The variants of `flow test compare`: what each one changes about the agent, read from the variants file or
// the flags, and what the child `flow test` it starts needs to apply that (the child's spec). The child side
// lives here too: it turns the spec into a model, text overrides, extra judged checks and an events file.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from "yaml";
import { openAICompatible, type Model } from "../../src/index.ts";
import type { EventSink } from "../../src/index.ts";
import { z } from "../../src/index.ts";
import { unmatchedEdits, useTestOverrides, type TextEdit } from "../../src/variant.ts";
import type { SuiteFile } from "./suite.ts";
import { hashOf } from "./suite.ts";

const edit = z.strictObject({ find: z.string().min(1), replace: z.string() });
const edits = z.array(edit).min(1);
const modelSpec = z.strictObject({
  id: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  reasoning: z.enum(["minimal", "low", "medium", "high"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  promptCaching: z.boolean().optional(),
  maxTokens: z.number().int().positive().optional(),
});
const variantSpec = z.strictObject({
  instructions: z.strictObject({ file: z.string().min(1).optional(), edits: edits.optional() }).optional(),
  model: modelSpec.optional(),
  code: z.strictObject({ ref: z.string().min(1).optional(), entry: z.string().min(1).optional() }).optional(),
  builtIn: z.strictObject({ edits }).optional(),
  agentUrl: z.string().min(1).optional(),
});
const NAME = /^[a-z0-9][a-z0-9_-]{0,29}$/;
const fileSpec = z.strictObject({
  judge: z.array(z.string().min(1)).max(10).optional(),
  variants: z.record(z.string(), variantSpec),
});

export type VariantSpec = z.infer<typeof variantSpec>;
export interface Variants {
  /** In the order the baseline first, then the others as written. */
  variants: Array<{ name: string; spec: VariantSpec }>;
  /** Judged checks added to every scenario of every variant (labelled judged in the table). */
  judge: string[];
}

/** The name of the variant that is the agent as it stands: always the baseline, always first. */
export const CURRENT = "current";

/** Reads a variants file (YAML or JSON) and checks it; throws a one-line problem per fault. */
export function readVariantsFile(path: string): Variants {
  let raw: unknown;
  try {
    raw = parseDocument(readFileSync(path, "utf8")).toJS();
  } catch (error) {
    throw new Error(`${path} could not be read: ${(error as Error).message.split("\n")[0]}`);
  }
  const parsed = fileSpec.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0]!;
    throw new Error(`${path}: ${first.path.join(".") || "(top level)"}: ${first.message}. A variants file has variants: { <name>: { instructions, model, code, builtIn, agentUrl } } and optionally judge: [sentences].`);
  }
  const names = Object.keys(parsed.data.variants);
  for (const name of names) if (!NAME.test(name)) throw new Error(`${path}: variant name "${name}" must be lower-case letters, digits, - or _, up to 30 characters.`);
  const rest = names.filter((n) => n !== CURRENT).map((name) => ({ name, spec: parsed.data.variants[name]! }));
  return { variants: [{ name: CURRENT, spec: parsed.data.variants[CURRENT] ?? {} }, ...rest], judge: parsed.data.judge ?? [] };
}

/** The variants one kind of flag names, with the agent as it is first. Mixing kinds, or one flag only, needs a file. */
export function variantsFromFlags(flags: { model: string[]; instructions: string[]; codeRef: string[]; withoutCurrent: boolean }): Variants {
  const kinds = [flags.model.length, flags.instructions.length, flags.codeRef.length].filter(Boolean).length;
  if (kinds === 0) throw new Error("Nothing to compare: name variants with --model, --instructions or --code-ref (repeat the flag for more than one), or put them in a file with --variants.");
  if (kinds > 1) throw new Error("--model, --instructions and --code-ref do not go together: a variant that changes more than one thing is written in a --variants file.");
  const label = (text: string) => text.toLowerCase().replace(/^.*\//, "").replace(/\.[a-z]+$/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "variant";
  const make = (values: string[], build: (value: string) => VariantSpec, nameOf: (value: string) => string) => {
    const used = new Set<string>([CURRENT]);
    return values.map((v) => {
      let name = nameOf(v);
      for (let i = 2; used.has(name); i++) name = `${nameOf(v).slice(0, 27)}-${i}`;
      used.add(name);
      return { name, spec: build(v) };
    });
  };
  const rest = flags.model.length
    ? make(flags.model, (id) => ({ model: { id } }), (id) => label(id))
    : flags.instructions.length
      ? make(flags.instructions, (file) => ({ instructions: { file } }), (file) => label(file))
      : make(flags.codeRef, (ref) => ({ code: { ref } }), (ref) => label(ref));
  const all = flags.withoutCurrent ? rest : [{ name: CURRENT, spec: {} as VariantSpec }, ...rest];
  if (all.length < 2) throw new Error("A comparison needs at least two variants: with --without-current, name two or more.");
  return { variants: all, judge: [] };
}

/** What a child `flow test` is told, in a JSON file named by FLOW_FRAMEWORK_COMPARE_CHILD. */
export interface ChildSpec {
  name: string;
  /** Every event the agent emits, one JSON line each. */
  eventsFile: string;
  /** Written when the child ends: which edits matched nothing. */
  resultFile: string;
  /** The project's tests folder (a code variant runs in another checkout but plays these). */
  testsDir: string;
  judge: string[];
  model?: z.infer<typeof modelSpec>;
  entry?: string;
  instructions?: { text?: string; edits?: TextEdit[] };
  builtIn?: TextEdit[];
}

/** The child's spec for a variant, with its instructions file read now (relative to the project). */
export function childSpec(variant: { name: string; spec: VariantSpec }, projectDir: string, judge: string[], files: { eventsFile: string; resultFile: string }): ChildSpec {
  const { spec } = variant;
  let text: string | undefined;
  if (spec.instructions?.file) {
    const path = isAbsolute(spec.instructions.file) ? spec.instructions.file : resolve(projectDir, spec.instructions.file);
    if (!existsSync(path)) throw new Error(`Variant ${variant.name}: instructions file ${spec.instructions.file} does not exist (looked in ${path}).`);
    text = readFileSync(path, "utf8");
  }
  return {
    name: variant.name,
    ...files,
    testsDir: join(projectDir, "tests"),
    judge,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.code?.entry ? { entry: spec.code.entry } : {}),
    ...(spec.instructions ? { instructions: { ...(text !== undefined ? { text } : {}), ...(spec.instructions.edits ? { edits: spec.instructions.edits } : {}) } } : {}),
    ...(spec.builtIn ? { builtIn: spec.builtIn.edits } : {}),
  };
}

/** The model a variant gives the agent, or undefined to keep the agent's own. Any model id, base URL and key variable the agent could use itself. */
export function variantModel(spec: ChildSpec["model"], env: NodeJS.ProcessEnv = process.env): Model | undefined {
  if (!spec) return undefined;
  let apiKey: string | undefined;
  if (spec.apiKeyEnv) {
    apiKey = env[spec.apiKeyEnv]?.trim();
    if (!apiKey) throw new Error(`The variant's model names ${spec.apiKeyEnv} as its key, and it is not set (in the environment or the agent's .env).`);
  }
  return openAICompatible({
    ...(spec.id ? { model: spec.id } : {}),
    ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(spec.reasoning ? { reasoning: spec.reasoning } : {}),
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.promptCaching !== undefined ? { promptCaching: spec.promptCaching } : {}),
    ...(spec.maxTokens ? { maxTokens: spec.maxTokens } : {}),
  });
}

/** The scenarios with `sentences` added to their expect.judge (the cloud's judge reads them like the scenario's own). Tool files are left alone. */
export function withJudge(files: SuiteFile[], sentences: string[]): SuiteFile[] {
  if (!sentences.length) return files;
  return files.map((file) => {
    if (!file.path.startsWith("scenarios/")) return file;
    const doc = parseDocument(file.content);
    let expect = doc.get("expect");
    if (!isMap(expect)) { expect = new YAMLMap(); doc.set("expect", expect); }
    let judge = (expect as YAMLMap).get("judge");
    if (!isSeq(judge)) { judge = new YAMLSeq(); (expect as YAMLMap).set("judge", judge); }
    for (const s of sentences) (judge as YAMLSeq).add(s);
    const content = doc.toString();
    return { ...file, content, hash: hashOf(content) };
  });
}

export function readChildSpec(path: string): ChildSpec {
  return JSON.parse(readFileSync(path, "utf8")) as ChildSpec;
}

/** The sink that keeps every event of the session in the spec's events file. */
export function eventsSink(spec: ChildSpec): EventSink {
  writeFileSync(spec.eventsFile, "");
  return (event) => appendFileSync(spec.eventsFile, `${JSON.stringify(event)}\n`);
}

/** Turns the text overrides on in this process (a test run only). */
export function applyChildOverrides(spec: ChildSpec): void {
  if (spec.instructions || spec.builtIn) useTestOverrides({ ...(spec.instructions ? { instructions: spec.instructions } : {}), ...(spec.builtIn ? { builtIn: spec.builtIn } : {}) });
}

/** Written when the child ends. */
export function writeChildResult(spec: ChildSpec): void {
  const unmatched = unmatchedEdits().map((e) => e.find);
  writeFileSync(spec.resultFile, JSON.stringify({ unmatchedEdits: unmatched }));
}

