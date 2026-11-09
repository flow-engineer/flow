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
// window.FlowApp: open(), close(), configure(config), signOut() (the person signed out on the site), and
// onboard(element, { label?, variant? }): the agent's "Onboard with AI" button (app.onboard) drawn in
// element. Every `<div data-flow-onboard>` on the page gets one too (data-label, data-variant), and
// FlowAppConfig.onboard sets the site's label and variant for all of them.
(() => {
  type Request = { nonce: string; returnTo: string; clientId: string; resource: string };
  type Config = {
    account?: string;
    signIn?: (request: Request) => Promise<{ code: string; state: string } | null>;
    navigate?: (path: string) => void | Promise<void>;
    /** After a link from the chat opened: why the page failed (or true), else nothing. */
    pageFailed?: () => string | boolean | null | undefined;
    /** The onboard button's label and look on this site. */
    onboard?: OnboardLook;
  };
  type OnboardLook = { label?: string; variant?: "pill" };
  type Agent = "claude" | "chatgpt" | "cursor";
  type Onboard = { label: string; prompt: string; agents: Agent[]; askLabel: string; askHint: string };
  type LinkResult = { url: string; ok: boolean; status?: number; reason?: string };
  type Launcher = { title: string; label: string; position: "right" | "left"; shape: "pill" | "circle" | "tab"; logo?: string; accent: string; accentText?: string; radius: number; font?: string; width: number; onboard?: Onboard };
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
  let settings: Launcher | undefined;
  const waiting: Array<[Element, OnboardLook]> = [];

  w.FlowApp = {
    open: () => actions.open(),
    close: () => actions.close(),
    /** New settings from the site: a different account signs the app in again. */
    configure(next: Config) {
      config = { ...config, ...next };
      post({ type: "account", account: config.account ?? null, signIn: !!config.signIn });
    },
    /** Draws the agent's onboard button in element (once the agent's settings are in). */
    onboard(element: Element, look: OnboardLook = {}) {
      if (settings) onboard(element, look);
      else waiting.push([element, look]);
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
    (launcher: Launcher) => {
      settings = launcher;
      draw(launcher);
      for (const [element, look] of waiting.splice(0)) onboard(element, look);
      // Every <div data-flow-onboard> on the page, now and as a single-page app draws more.
      const scan = () => document.querySelectorAll("[data-flow-onboard]").forEach((element) => onboard(element, {}));
      if (document.readyState === "loading") addEventListener("DOMContentLoaded", scan);
      else scan();
      let queued = false;
      new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; scan(); }); } }).observe(document.documentElement, { childList: true, subtree: true });
    },
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

  // ---- The onboard button: a pill in the accent that copies the agent's setup prompt, with a menu to open
  // it in an assistant or ask the app. It is drawn in a closed shadow root, so the site's CSS styles only its
  // place; its "Powered by flow.engineer" line is always shown, like the panel's own row.
  const drawn = new WeakSet<Element>();
  const ICON: Record<Agent, string> = {
    cursor: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
    chatgpt: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  };
  const NAME: Record<Agent, string> = { claude: "Claude", chatgpt: "ChatGPT", cursor: "Cursor" };
  const OPEN: Record<Agent, string> = { claude: "https://claude.ai/new?q=", chatgpt: "https://chatgpt.com/?q=", cursor: "cursor://anysphere.cursor-deeplink/prompt?text=" };
  const svg = (d: string, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
  const COPY = `<svg class="copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
  const CHAT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  const text = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const LOCKED = "display:inline-block!important;position:relative!important;visibility:visible!important;opacity:1!important;filter:none!important;transform:none!important;clip-path:none!important;mask:none!important;zoom:1!important;content-visibility:visible!important";

  function onboard(element: Element, look: OnboardLook) {
    const o = settings?.onboard;
    if (!o || drawn.has(element)) return;
    drawn.add(element);
    const site = config.onboard ?? {};
    const data = (element as HTMLElement).dataset ?? {};
    const label = look.label ?? data.label ?? site.label ?? o.label;
    const variant = look.variant ?? (data.variant as OnboardLook["variant"]) ?? site.variant ?? "pill";
    const accent = settings!.accent, ink = settings!.accentText ?? readable(accent);
    const shadow = element.attachShadow({ mode: "closed" });
    const chips = (["cursor", "chatgpt", "claude"] as Agent[]).filter((a) => o.agents.includes(a));
    shadow.innerHTML =
      `<style>:host{${LOCKED}}*{box-sizing:border-box}` +
      `.pill{position:relative;display:inline-flex;align-items:stretch;border-radius:999px;background:${accent};color:${ink};box-shadow:0 0 0 3px #fff,0 0 0 4.5px #171717;font-weight:500;font-size:15px;line-height:1.2;font-family:inherit}` +
      `button,a{all:unset;cursor:pointer;box-sizing:border-box}` +
      `.main{display:flex;align-items:center;gap:10px;padding:6px 16px 6px 6px;border-radius:999px 0 0 999px}` +
      `.side{display:flex;align-items:center;gap:6px;padding:0 16px;border-left:1px solid color-mix(in srgb,${ink} 28%,transparent);border-radius:0 999px 999px 0;font-size:14px}` +
      `.main:hover,.side:hover{background:color-mix(in srgb,${accent} 88%,#000)}.main:focus-visible,.side:focus-visible{outline:2px solid ${ink};outline-offset:-4px}` +
      `.chips{display:flex}.chips i{width:36px;height:36px;border-radius:50%;background:color-mix(in srgb,${ink} 16%,transparent);border:1px solid color-mix(in srgb,${ink} 28%,transparent);display:grid;place-items:center;margin-left:-8px}.chips i:first-child{margin-left:0}` +
      `.chips svg{width:18px;height:18px}.copy{width:16px;height:16px;opacity:.85}` +
      `.menu{position:absolute;top:calc(100% + 12px);left:0;min-width:300px;background:#fff;color:#171717;border:1px solid #e5e5e5;border-radius:14px;box-shadow:0 18px 40px -18px rgba(0,0,0,.25);padding:6px;z-index:2147482000;text-align:left;font-size:14px}` +
      `.menu[hidden]{display:none}.menu .item{display:flex;gap:10px;align-items:center;padding:9px 10px;border-radius:9px;width:100%}.menu .item:hover,.menu .item:focus-visible{background:#f5f5f5}` +
      `.menu svg{width:18px;height:18px;flex:none}.menu small{color:#737373;display:block;font-size:12px}.sep{height:1px;background:#f0f0f0;margin:4px 6px}` +
      `.powered{display:flex!important;visibility:visible!important;opacity:1!important;justify-content:center;gap:4px;margin:4px 0 0!important;padding:8px 10px 4px!important;border-top:1px solid #f0f0f0;color:#737373!important;font-size:12px!important;text-decoration:none}.powered b{font-weight:600;color:#525252}.powered:hover b{text-decoration:underline}` +
      `.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;background:#171717;color:#fff;padding:10px 16px;border-radius:999px;font-size:14px;transition:.25s;z-index:2147483002}.toast.on{opacity:1;transform:translateX(-50%)}</style>` +
      `<div class="pill ${variant}"><button class="main" type="button"><span class="chips">${chips.map((a) => `<i>${svg(ICON[a])}</i>`).join("")}</span><span class="label">${text(label)}</span>${COPY}</button>` +
      `<button class="side" type="button" aria-haspopup="menu" aria-expanded="false">More ▾</button>` +
      `<div class="menu" role="menu" hidden><button class="item" data-do="copy" role="menuitem">${COPY.replace(' class="copy"', "")}<span>Copy setup prompt<small>Paste into any coding agent</small></span></button>` +
      o.agents.map((a) => `<button class="item" data-do="${a}" role="menuitem">${svg(ICON[a])}<span>Open in ${NAME[a]}</span></button>`).join("") +
      `<div class="sep"></div><button class="item" data-do="ask" role="menuitem">${CHAT}<span>${text(o.askLabel)}<small>${text(o.askHint)}</small></span></button>` +
      `<a class="powered" href="https://flow.engineer/?utm_source=onboard&utm_medium=powered-by" target="_blank" rel="noopener">Powered by <b>flow.engineer</b></a></div></div><div class="toast" role="status"></div>`;
    const $ = <T extends Element>(selector: string) => shadow.querySelector<T>(selector)!;
    const menu = $<HTMLDivElement>(".menu"), side = $<HTMLButtonElement>(".side"), labelEl = $<HTMLSpanElement>(".label"), toast = $<HTMLDivElement>(".toast");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (open: boolean) => { menu.hidden = !open; side.setAttribute("aria-expanded", String(open)); };
    const copy = async (flash: boolean) => {
      try { await navigator.clipboard.writeText(o.prompt); } catch { toast.textContent = "Could not copy: use the menu to open it in an assistant"; toast.classList.add("on"); setTimeout(() => toast.classList.remove("on"), 2200); return; }
      toast.textContent = `Copied ✓ Paste it into ${o.agents.map((a) => NAME[a]).join(", ").replace(/, ([^,]*)$/, " or $1") || "your coding agent"}`;
      toast.classList.add("on");
      clearTimeout(timer);
      if (flash) labelEl.textContent = "Copied ✓";
      timer = setTimeout(() => { toast.classList.remove("on"); labelEl.textContent = label; }, 1600);
    };
    $<HTMLButtonElement>(".main").onclick = () => void copy(true);
    side.onclick = (event) => { event.stopPropagation(); show(menu.hasAttribute("hidden")); };
    menu.onclick = (event) => {
      event.stopPropagation();
      const what = (event.target as Element).closest<HTMLElement>("[data-do]")?.dataset.do;
      if (!what) return;
      show(false);
      if (what === "copy") void copy(false);
      else if (what === "ask") actions.open();
      else window.open(OPEN[what as Agent] + encodeURIComponent(o.prompt), "_blank", "noopener");
    };
    document.addEventListener("click", () => show(false));
    shadow.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Escape") { show(false); side.focus(); } });
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
