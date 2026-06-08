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
//   │  │ current run         │  │                      │  │
//   │  │ active sub-agents   │  │                      │  │
//   │  │ cost                │  │                      │  │
//   │  └─────────────────────┘  └──────────────────────┘  │
//   ├─ input (5 rows) ─────────────────────────────────────┤
//   ├─ footer (1 row) ─────────────────────────────────────┘

import { CliRenderer, BoxRenderable, TextRenderable, ScrollBoxRenderable, TextareaRenderable, RGBA } from "@opentui/core";
import { BUILTIN_REGISTRY, QUICK_START, renderQuickStart } from "../slash/builtin.js";
import { tryParseSlash } from "../slash/registry.js";
import { runAgent, DEFAULT_LIMITS } from "../agent/loop.js";
import { sessionToMessages } from "../agent/session.js";
import type { HarnessRuntime } from "../runtime.js";
import { formatUSD } from "../agent/cost.js";
import { Session } from "../agent/session.js";
import { askApproval as showApprovalModal, type ApprovalDecision } from "./approval-modal.js";

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

export interface TuiRunState {
  phase: "idle" | "running" | "complete" | "error";
  title: string;
  detail: string;
  updatedAt: number;
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
  setRunState(s: Partial<TuiRunState>): void;
  setSlashNames(names: string[]): void;
  setComposerMode(mode: "plan" | "build"): void;
  getComposerMode(): "plan" | "build";
  onSubmit(cb: (text: string) => void): void;
  onAction(cb: (a: TuiAction) => void): void;
  setInfo(text: string): void;
  getInput(): string;
  setInput(text: string): void;
  redraw(): void;
  /** Pop the approval modal and resolve with the user's decision. */
  askApproval(command: string, reason: string): Promise<ApprovalDecision>;
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

  const sbGoalLabel = new TextRenderable(renderer, { id: "sb-goal-label", content: " current run", fg: COLORS.fgDim });
  sidebar.add(sbGoalLabel);
  const sbGoalState = new TextRenderable(renderer, { id: "sb-goal-state", content: "  idle", fg: COLORS.fgDim, attributes: 1 });
  sidebar.add(sbGoalState);
  const sbGoalMeta = new TextRenderable(renderer, { id: "sb-goal-meta", content: "  ready for the next prompt", fg: COLORS.fgDim });
  sidebar.add(sbGoalMeta);
  const sbGoalDetail = new TextRenderable(renderer, { id: "sb-goal-detail", content: "  Ctrl+G inserts /goal", fg: COLORS.fgFaint });
  sidebar.add(sbGoalDetail);

  const sbSpacerGoal = new TextRenderable(renderer, { id: "sb-spacer-goal", content: "" });
  sidebar.add(sbSpacerGoal);

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

  const commandPreviewBox = new BoxRenderable(renderer, {
    id: "command-preview-box",
    backgroundColor: COLORS.bg,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 1,
    height: 2,
  });
  main.add(commandPreviewBox);
  const commandPreviewText = new TextRenderable(renderer, { id: "command-preview", content: "", fg: COLORS.fgDim });
  commandPreviewBox.add(commandPreviewText);

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
    content: " ⏎ send · ⇧⏎ newline · Tab complete · Ctrl+G /goal · /plan · /build · Ctrl+L clear · Ctrl+C abort · Ctrl+D quit ",
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
  let composerMode: "plan" | "build" = "build";
  const runState: TuiRunState = {
    phase: "idle",
    title: "idle",
    detail: "Ready for the next prompt.",
    updatedAt: Date.now(),
  };
  let slashNames = opts.slashNames.slice();
  let currentStreamText = "";
  let currentStreamTextEl: TextRenderable | null = null;
  const messageEls: TextRenderable[] = [];
  let infoTimer: NodeJS.Timeout | null = null;
  let lastPreviewKey = "";
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

    const goal = runtime?.getGoalActivity?.() ?? null;
    if (goal) {
      const phase = goal.phase === "executing" ? "running" : goal.phase;
      const step = goal.step > 0 ? "step " + goal.step + "/" + goal.maxSteps : "planning";
      const objective = goal.statusText ?? goal.objective;
      sbGoalState.content = "  " + goalIcon(phase) + " " + phase;
      sbGoalMeta.content = "  " + step + " · " + formatAgo(goal.updatedAt);
      sbGoalDetail.content = "  " + compactLine(objective, 24);
      sbGoalState.fg = goal.phase === "complete" ? COLORS.fgGreen : goal.phase === "blocked" ? COLORS.fgRed : COLORS.fgCyan;
      sbGoalMeta.fg = COLORS.fgDim;
      sbGoalDetail.fg = goal.phase === "blocked" ? COLORS.fgRed : goal.phase === "complete" ? COLORS.fgGreen : COLORS.fgFaint;
    } else if (runState.phase !== "idle") {
      sbGoalState.content = "  " + goalIcon(runState.phase) + " " + runState.title;
      sbGoalMeta.content = "  " + formatAgo(runState.updatedAt);
      sbGoalDetail.content = "  " + compactLine(runState.detail, 24);
      sbGoalState.fg = runState.phase === "complete" ? COLORS.fgGreen : runState.phase === "error" ? COLORS.fgRed : COLORS.fgCyan;
      sbGoalMeta.fg = COLORS.fgDim;
      sbGoalDetail.fg = runState.phase === "error" ? COLORS.fgRed : COLORS.fgFaint;
    } else {
      sbGoalState.content = "  idle — try a prompt";
      sbGoalMeta.content = "  /help · /goal · /model · /plan · /build";
      sbGoalDetail.content = "  ⏎ sends · Tab completes · " + composerMode + " mode";
      sbGoalState.fg = COLORS.fgDim;
      sbGoalMeta.fg = COLORS.fgDim;
      sbGoalDetail.fg = COLORS.fgFaint;
    }

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
    footerRight.content = "steps " + status.steps + " · " + composerMode + " mode  ";
    markSidebarDirty();
  }

  function updateComposerMode(mode: "plan" | "build"): void {
    composerMode = mode === "plan" ? "plan" : "build";
    updateStatus();
    refreshCommandPreview();
    renderer.requestRender();
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

  function refreshCommandPreview(): void {
    const text = textarea.plainText.trimStart();
    const next = buildCommandPreview(text, slashNames);
    if (next !== lastPreviewKey) {
      lastPreviewKey = next;
      commandPreviewText.content = next ? " " + next : "";
      renderer.requestRender();
    }
  }

  // --- input handling ---

  renderer.addInputHandler((sequence) => {
    if (sequence === "\x07") {  // Ctrl+G
      textarea.editBuffer.setText("/goal ");
      refreshCommandPreview();
      renderer.requestRender();
      return true;
    }
    if (sequence === "\x03") {  // Ctrl+C
      if (textarea.plainText.length > 0) textarea.clear();
      else for (const cb of actionListeners) cb({ action: "cancel" });
      refreshCommandPreview();
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
          refreshCommandPreview();
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
    refreshCommandPreview();
    markSidebarDirty();
    for (const cb of submitListeners) {
      try { cb(text); } catch (e) { console.error("submit error:", e); }
    }
  };

  // Periodic sidebar refresh.
  const sidebarTimer = setInterval(() => { markSidebarDirty(); refreshSidebar(); }, 2_000);
  const previewTimer = setInterval(() => { refreshCommandPreview(); }, 120);

  // --- public API ---

  return {
    async start() {
      updateStatus();
      // First-launch onboarding. We always show the quick-start card on
      // launch — it's cheap, fits in 6 lines, and the user can ignore it.
      // Returning users have already seen it; the persistent sidebar hint
      // keeps the same 4 commands one keystroke away.
      const quick = renderQuickStart({ title: "CodingHarness v" + VERSION + " — quick start" });
      for (const line of quick.split("\n")) {
        addMessageEl(line, line.startsWith("  ") ? COLORS.fg : COLORS.fgCyan, { prefix: line.startsWith("  ") ? "   " : " · " });
      }
      addMessageEl("(type /help any time to see every command)", COLORS.fgDim, { prefix: " · " });
      await doRefresh();
      refreshCommandPreview();
      renderer.start();
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (quitRequested) { clearInterval(check); resolve(); }
        }, 100);
      });
      clearInterval(sidebarTimer);
      clearInterval(previewTimer);
      renderer.stop();
      renderer.destroy();
    },

    stop() {
      quitRequested = true;
      clearInterval(sidebarTimer);
      clearInterval(previewTimer);
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

    setRunState(s) {
      Object.assign(runState, s);
      runState.updatedAt = s.updatedAt ?? Date.now();
      markSidebarDirty();
      renderer.requestRender();
    },

    setSlashNames(names) { slashNames = names.slice(); },
    setComposerMode(mode) { updateComposerMode(mode); },
    getComposerMode() { return composerMode; },
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
    setInput(text) { textarea.editBuffer.setText(text); refreshCommandPreview(); },
    redraw() { renderer.requestRender(); markSidebarDirty(); },

    async askApproval(command, reason) {
      // Defocus the textarea so the modal's input handler isn't fighting
      // the user's typing in the prompt.
      try { textarea.blur(); } catch {}
      try {
        return await showApprovalModal(renderer, command, reason, root);
      } finally {
        try { textarea.focus(); } catch {}
      }
    },
  };
}

function truncateArgs(args: string): string {
  const trimmed = args.replace(/\s+/g, " ").trim();
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "…" : trimmed;
}

function buildCommandPreview(text: string, slashNames: string[]): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    const lines = ["Type a prompt or /command to start."];
    for (const q of QUICK_START) {
      lines.push("  " + q.label.padEnd(12) + q.hint);
    }
    lines.push("Tab completes · Ctrl+G inserts /goal · /plan · /build · Ctrl+C aborts · Ctrl+D quits.");
    return lines.join("\n");
  }

  if (!trimmed.startsWith("/")) {
    return "⏎ sends this prompt. /help for commands, /goal for multi-step work, /plan or /build to switch modes.";
  }

  const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
  const bare = firstToken.slice(1);
  if (!bare) {
    return "Slash commands: /goal /help /model /plan /build\nTab completes the highlighted command.";
  }

  if (!trimmed.includes(" ")) {
      const matches = slashNames.filter((n) => n.startsWith(bare)).slice(0, 3);
      if (matches.length > 0) {
        const names = matches.map((name) => "/" + name).join("   ");
        if (matches.length === 1) {
          const cmd = BUILTIN_REGISTRY.get(matches[0]!);
          return names + "\n" + compactLine((cmd?.usage ?? "/" + matches[0]!) + (cmd?.description ? " · " + cmd.description : ""), 92);
        }
        return names + "\nTab completes the highlighted command.";
      }
      return "No slash command matches /" + bare + ".\nTry /help to list available commands.";
  }

  const cmd = BUILTIN_REGISTRY.get(bare);
  if (!cmd) {
    return "/" + bare + "\nTry /help to list available commands.";
  }

  return (cmd.usage ?? "/" + cmd.name) + "\n" + compactLine(cmd.description || "Enter to run.", 92);
}

function goalIcon(phase: string): string {
  if (phase === "complete") return "✓";
  if (phase === "blocked" || phase === "error") return "✗";
  if (phase === "running") return "●";
  return "·";
}

function compactLine(text: string, max = 24): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "ready";
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

function formatAgo(t: number): string {
  const dt = Date.now() - t;
  if (dt < 60_000) return Math.floor(dt / 1000) + "s ago";
  if (dt < 3_600_000) return Math.floor(dt / 60_000) + "m ago";
  if (dt < 86_400_000) return Math.floor(dt / 3_600_000) + "h ago";
  return Math.floor(dt / 86_400_000) + "d ago";
}
