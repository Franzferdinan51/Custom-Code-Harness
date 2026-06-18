// Extension hook registry. Mirrors the `McpRegistry` narrow
// interface (`src/agent/delegation.ts:375`) but for hook handlers.
//
// The contract:
//   - `register(name, hook, handler)` — bind a handler. The name is
//     the extension's identifier (for error logs + introspection).
//   - `dispatch(hook, payload)` — fire every handler registered for
//     this hook, in registration order, with error isolation: one
//     handler throwing MUST NOT prevent the next from running, and
//     MUST NOT propagate out of dispatch (so the agent loop
//     survives a misbehaving extension).
//   - `list()` / `listFor(hook)` — introspection (tests + future
//     `/ext list` slash command).
//   - `clear()` — wipe everything (reload on config change).
//
// `dispatch` is async even when handlers are sync, so we can run
// them in sequence and await each try/catch. The return value is
// the LAST non-undefined return from any handler — useful for
// `preSystemPrompt` which mutates the system prompt; the other
// hooks return void and the value is ignored.
//
// Handlers are stored as a tuple of (name, handler) so error logs
// can attribute the failure to the source extension.

import { log as defaultLog } from "../../util/logger.js";
import type { ChatMessage, ToolResult, ToolCall } from "../../types.js";

/** The 4 hook points the agent loop fires. Add new ones by
 *  appending to this union AND registering a payload type
 *  below — the loop and tests both narrow on it. */
export type ExtensionHookName =
  | "preSystemPrompt"
  | "postToolResult"
  | "onError"
  | "onCompaction";

/** Payload for `preSystemPrompt`. The handler MAY return a new
 *  system prompt string, or `undefined` to leave it unchanged.
 *  The first handler to return a non-undefined string wins
 *  (last-wins in registration order). */
export interface PreSystemPromptPayload {
  system: string;
  /** The user turn that triggered this run. */
  userTurn: string;
  /** Total messages currently in the transcript. */
  messageCount: number;
}

/** Payload for `postToolResult`. The handler is for side effects
 *  (logging, metrics) — the return value is ignored. */
export interface PostToolResultPayload {
  tool: ToolCall;
  result: ToolResult;
  /** True if the tool returned an error. */
  isError: boolean;
  /** Step index (1-based) within the current run. */
  step: number;
}

/** Payload for `onError`. Side-effect only. */
export interface OnErrorPayload {
  error: Error;
  /** Where the error came from — "provider" / "tool" / "compaction" / "internal". */
  context: "provider" | "tool" | "compaction" | "internal";
  /** Optional step index, for tool errors. */
  step?: number;
}

/** Payload for `onCompaction`. The handler may observe the
 *  before/after token counts; the `phase` field tells the handler
 *  whether compaction is about to start or has finished. */
export interface OnCompactionPayload {
  phase: "pre" | "post";
  /** Number of messages going into (pre) or coming out of (post) compaction. */
  messageCount: number;
  /** Rough token count for those messages. */
  tokens: number;
  /** Present on `phase: "post"`: the summary the engine produced. */
  summary?: string;
  /** The messages the engine is about to compact (pre) or just compacted (post). */
  messages: ChatMessage[];
}

/** Generic handler shape: takes a payload, returns either void
 *  (side-effect only) or the appropriate typed result. */
export type ExtensionHandler<P, R> = (payload: P) => R | Promise<R>;

/** Internal storage shape. We keep a parallel array (not a Map of
 *  arrays) so the registration order is deterministic and
 *  `dispatch` walks handlers in insertion order. */
interface HandlerEntry {
  extension: string;
  hook: ExtensionHookName;
  handler: ExtensionHandler<unknown, unknown>;
}

/** Narrow introspection record — what `list()` returns. The
 *  handler function itself is omitted; we only expose the
 *  metadata. */
export interface ExtensionInfo {
  name: string;
  hooks: ExtensionHookName[];
}

/** The 4 hook payloads mapped to handler return types. Used by
 *  the dispatcher to type-check the per-hook call sites. */
export interface DispatchResult {
  preSystemPrompt: string | undefined;
  postToolResult: void;
  onError: void;
  onCompaction: void;
}

export class ExtensionRegistry {
  /** All registered handlers, in insertion order. */
  private handlers: HandlerEntry[] = [];
  /** Per-extension dispose callbacks. Cleared on
   *  `removeExtension`. */
  private disposers = new Map<string, Array<() => void>>();
  /** Names that have been registered at least once. */
  private extensionNames = new Set<string>();
  /** Optional logger override (tests pass a stub). Defaults to the
   *  shared `log` from `util/logger.ts`. */
  private readonly logger: { error: (msg: string, extra?: unknown) => void; warn: (msg: string, extra?: unknown) => void };

  constructor(opts: { logger?: { error: (msg: string, extra?: unknown) => void; warn: (msg: string, extra?: unknown) => void } } = {}) {
    this.logger = opts.logger ?? { error: defaultLog.error, warn: defaultLog.warn };
  }

  /** Register a handler. The `name` is used for error attribution
   *  and for `removeExtension`. Returns true if added, false if
   *  an identical (name, hook, handler) tuple was already
   *  registered. */
  register<P, R>(
    name: string,
    hook: ExtensionHookName,
    handler: ExtensionHandler<P, R>,
  ): boolean {
    if (!name || typeof name !== "string") {
      throw new Error("ExtensionRegistry.register: name is required");
    }
    if (!isHookName(hook)) {
      throw new Error(`ExtensionRegistry.register: unknown hook "${hook}"`);
    }
    if (typeof handler !== "function") {
      throw new Error("ExtensionRegistry.register: handler must be a function");
    }
    // De-dup: same (name, hook, handler-fn) is a no-op.
    for (const h of this.handlers) {
      if (h.extension === name && h.hook === hook && h.handler === handler) {
        return false;
      }
    }
    this.handlers.push({ extension: name, hook, handler: handler as ExtensionHandler<unknown, unknown> });
    this.extensionNames.add(name);
    return true;
  }

  /** Unregister everything tied to a given extension. Idempotent.
   *  Returns the number of handlers removed. */
  removeExtension(name: string): number {
    const before = this.handlers.length;
    this.handlers = this.handlers.filter((h) => h.extension !== name);
    const disposers = this.disposers.get(name);
    if (disposers) {
      for (const d of disposers) {
        try { d(); } catch { /* swallow — disposers are best-effort */ }
      }
      this.disposers.delete(name);
    }
    // Recompute the name set; an extension's last handler may have
    // been just removed.
    let any = false;
    for (const h of this.handlers) { if (h.extension === name) { any = true; break; } }
    if (!any) this.extensionNames.delete(name);
    return before - this.handlers.length;
  }

  /** Internal — the loader uses this to register a per-extension
   *  dispose callback. */
  addDisposer(name: string, dispose: () => void): void {
    let arr = this.disposers.get(name);
    if (!arr) { arr = []; this.disposers.set(name, arr); }
    arr.push(dispose);
  }

  /** Fire every handler for a hook, in registration order, with
   *  error isolation. For `preSystemPrompt` the return value is
   *  the LAST non-undefined return from any handler (so
   *  extensions can chain transformations). For the other
   *  hooks the return is `void` — handler returns are ignored. */
  async dispatch<H extends ExtensionHookName>(
    hook: H,
    payload: H extends "preSystemPrompt" ? PreSystemPromptPayload :
             H extends "postToolResult" ? PostToolResultPayload :
             H extends "onError" ? OnErrorPayload :
             OnCompactionPayload,
  ): Promise<DispatchResult[H]> {
    if (!isHookName(hook)) {
      throw new Error(`ExtensionRegistry.dispatch: unknown hook "${hook}"`);
    }
    // Snapshot the handlers list — extensions might add/remove
    // during dispatch (re-entrancy safe).
    const snapshot = this.handlers.filter((h) => h.hook === hook).slice();
    if (hook === "preSystemPrompt") {
      // Chain transformations: each handler sees the CURRENT
      // system (initially the input; updated if a previous
      // handler returned a string). If no handler transforms,
      // the dispatch still returns a string — the input system
      // is echoed back. The agent loop (loop.ts) handles the
      // string as the candidate replacement for `input.system`.
      // The `typeof === "string"` guard in the loop is a no-op
      // for our return but is preserved so the loop doesn't
      // crash if a future hook adds a non-string return.
      let current: string = (payload as PreSystemPromptPayload).system;
      for (const entry of snapshot) {
        try {
          const r = await (entry.handler as ExtensionHandler<PreSystemPromptPayload, string | undefined>)({ ...(payload as PreSystemPromptPayload), system: current });
          if (typeof r === "string") current = r;
        } catch (e) {
          this.logger.error(`extension "${entry.extension}" hook "${hook}" threw`, { error: (e as Error).message });
          // continue with previous value
        }
      }
      return current as DispatchResult[H];
    }
    // Side-effect hooks: call all handlers, swallow errors.
    for (const entry of snapshot) {
      try {
        await (entry.handler as ExtensionHandler<unknown, void>)(payload);
      } catch (e) {
        this.logger.error(`extension "${entry.extension}" hook "${hook}" threw`, { error: (e as Error).message });
      }
    }
    return undefined as DispatchResult[H];
  }

  /** List every registered extension and the hooks it has bound.
   *  Stable order: first-registration wins. */
  list(): ExtensionInfo[] {
    const out: ExtensionInfo[] = [];
    const seen = new Set<string>();
    for (const h of this.handlers) {
      if (seen.has(h.extension)) continue;
      seen.add(h.extension);
      out.push({ name: h.extension, hooks: this.hooksFor(h.extension) });
    }
    return out;
  }

  /** List every handler bound to a specific hook. */
  listFor(hook: ExtensionHookName): Array<{ name: string; handler: ExtensionHandler<unknown, unknown> }> {
    return this.handlers
      .filter((h) => h.hook === hook)
      .map((h) => ({ name: h.extension, handler: h.handler }));
  }

  /** Wipe everything. Used by reload / shutdown. */
  clear(): void {
    // Run per-extension disposers first, in the order they were added.
    for (const [name, disposers] of this.disposers) {
      for (const d of disposers) {
        try { d(); } catch { /* best-effort */ }
      }
      this.disposers.set(name, []);
    }
    this.handlers = [];
    this.extensionNames.clear();
  }

  /** Number of registered handlers (not extensions). */
  get size(): number {
    return this.handlers.length;
  }

  /** True if no handlers are registered. */
  get isEmpty(): boolean {
    return this.handlers.length === 0;
  }

  private hooksFor(name: string): ExtensionHookName[] {
    const out: ExtensionHookName[] = [];
    for (const h of this.handlers) {
      if (h.extension === name && !out.includes(h.hook)) out.push(h.hook);
    }
    return out;
  }
}

/** Type guard — narrows a string to `ExtensionHookName`. Used by
 *  the loader (which receives a string from the manifest) and by
 *  the dispatch entrypoint (which is called from outside the
 *  class). */
export function isHookName(s: string): s is ExtensionHookName {
  return s === "preSystemPrompt" || s === "postToolResult" || s === "onError" || s === "onCompaction";
}
