// Main TUI class. Wires the screen, buffer, renderer, editor, and
// the runtime hooks. Public API:
//
//   const tui = createTui({ runtime, slashNames });
//   tui.start();
//   tui.onSubmit((text) => { ... });
//   tui.onAction((action) => { ... });
//   tui.appendText("streaming...");
//   tui.addToolCall("read", args, "ok", "/path/to/file");
//   tui.setStatus({ model: "gpt-4o", provider: "openai", session: "abc", tokens: 1234 });
//   tui.stop();

import { createScreen, type Screen, type StructuredKey } from "./tui/screen.js";
import { Buffer, type Style } from "./tui/buffer.js";
import { Renderer } from "./tui/render.js";
import { applyKey, makeEditor, pushHistory, reset as resetEditor, setText, startCompletion, nextCompletion, prevCompletion, type EditorState } from "./tui/editor.js";
import { computeLayout } from "./tui/layout.js";

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
  /** "user" | "assistant" | "tool" | "system" | "info" | "error" */
  kind: "user" | "assistant" | "tool" | "system" | "info" | "error";
  text: string;
  meta?: string;
  /** For tool messages: status icon ('ok' | 'err' | 'run'). */
  toolStatus?: "ok" | "err" | "run";
  /** For tool messages: tool name. */
  toolName?: string;
}

export interface TuiAction {
  action: string;
  data?: string;
}

export interface TuiOptions {
  /** Names of slash commands (for autocomplete). */
  slashNames: string[];
  /** Initial status. */
  status?: Partial<TuiStatus>;
  /** Initial history. */
  history?: string[];
}

export interface Tui {
  start(): void;
  stop(): void;
  /** Append streamed text to the current assistant message. */
  appendText(text: string): void;
  /** Finalize the current streaming assistant message. */
  endStream(): void;
  /** Add a new message to the message area. */
  addMessage(msg: TuiMessage): void;
  /** Append to the last message (creates one if none). */
  appendMessage(text: string): void;
  /** Add a tool call entry. status: 'run' | 'ok' | 'err'. */
  addToolCall(name: string, args: string, status: "run" | "ok" | "err", detail?: string): void;
  /** Update the status bar. */
  setStatus(s: Partial<TuiStatus>): void;
  /** Set the slash command list (for autocomplete). */
  setSlashNames(names: string[]): void;
  /** Subscribe to user submitting a prompt. */
  onSubmit(cb: (text: string) => void): void;
  /** Subscribe to a UI action (clear, cancel, eof, scroll, etc). */
  onAction(cb: (a: TuiAction) => void): void;
  /** Show a transient status message at the bottom of the input area. */
  setInfo(text: string): void;
  /** Get the current input text. */
  getInput(): string;
  /** Set the input text. */
  setInput(text: string): void;
  /** Force a redraw. */
  redraw(): void;
}

const STYLE = {
  reset: {} as Style,
  dim: { dim: true } as Style,
  bold: { bold: true } as Style,
  italic: { italic: true } as Style,
  inverse: { inverse: true } as Style,
  fg: {
    red: { fg: 1 } as Style,
    green: { fg: 2 } as Style,
    yellow: { fg: 3 } as Style,
    blue: { fg: 4 } as Style,
    magenta: { fg: 5 } as Style,
    cyan: { fg: 6 } as Style,
    gray: { fg: 8 } as Style,
    brightCyan: { fg: 14 } as Style,
    brightMagenta: { fg: 13 } as Style,
  },
  bg: {
    bar: { bg: 236 } as Style,
    selected: { bg: 240 } as Style,
  },
};

export function createTui(opts: TuiOptions): Tui {
  const screen = createScreen();
  let buffer: Buffer = new Buffer(screen.cols, screen.rows);
  let renderer: Renderer = new Renderer((s) => screen.write(s));
  const editor: EditorState = makeEditor();
  if (opts.history) editor.history = [...opts.history];
  let slashNames: string[] = opts.slashNames.slice();

  const status: TuiStatus = {
    model: "—",
    provider: "—",
    session: "—",
    cwd: "—",
    tokensIn: 0,
    tokensOut: 0,
    steps: 0,
    thinking: "medium",
    ...opts.status,
  };

  const messages: TuiMessage[] = [];
  let currentStream: string = ""; // for the streaming assistant
  let info: string = "";
  let needsRedraw = false;
  let entered = false;

  // Scroll: how many rows from the END of messages we're scrolled up.
  let scrollOffset = 0;
  // Multi-line input: we use a flat string and wrap visually.
  // The editor maintains lines; we render them line by line with wrap.
  // To keep it simple for v1, we render the lines exactly as-is.
  let inputWidth: number = 0;

  // Subscribers
  const submitListeners = new Set<(text: string) => void>();
  const actionListeners = new Set<(a: TuiAction) => void>();

  function draw(): void {
    if (!entered) return;
    buffer.clear();
    const layout = computeLayout(buffer.cols, buffer.rows);
    drawHeader(layout);
    drawMessages(layout);
    drawInput(layout);
    drawFooter(layout);
    renderer.render(buffer);
  }

  function drawHeader(l: ReturnType<typeof computeLayout>): void {
    // Top bar: app name + version + provider/model
    const title = " CodingHarness v0.2.0";
    const sub = " " + (status.provider || "—") + "/" + (status.model || "—");
    const session = " session:" + (status.session || "—").slice(0, 8);
    const right = "  tokens " + status.tokensIn + " in / " + status.tokensOut + " out  ";
    buffer.fillRect(l.headerRow, 0, buffer.cols, 1, " ", STYLE.bg.bar);
    buffer.writeString(l.headerRow, 0, title, { ...STYLE.bg.bar, ...STYLE.bold, ...STYLE.fg.brightCyan });
    buffer.writeString(l.headerRow, title.length, sub, { ...STYLE.bg.bar, ...STYLE.dim });
    buffer.writeString(l.headerRow, title.length + sub.length, session, { ...STYLE.bg.bar, ...STYLE.dim });
    // Right-aligned: tokens
    const rightCol = Math.max(0, buffer.cols - right.length);
    buffer.writeString(l.headerRow, rightCol, right, { ...STYLE.bg.bar, ...STYLE.dim });

    // Second line: cwd + thinking
    const cwd = " " + (status.cwd || "—");
    const think = "  thinking: " + status.thinking;
    buffer.writeString(l.headerRow + 1, 0, cwd, STYLE.dim);
    buffer.writeString(l.headerRow + 1, cwd.length, think, STYLE.dim);
    // Bottom border
    buffer.drawHLine(l.headerRow + 1, 0, buffer.cols, "─", { fg: 8 });
  }

  function drawMessages(l: ReturnType<typeof computeLayout>): void {
    // Build the rendered text: each message becomes 1-N lines.
    const lines: { kind: TuiMessage["kind"]; text: string; meta?: string; toolStatus?: TuiMessage["toolStatus"]; toolName?: string }[] = [];
    for (const m of messages) {
      const prefix = messagePrefix(m);
      const text = m.text;
      // Word-wrap to buffer.cols - 2 (for the indent)
      const wrapWidth = Math.max(20, buffer.cols - prefix.length - 1);
      const wrapped = wrapText(text, wrapWidth);
      for (let i = 0; i < wrapped.length; i++) {
        lines.push({ kind: m.kind, text: wrapped[i]!, meta: i === 0 ? m.meta : undefined, toolStatus: m.toolStatus, toolName: m.toolName });
      }
    }
    if (currentStream) {
      lines.push({ kind: "assistant", text: "" });
      const wrapped = wrapText(currentStream, Math.max(20, buffer.cols - 3));
      for (const w of wrapped) lines.push({ kind: "assistant", text: w });
    }
    // Slice for scrolling.
    const visible = lines.slice(Math.max(0, lines.length - l.messagesRows - scrollOffset));
    const startRow = l.messagesRow;
    for (let i = 0; i < visible.length && i < l.messagesRows; i++) {
      const m = visible[i]!;
      const r = startRow + i;
      if (m.kind === "user") {
        const p = " › ";
        buffer.writeString(r, 0, p, { ...STYLE.fg.green, ...STYLE.bold });
        buffer.writeString(r, p.length, m.text, STYLE.bold);
      } else if (m.kind === "assistant") {
        buffer.writeString(r, 0, "   ", STYLE.reset);
        buffer.writeString(r, 3, m.text, STYLE.reset);
      } else if (m.kind === "tool") {
        const mark = m.toolStatus === "ok" ? " ✓ " : m.toolStatus === "err" ? " ✗ " : " ⋯ ";
        const color = m.toolStatus === "ok" ? STYLE.fg.green : m.toolStatus === "err" ? STYLE.fg.red : STYLE.fg.yellow;
        const p = mark + (m.toolName ?? "tool") + "  ";
        buffer.writeString(r, 0, p, { ...color, ...STYLE.bold });
        buffer.writeString(r, p.length, m.text, STYLE.reset);
      } else if (m.kind === "system") {
        buffer.writeString(r, 0, " · " + m.text, STYLE.dim);
      } else if (m.kind === "info") {
        buffer.writeString(r, 0, " · " + m.text, { ...STYLE.fg.cyan, ...STYLE.dim });
      } else if (m.kind === "error") {
        buffer.writeString(r, 0, " ! " + m.text, { ...STYLE.fg.red, ...STYLE.bold });
      }
    }
    // Scroll indicator
    if (scrollOffset > 0) {
      const ind = " ↑ " + scrollOffset + " lines scrolled up (PgDn to scroll down) ";
      const r = l.messagesRow;
      buffer.writeString(r, Math.max(0, buffer.cols - ind.length), ind, { ...STYLE.fg.yellow, ...STYLE.dim });
    }
  }

  function messagePrefix(m: TuiMessage): string {
    if (m.kind === "user") return " › ";
    if (m.kind === "tool") return " ✓ tool  ";
    if (m.kind === "error") return " ! ";
    return "   ";
  }

  function drawInput(l: ReturnType<typeof computeLayout>): void {
    // Top border
    buffer.drawHLine(l.inputRow, 0, buffer.cols, "─", { fg: 8 });
    // Info line (transient status)
    if (info) {
      buffer.writeString(l.inputRow + 1, 0, info.slice(0, buffer.cols), { ...STYLE.fg.yellow, ...STYLE.dim });
    }
    // Input lines
    const inputStartRow = info ? l.inputRow + 2 : l.inputRow + 1;
    const inputLines: string[] = editor.lines;
    // Wrap each line to the input width.
    const wrapWidth = Math.max(20, buffer.cols - 4);
    const wrapped: string[] = [];
    for (const line of inputLines) {
      const w = wrapText(line, wrapWidth);
      for (const x of w) wrapped.push(x);
    }
    // Last line is the editable one; the cursor lives there.
    for (let i = 0; i < l.inputRows - (inputStartRow - l.inputRow) && i < wrapped.length; i++) {
      buffer.writeString(inputStartRow + i, 2, wrapped[i]!, STYLE.reset);
    }
    // If the editor's row is past the visible range, scroll within the input.
    // Compute the cursor position in the input.
    const cursorRow = inputStartRow + Math.min(wrapped.length - 1, l.inputRows - 2);
    let cursorCol = 2 + Math.min((wrapped[wrapped.length - 1] ?? "").length, wrapWidth);
    // If the last editor line is what we just rendered, position the cursor at col.
    // Approximation: position cursor at (cursorRow, cursorCol) and the user will see it.
    inputWidth = wrapWidth;
    pendingCursorRow = cursorRow;
    pendingCursorCol = cursorCol;
  }

  let pendingCursorRow = 0;
  let pendingCursorCol = 0;

  function drawFooter(l: ReturnType<typeof computeLayout>): void {
    const keys = " ⏎ send · ⇧⏎ newline · Tab complete · ↑/↓ history · Ctrl+C abort · Ctrl+D quit ";
    buffer.fillRect(l.footerRow, 0, buffer.cols, 1, " ", STYLE.bg.bar);
    buffer.writeString(l.footerRow, 0, keys, { ...STYLE.bg.bar, ...STYLE.dim });
    // Right: status
    const r = "  steps " + status.steps + "  ";
    const col = Math.max(0, buffer.cols - r.length);
    buffer.writeString(l.footerRow, col, r, { ...STYLE.bg.bar, ...STYLE.dim });
  }

  function wrapText(s: string, width: number): string[] {
    if (width <= 0) return [s];
    const out: string[] = [];
    const paragraphs = s.split("\n");
    for (const para of paragraphs) {
      if (para.length <= width) { out.push(para); continue; }
      // Word-wrap; if a single word is too long, hard-break it.
      let cur = "";
      const words = para.split(/(\s+)/); // keep whitespace tokens
      for (const w of words) {
        if ((cur + w).length > width && cur.length > 0) {
          out.push(cur);
          cur = w.replace(/^\s+/, "");
          if (cur.length > width) {
            // hard break
            while (cur.length > width) { out.push(cur.slice(0, width)); cur = cur.slice(width); }
          }
        } else {
          cur += w;
        }
      }
      if (cur.length > 0) out.push(cur);
    }
    if (out.length === 0) out.push("");
    return out;
  }

  // --- input handling ---

  function handleKey(k: StructuredKey): void {
    // Special: if input is empty and user presses up, scroll messages up.
    if (k.kind === "up" && editor.row === 0 && editor.col === 0 && (editor.lines[0] ?? "") === "" && editor.historyIndex === -1) {
      scrollOffset++;
      draw();
      return;
    }
    if (k.kind === "down" && editor.row === editor.lines.length - 1 && (editor.lines[editor.row] ?? "") === "" && editor.historyIndex === -1) {
      if (scrollOffset > 0) scrollOffset--;
      draw();
      return;
    }
    if (k.kind === "pageUp") { scrollOffset += Math.max(1, computeLayout(buffer.cols, buffer.rows).messagesRows - 1); draw(); return; }
    if (k.kind === "pageDown") { scrollOffset = Math.max(0, scrollOffset - Math.max(1, computeLayout(buffer.cols, buffer.rows).messagesRows - 1)); draw(); return; }

    const result = applyKey(editor, k);
    if (!result) { draw(); return; }
    if (result.submit !== undefined) {
      const text = result.submit;
      if (text.trim().length > 0) pushHistory(editor, text);
      // Echo user input as a message.
      if (text.length > 0) {
        messages.push({ kind: "user", text });
        scrollOffset = 0;
      }
      resetEditor(editor);
      draw();
      for (const cb of submitListeners) {
        try { cb(text); } catch (e) { logError(e); }
      }
      return;
    }
    if (result.action) {
      if (result.action === "complete") {
        // Use current line as filter.
        const line = editor.lines[editor.row] ?? "";
        if (line.startsWith("/") && !line.includes(" ")) {
          const base = line;
          const matches = slashNames.filter((n) => n.startsWith(base.replace(/^\//, "")));
          if (matches.length > 0) {
            startCompletion(editor, matches.map((n) => "/" + n));
          } else {
            // No matches; clear any existing completion
            editor.completion = undefined;
          }
        } else {
          nextCompletion(editor);
        }
        draw();
        return;
      }
      if (result.action === "complete-reverse") {
        prevCompletion(editor);
        draw();
        return;
      }
      // Pass through to action listeners.
      for (const cb of actionListeners) {
        try { cb({ action: result.action }); } catch (e) { logError(e); }
      }
      if (result.action === "clear-messages") { messages.length = 0; currentStream = ""; scrollOffset = 0; draw(); }
      if (result.action === "redraw") { renderer.reset(buffer.cols, buffer.rows); draw(); }
      // For cancel / eof, just notify and let the runtime decide.
      return;
    }
  }

  function logError(e: unknown): void {
    try { process.stderr.write("[tui] " + (e as Error).message + "\n"); } catch { /* ignore */ }
  }

  // --- lifecycle ---

  function start(): void {
    if (entered) return;
    entered = true;
    screen.enter();
    renderer.reset(screen.cols, screen.rows);
    buffer = new Buffer(screen.cols, screen.rows);
    draw();
    screen.onResize((cols, rows) => {
      buffer.resize(cols, rows);
      draw();
    });
    screen.onStructuredKey((k) => handleKey(k));
  }

  function stop(): void {
    if (!entered) return;
    entered = false;
    // Restore cursor and leave alt screen.
    screen.leave();
    screen.destroy();
  }

  return {
    start,
    stop,
    appendText(text) {
      currentStream += text;
      scrollOffset = 0;
      draw();
    },
    endStream() {
      if (currentStream) {
        messages.push({ kind: "assistant", text: currentStream });
        currentStream = "";
      }
      draw();
    },
    addMessage(msg) {
      messages.push(msg);
      scrollOffset = 0;
      draw();
    },
    appendMessage(text) {
      if (messages.length === 0) messages.push({ kind: "system", text: "" });
      messages[messages.length - 1]!.text += text;
      draw();
    },
    addToolCall(name, args, status, detail) {
      const icon = status === "ok" ? "✓" : status === "err" ? "✗" : "⋯";
      const text = name + (args ? " " + truncateArgs(args) : "") + (detail ? "  " + detail : "");
      messages.push({ kind: "tool", text, toolStatus: status, toolName: name });
      scrollOffset = 0;
      draw();
    },
    setStatus(s) {
      Object.assign(status, s);
      draw();
    },
    setSlashNames(names) {
      slashNames = names.slice();
    },
    onSubmit(cb) { submitListeners.add(cb); },
    onAction(cb) { actionListeners.add(cb); },
    setInfo(text) { info = text; draw(); if (text) setTimeout(() => { if (info === text) { info = ""; draw(); } }, 5_000); },
    getInput() { return editor.lines.join("\n"); },
    setInput(text) { setText(editor, text); draw(); },
    redraw() { renderer.reset(buffer.cols, buffer.rows); draw(); },
  };
}

function truncateArgs(args: string): string {
  const trimmed = args.replace(/\s+/g, " ").trim();
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "…" : trimmed;
}
