// app/embed.js: the web app's launcher, the one script a site embeds. A classic script (no import or
// export). It reads the brand's launcher settings from the agent (/app/config), draws the launcher in
// a Shadow DOM and, when opened, docks the app (an iframe on the agent's origin, where the person's
// token stays) at the side of the page. The page moves over to make room rather than being covered:
// <html> gets the `flow-app-open` class and a margin the panel's width, kept in the CSS variable
// --flow-app-width for the site's own fixed elements (`right: var(--flow-app-width, 0)`). On a narrow
// screen the panel covers the page instead. People can drag its edge to make it wider.
//
// It answers the app's sign-in requests with the site's own FlowAppConfig.signIn, so a person signed
// in on the site is signed in in the app:
//
//   window.FlowAppConfig = {
//     account: "<the signed-in person's id on the site>",     // a new id signs the app in afresh
//     signIn: async (request) => ({ code, state }),           // mint the login page's code for request
//   };
//
// Links in the chat to the site's own pages open in the site: with FlowAppConfig.navigate(path) (the
// site's router, for a single-page app), else as a normal page load. Each is then checked: a page that
// loaded with an error, a "not found" page, a redirect elsewhere, or FlowAppConfig.pageFailed() saying so
// (for pages that load but show their own failure) is reported to the app, for the brand's insights.
//
// window.FlowApp: open(), close(), configure(config), signOut() (the person signed out on the site).
(() => {
  type Request = { nonce: string; returnTo: string; clientId: string; resource: string };
  type Config = {
    account?: string;
    signIn?: (request: Request) => Promise<{ code: string; state: string } | null>;
    navigate?: (path: string) => void | Promise<void>;
    /** After a link from the chat opened: why the page failed (or true), else nothing. */
    pageFailed?: () => string | boolean | null | undefined;
  };
  type LinkResult = { url: string; ok: boolean; status?: number; reason?: string };
  type Launcher = { title: string; label: string; position: "right" | "left"; shape: "pill" | "circle" | "tab"; logo?: string; accent: string; accentText?: string; radius: number; font?: string; width: number };
  const w = window as unknown as { FlowApp?: object; FlowAppConfig?: Config };
  const script = (document.currentScript ?? document.querySelector('script[src*="/app/embed.js"]')) as HTMLScriptElement | null;
  if (w.FlowApp || !script) return;
  const src = new URL(script.src, location.href);
  const root = src.origin + src.pathname.replace(/\/embed\.js$/, "");
  const key = `flow-app:${src.origin}`;
  let config: Config = w.FlowAppConfig ?? {};
  let frame: HTMLIFrameElement | undefined;
  let opened = false;
  let ready = false;
  const post = (message: object) => frame?.contentWindow?.postMessage({ flowApp: 1, ...message }, src.origin);
  // Link results wait here until the app is open to take them (a page load starts it afresh).
  const queued = (): LinkResult[] => { try { return JSON.parse(sessionStorage.getItem(`${key}:links`) ?? "[]"); } catch { return []; } };
  const deliver = (result?: LinkResult) => {
    const all = [...queued(), ...(result ? [result] : [])];
    if (ready && frame) { for (const r of all) post({ type: "link-result", ...r }); sessionStorage.removeItem(`${key}:links`); }
    else sessionStorage.setItem(`${key}:links`, JSON.stringify(all.slice(-20)));
  };
  const check = () => {
    let pending: { url: string; at: number } | null = null;
    try { pending = JSON.parse(sessionStorage.getItem(`${key}:pending`) ?? "null"); } catch { /* none */ }
    sessionStorage.removeItem(`${key}:pending`);
    if (!pending || Date.now() - pending.at > 60_000) return;
    const target = new URL(pending.url);
    const entry = performance.getEntriesByType("navigation")[0] as (PerformanceNavigationTiming & { responseStatus?: number }) | undefined;
    const status = entry && entry.name.split("#")[0] === target.href.split("#")[0] ? entry.responseStatus : undefined;
    let reason: string | undefined;
    if (status && status >= 400) reason = `HTTP ${status}`;
    else if (/\b404\b|not found|could not be found/i.test(document.title)) reason = "page not found";
    else if (location.pathname !== target.pathname) reason = `went to ${location.pathname}`;
    else {
      const failed = (() => { try { return config.pageFailed?.(); } catch { return undefined; } })();
      if (failed) reason = typeof failed === "string" ? failed : "the page showed an error";
    }
    deliver({ url: target.href, ok: !reason, ...(status ? { status } : {}), ...(reason ? { reason } : {}) });
  };
  const go = async (path: string) => {
    const target = new URL(path, location.origin);
    if (target.origin !== location.origin) return;
    sessionStorage.setItem(`${key}:pending`, JSON.stringify({ url: target.href, at: Date.now() }));
    if (config.navigate) {
      await Promise.resolve(config.navigate(`${target.pathname}${target.search}${target.hash}`)).catch(() => undefined);
      // The site's router may take a while (a page compiled on first use): wait for its address to change,
      // then for the page to settle, before judging it. Still elsewhere after that, it went elsewhere.
      const until = Date.now() + 15_000;
      const settled = () => (location.pathname === target.pathname || Date.now() > until ? setTimeout(check, 1500) : setTimeout(settled, 200));
      settled();
    } else location.assign(target.href);
  };
  // Opened by a link from the chat: check the page once it has settled.
  if (sessionStorage.getItem(`${key}:pending`)) {
    const settle = () => setTimeout(check, 2500);
    if (document.readyState === "complete") settle();
    else addEventListener("load", settle, { once: true });
  }
  const actions = { open: () => {}, close: () => {} };

  w.FlowApp = {
    open: () => actions.open(),
    close: () => actions.close(),
    /** New settings from the site: a different account signs the app in again. */
    configure(next: Config) {
      config = { ...config, ...next };
      post({ type: "account", account: config.account ?? null, signIn: !!config.signIn });
    },
    /** The person signed out on the site: the app ends its sign-in too. */
    signOut() {
      config = { ...config, account: undefined };
      post({ type: "sign-out" });
    },
  };

  addEventListener("message", (event) => {
    const message = event.data as { flowApp?: number; type?: string; id?: string; request?: Request } | null;
    if (!frame || event.source !== frame.contentWindow || event.origin !== src.origin || message?.flowApp !== 1) return;
    if (message.type === "close") actions.close();
    if (message.type === "hello") {
      ready = true;
      post({ type: "account", account: config.account ?? null, signIn: !!config.signIn });
      deliver();
    }
    if (message.type === "navigate" && typeof (message as { path?: unknown }).path === "string") void go((message as { path: string }).path);
    if (message.type === "sign-in" && message.request) {
      const id = message.id;
      // A site with no signIn (or no one signed in on it) answers null: the app stays signed out.
      Promise.resolve(config.signIn ? config.signIn(message.request) : null).then(
        (code) => post({ type: "signed-in", id, code: code ?? null }),
        () => post({ type: "signed-in", id, code: null }),
      );
    }
  });

  fetch(`${root}/config?${new URLSearchParams({ origin: location.origin })}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))).then(
    (launcher: Launcher) => draw(launcher),
    (error) => console.error("FlowApp: this site may not embed the app, or the agent is unreachable.", error),
  );

  function draw(l: Launcher) {
    const side = l.position === "left" ? "left" : "right";
    const accentText = l.accentText ?? readable(l.accent);
    let width = Math.min(720, Math.max(340, Number(localStorage.getItem(`${key}:width`)) || l.width));
    const host = document.createElement("flow-app");
    const shadow = host.attachShadow({ mode: "open" });
    const font = l.font ?? 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
    const logo = l.logo ? `<img alt="" src="${l.logo.replace(/"/g, "&quot;")}">` : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.6.5-1.8.2-1.8-.7z"/></svg>`;
    shadow.innerHTML =
      `<style>:host{all:initial}` +
      `.launcher{all:initial;box-sizing:border-box;position:fixed;z-index:2147483000;bottom:20px;${side}:20px;display:flex;align-items:center;gap:9px;padding:8px 16px 8px 8px;border-radius:999px;background:${l.accent};color:${accentText};font:600 14px/1 ${font};box-shadow:0 8px 24px -6px #0005,0 0 0 1px #0001;cursor:pointer;transition:transform .2s,opacity .2s}` +
      `.launcher:hover{transform:translateY(-2px)}.launcher:focus-visible{outline:3px solid ${l.accent};outline-offset:3px}` +
      `.launcher img,.launcher svg{width:30px;height:30px;border-radius:50%;object-fit:cover;background:#fff2;fill:currentColor;padding:${l.logo ? 0 : 6}px;box-sizing:border-box}` +
      `.launcher.circle{padding:9px}.launcher.circle span{display:none}.launcher.circle img,.launcher.circle svg{width:38px;height:38px}` +
      `.launcher.tab{bottom:auto;top:50%;${side}:0;transform:translateY(-50%);border-radius:${side === "right" ? "10px 0 0 10px" : "0 10px 10px 0"};writing-mode:vertical-rl;padding:14px 9px;gap:8px}.launcher.tab img,.launcher.tab svg{width:22px;height:22px}` +
      `.launcher[hidden]{display:none}` +
      `.dock{position:fixed;z-index:2147483001;top:0;${side}:0;height:100vh;height:100dvh;width:${width}px;max-width:100vw;transform:translateX(${side === "right" ? "" : "-"}100%);transition:transform .28s cubic-bezier(.2,.8,.2,1);box-shadow:${side === "right" ? "-" : ""}1px 0 0 #0002,${side === "right" ? "-" : ""}12px 0 40px -18px #0004}` +
      `.dock.open{transform:none}.dock iframe{display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:normal}` +
      `.edge{position:absolute;top:0;${side === "right" ? "left" : "right"}:-4px;width:8px;height:100%;cursor:col-resize}.edge:hover,.edge.drag{background:${l.accent}55}` +
      `.dock.drag iframe{pointer-events:none}` +
      `@media(max-width:720px){.dock{width:100vw}.edge{display:none}}</style>` +
      `<button class="launcher ${l.shape}" type="button" aria-expanded="false" aria-controls="dock">${logo}<span></span></button>` +
      `<div class="dock" id="dock" role="complementary" aria-label="${l.title.replace(/"/g, "&quot;")}" hidden><div class="edge" role="separator" aria-orientation="vertical" aria-label="Resize"></div></div>`;
    const launcher = shadow.querySelector<HTMLButtonElement>(".launcher")!;
    launcher.querySelector("span")!.textContent = l.label;
    const dock = shadow.querySelector<HTMLDivElement>(".dock")!;
    const edge = shadow.querySelector<HTMLDivElement>(".edge")!;

    // The page makes room: a margin on <html> as wide as the panel, animated with it.
    const page = new CSSStyleSheet();
    page.replaceSync(`html.flow-app-open{margin-${side}:var(--flow-app-width)!important;transition:margin-${side} .28s cubic-bezier(.2,.8,.2,1)}html.flow-app-moving{transition:none!important}@media(max-width:720px){html.flow-app-open{margin-${side}:0!important}}`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, page];
    const room = () => document.documentElement.style.setProperty("--flow-app-width", `${opened ? width : 0}px`);

    actions.open = () => {
      if (!frame) {
        frame = document.createElement("iframe");
        frame.title = l.title;
        frame.allow = "clipboard-write";
        frame.src = `${root}?${new URLSearchParams({ origin: location.origin })}`;
        dock.append(frame);
      }
      opened = true;
      dock.hidden = false;
      void dock.offsetWidth; // Laid out closed first, so it slides in.
      dock.classList.add("open");
      document.documentElement.classList.add("flow-app-open");
      room();
      launcher.hidden = true;
      launcher.setAttribute("aria-expanded", "true");
      sessionStorage.setItem(`${key}:open`, "1");
      frame.focus();
    };
    actions.close = () => {
      opened = false;
      dock.classList.remove("open");
      document.documentElement.classList.remove("flow-app-open");
      room();
      launcher.hidden = false;
      launcher.setAttribute("aria-expanded", "false");
      sessionStorage.removeItem(`${key}:open`);
      launcher.focus({ focusVisible: false } as FocusOptions);
    };
    dock.addEventListener("transitionend", () => { if (!opened) dock.hidden = true; });
    launcher.onclick = () => actions.open();

    // Dragging the panel's edge sets its width; the page follows without animating.
    edge.onpointerdown = (down) => {
      edge.setPointerCapture(down.pointerId);
      dock.classList.add("drag");
      edge.classList.add("drag");
      document.documentElement.classList.add("flow-app-moving");
      edge.onpointermove = (move) => {
        width = Math.round(Math.min(720, Math.max(340, side === "right" ? innerWidth - move.clientX : move.clientX)));
        dock.style.width = `${width}px`;
        room();
      };
      edge.onpointerup = () => {
        edge.onpointermove = edge.onpointerup = null;
        dock.classList.remove("drag");
        edge.classList.remove("drag");
        document.documentElement.classList.remove("flow-app-moving");
        localStorage.setItem(`${key}:width`, String(width));
      };
    };

    const add = () => {
      document.body.append(host);
      // Open across a reload or a page change of a site that is not a single-page app.
      if (sessionStorage.getItem(`${key}:open`)) actions.open();
    };
    if (document.body) add();
    else addEventListener("DOMContentLoaded", add);
  }

  /** White or near-black text, whichever reads better on `color` (#rgb or #rrggbb). */
  function readable(color: string): string {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
    if (!hex) return "#fff";
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#111418" : "#fff";
  }
})();
