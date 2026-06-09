// SteerQueue — the in-memory FIFO the REPL uses to stash mid-run
// user input until the next turn boundary.
//
// `agnt-gg` ships a `/steer` primitive (see
// `agnt-gg/agnt/OrchestratorService.js`) that lets the user inject
// extra guidance into the model while a turn is still in flight.
// The design is "stash, then apply to last tool result" — the user's
// late typing gets prepended onto the last tool result the model
// already received, so the model sees it on the next step without
// re-doing any work.
//
// This file is the queue half of that contract. The wiring half
// lives in `src/ui/repl-v2.ts` (push on `busy`, drain at turn
// boundary) and the slash command lives in `src/slash/builtin.ts`.
//
// Invariants:
//   - ids are monotonically increasing and unique per queue instance
//   - `push` never throws (it always returns a valid entry id)
//   - `drain` returns at most the entries that were queued before the
//     call; entries pushed during a drain are left for the next drain
//   - `remove` is idempotent: removing an unknown id returns false
//     without mutating the queue
//   - `clear` is a no-op when the queue is empty
//
// The queue is single-process and in-memory. The harness does not
// persist steer text — unlike the goal store, steer text is short-
// lived, and the spec calls for it to live only for the duration of
// the current turn.

import { EventEmitter } from "node:events";
import type { ChatMessage } from "../types.js";

export interface SteerEntry {
  /** Monotonically increasing id. Stable across the lifetime of the
   *  queue. Used by the `/steer <id>` slash command to drop a
   *  specific entry. */
  id: number;
  /** The raw text the user typed. */
  text: string;
  /** ms-since-epoch when the entry was queued. */
  queuedAt: number;
}

export interface SteerQueueEvents {
  /** Fired when an entry is added. */
  push: [entry: SteerEntry];
  /** Fired when an entry is removed via `remove(id)`. */
  remove: [entry: SteerEntry];
  /** Fired when the queue is cleared (whether or not it was empty). */
  clear: [];
  /** Fired by `drain` after the drained entries are returned to the
   *  caller. The REPL listens for this to mark entries as "applied"
   *  in the footer / transcript. */
  applied: [entries: SteerEntry[]];
}

/** A typed extension of EventEmitter. We re-export a narrowed shape
 *  so callers can use `queue.on("applied", (entries) => ...)` without
 *  a cast. */
export declare interface SteerQueue {
  on<E extends keyof SteerQueueEvents>(event: E, listener: (...args: SteerQueueEvents[E]) => void): this;
  off<E extends keyof SteerQueueEvents>(event: E, listener: (...args: SteerQueueEvents[E]) => void): this;
  emit<E extends keyof SteerQueueEvents>(event: E, ...args: SteerQueueEvents[E]): boolean;
}

export class SteerQueue extends EventEmitter {
  private entries: SteerEntry[] = [];
  private nextId = 1;

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  /** Add an entry. Returns the entry (with its assigned id). */
  push(text: string): SteerEntry {
    const entry: SteerEntry = { id: this.nextId++, text, queuedAt: Date.now() };
    this.entries.push(entry);
    this.emit("push", entry);
    return entry;
  }

  /** Return the next entry without removing it. Null when empty. */
  peek(): SteerEntry | null {
    return this.entries[0] ?? null;
  }

  /** Remove and return all entries. Emits one `applied` event with
   *  the drained list (in queue order) so listeners can update the
   *  footer / transcript atomically. */
  drain(): SteerEntry[] {
    if (this.entries.length === 0) return [];
    const out = this.entries;
    this.entries = [];
    this.emit("applied", out);
    return out;
  }

  /** Remove a specific entry by id. Returns the removed entry, or
   *  null when the id was unknown. */
  remove(id: number): SteerEntry | null {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const [entry] = this.entries.splice(idx, 1);
    if (entry) this.emit("remove", entry);
    return entry ?? null;
  }

  /** Snapshot of the current queue (in queue order). */
  list(): SteerEntry[] {
    return [...this.entries];
  }

  /** Empty the queue. Emits `clear` even when the queue was empty
   *  (matches EventEmitter "always emit" semantics). */
  clear(): void {
    this.entries = [];
    this.emit("clear");
  }

  /** Current length. */
  get size(): number {
    return this.entries.length;
  }

  /** True when the queue is empty. */
  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** Apply the queued entries to the last `role: "tool"` message in
   *  `messages`. Returns `{ messages, applied }` where `messages` is
   *  a fresh array (the input is not mutated) and `applied` is the
   *  list of entries that were appended. When there is no tool
   *  message to apply to, the steer text is dropped (matches the
   *  "append to last tool result" contract: a no-op is preferable to
   *  inventing a fake tool result). */
  applyToLastToolResult(messages: ReadonlyArray<ChatMessage>): {
    messages: ChatMessage[];
    applied: SteerEntry[];
  } {
    const entries = this.drain();
    if (entries.length === 0) return { messages: [...messages], applied: [] };
    // Find the last tool message.
    let lastIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "tool") { lastIdx = i; break; }
    }
    if (lastIdx === -1) {
      // No tool message to apply to. The steer text is dropped —
      // matches the "append to last tool result" contract: when
      // there's no last tool result, the steer is a no-op.
      return { messages: [...messages], applied: [] };
    }
    const suffix = entries.map((e) => e.text).join("\n\n");
    const target = messages[lastIdx]!;
    const existing = target.content ?? "";
    const next: ChatMessage[] = [...messages];
    next[lastIdx] = { ...target, content: existing + (existing ? "\n\n" : "") + suffix };
    return { messages: next, applied: entries };
  }
}
