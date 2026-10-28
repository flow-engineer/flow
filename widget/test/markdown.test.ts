// covers: widget/src/markdown.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown } from "../src/markdown.ts";

test("raw HTML in the agent's text is shown as text, never as markup", () => {
  assert.equal(markdown(`<script>alert(1)</script> <img src=x onerror="alert(1)">`), "&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  // Inside code and link labels too, and a quote cannot leave the href.
  assert.equal(markdown("`<b>`"), "<code>&lt;b&gt;</code>");
  assert.equal(
    markdown(`[<i>x</i>](https://a.example/"onmouseover="alert(1))`),
    `<a href="https://a.example/&quot;onmouseover=&quot;alert(1" target="_blank" rel="noopener noreferrer">&lt;i&gt;x&lt;/i&gt;</a>)`,
  );
});

test("only http(s) links become links, opening in a new tab with noopener", () => {
  assert.equal(markdown("[tap](javascript:alert(1))"), "[tap](javascript:alert(1))");
  assert.equal(markdown("[tap](data:text/html,hi)"), "[tap](data:text/html,hi)");
  assert.equal(markdown("[Order](https://shop.example/o?a=1&b=2)"), `<a href="https://shop.example/o?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Order</a>`);
  assert.equal(markdown("See https://shop.example/x."), `See <a href="https://shop.example/x" target="_blank" rel="noopener noreferrer">https://shop.example/x</a>.`);
});

test("the subset is drawn: bold, italics, code, lists and line breaks", () => {
  assert.equal(markdown("**Price:** _₹45,000_ and `snake_case_name`"), "<b>Price:</b> <i>₹45,000</i> and <code>snake_case_name</code>");
  assert.equal(markdown("Pick one:\n- Disc\n- Digital\nThanks"), "Pick one:<ul><li>Disc</li><li>Digital</li></ul>Thanks");
  assert.equal(markdown("1. One\n2. **Two**"), "<ol><li>One</li><li><b>Two</b></li></ol>");
  assert.equal(markdown("Hi!\nHow can I help?"), "Hi!<br>How can I help?");
});
