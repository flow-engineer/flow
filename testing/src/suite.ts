// A test suite on disk: tests/scenarios/*.yaml and tests/tools/*.yaml, each file hashed by its
// content so the cloud stores it once and a run records exactly which tests it ran.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
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

const scenarioSchema = z.object({
  id: z.string().min(1),
  /** A short name for the scenario, such as "Milk corrected to oat"; the test itself is in `about` and the rest. */
  title: shortName(TITLE_MAX, "a title is a name, not the test. Move the detail to about:").optional(),
  /** What the scenario tests, in a sentence or two: shown under the title. */
  about: z.string().optional(),
  /** The area of the agent it tests, such as "Ordering": scenarios are grouped by it. */
  theme: shortName(THEME_MAX, "a theme is the area of the agent the scenario tests, in a word or two, such as Ordering.").optional(),
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
  }),
  /** The conversation so far: the run starts after these, as if they had been said (oldest first). */
  history: z.array(historyItem).min(1).max(200).optional(),
  opening: z.array(openingStep).min(1),
  /** Tools whose own code runs in this scenario, in place of the cloud's simulation (state the agent keeps itself). */
  tools: z.strictObject({ real: z.array(z.string().min(1)).min(1) }).optional(),
  world: withClock(z.string()).optional(),
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
