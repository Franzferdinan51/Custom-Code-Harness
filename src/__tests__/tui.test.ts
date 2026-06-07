// Tests for the TUI components: key parser, editor, buffer, layout.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { structureKey, type KeyEvent } from "../ui/tui/screen.js";
import { applyKey, makeEditor, currentLine, fullText, pushHistory, setText, startCompletion, nextCompletion, prevCompletion } from "../ui/tui/editor.js";
import { Buffer } from "../ui/tui/buffer.js";
import { computeLayout } from "../ui/tui/layout.js";

// ---- key parser ----

function k(name: string, opts: Partial<KeyEvent> = {}): KeyEvent {
  return { name, sequence: opts.sequence ?? name, ctrl: !!opts.ctrl, meta: !!opts.meta, shift: !!opts.shift, char: opts.char ?? "" };
}

test("structureKey: 'a' becomes a char", () => {
  const r = structureKey(k("a", { char: "a" }));
  assert.equal(r.kind, "char");
  if (r.kind === "char") assert.equal(r.char, "a");
});

test("structureKey: enter is enter, shift+enter is newline", () => {
  assert.equal(structureKey(k("return")).kind, "enter");
  assert.equal(structureKey(k("return", { shift: true })).kind, "newline");
});

test("structureKey: arrow keys", () => {
  assert.equal(structureKey(k("left")).kind, "left");
  assert.equal(structureKey(k("right")).kind, "right");
  assert.equal(structureKey(k("up")).kind, "up");
  assert.equal(structureKey(k("down")).kind, "down");
});

test("structureKey: ctrl+a is a ctrl action", () => {
  const r = structureKey(k("a", { ctrl: true }));
  assert.equal(r.kind, "ctrl");
  if (r.kind === "ctrl") assert.equal(r.key, "a");
});

test("structureKey: tab vs backtab", () => {
  assert.equal(structureKey(k("tab")).kind, "tab");
  assert.equal(structureKey(k("tab", { shift: true })).kind, "backtab");
});

// ---- editor ----

test("editor: starts empty", () => {
  const e = makeEditor();
  assert.equal(currentLine(e), "");
  assert.equal(fullText(e), "");
  assert.equal(e.row, 0);
  assert.equal(e.col, 0);
});

test("editor: typing chars", () => {
  const e = makeEditor();
  applyKey(e, { kind: "char", char: "h" });
  applyKey(e, { kind: "char", char: "i" });
  assert.equal(currentLine(e), "hi");
  assert.equal(e.col, 2);
});

test("editor: backspace", () => {
  const e = makeEditor();
  applyKey(e, { kind: "char", char: "h" });
  applyKey(e, { kind: "char", char: "i" });
  applyKey(e, { kind: "backspace" });
  assert.equal(currentLine(e), "h");
});

test("editor: enter submits", () => {
  const e = makeEditor();
  applyKey(e, { kind: "char", char: "h" });
  applyKey(e, { kind: "char", char: "i" });
  const r = applyKey(e, { kind: "enter" });
  assert.equal(r?.submit, "hi");
});

test("editor: newline splits the line", () => {
  const e = makeEditor();
  applyKey(e, { kind: "char", char: "a" });
  applyKey(e, { kind: "char", char: "b" });
  applyKey(e, { kind: "newline" });
  applyKey(e, { kind: "char", char: "c" });
  assert.equal(e.lines.length, 2);
  assert.equal(e.lines[0], "ab");
  assert.equal(e.lines[1], "c");
  assert.equal(e.row, 1);
  assert.equal(e.col, 1);
});

test("editor: arrow keys move the cursor", () => {
  const e = makeEditor();
  applyKey(e, { kind: "char", char: "a" });
  applyKey(e, { kind: "char", char: "b" });
  applyKey(e, { kind: "char", char: "c" });
  applyKey(e, { kind: "left" });
  applyKey(e, { kind: "left" });
  assert.equal(e.col, 1);
  applyKey(e, { kind: "char", char: "X" });
  // After typing "abc", col=3. Two lefts -> col=1. Insert X at col=1.
  assert.equal(currentLine(e), "aXbc");
  applyKey(e, { kind: "end" });
  applyKey(e, { kind: "left" });
  applyKey(e, { kind: "char", char: "Y" });
  // End -> col=4. Left -> col=3. Insert Y at col=3.
  assert.equal(currentLine(e), "aXbYc");
});

test("editor: home/end", () => {
  const e = makeEditor();
  applyKey(e, { kind: "char", char: "a" });
  applyKey(e, { kind: "char", char: "b" });
  applyKey(e, { kind: "char", char: "c" });
  applyKey(e, { kind: "home" });
  assert.equal(e.col, 0);
  applyKey(e, { kind: "end" });
  assert.equal(e.col, 3);
});

test("editor: ctrl+a/ctrl+e", () => {
  const e = makeEditor();
  applyKey(e, { kind: "char", char: "x" });
  applyKey(e, { kind: "char", char: "y" });
  applyKey(e, { kind: "ctrl", key: "a" });
  assert.equal(e.col, 0);
  applyKey(e, { kind: "ctrl", key: "e" });
  assert.equal(e.col, 2);
});

test("editor: ctrl+k kills to end of line", () => {
  const e = makeEditor();
  for (const c of "abcdef") applyKey(e, { kind: "char", char: c });
  applyKey(e, { kind: "home" });
  applyKey(e, { kind: "char", char: "X" });
  applyKey(e, { kind: "char", char: "Y" });
  applyKey(e, { kind: "ctrl", key: "k" });
  assert.equal(currentLine(e), "XY");
});

test("editor: history navigation via up/down", () => {
  const e = makeEditor();
  pushHistory(e, "first");
  pushHistory(e, "second");
  // Up twice: load "first" then "second"
  applyKey(e, { kind: "up" });
  assert.equal(fullText(e), "second");
  applyKey(e, { kind: "up" });
  assert.equal(fullText(e), "first");
  // Down restores the draft
  applyKey(e, { kind: "down" });
  applyKey(e, { kind: "down" });
  assert.equal(fullText(e), "");
});

test("editor: setText replaces content", () => {
  const e = makeEditor();
  setText(e, "hello\nworld");
  assert.equal(e.lines.length, 2);
  assert.equal(e.lines[0], "hello");
  assert.equal(e.row, 1);
  assert.equal(e.col, 5);
});

test("editor: completion cycles", () => {
  const e = makeEditor();
  applyKey(e, { kind: "char", char: "/" });
  applyKey(e, { kind: "char", char: "h" });
  startCompletion(e, ["/help", "/history"]);
  // First match is selected
  assert.equal(currentLine(e), "/help");
  nextCompletion(e);
  assert.equal(currentLine(e), "/history");
  nextCompletion(e);
  assert.equal(currentLine(e), "/help");
  prevCompletion(e);
  assert.equal(currentLine(e), "/history");
});

test("editor: ctrl+c returns 'cancel' action", () => {
  const e = makeEditor();
  applyKey(e, { kind: "char", char: "a" });
  const r = applyKey(e, { kind: "ctrl", key: "c" });
  assert.equal(r?.action, "cancel");
});

test("editor: ctrl+d returns 'eof' action", () => {
  const e = makeEditor();
  const r = applyKey(e, { kind: "ctrl", key: "d" });
  assert.equal(r?.action, "eof");
});

// ---- buffer ----

test("buffer: setCell and getCell", () => {
  const b = new Buffer(10, 5);
  b.setCell(0, 0, "X", { fg: 2, bold: true });
  const c = b.getCell(0, 0);
  assert.equal(c.char, "X");
  assert.equal(c.style.fg, 2);
  assert.equal(c.style.bold, true);
});

test("buffer: writeString wraps at column boundary", () => {
  const b = new Buffer(5, 3);
  b.writeString(0, 0, "abcde");
  b.writeString(0, 5, "fgh");
  // After wrap, the third 'e' is at (0,4), then f starts at (1,0).
  assert.equal(b.getCell(0, 4).char, "e");
  assert.equal(b.getCell(1, 0).char, "f");
  assert.equal(b.getCell(1, 2).char, "h");
});

test("buffer: writeString handles explicit newlines", () => {
  const b = new Buffer(10, 3);
  const end = b.writeString(0, 0, "hi\nthere");
  assert.equal(end.row, 1);
  assert.equal(end.col, 5);
  assert.equal(b.getCell(0, 0).char, "h");
  assert.equal(b.getCell(1, 0).char, "t");
});

test("buffer: resize preserves content", () => {
  const b = new Buffer(5, 3);
  b.setCell(0, 0, "X");
  b.resize(10, 3);
  assert.equal(b.getCell(0, 0).char, "X");
  assert.equal(b.cols, 10);
});

test("buffer: fillRect clears an area", () => {
  const b = new Buffer(5, 5);
  b.fillRect(0, 0, 5, 1, "─");
  for (let c = 0; c < 5; c++) assert.equal(b.getCell(0, c).char, "─");
});

// ---- layout ----

test("layout: 80x24 has positive message area", () => {
  const l = computeLayout(80, 24);
  assert.ok(l.messagesRows > 0);
  assert.ok(l.inputRows > 0);
  assert.ok(l.headerRows > 0);
  // Order: header, messages, input, footer
  assert.equal(l.messagesRow, l.headerRow + l.headerRows);
  assert.equal(l.inputRow, l.messagesRow + l.messagesRows);
  assert.equal(l.footerRow, l.inputRow + l.inputRows);
});

test("layout: 80x10 still has at least 3 message rows", () => {
  const l = computeLayout(80, 10);
  assert.ok(l.messagesRows >= 3);
});

test("ALL OK", () => {});
