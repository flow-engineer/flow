// A view template filled with a tool's data: logic-less Mustache with a few formatting filters, so a
// template made once draws any later result of the same shape, and data never becomes markup.
//   {{path}}            the value, escaped (dotted paths; `.` is the current item; names are looked up outward)
//   {{path|filter}}     number · compact (1.2M) · date (31 Oct 2026; ISO, epoch seconds or ms) · datetime ·
//                       truncate:N · pct:other (path / other × 100, 0–100) · pctmax:list.field (of the largest) ·
//                       count (an array's length) · default:text · urlencode
//   {{#path}}…{{/path}} a list repeats per item, an object or true shows once; {{^path}}…{{/path}} when empty or false
// A filter's argument may be a path. Unknown names draw nothing, never an error.

type Scope = unknown[];
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;", "=": "&#61;" };
const escape = (text: string) => text.replace(/[&<>"'`=]/g, (c) => ESC[c]!);

function get(scope: Scope, path: string): unknown {
  if (path === ".") return scope[scope.length - 1];
  const [head, ...rest] = path.split(".");
  for (let i = scope.length - 1; i >= 0; i--) {
    const frame = scope[i];
    if (frame && typeof frame === "object" && head! in (frame as object)) return walk((frame as Record<string, unknown>)[head!], rest);
  }
  return undefined;
}
function walk(value: unknown, rest: string[]): unknown {
  for (const key of rest) {
    if (Array.isArray(value)) return value.map((v) => walk(v, [key])).flat();
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const toDate = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  const d = Number.isFinite(n) ? new Date(n < 1e11 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

function format(value: unknown, filter: string, scope: Scope): unknown {
  const [name, arg] = filter.split(/:(.*)/s).map((s) => s?.trim());
  const n = Number(value);
  if (value !== null && typeof value === "object" && name !== "count" && name !== "default") return undefined;
  switch (name) {
    case "number": return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : value;
    case "compact": return Number.isFinite(n) ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n) : value;
    case "date": return toDate(value)?.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) ?? value;
    case "datetime": return toDate(value)?.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) ?? value;
    case "truncate": { const s = String(value ?? ""), max = Number(arg) || 60; return s.length > max ? `${s.slice(0, max - 1)}…` : s; }
    case "pct": { const total = Number(get(scope, arg ?? "")); return Number.isFinite(n) && total > 0 ? Math.max(0, Math.min(100, (n / total) * 100)).toFixed(1) : 0; }
    case "pctmax": { const all = [get(scope, arg ?? "")].flat().map(Number).filter(Number.isFinite); const max = Math.max(0, ...all); return Number.isFinite(n) && max > 0 ? Math.max(0, Math.min(100, (n / max) * 100)).toFixed(1) : 0; }
    case "count": return Array.isArray(value) ? value.length : 0;
    case "default": return value === undefined || value === null || value === "" ? arg ?? "" : value;
    case "urlencode": return encodeURIComponent(String(value ?? ""));
    default: return value;
  }
}

const empty = (v: unknown) => v === undefined || v === null || v === false || v === "" || (Array.isArray(v) && v.length === 0);

/** The template drawn with `data`: the markup it has, with every value escaped. */
export function fill(template: string, data: unknown): string {
  return section(template, [data]);
}

function section(text: string, scope: Scope): string {
  let out = "";
  let at = 0;
  const tag = /\{\{\s*([#^/]?)\s*([^}]*?)\s*\}\}/g;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    out += text.slice(at, m.index);
    at = tag.lastIndex;
    const [, kind, body] = m;
    if (kind === "#" || kind === "^") {
      const close = findClose(text, body!, at);
      if (close === -1) { at = text.length; break; }
      const inner = text.slice(at, close.start);
      const value = get(scope, body!);
      if (kind === "^") out += empty(value) ? section(inner, scope) : "";
      else if (Array.isArray(value)) out += value.map((item) => section(inner, [...scope, item])).join("");
      // An object or a value shows once with itself as `.`; a list repeats.
      else if (!empty(value)) out += section(inner, [...scope, value]);
      at = close.end;
      tag.lastIndex = at;
    } else if (!kind) {
      const [path, ...filters] = body!.split("|").map((s) => s.trim());
      let value: unknown = get(scope, path!);
      for (const f of filters) value = format(value, f, scope);
      // Only text and numbers are drawn: an object or a list is never dumped into the page.
      out += value === undefined || value === null || typeof value === "object" ? "" : escape(String(value));
    }
  }
  return out + text.slice(at);
}

/** Where the section opened by `name` closes, nested sections of the same name skipped. */
function findClose(text: string, name: string, from: number): { start: number; end: number } | -1 {
  const tag = new RegExp(`\\{\\{\\s*([#^/])\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`, "g");
  tag.lastIndex = from;
  let depth = 1;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return { start: m.index, end: tag.lastIndex };
  }
  return -1;
}

/** A value's shape (keys and types; a list by its items' merged shape), the same for any data a template fits. */
export function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(value)) return value.length ? [value.slice(0, 20).map((v) => shapeOf(v, depth + 1)).reduce(merge)] : [];
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf((value as Record<string, unknown>)[k], depth + 1)]));
  return value === null ? "null" : typeof value;
}

/** Two items' shapes as one: every key either has, and a value that is null in one takes the other's. */
function merge(a: unknown, b: unknown): unknown {
  if (a === "null") return b;
  if (b === "null") return a;
  if (Array.isArray(a) && Array.isArray(b)) return a.length && b.length ? [merge(a[0], b[0])] : a.length ? a : b;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return Object.fromEntries(keys.map((k) => [k, k in a ? (k in b ? merge((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]) : (a as Record<string, unknown>)[k]) : (b as Record<string, unknown>)[k]]));
  }
  return a;
}
