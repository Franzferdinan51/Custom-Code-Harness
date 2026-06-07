// TUI screen layer: raw TTY mode, alt-screen buffer, resize,
// key-press parsing.
//
// We do not use any TUI library — this is a thin wrapper around the
// TTY primitives that Node provides. ANSI escapes go to stdout;
// keystrokes come in via stdin in raw mode.

import { emitKeypressEvents } from "node:readline";
import { WriteStream, ReadStream } from "node:tty";

/** A single key event. `name` is the canonical name (e.g. "a", "enter",
 *  "up", "backspace", "tab", "ctrl+c"). `ctrl`, `meta`, `shift` are set
 *  for modifier-bearing keys. `sequence` is the raw input. */
export interface KeyEvent {
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** Resolved printable character (e.g. "A" with shift). Empty for special keys. */
  char: string;
}

/** A "structured" key, which is what the editor cares about.
 *  Either a printable char, or one of the named actions. */
export type StructuredKey =
  | { kind: "char"; char: string }
  | { kind: "enter" }
  | { kind: "newline" } // shift+enter or alt+enter
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "left"; meta?: boolean }
  | { kind: "right"; meta?: boolean }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "tab" }
  | { kind: "backtab" }
  | { kind: "esc" }
  | { kind: "ctrl"; key: string }
  | { kind: "pageUp" }
  | { kind: "pageDown" };

export interface Screen {
  readonly cols: number;
  readonly rows: number;
  /** Subscribe to key events. Returns an unsubscribe fn. */
  onKey(cb: (k: KeyEvent) => void): () => void;
  /** Subscribe to resize events. */
  onResize(cb: (cols: number, rows: number) => void): () => void;
  /** Subscribe to structured keys (the higher-level layer). */
  onStructuredKey(cb: (k: StructuredKey) => void): () => void;
  /** Enter the alt-screen buffer, hide cursor, set raw mode. */
  enter(): void;
  /** Leave the alt-screen buffer, restore cursor, exit raw mode. */
  leave(): void;
  /** Write raw bytes to the TTY (the buffer/renderer will use this). */
  write(s: string): void;
  /** Cleanup all listeners. */
  destroy(): void;
}

/** Detect terminal dimensions from TTY. */
function detectDims(tty: WriteStream | null): { cols: number; rows: number } {
  if (!tty) return { cols: 80, rows: 24 };
  return { cols: tty.columns || 80, rows: tty.rows || 24 };
}

/** Parse a Node-style keypress event into a StructuredKey. */
export function structureKey(k: KeyEvent): StructuredKey {
  if (k.ctrl) {
    if (k.name === "c") return { kind: "ctrl", key: "c" };
    if (k.name === "d") return { kind: "ctrl", key: "d" };
    if (k.name === "a") return { kind: "ctrl", key: "a" };
    if (k.name === "e") return { kind: "ctrl", key: "e" };
    if (k.name === "k") return { kind: "ctrl", key: "k" };
    if (k.name === "u") return { kind: "ctrl", key: "u" };
    if (k.name === "w") return { kind: "ctrl", key: "w" };
    if (k.name === "l") return { kind: "ctrl", key: "l" };
    if (k.name === "r") return { kind: "ctrl", key: "r" };
    if (k.name === "n") return { kind: "ctrl", key: "n" };
    if (k.name === "p") return { kind: "ctrl", key: "p" };
    if (k.name === "t") return { kind: "ctrl", key: "t" };
    return { kind: "ctrl", key: k.name };
  }
  if (k.meta) {
    if (k.name === "enter" || k.sequence === "\x1b\r" || k.sequence === "\x1b\n") return { kind: "newline" };
  }
  switch (k.name) {
    case "return":
    case "enter":
      return k.shift ? { kind: "newline" } : { kind: "enter" };
    case "backspace":
      return { kind: "backspace" };
    case "delete":
      return { kind: "delete" };
    case "left":
      return { kind: "left", meta: k.meta };
    case "right":
      return { kind: "right", meta: k.meta };
    case "up":
      return { kind: "up" };
    case "down":
      return { kind: "down" };
    case "home":
      return { kind: "home" };
    case "end":
      return { kind: "end" };
    case "tab":
      return k.shift ? { kind: "backtab" } : { kind: "tab" };
    case "escape":
      return { kind: "esc" };
    case "pageup":
      return { kind: "pageUp" };
    case "pagedown":
      return { kind: "pageDown" };
    default: {
      if (k.char) return { kind: "char", char: k.char };
      if (k.sequence && k.sequence.length === 1) return { kind: "char", char: k.sequence };
      return { kind: "esc" };
    }
  }
}

/** Parse the raw SGR/CSI sequence to determine shift state when the
 *  keypress event itself doesn't carry it. Most modern terminals
 *  send `\x1b[1;2A` for shift+up, `\x1b[1;5A` for ctrl+up, etc. */
function parseShiftFromSequence(seq: string): { shift: boolean; ctrl: boolean; meta: boolean } {
  // Match `\x1b[<params>;<mods><final>` where mods bit-1 is shift, bit-4 is alt, bit-5 is ctrl.
  const m = seq.match(/\x1b\[(?:1;)?(\d+)?(?:\d+)?([ABCDEFGH]|~)$/);
  // Fallback: just return false/true based on the keypress modifiers.
  return { shift: false, ctrl: false, meta: false };
}

export function createScreen(opts: { stdin?: ReadStream; stdout?: WriteStream } = {}): Screen {
  const tty = (opts.stdout ?? process.stdout) as WriteStream;
  const input = (opts.stdin ?? process.stdin) as ReadStream;
  let cols = detectDims(tty).cols;
  let rows = detectDims(tty).rows;
  let entered = false;
  const keyListeners = new Set<(k: KeyEvent) => void>();
  const resizeListeners = new Set<(c: number, r: number) => void>();
  const structuredListeners = new Set<(k: StructuredKey) => void>();

  // Use Node's built-in readline keypress emitter.
  emitKeypressEvents(input);

  const onKeypress = (_str: string | undefined, key: { sequence?: string; name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; code?: string } | undefined) => {
    if (!key) return;
    const name = (key.name ?? "?").toLowerCase();
    const char = ((): string => {
      // Readable char: prefer explicit char if name is the same; else derive.
      if (key.name && key.name.length === 1) return key.name;
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) return key.sequence;
      return "";
    })();
    // If shift wasn't carried on the keypress event (older terminals), derive from sequence.
    let shift = !!key.shift;
    let ctrl = !!key.ctrl;
    let meta = !!key.meta;
    if (!shift && key.sequence && key.sequence.startsWith("\x1b[")) {
      const s = parseShiftFromSequence(key.sequence);
      shift = s.shift;
      ctrl = s.ctrl;
      meta = s.meta;
    }
    const ev: KeyEvent = {
      name,
      sequence: key.sequence ?? "",
      ctrl,
      meta,
      shift,
      char,
    };
    for (const cb of keyListeners) cb(ev);
    const sk = structureKey(ev);
    for (const cb of structuredListeners) cb(sk);
  };

  const onResize = () => {
    const d = detectDims(tty);
    cols = d.cols;
    rows = d.rows;
    for (const cb of resizeListeners) cb(cols, rows);
  };

  input.on("keypress", onKeypress as (...args: unknown[]) => void);
  tty.on("resize", onResize);

  return {
    get cols() { return cols; },
    get rows() { return rows; },
    onKey(cb) { keyListeners.add(cb); return () => keyListeners.delete(cb); },
    onResize(cb) { resizeListeners.add(cb); return () => resizeListeners.delete(cb); },
    onStructuredKey(cb) { structuredListeners.add(cb); return () => structuredListeners.delete(cb); },
    enter() {
      if (entered) return;
      entered = true;
      if (tty.isTTY && input.isTTY) {
        tty.write("\x1b[?1049h"); // enter alt screen
        tty.write("\x1b[?25l"); // hide cursor
        tty.write("\x1b[?7l"); // disable line wrap (we manage it)
        input.setRawMode(true);
      }
      cols = detectDims(tty).cols;
      rows = detectDims(tty).rows;
    },
    leave() {
      if (!entered) return;
      entered = false;
      if (tty.isTTY && input.isTTY) {
        tty.write("\x1b[?7h");
        tty.write("\x1b[?25h");
        tty.write("\x1b[?1049l");
        input.setRawMode(false);
      }
    },
    write(s: string) { tty.write(s); },
    destroy() {
      this.leave();
      try { input.off("keypress", onKeypress as (...args: unknown[]) => void); } catch { /* ignore */ }
      try { tty.off("resize", onResize); } catch { /* ignore */ }
      keyListeners.clear();
      resizeListeners.clear();
      structuredListeners.clear();
    },
  };
}
