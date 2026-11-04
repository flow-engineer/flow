// A test suite on disk: tests/scenarios/*.yaml and tests/tools/*.yaml, each file hashed by its
// content so the cloud stores it once and a run records exactly which tests it ran. Beside them,
// tests/tools/<tool>.fake.ts: the developer's own code that plays a tool when the cloud asks
// (loadFakes); it runs on this machine and is never uploaded. tests/drafts/ (flow test pull,
// testing/src/pull.ts) is never part of the suite: a draft runs once it is moved into scenarios/.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMap, isSeq, LineCounter, parseDocument, type Node } from "yaml";
import { z } from "../../src/index.ts";

export interface SuiteFile {
  /** Relative to the tests folder: scenarios/latte-correction.yaml, tools/place_order.yaml. */
  path: string;
  hash: string;
  content: string;
}

export function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Every scenario and tool file under `testsDir`, in a stable order. */
export function loadSuite(testsDir: string): SuiteFile[] {
  const files: SuiteFile[] = [];
  for (const folder of ["scenarios", "tools"]) {
    const dir = join(testsDir, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".yaml")).sort()) {
      const content = readFileSync(join(dir, name), "utf8");
      files.push({ path: `${folder}/${name}`, hash: hashOf(content), content });
    }
  }
  return files;
}

/** One hash for the whole suite: runs are compared only when it matches. */
export function suiteHash(files: Array<{ path: string; hash: string }>): string {
  return hashOf(files.map((f) => `${f.path}:${f.hash}`).sort().join("\n"));
}

/** `{{ now [±<n>m|h|d|w]* [@ HH:MM] [| iso|date|time|weekday] }}`, spaces optional between the parts. */
const CLOCK = /^\s*now(?:\s*[+-]\s*\d+[mhdw])*(?:\s*@\s*(?:[01]\d|2[0-3]):[0-5]\d)?(?:\s*\|\s*(?:iso|date|time|weekday))?\s*$/;

/** What is wrong with the `{{ now ... }}` placeholders in `text`, or null. A placeholder is the test's clock
 * (`{{now}}`, `{{now + 7d | date}}`, `{{now + 6d @ 10:00}}`), filled by the cloud per run; any other `{{...}}` is left alone. */
export function placeholderProblem(text: string): string | null {
  for (const [whole, inner] of text.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    if (/^\s*now\b/.test(inner!) && !CLOCK.test(inner!)) {
      return `unknown placeholder ${whole}: write it like {{now + 3d}}, {{now - 2h | time}} or {{now + 1w @ 10:00 | date}}`;
    }
  }
  return null;
}

/** Every string in `value` whose placeholders are wrong, with where it is under `value`. */
function* placeholderProblems(value: unknown, path: PropertyKey[] = []): Generator<{ path: PropertyKey[]; problem: string }> {
  if (typeof value === "string") {
    const problem = placeholderProblem(value);
    if (problem) yield { path, problem };
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* placeholderProblems(value[i], [...path, i]);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) yield* placeholderProblems(item, [...path, key]);
  }
}

/** A value whose strings may hold placeholders, each checked. */
const withClock = <T extends z.ZodType>(schema: T) =>
  schema.superRefine((value, ctx) => {
    for (const { path, problem } of placeholderProblems(value)) ctx.addIssue({ code: "custom", message: problem, path });
  });

/** A time zone Intl knows. */
function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DDTHH:MM[:SS], optionally Z or ±HH:MM, naming a real moment. */
function isDateTime(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:Z|[+-](\d{2}):(\d{2}))?$/.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, s = 0, oh = 0, om = 0] = m.slice(1).map((part) => (part === undefined ? undefined : Number(part)));
  const day = new Date(Date.UTC(y!, mo! - 1, d!));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo! - 1 && day.getUTCDate() === d && h! < 24 && mi! < 60 && s! < 60 && oh! < 24 && om! < 60;
}

/** A tool call the run must (`calls`) or must not (`never`) make: a tool name, or the tool with input fields it must have. */
const expectedCall = z.union(
  [
    z.string().min(1),
    z.strictObject({
      tool: z.string().min(1),
      /** Each field must equal the call's input field: nested objects in part, arrays and strings exactly. */
      args: withClock(z.record(z.string(), z.unknown())).optional(),
    }),
  ],
  { error: "a tool name, or { tool: <name>, args: { <field>: <value> } }" },
);

/** "8h30m", "2d", "45m": how long a `wait` step lets pass. */
const WAIT = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/;

/** A wait's length in ms, or null when it is not one. */
export function waitMs(text: string): number | null {
  const m = WAIT.exec(text.trim());
  if (!m || !(m[1] || m[2] || m[3])) return null;
  const ms = (Number(m[1] ?? 0) * 24 * 60 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 60_000;
  return ms > 0 ? ms : null;
}

/** A moment on the test's clock: a date and time (local to the scenario's timezone unless it has an offset),
 * HH:MM (the next time the clock shows it), or a `{{now ...}}` placeholder. */
const moment = z.string().refine(
  (t) => isDateTime(t) || /^([01]\d|2[0-3]):[0-5]\d$/.test(t) || (/^\s*\{\{[\s\S]*\}\}\s*$/.test(t) && placeholderProblem(t) === null),
  "a time on the test's clock: 2026-10-20T23:30, 2026-10-20T23:30+05:30, 23:30, or {{now + 1d @ 08:00}}",
);

const template = z.strictObject({
  name: z.string().min(1),
  language: z.string().optional(),
  body: z.array(z.string()).optional(),
  buttons: z.array(z.strictObject({ index: z.number().int().min(0), value: z.string() })).optional(),
});

/** A Flow event as the business's backend sends it; `id` and `occurredAt` default to one per step and the clock. */
const flowEvent = withClock(
  z.strictObject({
    id: z.string().min(1).optional(),
    type: z.string().min(1),
    occurredAt: z.string().optional(),
    subject: z.string().min(1),
    delivery: z.string().optional(),
    data: z.record(z.string(), z.unknown()),
  }),
);

const businessNudge = withClock(
  z
    .strictObject({
      text: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
      template: template.optional(),
      respectQuietHours: z.boolean().optional(),
      expiresAt: moment.optional(),
    })
    .refine((n) => [n.text, n.prompt, n.template].filter((v) => v !== undefined).length === 1, "exactly one of text, prompt or template"),
);

/** What the agent's route must answer an event: a status, or a status and the field a 400 names. */
const answer = z.union([z.number().int().min(100).max(599), z.strictObject({ status: z.number().int().min(100).max(599), field: z.string().min(1).optional() })]);

/** One thing the agent sent (`expect.sent`), or must not have (`expect.not_sent`; `{}` is anything at all). */
const sentItem = z.strictObject({
  /** When, on the test's clock: HH:MM (any day), or a date and time; to the minute. */
  at: moment.optional(),
  /** A template by name. */
  template: z.string().min(1).optional(),
  /** The agent's own words rather than a template. */
  phrased: z.literal(true).optional(),
  /** A carousel (cards they swipe through), not a message or a template. */
  carousel: z.literal(true).optional(),
  /** Text the message (or the template's values, or the carousel's text and cards) holds. */
  text: withClock(z.string().min(1)).optional(),
}).refine((item) => !(item.carousel && item.template !== undefined), "a carousel is not a template: give carousel or template, not both");

const openingStep = z
  .object({
    say: withClock(z.string()).optional(),
    /** A file the person sends with it (say is its caption): a path in the tests folder. */
    attach: z.object({ kind: z.enum(["image", "audio", "document"]), file: z.string().refine(inTests, "a path inside the tests folder, such as fixtures/receipt.jpg") }).optional(),
    after_ms: z.number().int().min(0).optional(),
    /** The business's backend sends this event, to the agent's own route. */
    event: flowEvent.optional(),
    /** The route the event goes to; /v1/events when left out. */
    path: z.string().regex(/^\/[^\s?#]*$/, "a path such as /v1/events").optional(),
    /** bad: signed with another secret; missing: no Flow-Signature header. */
    signature: z.enum(["bad", "missing"]).optional(),
    /** What the route must answer; anything 2xx when left out. */
    answer: answer.optional(),
    /** The business nudges the person. */
    nudge: businessNudge.optional(),
    /** Time passes on the test's clock. */
    wait: z.string().refine((t) => waitMs(t) !== null, 'a length of time such as 8h30m, 45m or 2d').optional(),
    /** The agent restarts mid-conversation, on the same store: crash (it dies where it is; a new one takes over
     * once its lease runs out) or deploy (a new one starts beside it; the old one finishes what it holds and stops).
     * Right after a say, it lands while that message's turn runs. */
    restart: z.enum(["crash", "deploy"], { error: "crash or deploy" }).optional(),
    /** Move the test's clock to this time before the step. */
    at: moment.optional(),
  })
  .superRefine((step, ctx) => {
    const kinds = [step.say !== undefined || step.attach ? "say" : null, step.event ? "event" : null, step.nudge ? "nudge" : null, step.wait !== undefined ? "wait" : null, step.restart ? "restart" : null].filter(Boolean);
    if (kinds.length !== 1) ctx.addIssue({ code: "custom", message: kinds.length ? `one of say, event, nudge, wait or restart per step, not ${kinds.join(" and ")}` : "say something, attach a file, send an event, nudge, wait, or restart" });
    if (!step.event && (step.path || step.signature || step.answer !== undefined)) ctx.addIssue({ code: "custom", message: "path, signature and answer belong to an event step" });
    if (kinds[0] === "say" && !step.say && !step.attach) ctx.addIssue({ code: "custom", message: "say something, attach a file, or both" });
  })
  .transform((step) => (step.event || step.nudge || step.wait !== undefined || step.restart ? step : { ...step, say: step.say ?? "" }));

/** One message of the conversation a scenario starts from: what the person said, or what the agent said. */
const historyItem = z.union(
  [z.strictObject({ person: withClock(z.string().min(1).max(4000)) }), z.strictObject({ agent: withClock(z.string().min(1).max(4000)) })],
  { error: "{ person: <what they said> } or { agent: <what it said> }" },
);

/** A title's and a theme's most characters (code points, not bytes): names a list shows on one line. */
export const TITLE_MAX = 45;
export const THEME_MAX = 30;

/** A string of at most `max` characters, else `<n> characters, at most <max>: <fix>`. */
const shortName = (max: number, fix: string) =>
  z.string().superRefine((text, ctx) => {
    const length = [...text].length;
    if (length > max) ctx.addIssue({ code: "custom", message: `${length} characters, at most ${max}: ${fix}` });
  });

/** How a tool behaves in a scenario (`given.tools`): usual, slow, down, or flaky N% (N a whole number from 0 to 100). */
const toolMode = z.string().refine(
  (mode) => /^(?:usual|slow|down)$/.test(mode) || flakyPercent(mode) !== null,
  "usual, slow, down, or flaky N% with N a whole number from 0 to 100, such as flaky 30%",
);

/** The N of `flaky N%`, or null when `mode` is not one. */
export function flakyPercent(mode: string): number | null {
  const m = /^flaky (\d{1,3})%$/.exec(mode);
  return m && Number(m[1]) <= 100 ? Number(m[1]) : null;
}

/** The world as data: how each tool behaves (`tools`), flaky's dice (`seed`), and any other value for the fakes;
 * a tool file's name there (get_menu.yaml) is that tool's usual output. */
const given = z
  .object({
    tools: z.record(z.string().min(1), toolMode).optional(),
    seed: z.number().int().optional(),
  })
  .catchall(withClock(z.unknown()));

/** The behaviours a simulated person can show (`person.behaviours`), any of them together. */
const PERSON_BEHAVIOURS = ["impatient", "tangents", "half_messages", "pushes_rules", "walks_away"] as const;
/** The ways an attacker (`person.attack`) tries to make the agent break its rule, in the order it escalates by default. */
const ATTACK_TACTICS = ["ask", "reason", "authority", "pressure", "reframe", "inject"] as const;

/** A list of `names`, at least one, each once. */
const someOf = <T extends readonly [string, ...string[]]>(names: T, what: string) =>
  z
    .array(z.enum(names, { error: `one of ${names.join(", ")}` }))
    .min(1, `at least one ${what}, or leave it out`)
    .superRefine((list, ctx) => {
      list.forEach((name, i) => {
        if (list.indexOf(name) !== i) ctx.addIssue({ code: "custom", message: `${name} is listed twice: list each ${what} once`, path: [i] });
      });
    });

/** The one rule an attacker tries to make the agent break, in a sentence. */
const attackRule = z.string().superRefine((rule, ctx) => {
  const length = [...rule].length;
  if (!rule.trim()) ctx.addIssue({ code: "custom", message: "the rule the agent must keep, in a sentence, such as: Never gives a discount or a free item." });
  else if (length > 500) ctx.addIssue({ code: "custom", message: `${length} characters, at most 500: one rule, in a sentence` });
});

/** Where a scenario came from, for the people and tools that read the suite; a run never reads it. */
const origin = z.object({
  /** code: written from the agent's code and prompts; chat: made by Flow from a conversation that went wrong, its people made up. */
  from: z.enum(["code", "chat"], { error: "code or chat" }),
  /** Who wrote it, such as a coding agent. */
  by: z.string().min(1).optional(),
  /** The ids of what it covers (a prompt's rule, a tool, a code path), as a coverage plan names them. */
  covers: z.array(z.string().min(1)).optional(),
  /** Whether it was seen to fail on the agent that went wrong (reproduces_on_bad) or to pass on the fixed one (passes_on_fixed). */
  check: z.enum(["not_checked", "passes_on_fixed", "reproduces_on_bad"], { error: "not_checked, passes_on_fixed or reproduces_on_bad" }).optional(),
});

const scenarioSchema = z.object({
  id: z.string().min(1),
  /** A short name for the scenario, such as "Milk corrected to oat"; the test itself is in `about` and the rest. */
  title: shortName(TITLE_MAX, "a title is a name, not the test. Move the detail to about:").optional(),
  /** What the scenario tests, in a sentence or two: shown under the title. */
  about: z.string().optional(),
  /** The area of the agent it tests, such as "Ordering": scenarios are grouped by it. */
  theme: shortName(THEME_MAX, "a theme is the area of the agent the scenario tests, in a word or two, such as Ordering.").optional(),
  /** Where it came from: metadata, never read by a run. */
  origin: origin.optional(),
  /** Every platform it runs on; each is a run of its own, with its own result. */
  channels: z.array(z.enum(["sms", "whatsapp", "imessage", "telegram", "web"])).min(1),
  /** The IANA time zone of the test's clock; UTC when left out. */
  timezone: z.string().refine(isTimeZone, "not a time zone: use an IANA name such as America/New_York or UTC").optional(),
  /** The test's clock when each run starts, local to `timezone` unless it has an offset; the real time when left out.
   * YAML's default schema reads it as a string; a Date from another schema is taken as its UTC time. */
  now: z
    .preprocess((v) => (v instanceof Date ? v.toISOString().replace(/\.\d+Z$/, "Z") : v), z.string().refine(isDateTime, "not a date and time: write YYYY-MM-DDTHH:MM, with :SS, Z or an offset such as -04:00 if needed"))
    .optional(),
  person: z.object({
    /** Their address on the run's channel (a phone number on phone channels): who a business run's events and nudges are for. */
    address: z.string().min(1).optional(),
    persona: withClock(z.string()),
    goal: withClock(z.string()),
    knows: z.array(withClock(z.string())).optional(),
    /** How the person gives what it `knows`: as_asked (the default) answers what the agent asks; one_at_a_time gives
     * one fact per message, only the one asked for, and asked for several at once gives one and waits to be asked again. */
    reveal: z.enum(["as_asked", "one_at_a_time"], { error: "as_asked or one_at_a_time" }).optional(),
    /** How the person behaves besides its persona, any of: impatient (short replies, wants it done fast), tangents (drifts
     * off topic now and then, comes back), half_messages (splits a thought over two messages, the first cut off),
     * pushes_rules (told no, argues and asks again, up to twice), walks_away (may leave unresolved when the agent is slow,
     * repetitive or unhelpful; the run then ends walked_away and fails). */
    behaviours: someOf(PERSON_BEHAVIOURS, "behaviour").optional(),
    /** The person attacks, over several turns, trying to make the agent break `rule` (judged in every reply). `tactics`,
     * in the order it escalates: ask, reason (a believable story), authority (staff, the owner, already approved),
     * pressure (urgency, a bad review), reframe (a hypothetical, a role-play, just this once, in pieces), inject (text
     * dressed as a system note); all six in that order when left out. */
    attack: z
      .strictObject(
        { rule: attackRule, tactics: someOf(ATTACK_TACTICS, "tactic").optional() },
        { error: (issue) => (issue.code === "invalid_type" ? "{ rule: <the rule the agent must keep>, tactics: [<tactic>, ...] }" : undefined) },
      )
      .optional(),
  }).superRefine((person, ctx) => {
    const walks = person.behaviours?.indexOf("walks_away") ?? -1;
    if (person.attack && walks >= 0) ctx.addIssue({ code: "custom", message: "an attacker does not walk away: leave walks_away out", path: ["behaviours", walks] });
  }),
  /** The conversation so far: the run starts after these, as if they had been said (oldest first). */
  history: z.array(historyItem).min(1).max(200).optional(),
  opening: z.array(openingStep).min(1),
  /** Tools whose own code runs in this scenario, in place of the cloud's simulation (state the agent keeps itself). */
  tools: z.strictObject({ real: z.array(z.string().min(1)).min(1) }).optional(),
  /** In prose: a note for the person, the judge, and the model that plays a call no rule of `given` plays. */
  world: withClock(z.string()).optional(),
  /** The world as data: each tool call is played by rule (its mode, its fake, a recorded response) before a model. */
  given: given.optional(),
  max_turns: z.number().int().min(1).max(50).default(8),
  expect: z
    .object({
      outcome: z.array(withClock(z.string())).optional(),
      judge: z.array(withClock(z.string())).optional(),
      /** Each must be called at least once in the run; checked by code from the recorded calls. */
      calls: z.array(expectedCall).optional(),
      /** None may be called. */
      never: z.array(expectedCall).optional(),
      /** What the agent sent, in order (other sends may come between): checked by code, with the test's clock. */
      sent: z.array(sentItem).optional(),
      /** None of these was sent; `{}` is anything at all. */
      not_sent: z.array(sentItem).optional(),
      /** What the fakes' state holds when the run ends, each key one check in code: objects match in part, arrays
       * have the same length with each expected element matched in part (any order), other values are equal. */
      state: z.record(z.string(), z.unknown()).optional(),
    })
    .default({}),
});

const toolFileSchema = z.object({
  tool: z.string().min(1),
  behaviour: z.string().optional(),
  responses: z
    .array(
      z.object({
        when: z.string(),
        latency_ms: z.number().int().min(0),
        input: withClock(z.unknown()).optional(),
        output: withClock(z.unknown()).optional(),
        error: withClock(z.string()).optional(),
      }),
    )
    .min(1),
});

/** A relative path that stays inside the tests folder. */
function inTests(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
}

/** The type of a file a scenario attaches, from its extension. */
export function mimeOf(path: string): string {
  const types: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", pdf: "application/pdf", ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav" };
  return types[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
}

export type Scenario = z.infer<typeof scenarioSchema>;
export type OpeningStep = Scenario["opening"][number];
export type SentItem = z.infer<typeof sentItem>;

/** The business starts something in it (an event, a nudge, time passing, a restart), or it checks what was sent: a business run. */
export function isBusiness(scenario: Scenario): boolean {
  return scenario.opening.some((s) => s.event || s.nudge || s.wait !== undefined || s.at !== undefined || s.restart) || !!scenario.expect.sent || !!scenario.expect.not_sent || !!scenario.tools;
}
export type ToolFile = z.infer<typeof toolFileSchema>;
export type ExpectedCall = z.infer<typeof expectedCall>;

/** What is wrong with a scenario's `given.tools` for this agent: a tool it does not have, or down or flaky for a
 * tool whose file has no response with an error (the cloud refuses that scenario with the same reason). */
export function givenProblems(scenario: Scenario, tools: string[], toolFiles: ToolFile[]): string[] {
  const problems: string[] = [];
  for (const [tool, mode] of Object.entries(scenario.given?.tools ?? {})) {
    if (!tools.includes(tool)) {
      problems.push(`given.tools.${tool}: the agent has no tool ${tool}`);
      continue;
    }
    const fails = mode === "down" || flakyPercent(mode) !== null;
    if (fails && !toolFiles.some((f) => f.tool === tool && f.responses.some((r) => r.error !== undefined))) {
      problems.push(`given.tools.${tool}: ${mode} needs a response with an error in tools/${tool}.yaml`);
    }
  }
  return problems;
}

/** What a fake is given for one call. */
export interface FakeCall<I = any> {
  input: I;
  /** The scenario's given: without tools and seed; a tool file's name there is that tool's usual output. */
  world: Record<string, unknown>;
  /** One object per run, shared by every fake of the run: change it in place. Plain JSON. */
  state: Record<string, any>;
  /** The test's clock at this call, ISO 8601 (UTC). */
  now: string;
  /** This tool's calls in the run so far, this one included (1 for the first). */
  call: number;
  /** The tool file's responses, placeholders filled (empty when it has no file). */
  responses: ToolFile["responses"];
}

/** What the tool answered, and what it changed, in plain words. `{{now ...}}` placeholders in it are filled by the cloud. */
export type FakeAnswer = { output: unknown; changes?: string[] } | { error: string; changes?: string[] };

/** A tool played by the developer's own code in tests: the default export of tests/tools/<tool>.fake.ts. */
export type Fake<I = any> = (call: FakeCall<I>) => FakeAnswer | Promise<FakeAnswer>;

/** Every tests/tools/*.fake.ts under `testsDir`, by tool (the file name before .fake.ts). A file that does not
 * import, or whose default export is not a function, throws `tests/tools/<file>: ...`. */
export async function loadFakes(testsDir: string): Promise<Map<string, Fake>> {
  const fakes = new Map<string, Fake>();
  const dir = join(testsDir, "tools");
  if (!existsSync(dir)) return fakes;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".fake.ts")).sort()) {
    let module: { default?: unknown };
    try {
      module = await import(pathToFileURL(join(dir, name)).href);
    } catch (error) {
      throw new Error(`tests/tools/${name}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    }
    if (typeof module.default !== "function") throw new Error(`tests/tools/${name}: its default export must be the fake, a function (export default placeOrder)`);
    fakes.set(name.slice(0, -".fake.ts".length), module.default as Fake);
  }
  return fakes;
}

/** Parse and check a scenario. The error has one line per problem: `file:line: field: what is wrong`. */
export function parseScenario(file: Pick<SuiteFile, "path" | "content">): Scenario {
  return parseFile(scenarioSchema, file);
}

export function parseToolFile(file: Pick<SuiteFile, "path" | "content">): ToolFile {
  return parseFile(toolFileSchema, file);
}

function parseFile<T extends z.ZodType>(schema: T, file: Pick<SuiteFile, "path" | "content">): z.infer<T> {
  const lines = new LineCounter();
  const doc = parseDocument(file.content, { lineCounter: lines });
  const at = (offset: number | undefined) => `${file.path}:${offset === undefined ? 1 : lines.linePos(offset).line}`;
  if (doc.errors.length) {
    // The YAML parser's own message ends with where it is and a drawing of the line; the prefix says where.
    throw new Error(doc.errors.map((e) => `${at(e.pos[0])}: ${e.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "")}`).join("\n"));
  }
  const result = schema.safeParse(doc.toJS());
  if (result.success) return result.data;
  throw new Error(result.error.issues.map((issue) => {
    const field = issue.path.map((key, i) => (typeof key === "number" ? `[${key}]` : `${i ? "." : ""}${String(key)}`)).join("");
    const what = /received undefined$/.test(issue.message) ? "missing" : issue.message;
    return `${at(offsetOf(doc.contents, issue.path))}: ${field ? `${field}: ` : ""}${what}`;
  }).join("\n"));
}

/** Where the deepest part of `path` that the file has starts: the value, or for a missing key the key that holds it. */
function offsetOf(root: unknown, path: PropertyKey[]): number | undefined {
  let node = root;
  let offset = (root as Node | null)?.range?.[0];
  let holder: number | undefined;
  for (const key of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => (p.key as { value?: unknown } | null)?.value === key);
      if (!pair) return holder ?? offset;
      holder = (pair.key as Node).range?.[0];
      node = pair.value;
    } else if (isSeq(node) && typeof key === "number" && node.items[key]) {
      holder = undefined;
      node = node.items[key];
    } else break;
    offset = (node as Node | null)?.range?.[0] ?? offset;
  }
  return offset;
}
