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

      // ---- Call provider ----
      let assistantMsg: ChatMessage = { role: "assistant", content: "" };
      let usage = { inputTokens: 0, outputTokens: 0 };
      const toolCalls: ToolCall[] = [];
      try {
        // Build a derived signal that also aborts after a hard timeout.
        const turnSignal = timedSignal(input.signal, input.limits.requestTimeoutMs);
        const req: ProviderRequest = {
          model: input.model,
          system: input.system,
          messages: currentMessages,
          tools: input.tools.specs(),
          maxTokens: 8_192,
          temperature: 0.2,
          signal: turnSignal.signal,
        };
        try {
          for await (const ev of input.provider.stream(req)) {
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
        } finally {
          turnSignal.dispose();
        }
      } catch (err) {
        const e = err as Error;
        if (e.name === "AbortError" || input.signal.aborted) {
          onInfo("aborted during model turn");
          break;
        }
        onError(e);
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

      // ---- Execute tools in order ----
      const toolResults: ChatMessage[] = [];
      for (const tc of toolCalls) {
        if (input.signal.aborted) break;
        const result = await executeToolSafely(tc, input.tools, {
          cwd: input.cwd,
          signal: input.signal,
          limits: input.limits,
          log: (m) => log.debug(`tool ${tc.name}: ${m}`),
        });
        hooks.onToolCallEnd?.(tc, result);
        // Cap tool result size to protect the context window.
        const capped = capToolResult(result, input.limits.maxToolResultBytes);
        toolResults.push({
          role: "tool",
          toolCallId: tc.id,
          toolName: tc.name,
          content: capped,
          meta: { isError: result.isError, display: result.display },
        });
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
