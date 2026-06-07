// Minimal line-based REPL.
// - Reads lines from stdin in cooked mode (TTY only).
// - Pipes (non-TTY) read all of stdin and treat it as a single batch
//   with `---` separators (one prompt per chunk).
// - On non-TTY stdin, we drop into `--print` mode automatically.
//
// Abort/Ctrl+C is handled at the higher level (we expose an
// `abortCurrentTurn` method on the REPL).

import { createInterface, type Interface } from "node:readline";
import { c } from "./colors.js";

export interface ReplCallbacks {
  onLine: (line: string) => Promise<void> | void;
  onClose?: () => void;
}

export interface ReplHandle {
  /** Print a line above the prompt. */
  print(s: string): void;
  /** Set the prompt text. */
  setPrompt(prompt: string): void;
  /** Abort the currently running onLine handler. */
  abortCurrentTurn(): void;
  /** True if stdin is a TTY. */
  isInteractive(): boolean;
  /** Close the REPL. */
  close(): void;
}

export function startRepl(cb: ReplCallbacks): ReplHandle {
  const isTTY = !!process.stdin.isTTY;
  let rl: Interface | null = null;
  let currentAbort: AbortController | null = null;
  let prompt = c.cyan("ch") + c.gray(" › ");
  let busy = false;
  let closed = false;

  const printRaw = (s: string) => {
    if (rl) {
      // The cursor sits at the prompt. Clear it, write, then redraw.
      rl.write(null as unknown as string);
      process.stdout.write(s + "\n");
      rl.prompt(true);
    } else {
      process.stdout.write(s + "\n");
    }
  };

  const handle = {
    print(s: string) { printRaw(s); },
    setPrompt(p: string) {
      prompt = p;
      if (rl) rl.setPrompt(prompt);
    },
    abortCurrentTurn() {
      if (currentAbort) {
        try { currentAbort.abort(); } catch {}
      }
    },
    isInteractive() { return isTTY; },
    close() {
      if (closed) return;
      closed = true;
      try { rl?.close(); } catch {}
      try { cb.onClose?.(); } catch {}
    },
  } satisfies ReplHandle;

  if (isTTY) {
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.setPrompt(prompt);
    rl.prompt();
    rl.on("line", async (raw) => {
      if (busy) {
        // Queue single-line input: replace any pending line.
        // Simple: ignore — better UX is a real queue, but for v1 this is OK.
        return;
      }
      const line = raw.trim();
      rl?.write(null as unknown as string);
      if (!line) { rl?.prompt(true); return; }
      busy = true;
      currentAbort = new AbortController();
      const onSigInt = () => { try { currentAbort?.abort(); } catch {} };
      process.once("SIGINT", onSigInt);
      try {
        await cb.onLine(line);
      } catch (e) {
        process.stderr.write(c.red("error: " + (e as Error).message) + "\n");
      } finally {
        process.removeListener("SIGINT", onSigInt);
        currentAbort = null;
        busy = false;
        if (!closed) rl?.prompt(true);
      }
    });
    rl.on("close", () => handle.close());
  } else {
    // Non-TTY: read all of stdin and call onLine once with the joined content.
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", async () => {
      const trimmed = buf.trim();
      if (trimmed.length === 0) return;
      busy = true;
      currentAbort = new AbortController();
      try {
        await cb.onLine(trimmed);
      } catch (e) {
        process.stderr.write(c.red("error: " + (e as Error).message) + "\n");
      } finally {
        currentAbort = null;
        busy = false;
        handle.close();
      }
    });
  }

  return handle;
}
