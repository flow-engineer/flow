// widget.js: the chat box's launcher, the one script a page embeds. A classic script (no import or
// export) of at most 4 KB gzip: it reads its own tag's data attributes, draws the launcher in a Shadow
// DOM, exposes window.FlowChat, and loads the panel (widget/panel.js) with import() on first open.
(() => {
  const w = window as unknown as { FlowChat?: object };
  const script = (document.currentScript ?? document.querySelector('script[src*="/widget.js"]')) as HTMLScriptElement | null;
  if (w.FlowChat || !script) return;
  const src = new URL(script.src, location.href);
  const data = script.dataset;
  const lang = /^hi\b/i.test(data.lang || document.documentElement.lang || navigator.language || "") ? "hi" : "en";
  let context: unknown;
  try {
    context = data.context ? JSON.parse(data.context) : undefined;
  } catch {
    console.warn("FlowChat: data-context is not JSON");
  }
  const config = {
    root: src.origin + src.pathname.replace(/\/widget\.js$/, ""),
    title: data.title || (lang === "hi" ? "हमसे बात करें" : "Chat with us"),
    greeting: data.greeting,
    avatar: data.avatar,
    identityUrl: data.identityUrl,
    lang,
    context,
    signedOut: false,
  };

  const host = document.createElement("flow-chat");
  host.dataset.theme = data.theme === "light" || data.theme === "dark" ? data.theme : "auto";
  host.dataset.position = data.position === "left" ? "left" : "right";
  const shadow = host.attachShadow({ mode: "open" });
  // Theme tokens for the launcher and the panel; a site sets --flow-chat-accent, -accent-text, -font and -radius on flow-chat.
  const dark = "--bg:#16181d;--fg:#eceef1;--mu:#a3abb8;--bd:#3a404b;--bb:#252a33;--ring:#9db7ff;color-scheme:dark";
  shadow.innerHTML = `<button class="launcher" type="button" aria-haspopup="dialog" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg><span></span></button>`;
  // Constructable stylesheets, which a page's CSP style-src does not block; a <style> element only where they are missing.
  const style = (css: string) => {
    if ("replaceSync" in CSSStyleSheet.prototype) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    } else shadow.prepend(Object.assign(document.createElement("style"), { textContent: css }));
  };
  style(
    `:host{--a:var(--flow-chat-accent,#2457d6);--at:var(--flow-chat-accent-text,#fff);--f:var(--flow-chat-font,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);--r:var(--flow-chat-radius,16px);--bg:#fff;--fg:#1b1f24;--mu:#5b6370;--bd:#c9cfd8;--bb:#eef1f5;--ring:var(--a);color-scheme:light}` +
      `:host([data-theme=dark]){${dark}}@media(prefers-color-scheme:dark){:host([data-theme=auto]){${dark}}}` +
      `.launcher{all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:12px 18px;border:0;border-radius:999px;background:var(--a);color:var(--at);font:600 15px/1.2 var(--f);box-shadow:0 6px 20px #0003;cursor:pointer}` +
      `:host([data-position=left]) .launcher{right:auto;left:20px}.launcher:focus-visible{outline:3px solid var(--ring);outline-offset:3px}.launcher svg{width:20px;height:20px;fill:currentColor}`,
  );
  const launcher = shadow.querySelector("button")!;
  launcher.lastElementChild!.textContent = config.title;
  const add = () => document.body.append(host);
  if (document.body) add();
  else addEventListener("DOMContentLoaded", add);

  type Panel = { open(): void; close(): void; renew(): void };
  let panel: Promise<Panel> | undefined;
  const emit = (name: string, detail?: unknown) => host.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  const load = () =>
    (panel ??= import(config.root + "/widget/panel.js").then(
      (m) => m.mount({ shadow, host, launcher, config, emit, style }),
      (error) => {
        panel = undefined; // A failed load is tried again on the next open.
        throw error;
      },
    ));
  const open = () => void load().then((p) => p.open(), (error) => console.error("FlowChat:", error));
  const close = () => void panel?.then((p) => p.close());
  launcher.onclick = () => (launcher.getAttribute("aria-expanded") === "true" ? close() : open());
  w.FlowChat = {
    open,
    close,
    /** The business's context sent with each message from now on, e.g. { listing: "ps5-disc" }. */
    setContext(value: unknown) {
      config.context = value;
    },
    /** The visitor signed in on the site: a new session, signed in through data-identity-url. */
    signIn() {
      config.signedOut = false;
      void panel?.then((p) => p.renew());
    },
    /** The visitor signed out on the site: back to an anonymous visitor. */
    signOut() {
      config.signedOut = true;
      void panel?.then((p) => p.renew());
    },
  };
})();
