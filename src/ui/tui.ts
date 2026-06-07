// Main TUI class — built on OpenTUI (anomalyco/opentui), the native
// Zig TUI library. We keep the same public API as the v0.2.0
// hand-rolled version so the runtime doesn't change.
//
// Architecture:
//   - CliRenderer owns the alt screen, the input loop, and the render
//     loop. Everything draws to a single Yoga layout tree under
//     `renderer.root`.
//   - Header: a Box with flex-row and two Text children.
//   - Messages: a ScrollBox with a vertical flex column of Text
//     children. New messages get appended; the ScrollBox auto-scrolls.
//   - Input: a Textarea (multi-line editor) inside a Box with a border.
//   - Footer: a Box with a single Text child (the keybind hints).
//
// Streaming tokens append to the last "assistant" Text renderable.

import { CliRenderer, BoxRenderable, TextRenderable, ScrollBoxRenderable, TextareaRenderable, RGBA, type KeyEvent } from "@opentui/core";
import { BUILTIN_REGISTRY } from "../slash/builtin.js";
import { tryParseSlash } from "../slash/registry.js";
import { runAgent, DEFAULT_LIMITS } from "../agent/loop.js";
import { sessionToMessages } from "../agent/session.js";
import type { HarnessRuntime } from "../runtime.js";
import { c as color } from "./colors.js";

const VERSION = "0.2.1";

/** Is the current environment TUI-capable? */
export function isTuiCapable(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

// --- Status / message types (unchanged from v0.2.0) ---

export interface TuiStatus {
  model: string;
  provider: string;
  session: string;
  cwd: string;
  tokensIn: number;
  tokensOut: number;
  steps: number;
  thinking: string;
}

export interface TuiMessage {
  kind: "user" | "assistant" | "tool" | "system" | "info" | "error";
  text: string;
  meta?: string;
  toolStatus?: "ok" | "err" | "run";
  toolName?: string;
}

export interface TuiAction { action: string; data?: string; }

export interface TuiOptions {
  slashNames: string[];
  status?: Partial<TuiStatus>;
  history?: string[];
}

export interface Tui {
  start(): Promise<void>;
  stop(): void;
  appendText(text: string): void;
  endStream(): void;
  addMessage(msg: TuiMessage): void;
  appendMessage(text: string): void;
  addToolCall(name: string, args: string, status: "run" | "ok" | "err", detail?: string): void;
  setStatus(s: Partial<TuiStatus>): void;
  setSlashNames(names: string[]): void;
  onSubmit(cb: (text: string) => void): void;
  onAction(cb: (a: TuiAction) => void): void;
  setInfo(text: string): void;
  getInput(): string;
  setInput(text: string): void;
  redraw(): void;
}

// --- Color palette (RGBA) ---

const COLORS = {
  bg:        RGBA.fromHex("#0e1116"),
  bgHeader:  RGBA.fromHex("#1a1f29"),
  bgFooter:  RGBA.fromHex("#1a1f29"),
  bgInput:   RGBA.fromHex("#11151c"),
  bgUser:    RGBA.fromHex("#0f1923"),
  bgTool:    RGBA.fromHex("#161b24"),
  border:    RGBA.fromHex("#3a4150"),
  borderFocused: RGBA.fromHex("#6c8cff"),
  fg:        RGBA.fromHex("#e6e6e6"),
  fgDim:     RGBA.fromHex("#7a8190"),
  fgAccent:  RGBA.fromHex("#6c8cff"),
  fgCyan:    RGBA.fromHex("#5ed1ff"),
  fgGreen:   RGBA.fromHex("#7ed4a3"),
  fgRed:     RGBA.fromHex("#ff6b6b"),
  fgYellow:  RGBA.fromHex("#ffd166"),
  fgMagenta: RGBA.fromHex("#c792ea"),
} as const;

// --- The TUI ---

export function createTui(opts: TuiOptions): Tui {
  const renderer = new CliRenderer(process.stdin, process.stdout, process.stdout.columns || 100, process.stdout.rows || 32, {
    exitOnCtrlC: false,
    useMouse: true,
    enableMouseMovement: true,
    autoFocus: true,
    useKittyKeyboard: null, // disable — we handle our own key events
    backgroundColor: COLORS.bg,
  });
  renderer.setupTerminal();

  // Root layout: vertical flex column.
  //   ┌─ header (height 2) ────────────────────────────────┐
  //   │                                                       │
  //   │   messages (flex 1, ScrollBox)                       │
  //   │                                                       │
  //   ├─ input (height auto, ~3) ────────────────────────────┤
  //   ├─ footer (height 1) ──────────────────────────────────┘
  const root = renderer.root;
  root.flexDirection = "column";
  // root.backgroundColor = COLORS.bg; // RootRenderable doesn't accept this; the renderer config sets it

  // --- header ---
  const header = new BoxRenderable(renderer, {
    id: "header",
    backgroundColor: COLORS.bgHeader,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: 1,
    paddingRight: 1,
    height: 2,
  });
  root.add(header);

  const headerLeft = new TextRenderable(renderer, {
    id: "header-left",
    content: "",
    fg: COLORS.fgCyan,
    attributes: 1, // bold
  });
  header.add(headerLeft);

  const headerRight = new TextRenderable(renderer, {
    id: "header-right",
    content: "",
    fg: COLORS.fgDim,
  });
  header.add(headerRight);

  const headerLine = new TextRenderable(renderer, {
    id: "header-line",
    content: "─".repeat((process.stdout.columns || 100)),
    fg: COLORS.border,
  });
  header.add(headerLine);

  // --- messages (ScrollBox) ---
  const scroll = new ScrollBoxRenderable(renderer, {
    id: "messages",
    rootOptions: { backgroundColor: COLORS.bg, flexGrow: 1, flexShrink: 1 },
    wrapperOptions: { backgroundColor: COLORS.bg, flexGrow: 1 },
    viewportOptions: { backgroundColor: COLORS.bg, flexGrow: 1 },
    contentOptions: { backgroundColor: COLORS.bg, flexDirection: "column", gap: 0 },
    stickyScroll: true,
    stickyStart: "bottom",
    scrollY: true,
    scrollX: false,
    verticalScrollbarOptions: { visible: false },
  });
  root.add(scroll);

  // --- input area (Textarea inside a Box with border) ---
  const inputBox = new BoxRenderable(renderer, {
    id: "input-box",
    borderStyle: "single",
    border: ["top"],
    borderColor: COLORS.border,
    backgroundColor: COLORS.bgInput,
    flexDirection: "row",
    alignItems: "stretch",
    height: 5,
    paddingTop: 0,
    paddingBottom: 0,
  });
  root.add(inputBox);
  // Note: input box is added after scroll, before footer. The infoBox
  // is inserted via add(index) once it's constructed below.

  const textarea = new TextareaRenderable(renderer, {
    id: "prompt",
    backgroundColor: COLORS.bgInput,
    textColor: COLORS.fg,
    focusedBackgroundColor: COLORS.bgInput,
    focusedTextColor: COLORS.fg,
    placeholder: "Type a prompt or /command...",
    placeholderColor: COLORS.fgDim,
    flexGrow: 1,
    height: 3,
  });
  inputBox.add(textarea);
  textarea.focus();

  // --- footer ---
  const footer = new BoxRenderable(renderer, {
    id: "footer",
    backgroundColor: COLORS.bgFooter,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: 1,
    paddingRight: 1,
    height: 1,
  });
  root.add(footer);

  const footerLeft = new TextRenderable(renderer, {
    id: "footer-left",
    content: " ⏎ send · ⇧⏎ newline · Tab complete · ↑/↓ history · Ctrl+C abort · Ctrl+D quit ",
    fg: COLORS.fgDim,
  });
  footer.add(footerLeft);

  const footerRight = new TextRenderable(renderer, {
    id: "footer-right",
    content: "",
    fg: COLORS.fgDim,
  });
  footer.add(footerRight);

  // --- transient info banner above the input (for "thinking...") ---
  const infoBox = new BoxRenderable(renderer, {
    id: "info-box",
    backgroundColor: COLORS.bg,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 1,
    height: 1,
  });
  // Insert between messages (index 1) and input (index 2).
  root.add(infoBox, 2);
  const infoText = new TextRenderable(renderer, { id: "info", content: "", fg: COLORS.fgYellow });
  infoBox.add(infoText);

  // --- state ---

  const status: TuiStatus = {
    model: "—", provider: "—", session: "—", cwd: "—",
    tokensIn: 0, tokensOut: 0, steps: 0, thinking: "medium",
    ...opts.status,
  };
  let slashNames = opts.slashNames.slice();
  let currentStreamText = "";
  let currentStreamTextEl: TextRenderable | null = null;
  const messageEls: TextRenderable[] = [];  // most-recent last
  let infoTimer: NodeJS.Timeout | null = null;
  let quitRequested = false;
  let submitted = false;

  const submitListeners = new Set<(text: string) => void>();
  const actionListeners = new Set<(a: TuiAction) => void>();

  // --- rendering helpers ---

  function updateStatus(): void {
    const left = ` CodingHarness v${VERSION}  ${status.provider}/${status.model}  ${status.cwd}`;
    headerLeft.content = left;
    const right = `tokens ${status.tokensIn} in / ${status.tokensOut} out  `;
    headerRight.content = right;
    footerRight.content = `steps ${status.steps}  `;
  }

  function updateHeaderLine(): void {
    headerLine.content = "─".repeat(Math.max(20, renderer.width));
  }

  function addMessageEl(text: string, fg: RGBA, opts: { bg?: RGBA; prefix?: string } = {}): TextRenderable {
    const t = new TextRenderable(renderer, {
      id: "msg-" + messageEls.length,
      content: (opts.prefix ?? "") + text,
      fg,
    });
    scroll.content.add(t);
    messageEls.push(t);
    scroll.requestRender();
    return t;
  }

  function addMessageToUI(msg: TuiMessage): void {
    let fg = COLORS.fg;
    let bg: RGBA | undefined;
    let prefix = "";
    if (msg.kind === "user") { fg = COLORS.fgGreen; prefix = " › "; }
    else if (msg.kind === "assistant") { fg = COLORS.fg; }
    else if (msg.kind === "tool") {
      fg = msg.toolStatus === "ok" ? COLORS.fgGreen : msg.toolStatus === "err" ? COLORS.fgRed : COLORS.fgYellow;
      const mark = msg.toolStatus === "ok" ? " ✓ " : msg.toolStatus === "err" ? " ✗ " : " ⋯ ";
      prefix = mark + (msg.toolName ?? "tool") + "  ";
    }
    else if (msg.kind === "system") { fg = COLORS.fgDim; prefix = " · "; }
    else if (msg.kind === "info") { fg = COLORS.fgCyan; prefix = " · "; }
    else if (msg.kind === "error") { fg = COLORS.fgRed; prefix = " ! "; }
    addMessageEl(msg.text, fg, { bg, prefix });
  }

  // --- text input handling ---

  // Hook OpenTUI's input events. We use the textarea's onSubmit, but
  // we ALSO need to intercept Ctrl+C, Ctrl+D, Ctrl+L, etc. at the
  // renderer level.
  renderer.addInputHandler((sequence) => {
    if (sequence === "\x03") {  // Ctrl+C
      // If the textarea has content, clear it; otherwise act as cancel.
      if (textarea.plainText.length > 0) {
        textarea.clear();
      } else {
        for (const cb of actionListeners) cb({ action: "cancel" });
      }
      return true;
    }
    if (sequence === "\x04") {  // Ctrl+D
      for (const cb of actionListeners) cb({ action: "eof" });
      quitRequested = true;
      return true;
    }
    if (sequence === "\x0c") {  // Ctrl+L — clear messages
      for (const cb of actionListeners) cb({ action: "clear-messages" });
      return true;
    }
    return false;
  });

  // Slash command autocomplete: when user types /something and hits Tab,
  // we cycle through completions. OpenTUI's textarea already handles
  // tab as a focus advance, so we override with a custom keybinding.
  // Add our tab handler at the renderer level.
  renderer.addInputHandler((sequence) => {
    if (sequence === "\t") {
      const text = textarea.plainText;
      if (text.startsWith("/") && !text.includes(" ")) {
        const base = text.slice(1);
        const matches = slashNames.filter((n) => n.startsWith(base));
        if (matches.length > 0) {
          const m = matches[0]!;
          textarea.editBuffer.setText("/" + m + " ");
          return true;
        }
      }
      return false;
    }
    return false;
  });

  // Listen for submit.
  textarea.onSubmit = () => {
    const text = textarea.plainText;
    if (text.trim().length === 0) return;
    // Echo the user message.
    addMessageEl(text, COLORS.fgGreen, { prefix: " › " });
    textarea.clear();
    submitted = true;
    for (const cb of submitListeners) {
      try { cb(text); } catch (e) { console.error("submit error:", e); }
    }
  };

  // --- public API ---

  return {
    async start() {
      updateStatus();
      updateHeaderLine();
      addMessageEl("Welcome to CodingHarness v" + VERSION + ". Type /help for commands.", COLORS.fgCyan, { prefix: " · " });
      renderer.start();
      // Wait until quit is requested.
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (quitRequested) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
      renderer.stop();
      renderer.destroy();
    },

    stop() {
      quitRequested = true;
      try { renderer.stop(); } catch {}
      try { renderer.destroy(); } catch {}
    },

    appendText(text) {
      currentStreamText += text;
      if (!currentStreamTextEl) {
        // Create a new streaming text element.
        currentStreamTextEl = new TextRenderable(renderer, {
          id: "stream",
          content: currentStreamText,
          fg: COLORS.fg,
        });
        scroll.content.add(currentStreamTextEl);
        messageEls.push(currentStreamTextEl);
      } else {
        currentStreamTextEl.content = currentStreamText;
      }
    },

    endStream() {
      if (currentStreamTextEl && currentStreamText) {
        // The text element stays in the message list as a normal message.
        currentStreamTextEl = null;
        currentStreamText = "";
      } else if (currentStreamTextEl) {
        scroll.content.remove(currentStreamTextEl.id);
        currentStreamTextEl = null;
        currentStreamText = "";
      }
    },

    addMessage(msg) {
      addMessageToUI(msg);
    },

    appendMessage(text) {
      // Append to the last message element if any.
      const last = messageEls[messageEls.length - 1];
      if (last) {
        last.content = (last.content ?? "") + text;
      } else {
        addMessageEl(text, COLORS.fg);
      }
    },

    addToolCall(name, args, st, detail) {
      const icon = st === "ok" ? " ✓ " : st === "err" ? " ✗ " : " ⋯ ";
      const fg = st === "ok" ? COLORS.fgGreen : st === "err" ? COLORS.fgRed : COLORS.fgYellow;
      const text = name + (args ? " " + truncateArgs(args) : "") + (detail ? "  " + detail : "");
      addMessageEl(text, fg, { prefix: icon + name + "  " });
    },

    setStatus(s) {
      Object.assign(status, s);
      updateStatus();
    },

    setSlashNames(names) {
      slashNames = names.slice();
    },

    onSubmit(cb) { submitListeners.add(cb); },
    onAction(cb) { actionListeners.add(cb); },

    setInfo(text) {
      infoText.content = text ? " " + text : "";
      if (infoTimer) clearTimeout(infoTimer);
      if (text) {
        infoTimer = setTimeout(() => { infoText.content = ""; }, 5_000);
      }
    },

    getInput() { return textarea.plainText; },
    setInput(text) { textarea.editBuffer.setText(text); },
    redraw() { renderer.requestRender(); },
  };
}

function truncateArgs(args: string): string {
  const trimmed = args.replace(/\s+/g, " ").trim();
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "…" : trimmed;
}
