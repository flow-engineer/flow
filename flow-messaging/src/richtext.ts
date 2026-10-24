// Markdown read the same way Flow Messaging reads `format: markdown` content (its richtext
// package, ported rule for rule), so what an agent writes renders as it did when Flow Messaging
// rendered markdown itself. The adapter uses it to fill `telegram.parse_mode` HTML and
// `imessage.styles`.
//
// What it reads: **bold** and __bold__, *italic* and _italic_ (no space inside the marks; _ and
// __ only at word edges), ~~strikethrough~~, # headings (bold); Flow's tags <u>, <big>, <small>
// and the animations, each closed by </name>; `code`, ```code blocks``` and [text](https://...)
// links, never styled inside; bare http(s) URLs, kept exactly; a backslash before ASCII
// punctuation writes that character. A mark or tag without its closing one is text. Bold, italic
// and strikethrough do not span lines; tags may.

export type ImessageStyle =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "big"
  | "small"
  | "shake"
  | "nod"
  | "explode"
  | "ripple"
  | "bloom"
  | "jitter";

type Animation = "shake" | "nod" | "explode" | "ripple" | "bloom" | "jitter";

type Node =
  | { kind: "text" | "raw" | "code" | "codeblock"; text: string }
  | { kind: "bold" | "italic" | "underline" | "strike" | "big" | "small"; children: Node[] }
  | { kind: "animation"; name: Animation; children: Node[] }
  | { kind: "link"; url: string; children: Node[] };

const TAGS: Record<string, "underline" | "big" | "small" | "animation"> = {
  u: "underline",
  big: "big",
  small: "small",
  shake: "animation",
  nod: "animation",
  explode: "animation",
  ripple: "animation",
  bloom: "animation",
  jitter: "animation",
};

// Go's RE2 \s is [\t\n\f\r ], so the classes below spell it out.
const FENCE = /```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g;
const HEADING = /(?<=^|\n)#{1,6}[ \t]+([^\n]+)(?=\n|$)/g;
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\t\n\f\r ]+)\)/uy;
const BARE_URL = /https?:\/\/[^\t\n\f\r <>]+/uy;
const OPEN_TAG = /<(u|big|small|shake|nod|explode|ripple|bloom|jitter)>/y;
const URL_TRAIL = ".,;:!?)]'\"";
const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

/** Nesting bound; deeper marks are read as text. */
const MAX_DEPTH = 32;
/** What Go reads at a string's edge or in broken text (utf8.RuneError). */
const RUNE_ERROR = 0xfffd;

function parse(md: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of md.matchAll(FENCE)) {
    out.push(...block(md.slice(last, m.index)));
    out.push({ kind: "codeblock", text: m[1]!.replace(/\n+$/, "") });
    last = m.index + m[0].length;
  }
  out.push(...block(md.slice(last)));
  return out;
}

/** Text outside code blocks: headings as bold lines, the rest inline. */
function block(s: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of s.matchAll(HEADING)) {
    out.push(...inline(s.slice(last, m.index), 0));
    out.push({ kind: "bold", children: inline(m[1]!, 1) });
    last = m.index + m[0].length;
  }
  out.push(...inline(s.slice(last), 0));
  return out;
}

function isWord(r: number): boolean {
  return r === 0x5f || /[\p{L}\p{Nd}]/u.test(String.fromCodePoint(r));
}

function isSpace(r: number): boolean {
  return r === RUNE_ERROR || /\p{White_Space}/u.test(String.fromCodePoint(r));
}

const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;

/** The code point before s[i] (RUNE_ERROR at the start or on a lone surrogate). */
function before(s: string, i: number): number {
  if (i <= 0) return RUNE_ERROR;
  const u = s.charCodeAt(i - 1);
  if (isLow(u) && i >= 2 && isHigh(s.charCodeAt(i - 2))) return s.codePointAt(i - 2)!;
  return isHigh(u) || isLow(u) ? RUNE_ERROR : u;
}

/** The code point at s[j] (RUNE_ERROR at the end or on a lone surrogate). */
function after(s: string, j: number): number {
  if (j >= s.length) return RUNE_ERROR;
  const r = s.codePointAt(j)!;
  return r >= 0xd800 && r <= 0xdfff ? RUNE_ERROR : r;
}

/** The first ` or newline in s from `from`: its index, or -1. */
function tickOrNewline(s: string, from: number): number {
  for (let k = from; k < s.length; k++) if (s[k] === "`" || s[k] === "\n") return k;
  return -1;
}

function match(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}

/** One stretch of text. */
function inline(s: string, depth: number): Node[] {
  const out: Node[] = [];
  let buf = "";
  const add = (n: Node) => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
    out.push(n);
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length && ASCII_PUNCT.includes(s[i + 1]!)) {
      buf += s[i + 1];
      i += 2;
      continue;
    } else if (c === "`") {
      const k = tickOrNewline(s, i + 1);
      if (k > i + 1 && s[k] === "`") {
        add({ kind: "code", text: s.slice(i + 1, k) });
        i = k + 1;
        continue;
      }
    } else if (c === "[") {
      const m = match(LINK, s, i);
      if (m) {
        add({ kind: "link", url: m[2]!, children: inline(m[1]!, depth + 1) });
        i += m[0].length;
        continue;
      }
    } else if (c === "h" && !isWord(before(s, i))) {
      const m = match(BARE_URL, s, i);
      if (m) {
        let url = m[0];
        while (url && URL_TRAIL.includes(url[url.length - 1]!)) url = url.slice(0, -1);
        add({ kind: "raw", text: url });
        i += url.length;
        continue;
      }
    } else if (c === "<" && depth < MAX_DEPTH) {
      const m = match(OPEN_TAG, s, i);
      if (m) {
        const name = m[1]!;
        const end = closeTag(s, i + m[0].length, name);
        if (end >= 0) {
          const children = inline(s.slice(i + m[0].length, end), depth + 1);
          const kind = TAGS[name]!;
          add(kind === "animation" ? { kind, name: name as Animation, children } : { kind, children });
          i = end + name.length + 3;
          continue;
        }
      }
    } else if (c === "~" && s.startsWith("~~", i) && depth < MAX_DEPTH) {
      const end = closeMark(s, i + 2, "~~", false);
      if (end >= 0) {
        add({ kind: "strike", children: inline(s.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    } else if ((c === "*" || c === "_") && depth < MAX_DEPTH) {
      const word = c === "_";
      if (s.startsWith(c + c, i)) {
        if (opens(s, i, 2, word)) {
          const end = closeMark(s, i + 2, c + c, word);
          if (end >= 0) {
            add({ kind: "bold", children: inline(s.slice(i + 2, end), depth + 1) });
            i = end + 2;
            continue;
          }
        }
        // Two marks that open nothing are text, both.
        buf += c + c;
        i += 2;
        continue;
      }
      if (before(s, i) !== c.charCodeAt(0) && opens(s, i, 1, word)) {
        const end = closeMark(s, i + 1, c, word);
        if (end >= 0) {
          add({ kind: "italic", children: inline(s.slice(i + 1, end), depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }
    const size = isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1)) ? 2 : 1;
    buf += s.slice(i, i + size);
    i += size;
  }
  if (buf) out.push({ kind: "text", text: buf });
  return out;
}

/**
 * The mark of n characters at s[i] can open a span: text follows it with no space, and (for _
 * marks, and * when a word character comes before it) no word character comes before it.
 */
function opens(s: string, i: number, n: number, word: boolean): boolean {
  if (isSpace(after(s, i + n))) return false;
  if (word || s[i] === "*") return !isWord(before(s, i));
  return true;
}

/**
 * The closing mark for a span opened before `from`, on the same line: a mark preceded by no space
 * (and, for word marks, followed by no word character), not part of a longer run of the same
 * character. -1: none.
 */
function closeMark(s: string, from: number, mark: string, word: boolean): number {
  const c = mark[0];
  for (let j = from; j < s.length; j++) {
    const ch = s[j];
    if (ch === "\n") return -1;
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "`") {
      // A code span inside is skipped whole.
      const k = tickOrNewline(s, j + 1);
      if (k > j + 1 && s[k] === "`") j = k;
      continue;
    }
    if (ch !== c) continue;
    let run = j;
    while (run < s.length && s[run] === c) run++;
    const n = run - j;
    if (j === from) {
      // Right after the opening mark: an empty span is never one.
      j = run - 1;
      continue;
    }
    if (mark.length === 1 && n === 2 && c !== "~") {
      // A double mark inside a single one is a nested bold: skip it.
      j = run - 1;
      continue;
    }
    if (n >= mark.length && !isSpace(before(s, j)) && (!word || !isWord(after(s, j + mark.length)))) {
      // "***x***": the bold closes on the last two.
      return n > mark.length && mark.length === 2 ? run - 2 : j;
    }
    j = run - 1;
  }
  return -1;
}

/** The </name> closing a tag opened before `from`, counting nested ones of the same name. -1: none. */
function closeTag(s: string, from: number, name: string): number {
  const open = `<${name}>`;
  const end = `</${name}>`;
  let depth = 1;
  for (let j = from; j < s.length; ) {
    if (s.startsWith(open, j)) {
      depth++;
      j += open.length;
    } else if (s.startsWith(end, j)) {
      if (--depth === 0) return j;
      j += end.length;
    } else {
      j++;
    }
  }
  return -1;
}

/** Go's html.EscapeString. */
function escape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" })[ch]!);
}

function telegram(nodes: Node[]): string {
  let out = "";
  for (const n of nodes) {
    switch (n.kind) {
      case "text":
      case "raw":
        out += escape(n.text);
        break;
      case "code":
        out += `<code>${escape(n.text)}</code>`;
        break;
      case "codeblock":
        out += `<pre>${escape(n.text)}</pre>`;
        break;
      case "link":
        out += `<a href="${escape(n.url)}">${telegram(n.children)}</a>`;
        break;
      case "bold":
        out += `<b>${telegram(n.children)}</b>`;
        break;
      case "italic":
        out += `<i>${telegram(n.children)}</i>`;
        break;
      case "underline":
        out += `<u>${telegram(n.children)}</u>`;
        break;
      case "strike":
        out += `<s>${telegram(n.children)}</s>`;
        break;
      default:
        out += telegram(n.children);
    }
  }
  return out;
}

/**
 * Markdown as the HTML Telegram's parse_mode HTML takes: <b>, <i>, <u>, <s>, <code>, <pre> and
 * <a href>, everything else escaped; sizes and animations are left out, their text kept.
 */
export function telegramHTML(md: string): string {
  return telegram(parse(md));
}

const STYLE_OF = { bold: "bold", italic: "italic", underline: "underline", strike: "strikethrough", big: "big", small: "small" } as const;

/**
 * Markdown as plain text (every mark taken out; a link as "text (url)", or the url alone when the
 * text is the url) and the styled ranges over it, in UTF-16 code units, outer styles first.
 */
export function imessageStyles(md: string): { text: string; styles: Array<{ start: number; length: number; style: ImessageStyle }> } {
  let text = "";
  const styles: Array<{ start: number; length: number; style: ImessageStyle }> = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "text":
        case "raw":
        case "code":
        case "codeblock":
          text += n.text;
          break;
        case "link": {
          // The children's text is plainText(children); a link's styles cover only that part.
          const start = text.length;
          walk(n.children);
          if (text.slice(start) !== n.url) text += ` (${n.url})`;
          break;
        }
        default: {
          const range = { start: text.length, length: 0, style: n.kind === "animation" ? n.name : STYLE_OF[n.kind] };
          styles.push(range);
          walk(n.children);
          range.length = text.length - range.start;
        }
      }
    }
  };
  walk(parse(md));
  return { text, styles: styles.filter((r) => r.length > 0) };
}
