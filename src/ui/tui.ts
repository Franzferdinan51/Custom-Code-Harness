// Main TUI class — built on OpenTUI (anomalyco/opentui), the native
// Zig TUI library. We keep the same public API as the v0.2.0
// hand-rolled version so the runtime doesn't change.
//
// Layout (top-to-bottom, root is a column):
//
//   ┌─ header (2 rows) ────────────────────────────────────┐
//   ├─ body (flex 1) ──────────────────────────────────────┤
//   │  ┌─ sidebar (24 cols) ─┐  ┌─ main (flex 1) ──────┐  │
//   │  │ sessions            │  │  scroll (messages)   │  │
//   │  │ active sub-agents   │  │                      │  │
//   │  │ cost                │  │                      │  │
//   │  └─────────────────────┘  └──────────────────────┘  │
//   ├─ input (5 rows) ─────────────────────────────────────┤
//   ├─ footer (1 row) ─────────────────────────────────────┘

import { CliRenderer, BoxRenderable, TextRenderable, ScrollBoxRenderable, TextareaRenderable, RGBA } from "@opentui/core";
import { BUILTIN_REGISTRY } from "../slash/builtin.js";
import { tryParseSlash } from "../slash/registry.js";
import { runAgent, DEFAULT_LIMITS } from "../agent/loop.js";
import { sessionToMessages } from "../agent/session.js";
import type { HarnessRuntime } from "../runtime.js";
import { c as color } from "./colors.js";
import { formatUSD } from "../agent/cost.js";
import { Session } from "../agent/session.js";

const VERSION = "0.2.2";

/** Is the current environment TUI-capable? */
export function isTuiCapable(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

// --- Status / message types ---

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
  /** Runtime reference — used for sidebar data (sessions, cost, sub-agents). */
  runtime?: HarnessRuntime;
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
  bgSidebar: RGBA.fromHex("#11151c"),
  bgInput:   RGBA.fromHex("#11151c"),
  border:    RGBA.fromHex("#3a4150"),
  borderFocused: RGBA.fromHex("#6c8cff"),
  fg:        RGBA.fromHex("#e6e6e6"),
  fgDim:     RGBA.fromHex("#7a8190"),
  fgFaint:   RGBA.fromHex("#4a5160"),
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
    useKittyKeyboard: null,
    backgroundColor: COLORS.bg,
  });
  renderer.setupTerminal();

  const runtime = opts.runtime;

  const root = renderer.root;
  root.flexDirection = "column";

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

  const headerLeft = new TextRenderable(renderer, { id: "header-left", content: "", fg: COLORS.fgCyan, attributes: 1 });
  header.add(headerLeft);
  const headerRight = new TextRenderable(renderer, { id: "header-right", content: "", fg: COLORS.fgDim });
  header.add(headerRight);

  // --- body: sidebar + main ---
  const body = new BoxRenderable(renderer, {
    id: "body",
    flexDirection: "row",
    flexGrow: 1,
    flexShrink: 1,
  });
  root.add(body);

  // --- sidebar (left, 28 cols) ---
  const sidebar = new BoxRenderable(renderer, {
    id: "sidebar",
    backgroundColor: COLORS.bgSidebar,
    flexDirection: "column",
    width: 28,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
    borderStyle: "single",
    border: ["right"],
    borderColor: COLORS.border,
  });
  body.add(sidebar);

  // Sidebar header
  const sidebarTitle = new TextRenderable(renderer, { id: "sb-title", content: " CodingHarness", fg: COLORS.fgAccent, attributes: 1 });
  sidebar.add(sidebarTitle);

  const sbSessionsLabel = new TextRenderable(renderer, { id: "sb-sess-label", content: " sessions", fg: COLORS.fgDim });
  sidebar.add(sbSessionsLabel);

  const sbSessionsList = new TextRenderable(renderer, { id: "sb-sess-list", content: "  (loading...)", fg: COLORS.fgDim });
  sidebar.add(sbSessionsList);

  const sbSpacer1 = new TextRenderable(renderer, { id: "sb-spacer-1", content: "" });
  sidebar.add(sbSpacer1);

  const sbAgentsLabel = new TextRenderable(renderer, { id: "sb-agents-label", content: " active sub-agents", fg: COLORS.fgDim });
  sidebar.add(sbAgentsLabel);
  const sbAgentsList = new TextRenderable(renderer, { id: "sb-agents-list", content: "  (none)", fg: COLORS.fgDim });
  sidebar.add(sbAgentsList);

  const sbSpacer2 = new TextRenderable(renderer, { id: "sb-spacer-2", content: "" });
  sidebar.add(sbSpacer2);

  const sbCostLabel = new TextRenderable(renderer, { id: "sb-cost-label", content: " cost (session)", fg: COLORS.fgDim });
  sidebar.add(sbCostLabel);
  const sbCostTotal = new TextRenderable(renderer, { id: "sb-cost-total", content: "  $0.00", fg: COLORS.fgCyan, attributes: 1 });
  sidebar.add(sbCostTotal);
  const sbCostTokens = new TextRenderable(renderer, { id: "sb-cost-tokens", content: "  0 in / 0 out", fg: COLORS.fgFaint });
  sidebar.add(sbCostTokens);
  const sbCostPerModel = new TextRenderable(renderer, { id: "sb-cost-model", content: "", fg: COLORS.fgFaint });
  sidebar.add(sbCostPerModel);

  // --- main (right) ---
  const main = new BoxRenderable(renderer, {
    id: "main",
    flexDirection: "column",
    flexGrow: 1,
  });
  body.add(main);

  // --- info banner (transient) ---
  const infoBox = new BoxRenderable(renderer, {
    id: "info-box",
    backgroundColor: COLORS.bg,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 1,
    height: 1,
  });
  main.add(infoBox);
  const infoText = new TextRenderable(renderer, { id: "info", content: "", fg: COLORS.fgYellow });
  infoBox.add(infoText);

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
  main.add(scroll);

  // --- input area ---
  const inputBox = new BoxRenderable(renderer, {
    id: "input-box",
    borderStyle: "single",
    border: ["top"],
    borderColor: COLORS.border,
    backgroundColor: COLORS.bgInput,
    flexDirection: "row",
    alignItems: "stretch",
    height: 5,
  });
  main.add(inputBox);
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
  const footerRight = new TextRenderable(renderer, { id: "footer-right", content: "", fg: COLORS.fgDim });
  footer.add(footerRight);

  // --- state ---

  const status: TuiStatus = {
    model: "—", provider: "—", session: "—", cwd: "—",
    tokensIn: 0, tokensOut: 0, steps: 0, thinking: "medium",
    ...opts.status,
  };
  let slashNames = opts.slashNames.slice();
  let currentStreamText = "";
  let currentStreamTextEl: TextRenderable | null = null;
  const messageEls: TextRenderable[] = [];
  let infoTimer: NodeJS.Timeout | null = null;
  let quitRequested = false;
  let sidebarDirty = true;

  const submitListeners = new Set<(text: string) => void>();
  const actionListeners = new Set<(a: TuiAction) => void>();

  // --- sidebar refresh ---

  function refreshSidebar(): void {
    if (!sidebarDirty) return;
    sidebarDirty = false;
    void doRefresh();
  }
  function markSidebarDirty(): void { sidebarDirty = true; }

  async function doRefresh(): Promise<void> {
    // Sessions list: most recent 5.
    try {
      const list = await Session.list(5);
      const lines = list.map((m, i) => {
        const marker = m.id === status.session ? "●" : " ";
        const short = m.id.slice(0, 8);
        const when = formatAgo(m.updatedAt);
        return " " + marker + " " + short + "  " + when;
      });
      sbSessionsList.content = lines.length === 0 ? "  (none)" : lines.join("\n");
    } catch { sbSessionsList.content = "  (error)"; }

    // Active sub-agents.
    if (runtime && runtime.activeSubagents.size > 0) {
      const lines: string[] = [];
      for (const [id, a] of runtime.activeSubagents) {
        const mark = a.status === "ok" ? "✓" : a.status === "err" ? "✗" : "⋯";
        const shortPrompt = a.prompt.length > 16 ? a.prompt.slice(0, 14) + "…" : a.prompt;
        lines.push(" " + mark + " " + id.split(":")[0] + "  " + shortPrompt);
      }
      sbAgentsList.content = lines.join("\n");
    } else if (runtime && runtime.subagentHistory.length > 0) {
      // Show the last 3.
      const recent = runtime.subagentHistory.slice(-3).reverse();
      sbAgentsList.content = recent.map((s) => {
        const mark = s.status === "ok" ? "✓" : s.status === "err" ? "✗" : "·";
        return " " + mark + " " + s.name + "  " + formatUSD(s.cost);
      }).join("\n");
    } else {
      sbAgentsList.content = "  (none)";
    }

    // Cost.
    if (runtime && runtime.cost) {
      const t = runtime.cost.total();
      sbCostTotal.content = "  " + formatUSD(t.cost);
      sbCostTokens.content = "  " + t.inputTokens + " in / " + t.outputTokens + " out";
      const perModel = runtime.cost.perModel();
      if (perModel.length > 0) {
        const top = perModel[0]!;
        sbCostPerModel.content = "  " + (top.model.length > 22 ? top.model.slice(0, 20) + "…" : top.model) + "  " + formatUSD(top.cost);
      } else {
        sbCostPerModel.content = "";
      }
    } else {
      sbCostTotal.content = "  $0.00";
      sbCostTokens.content = "  0 in / 0 out";
      sbCostPerModel.content = "";
    }
  }

  // --- rendering helpers ---

  function updateStatus(): void {
    headerLeft.content = " CodingHarness v" + VERSION + "  " + (status.provider || "—") + "/" + (status.model || "—") + "  " + (status.cwd || "—");
    const costText = runtime && runtime.cost ? " · " + formatUSD(runtime.cost.total().cost) : "";
    headerRight.content = "tokens " + status.tokensIn + " in / " + status.tokensOut + " out" + costText + "  ";
    footerRight.content = "steps " + status.steps + "  ";
    markSidebarDirty();
  }

  function addMessageEl(text: string, fg: RGBA, opts2: { prefix?: string } = {}): TextRenderable {
    const t = new TextRenderable(renderer, {
      id: "msg-" + messageEls.length,
      content: (opts2.prefix ?? "") + text,
      fg,
    });
    scroll.content.add(t);
    messageEls.push(t);
    scroll.requestRender();
    return t;
  }

  function addMessageToUI(msg: TuiMessage): void {
    let fg = COLORS.fg;
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
    addMessageEl(msg.text, fg, { prefix });
  }

  // --- input handling ---

  renderer.addInputHandler((sequence) => {
    if (sequence === "\x03") {  // Ctrl+C
      if (textarea.plainText.length > 0) textarea.clear();
      else for (const cb of actionListeners) cb({ action: "cancel" });
      return true;
    }
    if (sequence === "\x04") {  // Ctrl+D
      for (const cb of actionListeners) cb({ action: "eof" });
      quitRequested = true;
      return true;
    }
    if (sequence === "\x0c") {  // Ctrl+L
      for (const cb of actionListeners) cb({ action: "clear-messages" });
      return true;
    }
    return false;
  });

  renderer.addInputHandler((sequence) => {
    if (sequence === "\t") {
      const text = textarea.plainText;
      if (text.startsWith("/") && !text.includes(" ")) {
        const base = text.slice(1);
        const matches = slashNames.filter((n) => n.startsWith(base));
        if (matches.length > 0) {
          textarea.editBuffer.setText("/" + matches[0]! + " ");
          return true;
        }
      }
      return false;
    }
    return false;
  });

  textarea.onSubmit = () => {
    const text = textarea.plainText;
    if (text.trim().length === 0) return;
    addMessageEl(text, COLORS.fgGreen, { prefix: " › " });
    textarea.clear();
    markSidebarDirty();
    for (const cb of submitListeners) {
      try { cb(text); } catch (e) { console.error("submit error:", e); }
    }
  };

  // Periodic sidebar refresh.
  const sidebarTimer = setInterval(() => { markSidebarDirty(); refreshSidebar(); }, 2_000);

  // --- public API ---

  return {
    async start() {
      updateStatus();
      addMessageEl("Welcome to CodingHarness v" + VERSION + ". Type /help for commands.", COLORS.fgCyan, { prefix: " · " });
      await doRefresh();
      renderer.start();
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (quitRequested) { clearInterval(check); resolve(); }
        }, 100);
      });
      clearInterval(sidebarTimer);
      renderer.stop();
      renderer.destroy();
    },

    stop() {
      quitRequested = true;
      clearInterval(sidebarTimer);
      try { renderer.stop(); } catch {}
      try { renderer.destroy(); } catch {}
    },

    appendText(text) {
      currentStreamText += text;
      if (!currentStreamTextEl) {
        currentStreamTextEl = new TextRenderable(renderer, { id: "stream", content: currentStreamText, fg: COLORS.fg });
        scroll.content.add(currentStreamTextEl);
        messageEls.push(currentStreamTextEl);
      } else {
        currentStreamTextEl.content = currentStreamText;
      }
    },

    endStream() {
      currentStreamTextEl = null;
      currentStreamText = "";
    },

    addMessage(msg) { addMessageToUI(msg); },

    appendMessage(text) {
      const last = messageEls[messageEls.length - 1];
      if (last) last.content = (last.content ?? "") + text;
      else addMessageEl(text, COLORS.fg);
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
      markSidebarDirty();
    },

    setSlashNames(names) { slashNames = names.slice(); },
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
    redraw() { renderer.requestRender(); markSidebarDirty(); },
  };
}

function truncateArgs(args: string): string {
  const trimmed = args.replace(/\s+/g, " ").trim();
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "…" : trimmed;
}

function formatAgo(t: number): string {
  const dt = Date.now() - t;
  if (dt < 60_000) return Math.floor(dt / 1000) + "s ago";
  if (dt < 3_600_000) return Math.floor(dt / 60_000) + "m ago";
  if (dt < 86_400_000) return Math.floor(dt / 3_600_000) + "h ago";
  return Math.floor(dt / 86_400_000) + "d ago";
}
