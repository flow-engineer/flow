// Flow's own sign-in page: where `flow mcp login` ends in the browser, after flow.engineer's Allow
// page, in flow.engineer's look (its palette, fonts, logo, and the login page's card on the brand
// gradient). Teams' CLIs keep the framework's branded page (cli/src/auth.ts); this is Flow's
// signInPage, as any team could write its own.

import { createHash } from "node:crypto";
import type { SignInPage } from "../../cli/src/commands.ts";

// Flow's logo, the chevrons and "flow", drawn as flow.engineer's header draws it (web/src/data/logo.mjs).
const MARK = "M47.1 149.9C47.1 151 47.3 152.6 48.1 153.7C48.8 154.8 50 155.7 51.5 156.4C53 157.2 51.7 156.9 57 158C62.2 159.2 74.8 161.4 82.9 163.4C91.1 165.4 99.5 167.8 105.8 169.9C112.1 172.1 117.4 174.6 120.8 176.2C124.1 177.8 124.6 178.5 126 179.5C127.4 180.5 128.2 181.3 129.3 182.4C130.4 183.6 131.5 184.8 132.7 186.5C133.8 188.2 135.1 190.5 136.1 192.4C137 194.4 137.5 195.7 138.3 198.1C139.1 200.6 139.9 202.9 140.6 207C141.3 211.1 142 215.7 142.4 222.5C142.9 229.4 142.8 242.8 143 247.9C143.3 253 143.4 251.8 143.8 253.1C144.3 254.5 144.9 255.2 145.6 255.8C146.3 256.5 147.2 256.8 148 257C148.8 257.1 149.5 257.1 150.4 256.8C151.2 256.5 152.2 255.9 153.1 254.9C154 254 154.8 252.6 155.6 251.1C156.3 249.7 156.5 249.5 157.5 246C158.6 242.6 160.5 236.2 161.9 230.4C163.3 224.6 164.7 218 165.8 211.3C166.9 204.5 168 196.3 168.5 190C169 183.7 169 177.7 168.9 173.3C168.8 168.9 168.4 166.7 167.9 163.7C167.3 160.8 166.5 157.9 165.5 155.6C164.5 153.3 163 151.4 161.8 150C160.6 148.7 159.6 148.2 158.4 147.4C157.2 146.6 156.2 146 154.4 145.2C152.6 144.5 150 143.5 147.7 142.9C145.3 142.2 143.8 141.7 140.3 141.1C136.8 140.5 132.3 139.5 126.4 139.1C120.6 138.6 113.3 138 105.3 138.1C97.3 138.2 86.7 138.9 78.4 139.7C70.1 140.4 60.2 142 55.7 142.7C51.3 143.4 52.8 143.4 51.8 143.8C50.8 144.2 50.3 144.5 49.6 145.1C49 145.7 48.2 146.6 47.7 147.4C47.3 148.2 47 148.9 47.1 149.9ZM104 99C104.1 100.1 104.3 101.6 105.1 102.7C105.9 103.8 103.3 103.8 108.9 105.4C114.5 106.9 130.4 109.9 138.9 112C147.3 114 153.7 115.8 159.8 117.9C165.9 119.9 171.8 122.6 175.4 124.2C179 125.9 179.6 126.5 181.2 127.7C182.8 128.8 183.9 129.9 185.2 131.1C186.4 132.4 187.4 133.4 188.6 135.1C189.7 136.7 190.9 138.8 192 141C193.1 143.3 194.1 146.3 194.9 148.6C195.7 151 195.9 151.3 196.6 155.2C197.2 159.1 198.3 165 198.7 171.9C199.1 178.8 198.8 191.4 199 196.5C199.2 201.6 199.4 201 199.8 202.5C200.2 203.9 200.6 204.4 201.3 205C201.9 205.7 202.6 206.3 203.5 206.5C204.3 206.7 205.4 206.8 206.3 206.5C207.1 206.2 208 205.6 208.8 204.8C209.6 204 210.2 203 210.9 201.6C211.6 200.2 211.9 199.6 212.8 196.5C213.7 193.3 215 189.7 216.4 182.7C217.9 175.7 220.4 161.9 221.6 154.3C222.8 146.7 223.2 142.3 223.6 137.1C224.1 131.9 224.3 127.2 224.3 123.2C224.2 119.1 223.9 115.9 223.5 112.9C223.1 109.9 222.5 107.4 221.6 105.2C220.7 103 219.9 101.4 218.2 99.6C216.5 97.9 214.2 96.2 211.2 94.8C208.2 93.3 204.7 92.2 200.3 91.1C195.9 90 190.4 89 184.8 88.3C179.1 87.7 173.7 87.1 166.4 87.1C159.2 87 149.9 87.2 141.1 87.9C132.2 88.7 118.8 90.7 113.5 91.4C108.2 92.2 110.3 92 109.2 92.4C108.1 92.8 107.4 93.1 106.7 93.7C106 94.3 105.2 95.1 104.7 96C104.3 96.9 104 97.9 104 99Z";
const WORD = "M296 231V167.6H280.9V154.7L305 156.3V154.9C300 154 295.9 152.5 292.8 150.4C289.6 148.2 287.4 145.6 285.9 142.4C284.5 139.2 283.8 135.7 283.8 131.8C283.8 127 284.9 122.7 287.2 118.9C289.5 115 292.6 112 296.7 109.9C300.9 107.7 306 106.6 311.8 106.6C316.5 106.6 320.8 107.4 324.8 109C328.8 110.4 332.2 112.7 335.2 116L333.1 132C329.6 128.5 326.3 126.1 323.2 124.6C320.1 123.1 316.9 122.3 313.6 122.3C309 122.3 305.4 123.7 302.8 126.6C300.4 129.4 299.2 132.7 299.2 136.7C299.2 139.9 300 142.9 301.6 145.5C303.1 148.1 305.3 150.2 308.1 151.8C310.8 153.2 313.9 154 317.2 154H333.6V167.6H312.2V231H296ZM345.3 231V108.6H361.7V231H345.3ZM420.7 233.3C412.2 233.3 404.5 231.5 397.6 227.9C390.9 224.3 385.6 218.9 381.6 211.7C377.8 204.4 375.9 195.4 375.9 184.6C375.9 173.6 377.8 164.6 381.8 157.4C385.8 150.2 391 144.8 397.6 141.2C404.4 137.5 411.9 135.6 420.1 135.6C428.5 135.6 436.1 137.5 442.8 141.2C449.5 144.9 454.8 150.4 458.7 157.7C462.6 164.9 464.6 174 464.6 184.9C464.6 195.8 462.7 204.9 458.8 212.1C455 219.3 449.7 224.6 443 228.1C436.4 231.6 429 233.3 420.7 233.3ZM420.7 219.8C426.3 219.8 431.2 218.5 435.3 215.9C439.3 213.1 442.5 209.2 444.6 204.2C446.8 199.1 447.9 193 447.9 185.6C447.9 178.2 446.7 171.8 444.4 166.6C442.2 161.2 438.9 157 434.7 154.1C430.6 151.1 425.7 149.6 420 149.6C414.3 149.6 409.5 151.1 405.4 154C401.3 156.7 398.1 160.7 395.8 166C393.7 171.2 392.6 177.3 392.6 184.4C392.6 195.3 395.1 203.9 400 210.3C405 216.7 411.9 219.8 420.7 219.8ZM494.2 231L468.4 138.1H485.9L505.1 216.6H506L525.8 138.1H544.9L563.8 216.6H564.7L585.2 138.1H602L575.5 231H553.2L535.4 155.9H534.8L516.1 231H494.2Z";

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

// flow.engineer's tokens (web/src/styles/site.css): colours only from its palette and neutrals.
// Light only, as every Flow page is.
const STYLE = `
:root { color-scheme: light;
  --sage: #CDDD95; --lavender: #DFE6F7; --blush: #F3E8EE; --peach: #FDE9D6; --sage-deep: #6E7F2E;
  --gradient: linear-gradient(135deg, var(--lavender) 0%, var(--blush) 55%, var(--peach) 100%);
  --bg: #fff; --surface: #fff; --ink: rgb(28, 26, 23); --ink-2: rgba(28, 26, 23, .72); --ink-3: rgba(28, 26, 23, .56); --line: rgba(28, 26, 23, .1);
  --term: #1c1a17;
  --lift: 0 0 0 1px rgba(95, 99, 106, .1), 0 12px 32px -8px rgba(43, 43, 48, .16);
  --head: 'Bricolage Grotesque', 'Inter', system-ui, sans-serif; --font: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 400 1rem/1.5 var(--font); -webkit-font-smoothing: antialiased; }
.page { min-height: 100vh; min-height: 100svh; display: flex; flex-direction: column; }
.top { display: flex; align-items: center; height: 74px; padding: 16px 24px 0; max-width: 1328px; width: 100%; margin: 0 auto; color: var(--ink); }
.top svg { display: block; }
.main { flex: 1; display: grid; place-items: start center; padding: 40px 16px 72px; }
.panel { width: min(100%, 520px); padding: clamp(10px, 3vw, 36px); background: var(--gradient); border-radius: 24px; }
.card { background: var(--surface); border-radius: 20px; box-shadow: var(--lift); padding: 32px; display: grid; gap: 16px; justify-items: start; }
.card > * { margin: 0; max-width: 100%; }
.state { display: inline-flex; align-items: center; gap: 8px; height: 28px; padding: 0 12px; border-radius: 999px; font: 500 .8125rem/1 var(--font); background: var(--mark-bg); color: var(--mark-ink); }
.state::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.ok { --mark-bg: color-mix(in srgb, var(--sage) 55%, #fff); --mark-ink: var(--sage-deep); } .bad { --mark-bg: var(--peach); --mark-ink: var(--ink); }
h1 { font: 500 1.875rem/1.12 var(--head); letter-spacing: -.02em; text-wrap: balance; }
.message { color: var(--ink-2); }
.term { width: 100%; margin-top: 8px; background: var(--term); color: #f4f4f2; border-radius: 16px; box-shadow: 0 12px 32px -12px rgba(43, 43, 48, .35); overflow: hidden; }
.bar { display: flex; align-items: center; gap: 6px; padding: 11px 14px; border-bottom: 1px solid rgba(255, 255, 255, .08); font: 400 .75rem/1 var(--mono); color: rgba(255, 255, 255, .55); }
.bar i { width: 10px; height: 10px; border-radius: 50%; background: rgba(255, 255, 255, .22); }
.bar span { margin-left: 8px; }
.lines { padding: 14px 18px 16px; font: 400 .8125rem/1.7 var(--mono); overflow-wrap: anywhere; }
.lines div { white-space: pre-wrap; }
.p { color: var(--sage); } .good { color: var(--sage); } .fail { color: var(--peach); } .dim { color: rgba(255, 255, 255, .55); }
.cursor { display: inline-block; width: 8px; height: 1.1em; vertical-align: -.2em; background: #f4f4f2; animation: blink 1.1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .cursor { animation: none; } }
.close { font-size: .875rem; color: var(--ink-3); }
.close code { font: 500 .875em/1 var(--mono); padding: 2px 6px; border-radius: 6px; background: var(--line); color: var(--ink); overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .top { padding-inline: 16px; height: 64px; }
  .main { padding-top: 12px; }
  .panel { padding: 10px; border-radius: 20px; }
  .card { padding: 24px 20px; }
  h1 { font-size: 1.625rem; }
}
`;

const FONTS = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500&family=Inter:wght@400;500&display=swap";

/** The page, both outcomes, light only. Its CSP is a meta tag naming its own style and script by hash (a signInPage gets no nonce); the fonts are flow.engineer's, with system fonts when they cannot load. */
export function flowSignInPage(page: SignInPage): string {
  const ok = page.status === "signed-in";
  const command = escape(page.command);
  const script = `history.replaceState(null, "", location.pathname);${ok ? " setTimeout(function () { window.close(); }, 1500);" : ""}`;
  const csp = `default-src 'none'; style-src ${hash(STYLE)} https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src ${hash(script)}; base-uri 'none'; form-action 'none'`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="color-scheme" content="light">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${ok ? "Signed in to Flow" : "Flow: sign-in didn't finish"}</title>
<link rel="stylesheet" href="${FONTS}">
<style>${STYLE}</style>
</head>
<body>
<div class="page">
<header class="top" role="img" aria-label="Flow"><svg width="84.8" height="26" viewBox="47 87 555 170.25" fill="none" aria-hidden="true"><path d="${MARK}" fill="currentColor"/><path d="${WORD}" fill="currentColor"/></svg></header>
<main class="main"><div class="panel"><div class="card">
<div class="state ${ok ? "ok" : "bad"}">${ok ? "Signed in" : "Not signed in"}</div>
<h1>${ok ? "Head back to your terminal." : "Sign-in didn't finish."}</h1>
<p class="message">${escape(page.message)}</p>
<div class="term" aria-hidden="true">
<div class="bar"><i></i><i></i><i></i><span>${escape(page.cli)}</span></div>
<div class="lines">
<div><span class="p">$</span> ${command}</div>
${ok ? "<div class=\"good\">✓ Signed in to Flow</div>" : "<div class=\"fail\">✕ Sign-in didn't finish</div><div class=\"dim\"># run it again to try once more</div>"}
<div><span class="p">$</span> ${ok ? "" : command}<span class="cursor"></span></div>
</div>
</div>
<p class="close">${ok ? "You can close this tab." : `Run <code>${command}</code> in your terminal to try again.`}</p>
</div></div></main>
</div>
<script>${script}</script>
</body>
</html>
`;
}
