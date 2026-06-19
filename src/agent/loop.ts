// The core agent loop.
//
// This is the file that determines whether the harness crashes or
// survives. Every async path here is wrapped, every stream consumer
// has bounds, and every tool call is funneled through a registry
// that catches errors and reports them to the model.

import type {
  ChatMessage,
  Provider,
  ProviderRequest,
  ToolCall,
  ToolResult,
} from "../types.js";
import { ToolRegistry, type ToolContext } from "./tools/registry.js";
import { log } from "../util/logger.js";
import { ToolError } from "../util/errors.js";
import { ExtensionRegistry } from "./extensions/registry.js";
import { compact as compactMessages, roughTokenCount } from "./compaction.js";

export interface AgentRunHooks {
  onTextDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  onToolCallStart?: (tc: ToolCall) => void;
  onToolCallEnd?: (tc: ToolCall, result: ToolResult) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  onInfo?: (msg: string) => void;
  onError?: (err: Error) => void;
}

export interface AgentRunInput {
  provider: Provider;
  model: string;
  system?: string;
  /** Conversation history. The last message should be the new user turn. */
  messages: ChatMessage[];
  tools: ToolRegistry;
  cwd: string;
  signal: AbortSignal;
  limits: { bashTimeoutMs: number; readMaxBytes: number; maxToolResultBytes: number; maxSteps: number; requestTimeoutMs: number };
  hooks?: AgentRunHooks;
  /** When the loop finishes (success or abort), this receives the final assistant message. */
  onComplete?: (final: ChatMessage) => void;
  /**
   * Optional failover chain. If the primary provider throws, the loop
   * tries the next entry. Each entry is `{ provider, model }` — the
   * same provider instance can appear with a different model.
   */
  failoverChain?: Array<{ provider: Provider; model: string }>;
  /**
   * Optional extension hook registry. When present, the loop fires
   * the 4 extension hook points (preSystemPrompt, postToolResult,
   * onError, onCompaction) at the natural seams. Handler errors
   * are isolated by the registry — the loop never crashes because
   * of a misbehaving extension. Phase 4 T2. */
  extensionRegistry?: ExtensionRegistry;
}

export interface AgentRunResult {
  /** The final assistant message (may be empty on early abort). */
  final: ChatMessage;
  /** Total token usage across the run. */
  usage: { inputTokens: number; outputTokens: number };
  /** Number of LLM round-trips. */
  steps: number;
}

/** Run a single user turn. The agent may call zero or more tools. */
export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const hooks = input.hooks ?? {};
  const onInfo = hooks.onInfo ?? (() => {});
  const onError = hooks.onError ?? ((e) => log.error("agent error", e));
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  let steps = 0;
  let currentMessages = input.messages;
  // The last assistant message produced.
  let final: ChatMessage = { role: "assistant", content: "" };

  // Top-level try/catch: any uncaught error here is reported to the
  // caller via onError and a final message. The harness must never crash.
  try {
    while (steps < input.limits.maxSteps) {
      if (input.signal.aborted) {
        onInfo("aborted");
        break;
      }
      steps += 1;

      // ---- Pre-system-prompt hook (Phase 4 T2) ----
      // Extensions may transform the system prompt before the
      // provider is called. The latest non-undefined return wins.
      // The hook is a no-op when no registry is wired.
      let effectiveSystem = input.system;
      if (input.extensionRegistry && !input.extensionRegistry.isEmpty) {
        const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
        const transformed = await input.extensionRegistry.dispatch("preSystemPrompt", {
          system: effectiveSystem ?? "",
          userTurn: lastUser?.content ?? "",
          messageCount: currentMessages.length,
        });
        if (typeof transformed === "string") effectiveSystem = transformed;
      }

      // ---- Call provider (with optional failover chain) ----
      let assistantMsg: ChatMessage = { role: "assistant", content: "" };
      let usage = { inputTokens: 0, outputTokens: 0 };
      const toolCalls: ToolCall[] = [];
      // Build the attempt chain. The primary is always first; the
      // chain may add fallbacks. Empty array = just the primary.
      const chain: Array<{ provider: Provider; model: string }> = [
        { provider: input.provider, model: input.model },
        ...(input.failoverChain ?? []),
      ];
      let streamedSuccessfully = false;
      try {
        outer: for (let attempt = 0; attempt < chain.length; attempt++) {
          const { provider, model } = chain[attempt]!;
          if (attempt > 0) {
            onInfo(`failing over to ${provider.id}/${model} (attempt ${attempt + 1}/${chain.length})`);
          }
          // Build a derived signal that also aborts after a hard timeout.
          const turnSignal = timedSignal(input.signal, input.limits.requestTimeoutMs);
          const req: ProviderRequest = {
            model,
            system: effectiveSystem,
            messages: currentMessages,
            tools: input.tools.specs(),
            maxTokens: 8_192,
            temperature: 0.2,
            signal: turnSignal.signal,
          };
          try {
            for await (const ev of provider.stream(req)) {
              switch (ev.type) {
                case "text":
                  if (ev.text) {
                    assistantMsg.content += ev.text;
                    hooks.onTextDelta?.(ev.text);
                  }
                  break;
                case "reasoning":
                  if (ev.reasoning) {
                    assistantMsg.reasoning = (assistantMsg.reasoning ?? "") + ev.reasoning;
                    hooks.onReasoningDelta?.(ev.reasoning);
                  }
                  break;
                case "tool_call":
                  if (ev.toolCall) {
                    toolCalls.push(ev.toolCall);
                    hooks.onToolCallStart?.(ev.toolCall);
                  }
                  break;
                case "usage":
                  if (ev.usage) usage = ev.usage;
                  break;
                case "error":
                  throw new Error(ev.error?.message ?? "provider error");
                case "done":
                  break;
              }
            }
            streamedSuccessfully = true;
            break outer;
          } catch (streamErr) {
            const e = streamErr as Error;
            // User-initiated abort: do not failover, exit immediately.
            if (e.name === "AbortError" || input.signal.aborted) {
              onInfo("aborted during model turn");
              break outer;
            }
            // Otherwise, on the last attempt we re-throw; on earlier
            // attempts we let the outer loop try the next provider.
            if (attempt === chain.length - 1) throw e;
            hooks.onInfo?.(`primary ${provider.id}/${model} failed: ${e.message} — trying next in chain`);
          } finally {
            // Always release the timeout timer + parent-signal
            // listener, even on the success / user-abort paths.
            // Pre-fix: the success path (`break outer` from the
            // `for await` completing normally) leaked the timer
            // because there was no finally, so the
            // `setTimeout(..., requestTimeoutMs)` kept the event
            // loop alive for up to `requestTimeoutMs` after every
            // successful provider turn.
            turnSignal.dispose();
          }
        }
      } catch (err) {
        const e = err as Error;
        if (e.name === "AbortError" || input.signal.aborted) {
          onInfo("aborted during model turn");
          break;
        }
        onError(e);
        // onError hook (Phase 4 T2) — fire-and-forget for extensions
        // that want to track provider-side failures (e.g. log
        // upstream rate-limits, increment a metric, send a
        // Sentry event). Errors inside the hook are isolated by
        // the registry; this catch is for the dispatch plumbing
        // itself, which would be a bug.
        if (input.extensionRegistry && !input.extensionRegistry.isEmpty) {
          try {
            await input.extensionRegistry.dispatch("onError", {
              error: e,
              context: "provider",
              step: steps,
            });
          } catch (hookErr) {
            log.error("onError dispatch failed", hookErr);
          }
        }
        // Surface a clear message to the model so it can adjust.
        assistantMsg = {
          role: "assistant",
          content: `Provider error: ${e.message}. I should tell the user and stop.`,
          meta: { providerError: true },
        };
      }
      if (toolCalls.length > 0) assistantMsg.toolCalls = toolCalls;
      totalUsage.inputTokens += usage.inputTokens;
      totalUsage.outputTokens += usage.outputTokens;
      hooks.onUsage?.(usage);

      // Persist the assistant message in the local transcript.
      currentMessages = [...currentMessages, assistantMsg];
      final = assistantMsg;

      // If no tool calls, we're done with this turn.
      if (toolCalls.length === 0) break;

      // ---- Execute tools ----
      // If every call in this step is to a "parallel-safe" tool (read-only,
      // no shared state, no order-dependence), run them concurrently. Any
      // step containing a mutating tool (write/edit/bash/etc.) runs
      // sequentially to preserve ordering. This is a conservative
      // heuristic — the model can always choose to put mutating calls
      // in a separate step if it needs parallelism on reads.
      const allSafe = toolCalls.every((tc) => PARALLEL_SAFE_TOOLS.has(tc.name));
      const toolResults: ChatMessage[] = [];
      if (allSafe && toolCalls.length > 1) {
        const settled = await Promise.all(
          toolCalls.map((tc) =>
            executeToolSafely(tc, input.tools, {
              cwd: input.cwd,
              signal: input.signal,
              limits: input.limits,
              log: (m) => log.debug(`tool ${tc.name}: ${m}`),
            })
          )
        );
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i]!;
          const r = settled[i]!;
          hooks.onToolCallEnd?.(tc, r);
          // postToolResult hook (Phase 4 T2) — side-effect only.
          if (input.extensionRegistry && !input.extensionRegistry.isEmpty) {
            await input.extensionRegistry.dispatch("postToolResult", {
              tool: tc,
              result: r,
              isError: r.isError === true,
              step: steps,
            });
          }
          toolResults.push(toResultMessage(tc, r, input.limits.maxToolResultBytes));
        }
      } else {
        for (const tc of toolCalls) {
          if (input.signal.aborted) break;
          const result = await executeToolSafely(tc, input.tools, {
            cwd: input.cwd,
            signal: input.signal,
            limits: input.limits,
            log: (m) => log.debug(`tool ${tc.name}: ${m}`),
          });
          hooks.onToolCallEnd?.(tc, result);
          // postToolResult hook (Phase 4 T2) — side-effect only.
          // Errors during a single hook dispatch are swallowed
          // by the registry; we only catch errors that escape the
          // dispatch wrapper (e.g. from the dispatch plumbing
          // itself). Hook-handler errors are the registry's
          // responsibility, not the loop's.
          if (input.extensionRegistry && !input.extensionRegistry.isEmpty) {
            try {
              await input.extensionRegistry.dispatch("postToolResult", {
                tool: tc,
                result,
                isError: result.isError === true,
                step: steps,
              });
            } catch (e) {
              // Belt-and-braces: the registry should swallow
              // handler errors, but a thrown error from the
              // dispatch plumbing itself is a bug we want to
              // log without breaking the agent loop.
              log.error("postToolResult dispatch failed", e);
            }
          }
          toolResults.push(toResultMessage(tc, result, input.limits.maxToolResultBytes));
        }
      }
      currentMessages = [...currentMessages, ...toolResults];

      // If every tool returned an error, stop — the model should not loop
      // forever on broken tools. Surface the last error to the user.
      if (toolResults.every((m) => m.meta?.isError === true)) {
        onInfo("all tools errored; ending turn");
        break;
      }
    }
    if (steps >= input.limits.maxSteps) {
      onInfo(`max steps (${input.limits.maxSteps}) reached`);
    }
  } catch (err) {
    onError(err as Error);
    // onError hook for the outer try/catch — same contract as the
    // provider path: extensions observe the failure, the loop
    // continues to a clean final message.
    if (input.extensionRegistry && !input.extensionRegistry.isEmpty) {
      try {
        await input.extensionRegistry.dispatch("onError", {
          error: err as Error,
          context: "internal",
        });
      } catch (hookErr) {
        log.error("onError dispatch failed (outer catch)", hookErr);
      }
    }
    final = { role: "assistant", content: `internal error: ${(err as Error).message}` };
  }

  const r: AgentRunResult = { final, usage: totalUsage, steps };
  try { input.onComplete?.(final); } catch { /* ignore */ }
  return r;
}

// ---------- Helpers ----------

/** Return a derived AbortSignal that aborts when `parent` aborts or
 *  after `ms` milliseconds — whichever comes first. The caller must
 *  call `dispose()` to release the timer. */
function timedSignal(parent: AbortSignal, ms: number): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | null = setTimeout(() => ctrl.abort(new Error(`timeout after ${ms}ms`)), ms);
  const onAbort = () => ctrl.abort(parent.reason);
  if (parent.aborted) onAbort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ctrl.signal,
    dispose: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      parent.removeEventListener("abort", onAbort);
    },
  };
}

async function executeToolSafely(
  tc: ToolCall,
  registry: ToolRegistry,
  ctx: ToolContext
): Promise<ToolResult> {
  const tool = registry.get(tc.name);
  if (!tool) {
    return {
      toolCallId: tc.id,
      display: `unknown tool: ${tc.name}`,
      content: `unknown tool: ${tc.name}. Available tools: ${registry.list().map((t) => t.spec.name).join(", ")}`,
      isError: true,
    };
  }
  // Validate
  let args: Record<string, unknown>;
  try {
    args = tool.validate(JSON.parse(tc.argsJson || "{}"));
  } catch (e) {
    if (e instanceof ToolError) {
      return { toolCallId: tc.id, display: `${tc.name}: ${e.message}`, content: `${tc.name} validation failed: ${e.message}`, isError: true };
    }
    return { toolCallId: tc.id, display: `${tc.name} validation crashed`, content: `${tc.name} validation crashed: ${(e as Error).message}`, isError: true };
  }
  // Execute with a try/catch — even if the tool is buggy, the loop survives.
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    const err = e as Error;
    return {
      toolCallId: tc.id,
      display: `${tc.name} crashed: ${err.message}`,
      content: `${tc.name} crashed: ${err.message}\n${err.stack ?? ""}`,
      isError: true,
    };
  }
}

function capToolResult(result: ToolResult, maxBytes: number): string {
  if (!result.content) return result.content;
  if (result.content.length <= maxBytes) return result.content;
  const head = result.content.slice(0, maxBytes);
  return head + `\n\n... (truncated; original was ${result.content.length} bytes)`;
}

/** Default limits. Centralized so the CLI and tests can override. */
export const DEFAULT_LIMITS = {
  bashTimeoutMs: 30_000,
  readMaxBytes: 200_000,
  maxToolResultBytes: 200_000,
  maxSteps: 32,
  requestTimeoutMs: 120_000,
};

/** Tools that are safe to run concurrently with each other. They are
 *  read-only, side-effect-free, and do not depend on each other's
 *  output. A step containing ANY tool NOT in this set runs
 *  sequentially. */
const PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "http",
  "list_skills",
  "read_memory",
  "search_memory",
  "read_todo",
]);

function toResultMessage(tc: ToolCall, result: ToolResult, maxBytes: number): ChatMessage {
  const capped = capToolResult(result, maxBytes);
  return {
    role: "tool",
    toolCallId: tc.id,
    toolName: tc.name,
    content: capped,
    meta: { isError: result.isError, display: result.display },
  };
}

// ---------- Compaction hook (Phase 4 T2 — onCompaction) ----------
//
// The 4th hook point in the Phase 4 T2 spec. The agent loop does
// not auto-compact (compaction is a runtime/CLI-level concern),
// so we expose a `runCompactionWithHooks` helper that callers
// (the runtime's `compact()`, the CLI's `/compact`, etc.) use
// instead of `compaction.compact` directly. The helper fires
// the `onCompaction` hook around the compaction step with both
// `phase: "pre"` and `phase: "post"` payloads.
//
// This keeps the contract clean:
//   - `runAgent` fires preSystemPrompt / postToolResult / onError
//     inline (the 3 hooks the loop owns naturally).
//   - `runCompactionWithHooks` fires onCompaction around the
//     compaction call (the 1 hook tied to a runtime-level event).
// Callers that don't care about hooks can still call
// `compaction.compact` directly — the hook is opt-in.

export interface CompactionWithHooksOptions {
  cutoff?: number;
  maxSummaryTokens?: number;
  signal?: AbortSignal;
  /** When present, the `onCompaction` hook is fired with the
   *  payload before (phase: "pre") and after (phase: "post")
   *  the compaction. Handler errors are isolated. */
  extensionRegistry?: ExtensionRegistry;
}

/** Same shape as `CompactionResult` from `compaction.ts` —
 *  re-exported here so callers can import the typed return
 *  value alongside the helper. */
export type CompactionWithHooksResult = import("./compaction.js").CompactionResult;

/** Run a compaction step and fire the `onCompaction` extension
 *  hook around it. The hook sees a `pre` payload (the messages
 *  about to be summarized) and a `post` payload (the summary
 *  that was produced). */
export async function runCompactionWithHooks(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  opts: CompactionWithHooksOptions = {},
): Promise<CompactionWithHooksResult> {
  const signal = opts.signal ?? new AbortController().signal;
  const reg = opts.extensionRegistry;
  // pre-hook (fire-and-forget; we don't let handlers abort the
  // compaction, but errors are still isolated).
  if (reg && !reg.isEmpty) {
    try {
      await reg.dispatch("onCompaction", {
        phase: "pre",
        messageCount: messages.length,
        tokens: roughTokenCount(messages),
        messages,
      });
    } catch (e) {
      log.error("onCompaction pre-hook dispatch failed", e);
    }
  }
  const result = await compactMessages(provider, model, messages, {
    cutoff: opts.cutoff,
    maxSummaryTokens: opts.maxSummaryTokens,
    signal,
  });
  if (reg && !reg.isEmpty) {
    try {
      await reg.dispatch("onCompaction", {
        phase: "post",
        messageCount: result.keepFromIndex,
        tokens: roughTokenCount(messages.slice(0, result.keepFromIndex)),
        messages: messages.slice(0, result.keepFromIndex),
        summary: result.summary,
      });
    } catch (e) {
      log.error("onCompaction post-hook dispatch failed", e);
    }
  }
  return result;
}

// ---------- Re-exports (Phase 1 — p1-unify wireup) ----------
//
// `src/agent/loop.ts` is the canonical home of `runAgent`. The new
// `Loop<"agent">` shape (the AgentLoop factory) is implemented in
// `loops/agent.ts` and re-exported here so callers and tests can
// `import { agentLoop, type AgentLoop, type AgentLoopInput,
// type AgentLoopOutput } from "./loop.js"` without reaching into
// the `loops/` subdir. The AgentLoop wraps `runAgent` from this
// file; this re-export is the spec-mandated surface from
// `plans/plan_phase1/notes/agnt-port-plan.md` §3.

export {
  agentLoop,
  type AgentLoop,
  type AgentLoopInput,
  type AgentLoopOutput,
} from "./loops/agent.js";
