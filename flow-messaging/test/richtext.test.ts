// covers: flow-messaging/src/richtext.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { imessageStyles, telegramHTML } from "../src/richtext.ts";

// Flow Messaging's own TestRender table (messaging/internal/richtext): input, its Telegram
// column, its plain column.
const CASES: Array<[name: string, input: string, telegram: string, plain: string]> = [
  ["plain text", "hello there", "hello there", "hello there"],
  ["bold", "**hi** and __hi__", "<b>hi</b> and <b>hi</b>", "hi and hi"],
  ["italic", "*it* and _it_", "<i>it</i> and <i>it</i>", "it and it"],
  ["strike", "~~gone~~", "<s>gone</s>", "gone"],
  ["underline", "<u>under</u>", "<u>under</u>", "under"],
  ["sizes", "<big>Big</big> <small>small</small>", "Big small", "Big small"],
  ["every animation", "<shake>a</shake><nod>b</nod><explode>c</explode><ripple>d</ripple><bloom>e</bloom><jitter>f</jitter>", "abcdef", "abcdef"],
  ["nested marks", "**bold _and it_**", "<b>bold <i>and it</i></b>", "bold and it"],
  ["marks inside a tag", "<big>**Sale** ~~$20~~ $10</big>", "<b>Sale</b> <s>$20</s> $10", "Sale $20 $10"],
  ["a tag inside marks", "**<shake>now</shake>**", "<b>now</b>", "now"],
  ["the same tag nested", "<big>a <big>b</big> c</big>", "a b c", "a b c"],
  ["a tag across lines", "<small>one\ntwo</small>", "one\ntwo", "one\ntwo"],
  ["unclosed tag", "<big>no end", "&lt;big&gt;no end", "<big>no end"],
  ["stray closing tag", "end</u>", "end&lt;/u&gt;", "end</u>"],
  ["unknown tag", "<b>x</b> <script>", "&lt;b&gt;x&lt;/b&gt; &lt;script&gt;", "<b>x</b> <script>"],
  ["mismatched tags", "<u>a<big>b</u>c</big>", "<u>a&lt;big&gt;b</u>c&lt;/big&gt;", "a<big>bc</big>"],
  ["unclosed bold", "**half", "**half", "**half"],
  ["bold across lines is text", "**one\ntwo**", "**one\ntwo**", "**one\ntwo**"],
  ["spaced asterisks", "2 * 3 * 4", "2 * 3 * 4", "2 * 3 * 4"],
  ["intraword asterisks", "2*3*4", "2*3*4", "2*3*4"],
  ["escaped asterisks", "\\*not\\* italic", "*not* italic", "*not* italic"],
  ["one literal mark", "a \\* b", "a * b", "a * b"],
  ["snake case", "snake_case_name stays", "snake_case_name stays", "snake_case_name stays"],
  ["literal tag markup", "\\[big] is literal", "[big] is literal", "[big] is literal"],
  ["code", "`a **b** c`", "<code>a **b** c</code>", "a **b** c"],
  ["code block", "```go\nx = **1**\n```", "<pre>x = **1**</pre>", "x = **1**"],
  ["link", "[Flow](https://flow.engineer)", '<a href="https://flow.engineer">Flow</a>', "Flow (https://flow.engineer)"],
  ["link to itself", "[https://a.example](https://a.example)", '<a href="https://a.example">https://a.example</a>', "https://a.example"],
  ["bare url keeps underscores", "see https://x.dev/a_b_c_d.", "see https://x.dev/a_b_c_d.", "see https://x.dev/a_b_c_d."],
  ["heading", "# Title\nbody", "<b>Title</b>\nbody", "Title\nbody"],
  ["emoji", "**🎉 party** <bloom>🌸</bloom> 👍🏽", "<b>🎉 party</b> 🌸 👍🏽", "🎉 party 🌸 👍🏽"],
  ["html is escaped for telegram", "a & <b>", "a &amp; &lt;b&gt;", "a & <b>"],
  ["triple marks", "***both***", "<b><i>both</i></b>", "both"],
  ["empty marks", "**** and __", "**** and __", "**** and __"],
];

test("telegramHTML renders every case as Flow Messaging's Telegram renderer does", () => {
  for (const [name, input, want] of CASES) assert.equal(telegramHTML(input), want, name);
  assert.equal(telegramHTML(`"quoted" & 'single'`), "&#34;quoted&#34; &amp; &#39;single&#39;");
});

test("imessageStyles gives the plain text and its styled ranges in UTF-16 offsets", () => {
  for (const [name, input, , plain] of CASES) assert.equal(imessageStyles(input).text, plain, name);

  const styles = (md: string) => imessageStyles(md).styles;
  assert.deepEqual(styles("**hi** and __hi__"), [
    { start: 0, length: 2, style: "bold" },
    { start: 7, length: 2, style: "bold" },
  ]);
  assert.deepEqual(styles("**bold _and it_**"), [
    { start: 0, length: 11, style: "bold" },
    { start: 5, length: 6, style: "italic" },
  ]);
  assert.deepEqual(styles("***both***"), [
    { start: 0, length: 4, style: "bold" },
    { start: 0, length: 4, style: "italic" },
  ]);
  assert.deepEqual(styles("<small>one\ntwo</small>"), [{ start: 0, length: 7, style: "small" }]);
  assert.deepEqual(imessageStyles("🎉 **hi**"), { text: "🎉 hi", styles: [{ start: 3, length: 2, style: "bold" }] });
  assert.deepEqual(styles("**🎉 party** <bloom>🌸</bloom> 👍🏽"), [
    { start: 0, length: 8, style: "bold" },
    { start: 9, length: 2, style: "bloom" },
  ]);
  assert.deepEqual(imessageStyles("see [**Flow**](https://flow.engineer) <u>~~now~~</u>"), {
    text: "see Flow (https://flow.engineer) now",
    styles: [
      { start: 4, length: 4, style: "bold" },
      { start: 33, length: 3, style: "underline" },
      { start: 33, length: 3, style: "strikethrough" },
    ],
  });
  assert.deepEqual(styles("<big>B</big><small>s</small><shake>a</shake><nod>b</nod><explode>c</explode><ripple>d</ripple><bloom>e</bloom><jitter>f</jitter>"), [
    { start: 0, length: 1, style: "big" },
    { start: 1, length: 1, style: "small" },
    { start: 2, length: 1, style: "shake" },
    { start: 3, length: 1, style: "nod" },
    { start: 4, length: 1, style: "explode" },
    { start: 5, length: 1, style: "ripple" },
    { start: 6, length: 1, style: "bloom" },
    { start: 7, length: 1, style: "jitter" },
  ]);
  for (const md of ["**half", "<big>no end", "**one\ntwo**", "**** and __", "2 * 3 * 4", "snake_case_name", "`**code**`", "hello"]) {
    assert.deepEqual(styles(md), [], md);
  }
});

// Telegram counts a parse_mode text's length after parsing (V0's rule), so a Markdown text the send
// tool let through (at most TELEGRAM.maxLength) must never parse longer than it was written.
test("telegramHTML's text, as Telegram parses it, is never longer than the Markdown", () => {
  // The length Telegram counts: tags are not text, and an entity is one character (UTF-16 code units).
  const parsedLength = (html: string) => {
    let n = 0;
    for (let i = 0; i < html.length; i++) {
      if (html[i] === "<") i = html.indexOf(">", i);
      else {
        if (html[i] === "&") i = html.indexOf(";", i);
        n++;
      }
    }
    return n;
  };
  const escaped = `<&>"'`.repeat(820).slice(0, 4096);
  for (const md of [...CASES.map(([, input]) => input), escaped, `**${"a".repeat(4092)}**`, `[${"a".repeat(2000)}](https://${"b".repeat(2000)}.example)`]) {
    assert.ok(parsedLength(telegramHTML(md)) <= md.length, md.slice(0, 40));
  }
  assert.ok(telegramHTML(escaped).length > 4096 && parsedLength(telegramHTML(escaped)) === 4096); // longer than the limit only before parsing
});
