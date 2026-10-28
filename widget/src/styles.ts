// The panel's styles, inside the Shadow DOM. The theme tokens (--a accent, --at text on it, --f font,
// --r radius, --bg, --fg, --mu muted, --bd border, --bb agent bubble, --ring focus) come from the
// loader, for light and dark. Every text color pair meets WCAG AA in both themes.
export const CSS = `
[hidden]{display:none!important}
.panel{all:initial;position:fixed;z-index:2147483001;bottom:84px;right:20px;box-sizing:border-box;width:min(380px,calc(100vw - 40px));height:min(620px,calc(100vh - 110px));display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:15px/1.45 var(--f);border:1px solid var(--bd);border-radius:var(--r);box-shadow:0 12px 40px #0003;overflow:hidden}
:host([data-position=left]) .panel{right:auto;left:20px}
header{display:flex;align-items:center;gap:10px;padding:10px 10px 10px 16px;border-bottom:1px solid var(--bd)}
header img{width:32px;height:32px;border-radius:50%;object-fit:cover}
h2{flex:1;margin:0;font-size:16px;font-weight:600}
h3{margin:0;font-size:15px;font-weight:600;flex:1}
button{font:inherit;color:inherit;cursor:pointer}
.x{border:0;background:none;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;flex:none}
.x:hover,.opt:hover,.chip:hover{background:var(--bb)}
svg{width:20px;height:20px;fill:currentColor}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.thread{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:16px;display:flex;flex-direction:column;gap:10px}
.row{display:flex;flex-direction:column;align-items:flex-start;max-width:85%}
.row.wide{max-width:100%}
.me{align-self:flex-end;align-items:flex-end}
.bubble{padding:9px 13px;border-radius:calc(var(--r) - 2px);background:var(--bb);overflow-wrap:anywhere;max-width:100%;box-sizing:border-box}
.me .bubble{background:var(--a);color:var(--at);white-space:pre-wrap}
.bubble img{display:block;max-width:100%;border-radius:10px;margin:2px 0 6px}
.md a{color:inherit;text-decoration:underline}
.md code{font:13px ui-monospace,Menlo,monospace;background:#8883;padding:1px 4px;border-radius:4px}
.md pre{white-space:pre-wrap;margin:4px 0}
.md ul,.md ol{margin:4px 0;padding-left:20px}
.quote{font-size:13px;color:var(--mu);border-left:3px solid var(--bd);padding:0 8px;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.chip{border:1px solid var(--bd);background:var(--bg);color:var(--fg);border-radius:999px;padding:7px 13px;min-height:36px;box-sizing:border-box;font-size:14px;text-decoration:none;display:inline-flex;align-items:center}
.cards{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;max-width:100%;padding:2px 2px 6px;margin-top:6px;box-sizing:border-box}
.card{flex:0 0 220px;scroll-snap-align:start;border:1px solid var(--bd);border-radius:12px;overflow:hidden;background:var(--bg);display:flex;flex-direction:column}
.card img{width:100%;height:140px;object-fit:cover;display:block}
.card .md{padding:8px 10px 0}
.card .chips{padding:0 10px 10px}
.note{font-size:12px;color:var(--mu);margin-top:3px}
.note button{border:0;background:none;text-decoration:underline;padding:0 0 0 4px;font-size:12px}
.react{font-size:14px;margin-top:-4px;background:var(--bg);border:1px solid var(--bd);border-radius:999px;padding:0 6px}
.typing{display:flex;align-items:center;gap:8px;padding:0 16px 8px;color:var(--mu);font-size:13px}
.dots{display:inline-flex;gap:3px}
.dots i{width:6px;height:6px;border-radius:50%;background:var(--mu);animation:blink 1.2s infinite}
.dots i:nth-child(2){animation-delay:.15s}
.dots i:nth-child(3){animation-delay:.3s}
@keyframes blink{0%,60%,100%{opacity:.3}30%{opacity:1}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
form{display:flex;gap:8px;align-items:flex-end;padding:10px 12px;border-top:1px solid var(--bd)}
textarea{flex:1;box-sizing:border-box;resize:none;border:1px solid var(--bd);border-radius:20px;padding:9px 14px;font:inherit;background:var(--bg);color:var(--fg);max-height:120px;line-height:1.35}
textarea::placeholder{color:var(--mu)}
.go{width:40px;height:40px;border-radius:50%;border:0;background:var(--a);color:var(--at);display:grid;place-items:center;flex:none}
.sheet{position:absolute;left:0;right:0;bottom:0;max-height:75%;overflow:auto;background:var(--bg);border-top:1px solid var(--bd);border-radius:var(--r) var(--r) 0 0;box-shadow:0 -8px 30px #0003;padding:6px 0 12px}
.sheet .head{display:flex;align-items:center;padding:0 6px 0 16px}
.opt{display:block;width:100%;text-align:left;border:0;background:none;padding:10px 16px}
.opt small{display:block;color:var(--mu);font-size:13px}
@media (max-width:639.98px){
.panel{inset:0;width:auto;height:100vh;height:100dvh;border:0;border-radius:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
textarea{font-size:16px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
