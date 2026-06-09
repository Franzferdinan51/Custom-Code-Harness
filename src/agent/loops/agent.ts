// AgentLoop — wraps `runAgent` from `src/agent/loop.ts` as a Loop<"agent">.
//
// Tier 3 in the loop hierarchy. The body of the loop (multi-step LLM
// turn with tool dispatch) is unchanged; this file just gives it the
// `Loop<Kind>` shape so it composes with the rest of the hierarchy.
//
// AgentLoop is the workhorse — every sub-agent spawn (the `agent` kind
// in the delegation union, the spawn_subagent tool, the council
// councilor) ultimately runs through this. The input mirrors the
// fields of `AgentRunInput` from `loop.ts` so callers can pass them
// through unchanged.

import type { Loop, LoopContext } from "./loop.js";
import type { AgentRunHooks, AgentRunResult, AgentRunInput } from "../loop.js";
import { runAgent, DEFAULT_LIMITS } from "../loop.js";
import type { Provider, ChatMessage } from "../../types.js";
import type { ToolRegistry } from "../tools/registry.js";

/** Input to an AgentLoop run. Mirrors the fields of `AgentRunInput`
 *  from `src/agent/loop.ts` so a Loop<"agent"> is a thin wrapper. */
export interface AgentLoopInput {
  provider: Provider;
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools: ToolRegistry;
  cwd: string;
  signal: AbortSignal;
  /** Optional limits. Defaults to `DEFAULT_LIMITS` from loop.ts. */
  limits?: AgentRunInput["limits"];
  /** Optional hooks. Translated to the loop's hooks. */
  hooks?: AgentRunHooks;
  /** Optional failover chain. */
  failoverChain?: AgentRunInput["failoverChain"];
}

export interface AgentLoopOutput {
  /** The result of the agent run — same shape as `runAgent()` returns. */
  result: AgentRunResult;
  /** The final assistant message text (for convenience). */
  finalText: string;
  /** True when the run terminated cleanly (not aborted, not error). */
  ok: boolean;
}

/** A Loop<"agent"> backed by the existing `runAgent()`. */
export interface AgentLoop extends Loop<"agent", AgentLoopInput, AgentLoopOutput> {}

/** Build an AgentLoop. The closure captures no state — the same
 *  AgentLoop can run many times against different inputs. */
export function agentLoop(): AgentLoop {
  return {
    kind: "agent",
    description: "single LLM turn with tool dispatch (wraps runAgent)",
    async run(input: AgentLoopInput, _ctx: LoopContext): Promise<AgentLoopOutput> {
      const limits = input.limits ?? { ...DEFAULT_LIMITS };
      // Bridge the loop's hooks into the agent's hooks, so callers
      // can use a uniform hooks surface.
      const agentHooks: AgentRunHooks = {
        ...(input.hooks ?? {}),
        onInfo: (msg) => { input.hooks?.onInfo?.(msg); _ctx.hooks?.onInfo?.(msg); },
        onError: (err) => { input.hooks?.onError?.(err); _ctx.hooks?.onError?.(err); },
        onTextDelta: (t) => { input.hooks?.onTextDelta?.(t); _ctx.hooks?.onTextDelta?.(t); },
        onToolCallStart: (tc) => { input.hooks?.onToolCallStart?.(tc); _ctx.hooks?.onToolCallStart?.(tc.name); },
        onToolCallEnd: (tc, r) => { input.hooks?.onToolCallEnd?.(tc, r); _ctx.hooks?.onToolCallEnd?.(tc.name, !!r.isError); },
      };
      const result = await runAgent({
        provider: input.provider,
        model: input.model,
        ...(input.system !== undefined ? { system: input.system } : {}),
        messages: input.messages,
        tools: input.tools,
        cwd: input.cwd,
        signal: input.signal,
        limits,
        hooks: agentHooks,
        ...(input.failoverChain ? { failoverChain: input.failoverChain } : {}),
      });
      return {
        result,
        finalText: result.final.content,
        ok: !input.signal.aborted && result.steps > 0,
      };
    },
  };
}
