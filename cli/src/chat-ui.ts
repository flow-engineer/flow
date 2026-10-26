// The interactive session is isolated from command parsing and loaded only for human chat.
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, Editor, Markdown, ProcessTerminal, Text, TUI, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type Terminal, type MarkdownTheme } from "@mariozechner/pi-tui";

import type { ChatSession, ChatUpdate } from "./terminal.ts";

type Entry =
  | { kind: "user" | "reply" | "notice"; text: string; body: Component }
  | { kind: "tool"; id: string; name: string; input?: unknown; output?: unknown; state: "running" | "done" | "failed" | "detached"; ms?: number };
type ScrollAnchor = { entry: Entry | "help" | "empty"; row: number };

const commands = [
  { name: "help", description: "Show keyboard shortcuts" },
  { name: "details", description: "Expand tool inputs and results" },
  { name: "new", description: "Clear this view and forget the terminal reference" },
  { name: "exit", description: "Leave chat" },
];
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const describe = (value: unknown) => clean(typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "");

// Approximate brand colors with the portable 256-color palette; never require RGB support.
function nearest(rgb: number[]): number {
  const cube = [0, 95, 135, 175, 215, 255];
  let closest = 16, distance = Infinity;
  for (let index = 16; index < 256; index++) {
    const n = index - 16;
    const candidate = index >= 232 ? Array(3).fill(8 + (index - 232) * 10)
      : [cube[Math.floor(n / 36)]!, cube[Math.floor(n / 6) % 6]!, cube[n % 6]!];
    const delta = candidate.reduce((sum, value, channel) => sum + (value - rgb[channel]!) ** 2, 0);
    if (delta < distance) { closest = index; distance = delta; }
  }
  return closest;
}

function brandColor(hex?: string): { code: string; rgb?: number[] } {
  if (hex === undefined) return { code: "36" }; // The terminal profile's own cyan.
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("chat.accent must be a six-digit hex color.");
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  return { code: `38;5;${nearest(rgb)}`, rgb };
}

/** Session state and layout; the terminal is injected so layout/input tests never need a real TTY. */
export class ChatView implements Component, Focusable {
  readonly editor: Editor;
  private entries: Entry[] = [];
  private details = false;
  private help = false;
  private anchor?: ScrollAnchor;
  private savedAnchor?: ScrollAnchor;
  private scrollDelta = 0;
  private jump?: "top" | "bottom";
  private viewportRows = 1;
  private busy?: AbortController;
  private light?: boolean;
  private panelBackground?: string;
  private sendBounds?: { row: number; first: number; last: number };
  private pressedSend = false;
  private tick = 0;
  private title = "New conversation";
  private _focused = false;
  private readonly markdown: MarkdownTheme;
  private readonly color: (code: string, text: string) => string;
  private readonly dim: (text: string) => string;
  private readonly accent: (text: string) => string;
  private readonly accentRgb?: number[];

  private tui: TUI;
  private session: ChatSession;
  private exit: () => void;
  constructor(tui: TUI, session: ChatSession, exit: () => void) {
    this.tui = tui; this.session = session; this.exit = exit;
    this.color = (code, text) => session.color === false ? text : `\x1b[${code}m${text}\x1b[0m`;
    this.dim = text => this.color(this.light === undefined ? "22;39" : this.light ? "22;38;5;243" : "22;38;5;247", text);
    const accent = brandColor(session.accent);
    this.accentRgb = accent.rgb;
    this.accent = text => this.color(`22;${accent.code}`, text);
    this.markdown = {
      heading: text => this.color("1;39", text),
      link: this.accent, linkUrl: this.dim, code: this.accent,
      codeBlock: text => this.color("39", text), codeBlockBorder: this.dim,
      quote: this.dim, quoteBorder: this.dim, hr: this.dim, listBullet: this.accent,
      bold: text => this.color("1", text), italic: text => this.color("3", text),
      strikethrough: text => this.color("9", text), underline: text => this.color("4", text),
    };
    this.editor = new Editor(tui, { borderColor: this.dim, selectList: {
      selectedPrefix: this.accent, selectedText: this.accent, description: this.dim, scrollInfo: this.dim, noMatch: this.dim,
    } }, { paddingX: 1, autocompleteMaxVisible: 4 });
    // Complete only our commands. File completion would suggest attachments we do not send.
    this.editor.setAutocompleteProvider({
      async getSuggestions(lines, row, col) {
        const prefix = lines[row]!.slice(0, col);
        if (row || !/^\/[a-z]*$/.test(prefix)) return null;
        return { prefix, items: commands.filter(c => `/${c.name}`.startsWith(prefix)).map(c => ({ value: `/${c.name}`, label: `/${c.name}`, description: c.description })) };
      },
      applyCompletion(lines, row, col, item, prefix) {
        const updated = [...lines]; updated[row] = lines[row]!.slice(0, col - prefix.length) + item.value + lines[row]!.slice(col);
        return { lines: updated, cursorLine: row, cursorCol: col - prefix.length + item.value.length };
      },
    });
    this.editor.onSubmit = text => { void this.submit(text); };
    this.editor.onChange = () => this.tui.requestRender();
  }

  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.editor.focused = value; }
  invalidate() { this.editor.invalidate(); for (const e of this.entries) if ("body" in e) e.body.invalidate(); }
  /** A highlight that sweeps across a running tool's name, so progress shows without a status mark. */
  private shimmer(text: string): string {
    if (this.session.color === false) return text;
    const chars = [...text], at = this.tick % (chars.length + 6) - 3;
    return chars.map((char, i) => Math.abs(i - at) <= 1 ? this.accent(char) : this.color("22;39", char)).join("");
  }

  animate() { if (this.busy) { this.tick++; this.tui.requestRender(); } }
  stop() { this.busy?.abort(); }

  private append(kind: "user" | "reply" | "notice", text: string) {
    const safe = clean(text);
    const body = kind === "reply" ? new Markdown(safe, 0, 0, this.markdown) : new Text(safe, 0, 0);
    this.entries.push({ kind, text: safe, body });
  }

  private update(event: ChatUpdate) {
    if (event.type === "reply") this.append("reply", event.text);
    else {
      const item = event.event;
      if (item.tool === "send_terminal") return;
      if (item.type === "skill.loaded") this.append("notice", `Loaded skill ${item.skill ?? ""}`);
      if (item.type.startsWith("tool.") || item.type === "task.done") {
        const id = item.callId ?? `${this.entries.length}`;
        let entry = this.entries.find((e): e is Extract<Entry, { kind: "tool" }> => e.kind === "tool" && e.id === id);
        if (!entry) { entry = { kind: "tool", id, name: clean(item.tool ?? "Tool"), state: "running" }; this.entries.push(entry); }
        if (item.input !== undefined) entry.input = item.input;
        if (item.output !== undefined) entry.output = item.output;
        entry.ms = item.ms;
        entry.state = item.type === "tool.start" ? "running" : item.type === "tool.detached" ? "detached" : item.ok === false ? "failed" : "done";
      }
    }
    this.tui.requestRender();
  }

  private toggleHelp() {
    if (this.help) { this.help = false; this.anchor = this.savedAnchor; this.savedAnchor = undefined; }
    else { this.savedAnchor = this.anchor; this.help = true; this.anchor = { entry: "help", row: 0 }; }
    this.scrollDelta = 0; this.jump = undefined;
  }

  private followLatest() {
    this.anchor = undefined; this.savedAnchor = undefined;
    this.scrollDelta = 0; this.jump = undefined;
  }

  async submit(value: string) {
    const text = value.trim();
    if (!text) return;
    if (text === "/exit") { this.exit(); return; }
    if (text === "/help") { this.toggleHelp(); this.tui.requestRender(); return; }
    if (text === "/details") { this.details = !this.details; this.tui.requestRender(); return; }
    if (this.busy) { this.editor.setText(text); return; }
    if (text === "/new") {
      try { this.session.reset(); this.entries = []; this.title = "New conversation"; this.help = false; this.followLatest(); this.append("notice", "Forgot the terminal reference. Shared person history stays with the agent."); }
      catch { this.append("notice", "Could not forget the saved reference. Try again."); }
      this.tui.requestRender(); return;
    }
    if (text.startsWith("/") && !text.includes("\n")) { this.append("notice", "Unknown command. Type /help for shortcuts."); this.tui.requestRender(); return; }
    this.help = false; this.followLatest();
    if (this.title === "New conversation") this.title = clean(text.split("\n")[0]!).slice(0, 100);
    this.editor.addToHistory(text);
    this.append("user", text);
    const request = new AbortController(); this.busy = request;
    this.editor.disableSubmit = true;
    this.tui.requestRender();
    try { await this.session.send(text, event => { if (!request.signal.aborted) this.update(event); }, request.signal); }
    catch (error) {
      this.append("notice", request.signal.aborted ? "Stopped waiting. Work already accepted by the agent may still finish." : error instanceof Error ? error.message : "Could not finish the request.");
      if (!this.editor.getText()) this.editor.setText(text);
    } finally {
      for (const entry of this.entries) if (entry.kind === "tool" && entry.state === "running") entry.state = "detached";
      this.busy = undefined; this.editor.disableSubmit = false;
      this.tui.requestRender();
    }
  }

  handleInput(data: string) {
    const background = /^\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)$/i.exec(data);
    if (background) {
      const rgb = background.slice(1).map(part => Math.round(parseInt(part, 16) / (16 ** part.length - 1) * 255));
      this.light = rgb.reduce((sum, value) => sum + value, 0) / 3 >= 128;
      // Sent messages sit on a faint wash of the brand accent, or a neutral shade without one.
      const gray = rgb.reduce((sum, value) => sum + value, 0) / 3 + (this.light ? -12 : 14);
      // The 256-color cube has no dark tints, so a wash needs a terminal that reports 24-bit color.
      const wash = this.accentRgb && /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? "")
        ? rgb.map((value, channel) => Math.round(value + (this.accentRgb![channel]! - value) * (this.light ? 0.12 : 0.18))) : undefined;
      this.panelBackground = wash ? `2;${wash.join(";")}` : `5;${232 + Math.max(0, Math.min(23, Math.round((gray - 8) / 10)))}`;
      this.invalidate(); this.tui.requestRender(); return;
    }
    // ProcessTerminal buffers split escape sequences, including SGR and legacy mouse packets.
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/.exec(data);
    const legacyMouse = data.startsWith("\x1b[M") && data.length === 6;
    if (mouse || legacyMouse) {
      const button = mouse ? Number(mouse[1]) : data.charCodeAt(3) - 32;
      if ((!mouse || mouse[4] === "M") && (button & 64)) {
        const direction = button & 3;
        if (direction <= 1) this.scrollDelta += direction === 0 ? -3 : 3;
      }
      const x = mouse ? Number(mouse[2]) : data.charCodeAt(4) - 32;
      const y = mouse ? Number(mouse[3]) : data.charCodeAt(5) - 32;
      const within = this.sendBounds && y === this.sendBounds.row && x >= this.sendBounds.first && x <= this.sendBounds.last;
      if (!(button & 64)) {
        const released = mouse ? mouse[4] === "m" : (button & 3) === 3;
        if ((button & 3) === 0 && !released) this.pressedSend = Boolean(within);
        else if (released) {
          const send = this.pressedSend && within;
          this.pressedSend = false;
          if (send) this.editor.handleInput("\r");
        }
      }
      // Other clicks and horizontal wheel events never become text in the composer.
      this.tui.requestRender(); return;
    }
    if (matchesKey(data, "ctrl+c")) {
      if (this.busy) this.busy.abort();
      else if (this.editor.getText()) this.editor.setText("");
      else this.exit();
    } else if (matchesKey(data, "ctrl+d") && !this.editor.getText()) this.exit();
    else if (matchesKey(data, "ctrl+o")) this.details = !this.details;
    else if (matchesKey(data, "f1")) this.toggleHelp();
    else if (matchesKey(data, "escape") && this.busy) this.busy.abort();
    else if (matchesKey(data, "pageUp")) this.scrollDelta -= Math.max(1, this.viewportRows - 2);
    else if (matchesKey(data, "pageDown")) this.scrollDelta += Math.max(1, this.viewportRows - 2);
    else if (matchesKey(data, "ctrl+end")) { this.jump = "bottom"; this.scrollDelta = 0; }
    else if (matchesKey(data, "ctrl+home")) { this.jump = "top"; this.scrollDelta = 0; }
    else if (matchesKey(data, "alt+enter")) this.editor.insertTextAtCursor("\n");
    else this.editor.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.sendBounds = undefined;
    const rows = Math.max(1, this.tui.terminal.rows);
    if (width < 16 || rows < 9) return [truncateToWidth("Enlarge the terminal to chat.", width), ...Array(Math.max(0, rows - 1)).fill("")];
    const contentWidth = Math.max(8, Math.min(100, width - 6));
    const margin = Math.max(1, Math.floor((width - contentWidth) / 2));
    const inset = (line: string) => " ".repeat(margin) + line;
    const panelLine = (line: string) => truncateToWidth(line, contentWidth, "", true);
    const shaded = (line: string) => {
      const body = panelLine(line);
      if (this.session.color === false || this.panelBackground === undefined) return body;
      const background = `\x1b[48;${this.panelBackground}m`;
      return background + body.replace(/\x1b\[0m/g, `\x1b[0m${background}`) + "\x1b[49m";
    };
    const renderedEditor = this.editor.render(contentWidth - 4);
    const bottom = renderedEditor.findIndex((line, i) => i > 0 && /^─/.test(stripVTControlCharacters(line)));
    const body = renderedEditor.slice(1, bottom < 0 ? undefined : bottom);
    const suggestions = bottom < 0 ? [] : renderedEditor.slice(bottom + 1);
    const suggestionCount = Math.min(suggestions.length, Math.max(0, rows - 9));
    const editorBudget = Math.max(1, rows - 8 - suggestionCount);
    const cursor = Math.max(0, body.findIndex(line => line.includes(CURSOR_MARKER) || line.includes("\x1b[7m")));
    const from = Math.max(0, Math.min(cursor - Math.floor(editorBudget / 2), body.length - editorBudget));
    const inputLines = body.slice(from, from + editorBudget).map(line => {
      if (!this.editor.getText()) line = line.replace("\x1b[7m \x1b[0m", `\x1b[7m \x1b[0m${this.dim("Write a message…")}`);
      return inset(this.dim("│ ") + truncateToWidth(line, contentWidth - 4, "", true) + this.dim(" │"));
    });
    const button = " Send ↑ ";
    const buttonWidth = visibleWidth(button);
    const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][this.tick % 10];
    const actionWidth = contentWidth - 4 - buttonWidth;
    const activity = this.busy ? `${this.accent(spinner!)} ${this.dim("Working…  Esc stops waiting")}` : "";
    const sendButton = this.panelBackground === undefined ? this.accent(button)
      : this.color(`48;${this.panelBackground}`, this.accent(button));
    const action = this.dim("│ ") + truncateToWidth(activity, actionWidth, "", true) + sendButton + this.dim(" │");
    const composer = [inset(this.dim(`╭${"─".repeat(contentWidth - 2)}╮`)), ...inputLines,
      inset(action), inset(this.dim(`╰${"─".repeat(contentWidth - 2)}╯`)),
      ...suggestions.slice(0, suggestionCount).map(line => inset(`  ${line}`))];
    const footer = [...composer, inset(this.dim(`Ctrl+O details${this.details ? " on" : ""}`))];
    this.sendBounds = { row: rows - footer.length + 1 + inputLines.length + 1,
      first: margin + 2 + actionWidth + 1, last: margin + 2 + actionWidth + buttonWidth };
    let header = inset(this.accent(clean(this.session.name)) + this.color("22;39", `  /  ${this.title}`));
    const available = Math.max(1, rows - footer.length - 3);
    this.viewportRows = available;
    let timeline: string[] = [];
    const anchors: ScrollAnchor[] = [];
    if (this.help) {
      timeline = new Markdown("## Chat shortcuts\n\n- **Enter** sends; **Shift+Enter**, **Alt+Enter**, or **\\\\ then Enter** adds a line.\n- **Up/Down** recall previous messages when at the edge of the editor.\n- **Tab** completes slash commands.\n- **Ctrl+O** or `/details` expands tool inputs and results.\n- **Mouse wheel/trackpad** and **PageUp/PageDown** scroll the conversation. **Ctrl+Home** jumps to the start; **Ctrl+End** returns to the latest reply.\n- **Escape** stops waiting for the current request. Accepted work may still finish.\n- **Ctrl+C** clears a draft, stops waiting, or exits on an empty prompt.\n- `/new` clears this view and forgets the saved terminal reference. Shared person history stays.\n- `/exit` leaves chat. **F1** toggles this help.", 0, 0, this.markdown).render(contentWidth);
    } else if (!this.entries.length) {
      timeline = [this.color("1", "What can I help you with?"), this.dim("Ask a question, describe a task, or paste some context.")];
    } else {
      for (const [index, entry] of this.entries.entries()) {
        const first = timeline.length;
        if (entry.kind === "tool") {
          // Tools read as a quiet sentence on an accent rail; only a failure raises its voice.
          const ms = entry.ms === undefined ? "" : ` · ${(entry.ms / 1000).toFixed(1)}s`;
          if (this.entries[index - 1]?.kind !== "tool") timeline.push("");
          const name = entry.state === "running" ? this.shimmer(entry.name) : this.color("22;39", entry.name);
          const state = entry.state === "failed" ? this.color("31", "failed") : entry.state === "running" ? this.dim("running") : entry.state === "detached" ? this.dim("still running after you stopped waiting") : "";
          timeline.push(panelLine(`${this.accent("▏")} ${name}${state ? `  ${state}` : ""}${this.dim(ms)}`));
          if (this.details) {
            if (entry.input !== undefined) timeline.push(...new Text(`${this.color("1;39", "Input")}\n${describe(entry.input)}`, 4, 0).render(contentWidth).map(line => panelLine(line)));
            if (entry.output !== undefined) timeline.push(...new Text(`${this.color("1;39", "Result")}\n${describe(entry.output)}`, 4, 0).render(contentWidth).map(line => panelLine(line)));
          }
        } else if (entry.kind === "notice") timeline.push(...new Text(this.dim(entry.text), 0, 0).render(contentWidth), "");
        else {
          if (entry.kind === "user") {
            timeline.push("");
            timeline.push(...entry.body.render(contentWidth - 4).map(line => shaded(`  ${line}`)), "");
          } else {
            timeline.push("", this.color("1", this.accent(clean(this.session.name))), "");
            timeline.push(...entry.body.render(contentWidth - 2).map(line => `  ${line}`), "");
          }
        }
        for (let row = 0; row < timeline.length - first; row++) anchors.push({ entry, row });
      }
    }
    if (this.help || !this.entries.length) {
      for (let row = 0; row < timeline.length; row++) anchors.push({ entry: this.help ? "help" : "empty", row });
    }
    const maximum = Math.max(0, timeline.length - available);
    let top = maximum;
    if (this.anchor) {
      const first = anchors.findIndex(item => item.entry === this.anchor!.entry);
      const last = anchors.findLastIndex(item => item.entry === this.anchor!.entry);
      if (first >= 0) top = first + Math.min(this.anchor.row, last - first);
    }
    if (this.jump) top = this.jump === "top" ? 0 : maximum;
    top = Math.max(0, Math.min(maximum, top + this.scrollDelta));
    this.scrollDelta = 0; this.jump = undefined;
    // Following is a state: new output moves the view only while it is at the latest reply.
    this.anchor = top < maximum ? anchors[top] : undefined;
    const end = Math.min(timeline.length, top + available);
    const visible = timeline.slice(top, end).map(inset);
    if (this.anchor) header += this.dim("  ·  earlier messages");
    const padding = Array(Math.max(0, available - visible.length)).fill("");
    const empty = !this.help && !this.entries.length;
    const frame = [header, "", ...(empty ? [...padding, ...visible] : [...visible, ...padding]), "", ...footer];
    return frame.slice(0, rows).map(line => {
      const padded = truncateToWidth(line, width, "", true);
      if (this.session.color === false) return padded;
      const base = "\x1b[39;49m";
      return base + padded.replace(/\x1b\[0m/g, `\x1b[0m${base}`) + "\x1b[0m";
    });
  }
}

export async function runChatUI(session: ChatSession, terminal: Terminal = new ProcessTerminal()): Promise<number> {
  const tui = new TUI(terminal);
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const view = new ChatView(tui, session, finish);
  tui.addChild(view); tui.setFocus(view);
  const abort = () => finish();
  session.signal?.throwIfAborted();
  session.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setInterval> | undefined;
  terminal.write("\x1b[?1049h\x1b[H");
  try {
    tui.start();
    terminal.write("\x1b[?1000h\x1b[?1006h");
    if (session.color !== false) terminal.write("\x1b]11;?\x07");
    timer = setInterval(() => view.animate(), 100);
    await done;
    return 0;
  } finally {
    if (timer) clearInterval(timer);
    try { view.stop(); tui.stop(); }
    finally {
      terminal.write("\x1b[?1006l\x1b[?1000l\x1b[?1049l");
      session.signal?.removeEventListener("abort", abort);
    }
  }
}
