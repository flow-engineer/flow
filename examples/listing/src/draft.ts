// The form's rules, in plain code with no framework in it: which fields exist, how a person's own
// words become values, which ONE thing to ask next, and what the summary hash covers. The tools
// (tools.ts) keep the draft and call these; the model never converts, ranks or compares anything.

export const ZONE = "America/New_York"; // the agent's time zone (createAgent timeZone): "a month ago" is read against it

export interface Field {
  name: string;
  /** What to ask, in a few words, when this is the next thing missing. */
  ask: string;
  required: boolean;
  /** Other names the model (or a person) might use for it. */
  aliases: string[];
  /** Turns the person's words into a value, or says why not. `raw` is kept for the summary. */
  read?: (raw: string, now: number) => { value: string | number; approx?: boolean } | { problem: string; suggestions?: string[] };
}

const CONDITIONS = ["new", "like new", "good", "fair", "poor"];
/** Longest first, so "like new" is never read as "new". */
const BY_LENGTH = [...CONDITIONS].sort((a, b) => b.length - a.length);
const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };

/** Today in `ZONE` as year, month (1-12), day. */
function today(now: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day };
}
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

/** "35k", "$1,200", "35 thousand", "about 35000" -> 35000. Not a number: a problem, never a guess. */
export function readAmount(raw: string): { value: number } | { problem: string } {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?\b/i.exec(raw);
  if (!m) return { problem: `"${raw}" has no amount in it` };
  const value = Math.round(parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1));
  return value > 0 ? { value } : { problem: "the price must be more than 0" };
}

/** "a month ago", "2 years", "last year", "yesterday", "2022", "2024-03-09" -> a date, against the clock. */
export function readDate(raw: string, now: number): { value: string; approx: boolean } | { problem: string } {
  const text = raw.trim().toLowerCase();
  const t = today(now);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { value: text, approx: false };
  if (/^(19|20)\d{2}$/.test(text)) return { value: text, approx: true };
  if (text === "today") return { value: iso(t.y, t.m, t.d), approx: false };
  if (text === "yesterday") return { value: iso(t.y, t.m, t.d - 1), approx: false };
  const m = /^(?:about |around |roughly )?(?:(last|a|an|one|two|couple of|a couple of|three|four|five|six|seven|eight|nine|ten|twelve|\d+)\s*)(days?|weeks?|wks?|months?|mos?|years?|yrs?)(?:\s+(?:ago|back|old))?$/.exec(text);
  if (!m) return { problem: `could not read "${raw}" as a date: ask for a year, or how long ago` };
  const n = m[1] === "last" ? 1 : /^\d+$/.test(m[1]) ? +m[1] : (WORDS[m[1].replace(/^a couple of$|^couple of$/, "couple")] ?? 1);
  const unit = m[2].startsWith("d") ? "day" : m[2].startsWith("w") ? "week" : m[2].startsWith("m") ? "month" : "year";
  const d = unit === "day" ? iso(t.y, t.m, t.d - n) : unit === "week" ? iso(t.y, t.m, t.d - 7 * n) : unit === "month" ? iso(t.y, t.m - n, t.d) : iso(t.y - n, t.m, t.d);
  return { value: d, approx: true };
}

export const FIELDS: Field[] = [
  { name: "item", ask: "what they are selling", required: true, aliases: ["title", "product", "thing", "name of item"] },
  {
    name: "condition",
    ask: `its condition (${CONDITIONS.join(", ")})`,
    required: true,
    aliases: ["state", "quality", "shape"],
    read: (raw) => {
      const t = raw.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
      const hit = BY_LENGTH.find((c) => t === c || t.includes(c)) ?? (/mint|as new|barely used|hardly used/.test(t) ? "like new" : /brand new|unopened|sealed/.test(t) ? "new" : /ok|okay|decent|used/.test(t) ? "fair" : undefined);
      return hit ? { value: hit } : { problem: `"${raw}" is not one of the conditions`, suggestions: CONDITIONS };
    },
  },
  { name: "price", ask: "their asking price", required: true, aliases: ["asking price", "cost", "amount", "rate"], read: (raw) => readAmount(raw) },
  { name: "bought_on", ask: "when they bought it, roughly", required: true, aliases: ["bought", "purchased", "age", "year", "used for", "usage", "purchase date"], read: (raw, now) => readDate(raw, now) },
  {
    name: "postcode",
    ask: "the postcode for pickup",
    required: true,
    aliases: ["zip", "zip code", "postal code", "area", "location"],
    read: (raw) => {
      const v = raw.toUpperCase().replace(/\s+/g, " ").trim();
      return /^[A-Z0-9][A-Z0-9 -]{2,8}$/.test(v) && /\d/.test(v) ? { value: v } : { problem: `"${raw}" does not look like a postcode`, suggestions: [] };
    },
  },
  { name: "pickup", ask: "when a buyer can collect it", required: true, aliases: ["collection", "availability", "available", "pick up", "when"] },
  { name: "faults", ask: "whether anything is wrong with it", required: false, aliases: ["issues", "problems", "damage", "wear", "defects", "flaws", "known issues"] },
  { name: "reason", ask: "why they are selling", required: false, aliases: ["why", "reason for selling", "reason to sell"] },
];
/** The optional questions worth asking, each at most once. Every other optional field is kept only when volunteered. */
const ASK_OPTIONAL = ["faults"];

export interface Entry { raw: string; value: string | number; derived: boolean; approx?: boolean }
export interface Draft {
  fields: Record<string, Entry>;
  /** Optional fields already asked once: never asked again. */
  offered: string[];
  /** The hash the person was last shown a summary of; cleared by any change. */
  summarised: string | null;
}
export const emptyDraft = (): Draft => ({ fields: {}, offered: [], summarised: null });

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** A field name as the model wrote it -> the real field, or the closest real names (never a dead end). */
export function resolveField(given: string): { field: Field } | { closest: string[] } {
  const g = squash(given);
  const exact = FIELDS.find((f) => squash(f.name) === g || f.aliases.some((a) => squash(a) === g));
  if (exact) return { field: exact };
  const partial = FIELDS.find((f) => g.length >= 3 && [f.name, ...f.aliases].some((n) => squash(n).includes(g) || g.includes(squash(n))));
  if (partial) return { field: partial };
  const ranked = FIELDS.map((f) => ({ f, d: Math.min(...[f.name, ...f.aliases].map((n) => distance(g, squash(n)))) })).sort((a, b) => a.d - b.d);
  return { closest: ranked.slice(0, 3).map((r) => r.f.name) };
}

export interface Problem { field: string; problem: string; suggestions?: string[] }
export interface Applied { unknown: Array<{ given: string; closest: string[] }>; problems: Problem[] }

/** Merges what the person said into the draft: a later statement replaces an earlier one; a bad one is a problem and changes nothing. */
export function apply(draft: Draft, given: Record<string, string>, clear: string[], now: number): Applied {
  const out: Applied = { unknown: [], problems: [] };
  for (const [name, raw] of Object.entries(given)) {
    const r = resolveField(name);
    if ("closest" in r) { out.unknown.push({ given: name, closest: r.closest }); continue; }
    const f = r.field;
    const text = String(raw).trim();
    if (!text) continue;
    const read = f.read?.(text, now);
    if (read && "problem" in read) { out.problems.push({ field: f.name, problem: read.problem, suggestions: read.suggestions }); continue; }
    draft.fields[f.name] = read ? { raw: text, value: read.value, derived: String(read.value) !== text, approx: read.approx } : { raw: text, value: text, derived: false };
  }
  for (const name of clear) {
    const r = resolveField(name);
    if ("field" in r) delete draft.fields[r.field.name];
    else out.unknown.push({ given: name, closest: r.closest });
  }
  draft.summarised = null;
  return out;
}

/** The one thing to ask next, chosen here: required fields in the order above, then each worthwhile optional one once. */
export function nextAsk(draft: Draft): { field: string; ask: string } | null {
  const missing = FIELDS.find((f) => f.required && !draft.fields[f.name]);
  if (missing) return { field: missing.name, ask: missing.ask };
  const opt = FIELDS.find((f) => ASK_OPTIONAL.includes(f.name) && !draft.fields[f.name] && !draft.offered.includes(f.name));
  return opt ? { field: opt.name, ask: opt.ask } : null;
}

export const missing = (draft: Draft) => FIELDS.filter((f) => f.required && !draft.fields[f.name]).map((f) => f.name);

/** What a summary covers: change any value and the hash changes, so an old yes cannot cover it. */
export function hashOf(draft: Draft): string {
  const text = JSON.stringify(FIELDS.map((f) => [f.name, draft.fields[f.name]?.value ?? null]));
  let h = 5381;
  for (const c of text) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/** The draft with derived values marked, for the model and for the summary. */
export function show(draft: Draft): Record<string, string> {
  return Object.fromEntries(Object.entries(draft.fields).map(([k, e]) => [k, e.derived ? `${e.value}${e.approx ? " (about)" : ""}, from "${e.raw}"` : String(e.value)]));
}
