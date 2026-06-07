// Multi-line text input editor with history and keybindings.
//
// Maintains a list of lines, a cursor position (line, col), and a
// history index. The editor is "stateless" — callers drive it by
// calling `applyKey()` with StructuredKey events and reading the
// updated state.

import type { StructuredKey } from "./screen.js";

export interface EditorState {
  /** Lines of text. Empty string represents an empty line. */
  lines: string[];
  /** Cursor line (0-indexed). */
  row: number;
  /** Cursor column (0-indexed, in code points). */
  col: number;
  /** History of past submissions. */
  history: string[];
  /** Current index in history when scrolling with up/down, or -1. */
  historyIndex: number;
  /** The text that was being edited when history navigation started. */
  savedDraft: string;
  /** Current autocomplete state, if any. */
  completion?: { base: string; matches: string[]; index: number };
}

export function makeEditor(): EditorState {
  return {
    lines: [""],
    row: 0,
    col: 0,
    history: [],
    historyIndex: -1,
    savedDraft: "",
  };
}

/** Get the current line's text. */
export function currentLine(s: EditorState): string {
  return s.lines[s.row] ?? "";
}

/** Total text across all lines joined with "\n". */
export function fullText(s: EditorState): string {
  return s.lines.join("\n");
}

/** Set the cursor column to a valid position on the current line. */
function clampCol(s: EditorState): void {
  const line = s.lines[s.row] ?? "";
  if (s.col > line.length) s.col = line.length;
}

/** Insert a character at the cursor. */
function insertChar(s: EditorState, ch: string): void {
  const line = s.lines[s.row] ?? "";
  const before = line.slice(0, s.col);
  const after = line.slice(s.col);
  s.lines[s.row] = before + ch + after;
  s.col += ch.length;
  s.historyIndex = -1;
  s.savedDraft = fullText(s);
}

/** Insert a newline (split the current line at cursor). */
function insertNewline(s: EditorState): void {
  const line = s.lines[s.row] ?? "";
  const before = line.slice(0, s.col);
  const after = line.slice(s.col);
  s.lines[s.row] = before;
  s.lines.splice(s.row + 1, 0, after);
  s.row += 1;
  s.col = 0;
  s.historyIndex = -1;
  s.savedDraft = fullText(s);
}

/** Delete the char BEFORE the cursor (backspace). */
function backspace(s: EditorState): void {
  if (s.col > 0) {
    const line = s.lines[s.row]!;
    s.lines[s.row] = line.slice(0, s.col - 1) + line.slice(s.col);
    s.col -= 1;
  } else if (s.row > 0) {
    const cur = s.lines[s.row]!;
    const prev = s.lines[s.row - 1]!;
    s.row -= 1;
    s.col = prev.length;
    s.lines[s.row] = prev + cur;
    s.lines.splice(s.row + 1, 1);
  }
  s.historyIndex = -1;
  s.savedDraft = fullText(s);
}

/** Delete the char AT the cursor (delete key). */
function deleteAt(s: EditorState): void {
  const line = s.lines[s.row]!;
  if (s.col < line.length) {
    s.lines[s.row] = line.slice(0, s.col) + line.slice(s.col + 1);
  } else if (s.row < s.lines.length - 1) {
    s.lines[s.row] = line + s.lines[s.row + 1]!;
    s.lines.splice(s.row + 1, 1);
  }
  s.historyIndex = -1;
  s.savedDraft = fullText(s);
}

function moveLeft(s: EditorState, word: boolean): void {
  if (word) {
    const line = s.lines[s.row] ?? "";
    let i = s.col;
    while (i > 0 && /\s/.test(line[i - 1] ?? "")) i--;
    while (i > 0 && !/\s/.test(line[i - 1] ?? "")) i--;
    s.col = i;
  } else if (s.col > 0) {
    s.col -= 1;
  } else if (s.row > 0) {
    s.row -= 1;
    s.col = s.lines[s.row]!.length;
  }
}

function moveRight(s: EditorState, word: boolean): void {
  const line = s.lines[s.row] ?? "";
  if (word) {
    let i = s.col;
    while (i < line.length && !/\s/.test(line[i] ?? "")) i++;
    while (i < line.length && /\s/.test(line[i] ?? "")) i++;
    s.col = i;
  } else if (s.col < line.length) {
    s.col += 1;
  } else if (s.row < s.lines.length - 1) {
    s.row += 1;
    s.col = 0;
  }
}

function moveUp(s: EditorState): void {
  if (s.row > 0) {
    s.row -= 1;
    clampCol(s);
    return;
  }
  // Up on first line: load previous history entry.
  if (s.history.length === 0) return;
  if (s.historyIndex === -1) {
    s.savedDraft = fullText(s);
    s.historyIndex = s.history.length - 1;
  } else if (s.historyIndex > 0) {
    s.historyIndex -= 1;
  } else {
    return;
  }
  loadHistory(s);
}

function moveDown(s: EditorState): void {
  if (s.row < s.lines.length - 1) {
    s.row += 1;
    clampCol(s);
    return;
  }
  if (s.historyIndex === -1) return;
  if (s.historyIndex < s.history.length - 1) {
    s.historyIndex += 1;
    loadHistory(s);
  } else {
    s.historyIndex = -1;
    s.lines = s.savedDraft.length === 0 ? [""] : s.savedDraft.split("\n");
    s.row = Math.max(0, s.lines.length - 1);
    s.col = (s.lines[s.row] ?? "").length;
  }
}

function loadHistory(s: EditorState): void {
  const text = s.history[s.historyIndex] ?? "";
  s.lines = text.length === 0 ? [""] : text.split("\n");
  s.row = Math.max(0, s.lines.length - 1);
  s.col = (s.lines[s.row] ?? "").length;
}

function moveHome(s: EditorState): void {
  s.col = 0;
}

function moveEnd(s: EditorState): void {
  s.col = (s.lines[s.row] ?? "").length;
}

function killToEnd(s: EditorState): void {
  const line = s.lines[s.row]!;
  s.lines[s.row] = line.slice(0, s.col);
  s.historyIndex = -1;
  s.savedDraft = fullText(s);
}

function killToStart(s: EditorState): void {
  const line = s.lines[s.row]!;
  s.lines[s.row] = line.slice(s.col);
  s.col = 0;
  s.historyIndex = -1;
  s.savedDraft = fullText(s);
}

function killWord(s: EditorState): void {
  const line = s.lines[s.row] ?? "";
  let i = s.col;
  while (i > 0 && /\s/.test(line[i - 1] ?? "")) i--;
  while (i > 0 && !/\s/.test(line[i - 1] ?? "")) i--;
  s.lines[s.row] = line.slice(0, i) + line.slice(s.col);
  s.col = i;
  s.historyIndex = -1;
  s.savedDraft = fullText(s);
}

function clearEditor(s: EditorState): void {
  s.lines = [""];
  s.row = 0;
  s.col = 0;
  s.completion = undefined;
}

/** Apply a StructuredKey. Returns:
 *  - { submit: text }  if the user pressed Enter
 *  - { action: "..." } for special actions
 *  - undefined        if the key was handled but no action needed
 *  - { unhandled: k } if the key wasn't handled */
export function applyKey(s: EditorState, k: StructuredKey): { submit?: string; action?: string; unhandled?: StructuredKey } | undefined {
  switch (k.kind) {
    case "char":
      if (k.char.length > 0) {
        if (s.completion) insertCompletion(s, k.char);
        else insertChar(s, k.char);
        s.completion = undefined;
      }
      return undefined;
    case "enter":
      return { submit: fullText(s) };
    case "newline":
      insertNewline(s);
      s.completion = undefined;
      return undefined;
    case "backspace":
      backspace(s);
      s.completion = undefined;
      return undefined;
    case "delete":
      deleteAt(s);
      s.completion = undefined;
      return undefined;
    case "left":
      moveLeft(s, !!k.meta);
      s.completion = undefined;
      return undefined;
    case "right":
      moveRight(s, !!k.meta);
      s.completion = undefined;
      return undefined;
    case "up":
      moveUp(s);
      s.completion = undefined;
      return undefined;
    case "down":
      moveDown(s);
      s.completion = undefined;
      return undefined;
    case "home":
      moveHome(s);
      s.completion = undefined;
      return undefined;
    case "end":
      moveEnd(s);
      s.completion = undefined;
      return undefined;
    case "tab":
      return { action: "complete" };
    case "backtab":
      return { action: "complete-reverse" };
    case "esc":
      clearEditor(s);
      return undefined;
    case "ctrl":
      if (k.key === "a") { moveHome(s); s.completion = undefined; return undefined; }
      if (k.key === "e") { moveEnd(s); s.completion = undefined; return undefined; }
      if (k.key === "k") { killToEnd(s); s.completion = undefined; return undefined; }
      if (k.key === "u") { killToStart(s); s.completion = undefined; return undefined; }
      if (k.key === "w") { killWord(s); s.completion = undefined; return undefined; }
      if (k.key === "l") return { action: "clear-messages" };
      if (k.key === "c") return { action: "cancel" };
      if (k.key === "d") return { action: "eof" };
      if (k.key === "r") return { action: "redraw" };
      if (k.key === "n") { moveDown(s); s.completion = undefined; return undefined; }
      if (k.key === "p") { moveUp(s); s.completion = undefined; return undefined; }
      if (k.key === "t") return { action: "noop" };
      return { unhandled: k };
    case "pageUp":
      return { action: "scroll-up" };
    case "pageDown":
      return { action: "scroll-down" };
  }
  return { unhandled: k };
}

/** Push a submitted value to the editor's history. */
export function pushHistory(s: EditorState, text: string): void {
  if (!text.trim()) return;
  if (s.history.length > 0 && s.history[s.history.length - 1] === text) return;
  s.history.push(text);
  if (s.history.length > 200) s.history.shift();
}

/** Reset the editor to a fresh empty state. */
export function reset(s: EditorState): void {
  s.lines = [""];
  s.row = 0;
  s.col = 0;
  s.historyIndex = -1;
  s.savedDraft = "";
  s.completion = undefined;
}

/** Set the input programmatically (e.g. for slash command fills). */
export function setText(s: EditorState, text: string): void {
  s.lines = text.length === 0 ? [""] : text.split("\n");
  s.row = s.lines.length - 1;
  s.col = (s.lines[s.row] ?? "").length;
  s.historyIndex = -1;
  s.completion = undefined;
}

/** Begin (or continue) a completion session for the current line. */
export function startCompletion(s: EditorState, candidates: string[]): void {
  const line = currentLine(s);
  const m = line.match(/^(\/\S*)$/);
  if (!m) {
    s.completion = undefined;
    return;
  }
  const base = m[1]!;
  s.completion = { base, matches: candidates, index: 0 };
  applyCompletion(s);
}

/** Cycle to the next completion match. */
export function nextCompletion(s: EditorState): void {
  if (!s.completion) return;
  s.completion.index = (s.completion.index + 1) % Math.max(1, s.completion.matches.length);
  applyCompletion(s);
}

/** Cycle to the previous completion match. */
export function prevCompletion(s: EditorState): void {
  if (!s.completion) return;
  const n = s.completion.matches.length;
  if (n === 0) return;
  s.completion.index = (s.completion.index - 1 + n) % n;
  applyCompletion(s);
}

function applyCompletion(s: EditorState): void {
  if (!s.completion) return;
  const m = s.completion.matches[s.completion.index];
  if (m === undefined) return;
  s.lines[s.row] = m;
  s.col = m.length;
}

function insertCompletion(s: EditorState, ch: string): void {
  if (!s.completion) { insertChar(s, ch); return; }
  // If the typed char matches the next char of the current match, advance the base.
  const m = s.completion.matches[s.completion.index] ?? "";
  if (m[s.col] === ch) {
    insertChar(s, ch);
  } else {
    // The user is filtering further — drop completion, just insert.
    s.completion = undefined;
    insertChar(s, ch);
  }
}
