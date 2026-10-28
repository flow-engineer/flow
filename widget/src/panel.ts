// The chat panel, loaded by widget.js on first open: it draws the thread from the client's updates,
// sends what the visitor types or taps, and keeps the stream open only while it is needed (the panel
// open or a reply due, the tab visible, and something happened in the last 2 minutes).
import { createClient, type Button, type ChatEvent, type Choice, type Link, type Live } from "./client.js";
import { markdown } from "./markdown.js";
import { CSS } from "./styles.js";
import { WORDS } from "./strings.js";

/** What widget.js hands over: its settings (read live: setContext and signIn change them) and the launcher. */
export type Config = {
  root: string;
  title: string;
  greeting?: string;
  avatar?: string;
  identityUrl?: string;
  lang: "en" | "hi";
  context?: unknown;
  signedOut: boolean;
};
type Mount = { shadow: ShadowRoot; host: HTMLElement; launcher: HTMLButtonElement; config: Config; emit(name: string, detail?: unknown): void };

const IDLE_MS = 120_000;
const ICONS = {
  close: "M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z",
  send: "M3 20.5 21 12 3 3.5V10l12 2-12 2z",
};
const https = (url?: string) => !!url && /^https:\/\//i.test(url);
const web = (url?: string) => !!url && /^https?:\/\//i.test(url);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function iconButton(cls: string, label: string, icon: keyof typeof ICONS, type: "button" | "submit" = "button") {
  const button = el("button", cls);
  button.type = type;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[icon]}"/></svg>`;
  return button;
}

export function mount({ shadow, launcher, config, emit }: Mount) {
  const w = WORDS[config.lang];
  const style = el("style");
  style.textContent = CSS;

  const panel = el("div", "panel");
  panel.hidden = true;
  panel.lang = config.lang;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "flow-chat-title");
  const header = el("header");
  if (https(config.avatar)) {
    const avatar = el("img");
    avatar.src = config.avatar!;
    avatar.alt = "";
    header.append(avatar);
  }
  const title = el("h2", "", config.title);
  title.id = "flow-chat-title";
  const closer = iconButton("x", w.close, "close");
  header.append(title, closer);

  const thread = el("div", "thread");
  thread.setAttribute("role", "log");
  thread.setAttribute("aria-live", "polite");
  thread.setAttribute("aria-labelledby", "flow-chat-title");
  thread.tabIndex = 0;
  const typing = el("div", "typing");
  typing.hidden = true;
  typing.setAttribute("aria-hidden", "true");
  const status = el("span");
  typing.append(el("span", "dots"), status);
  typing.firstElementChild!.innerHTML = "<i></i><i></i><i></i>";
  const announcer = el("div", "sr");
  announcer.setAttribute("aria-live", "polite");

  const form = el("form");
  const input = el("textarea");
  input.rows = 1;
  input.placeholder = w.placeholder;
  input.setAttribute("aria-label", w.message);
  input.maxLength = 2000;
  form.append(input, iconButton("go", w.send, "send", "submit"));

  const sheet = el("div", "sheet");
  sheet.hidden = true;
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "flow-chat-sheet");

  panel.append(header, thread, typing, announcer, form, sheet);
  shadow.append(style, panel);

  const rows = new Map<string, HTMLElement>();
  const unechoed = new Map<string, HTMLElement>(); // the visitor's messages drawn at once, until their echo comes
  let isOpen = false;
  let announced = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let listOpener: HTMLElement | null = null;

  const client = createClient({
    root: config.root,
    meta: () => ({ page: { url: location.href, title: document.title }, context: config.context }),
    identity: async () => {
      if (config.signedOut || !config.identityUrl) return null;
      // Same origin only, so the site's own sign-in cookie goes and nothing else does.
      const url = new URL(config.identityUrl, location.href);
      if (url.origin !== location.origin) return null;
      const answer = await fetch(url, { credentials: "same-origin", headers: { accept: "application/json" } });
      return answer.ok ? ((await answer.json()) as { token?: string }).token ?? null : null;
    },
  });

  // ---- Drawing

  /** Adds a row at the end, keeping the reader at the bottom if they were there. */
  function place(row: HTMLElement) {
    const atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    thread.append(row);
    if (atEnd) thread.scrollTop = thread.scrollHeight;
  }

  function tap(label: string, id?: string) {
    send(label, { id, title: label });
  }

  function chips(buttons: Button[] = [], link?: Link) {
    const box = el("div", "chips");
    for (const b of buttons.slice(0, 10)) {
      const chip = el("button", "chip", b.label);
      chip.type = "button";
      chip.onclick = () => tap(b.label, b.id);
      box.append(chip);
    }
    if (link && web(link.url)) {
      const a = el("a", "chip", link.label + " ↗");
      a.href = link.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = w.opens;
      box.append(a);
    }
    return box;
  }

  function photo(url: string, alt: string) {
    const img = el("img");
    img.src = url;
    img.alt = alt;
    img.loading = "lazy";
    return img;
  }

  function text(md: string) {
    const body = el("div", "md");
    body.innerHTML = markdown(md);
    return body;
  }

  function agentRow(event: Extract<ChatEvent, { id: string }>) {
    const row = el("div", "row them");
    const bubble = el("div", "bubble");
    const quoted = "replyTo" in event && event.replyTo ? rows.get(event.replyTo) : undefined;
    if (quoted) bubble.append(el("div", "quote", (quoted.classList.contains("me") ? w.you : config.title) + ": " + quoted.dataset.text));
    if (event.type === "message" && event.from === "agent") {
      if (https(event.image?.url)) bubble.append(photo(event.image!.url, w.photo));
      if (event.text) bubble.append(text(event.text));
      row.append(bubble);
      const box = chips(event.buttons, event.link);
      if (event.list) {
        const opener = el("button", "chip", event.list.button + " ▾");
        opener.type = "button";
        opener.setAttribute("aria-haspopup", "dialog");
        const list = event.list;
        opener.onclick = () => openList(list.button, list.rows, opener);
        box.append(opener);
      }
      if (box.childElementCount) row.append(box);
    } else if (event.type === "carousel") {
      if (event.text) bubble.append(text(event.text));
      if (bubble.childElementCount) row.append(bubble);
      row.classList.add("wide");
      const strip = el("div", "cards");
      strip.setAttribute("role", "group");
      for (const card of event.cards.slice(0, 10)) {
        const c = el("div", "card");
        if (https(card.image?.url)) c.append(photo(card.image.url, card.text ? "" : w.photo));
        if (card.text) c.append(text(card.text));
        const box = chips(card.buttons?.slice(0, 3), card.link);
        if (box.childElementCount) c.append(box);
        strip.append(c);
      }
      row.append(strip);
    }
    row.dataset.text = event.text;
    return row;
  }

  function personRow(id: string, body: string) {
    const row = el("div", "row me");
    row.append(el("div", "bubble", body));
    row.dataset.text = body;
    rows.set(id, row);
    return row;
  }

  function note(row: HTMLElement, words?: string, retry?: () => void) {
    row.querySelector(".note")?.remove();
    if (!words) return;
    const line = el("div", "note", words);
    if (retry) {
      const again = el("button", "", w.retry);
      again.type = "button";
      again.onclick = retry;
      line.append(again);
    }
    row.append(line);
  }

  function react(messageId: string, emoji: string) {
    const row = rows.get(messageId);
    if (!row) return;
    row.querySelector(".react")?.remove();
    if (!emoji) return;
    const pill = el("span", "react", emoji);
    pill.setAttribute("role", "img");
    pill.setAttribute("aria-label", `${w.reacted}: ${emoji}`);
    row.insertBefore(pill, row.querySelector(".note"));
  }

  /** Draws one event; returns whether it was new to this thread. */
  function draw(event: ChatEvent): boolean {
    if (event.type === "reaction") return react(event.messageId, event.emoji), false;
    if (event.type === "message" && event.from === "person") {
      const mine = unechoed.get(event.id);
      if (mine) {
        unechoed.delete(event.id);
        note(mine);
        rows.set(event.id, mine);
        if (!mine.isConnected) place(mine); // a history read again while it was on its way
        return false;
      }
      if (rows.has(event.id)) return false;
      place(personRow(event.id, event.text));
      return true;
    }
    if (rows.has(event.id)) return false;
    hideTyping();
    const row = agentRow(event);
    rows.set(event.id, row);
    place(row);
    return true;
  }

  function redraw(events: ChatEvent[]) {
    rows.clear();
    thread.replaceChildren();
    if (!events.some((e) => e.type !== "reaction") && config.greeting) thread.append(agentRow({ type: "message", from: "agent", id: "", text: config.greeting, seq: 0, at: 0 }));
    for (const event of events) draw(event);
    for (const [id, row] of unechoed) {
      rows.set(id, row);
      thread.append(row);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function showLive(live: Live) {
    typing.hidden = !live.typing && !live.status;
    status.textContent = live.status ?? "";
    // Said once per turn: a screen reader hears that a reply is coming, not each change.
    if (!typing.hidden && !announced) {
      announced = true;
      announcer.textContent = live.status || w.typing;
    }
  }

  function hideTyping() {
    typing.hidden = true;
    status.textContent = "";
  }

  // ---- Lists

  function openList(heading: string, items: { id: string; title: string; description?: string }[], opener: HTMLElement) {
    listOpener = opener;
    const head = el("div", "head");
    const h = el("h3", "", heading);
    h.id = "flow-chat-sheet";
    head.append(h, iconButton("x", w.back, "close"));
    (head.lastElementChild as HTMLElement).onclick = closeList;
    sheet.replaceChildren(head);
    for (const item of items.slice(0, 10)) {
      const option = el("button", "opt", item.title);
      option.type = "button";
      if (item.description) option.append(el("small", "", item.description));
      option.onclick = () => {
        closeList();
        tap(item.title, item.id);
      };
      sheet.append(option);
    }
    sheet.hidden = false;
    (sheet.querySelector(".opt") as HTMLElement | null)?.focus();
  }

  function closeList() {
    sheet.hidden = true;
    listOpener?.focus();
    listOpener = null;
  }

  // ---- Sending

  function send(body: string, choice?: Choice) {
    body = body.trim();
    if (!body) return;
    const id = client.send(body, choice);
    const row = personRow(id, body);
    unechoed.set(id, row);
    note(row, w.sending);
    announced = false;
    hideTyping();
    place(row);
    thread.scrollTop = thread.scrollHeight;
    touch();
    emit("flowchat:message", { type: "message", from: "person", id, text: body, ...(choice ? { choice } : {}) });
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    send(input.value);
    input.value = "";
    grow();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  const grow = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight + 2, 120) + "px";
  };
  input.oninput = () => (grow(), touch());

  client.on((update) => {
    if (update.kind === "history") redraw(update.events);
    else if (update.kind === "event") {
      if (draw(update.event)) emit("flowchat:message", update.event);
      touch();
    } else if (update.kind === "live") showLive(update.live);
    else if (update.kind === "session") input.maxLength = update.chars;
    else {
      const row = rows.get(update.id);
      if (!row) return;
      if (update.kind === "sent") return unechoed.has(update.id) && note(row);
      const words = w[update.error as "too_large" | "rate_limited"] ?? w.failed;
      const retry = update.error === "network" || update.error === "rate_limited" ? () => (note(row, w.sending), client.retry(update.id)) : undefined;
      note(row, words, retry);
    }
  });

  // ---- Staying connected only while needed

  function touch() {
    clearTimeout(idle);
    if (document.hidden) return;
    if (isOpen || client.awaiting()) client.connect();
    idle = setTimeout(() => (client.awaiting() ? touch() : client.disconnect()), IDLE_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return touch();
    clearTimeout(idle);
    client.disconnect();
  });
  panel.addEventListener("pointerdown", touch);
  thread.addEventListener("scroll", touch, { passive: true });

  // ---- Open, close, phones

  const phone = matchMedia("(max-width: 639.98px)");
  const viewport = window.visualViewport;
  /** On a phone the panel is a full-screen sheet over the page, sized to what the keyboard leaves visible. */
  function fit() {
    const sheetMode = isOpen && phone.matches;
    if (sheetMode) panel.setAttribute("aria-modal", "true");
    else panel.removeAttribute("aria-modal");
    panel.style.height = sheetMode && viewport ? viewport.height + "px" : "";
    panel.style.top = sheetMode && viewport ? viewport.offsetTop + "px" : "";
  }
  viewport?.addEventListener("resize", fit);
  viewport?.addEventListener("scroll", fit);
  phone.addEventListener("change", fit);

  function open() {
    if (isOpen) return;
    isOpen = true;
    panel.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    fit();
    touch();
    thread.scrollTop = thread.scrollHeight;
    (phone.matches ? closer : input).focus();
    emit("flowchat:open");
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    panel.hidden = true;
    sheet.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    fit();
    launcher.focus();
    if (!client.awaiting()) client.disconnect();
  }
  closer.onclick = close;

  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      return sheet.hidden ? close() : closeList();
    }
    // Focus stays inside the list while it is open, and inside the panel while it covers the page.
    if (e.key !== "Tab" || (sheet.hidden && !panel.hasAttribute("aria-modal"))) return;
    const scope = sheet.hidden ? panel : sheet;
    const items = [...scope.querySelectorAll<HTMLElement>("button,textarea,a[href],[tabindex='0']")].filter((x) => x.getClientRects().length);
    const first = items[0];
    const last = items[items.length - 1];
    const active = shadow.activeElement;
    if (e.shiftKey && (active === first || !scope.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !scope.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  });

  return { open, close, renew: () => client.renew() };
}
