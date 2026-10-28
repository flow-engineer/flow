// The agent's Markdown as safe HTML. Everything is escaped first; then only a small subset is drawn:
// **bold**, *italics*, `code`, ``` blocks ```, line breaks, - and 1. lists, and http(s) links, which
// open in a new tab with rel="noopener noreferrer". No raw HTML ever reaches the page, and a link to
// any other scheme (javascript:, data:) stays plain text.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const anchor = (url: string, label: string) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;

// Pieces drawn before the rest is escaped: their contents get no marks. Bare URLs end before trailing punctuation.
const PIECES: Array<[RegExp, (...m: string[]) => string]> = [
  [/```(?:[\w-]*\n)?([\s\S]+?)```/g, (_, code) => `<pre><code>${escapeHtml(code)}</code></pre>`],
  [/`([^`\n]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`],
  [/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_, label, url) => anchor(url, label)],
  [/\bhttps?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'*_~]/gi, (url) => anchor(url, url)],
];

const MARKS: Array<[RegExp, string]> = [
  [/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, "<b>$1</b>"],
  [/__(\S(?:[^_\n]*\S)?)__/g, "<b>$1</b>"],
  [/(^|[^\w*])\*(\S(?:[^*\n]*\S)?)\*(?![\w*])/g, "$1<i>$2</i>"],
  [/(^|[^\w])_(\S(?:[^_\n]*\S)?)_(?!\w)/g, "$1<i>$2</i>"],
  [/~~(\S(?:[^~\n]*\S)?)~~/g, "<s>$1</s>"],
];

const marks = (html: string) => MARKS.reduce((out, [pattern, to]) => out.replace(pattern, to), html);

export function markdown(text: string): string {
  const kept: string[] = [];
  let html = text.replace(/\0/g, "");
  for (const [pattern, draw] of PIECES) html = html.replace(pattern, (...m) => `\0${kept.push(draw(...m)) - 1}\0`);
  html = escapeHtml(html);
  // Lines: runs of "- item" or "1. item" become lists; other lines are joined with line breaks.
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  for (const line of html.split("\n")) {
    const item = /^\s*(?:([-*•])|\d+[.)])\s+(.*)$/.exec(line);
    const kind = item ? (item[1] ? "ul" : "ol") : null;
    if (list && kind !== list) out.push(`</${list}>`);
    if (kind && kind !== list) {
      if (out.length) out[out.length - 1] = out[out.length - 1].replace(/\n$/, "");
      out.push(`<${kind}>`);
    }
    list = kind;
    if (item) out.push(`<li>${marks(item[2])}</li>`);
    else out.push(marks(line) + "\n");
  }
  if (list) out.push(`</${list}>`);
  html = out.join("").replace(/\n$/, "").replace(/\n/g, "<br>");
  return html.replace(/\0(\d+)\0/g, (_, i) => kept[Number(i)]);
}
