// ToolLoop — wraps a single tool execution against the ToolRegistry.
//
// Tier 5 in the loop hierarchy. The agent loop (Tier 3) ultimately
// dispatches here for every tool call. A ToolLoop is a thin adapter
// over `ToolRegistry.get(name).run(args, ctx)` — it adds the Loop<Kind>
// shape so it composes with the rest of the hierarchy.
//
// Use cases:
//   - One-shot execution: ToolLoop{ name: "read" }.run({path: "..."}, ctx)
//   - Tool allowlist probing: ToolLoop.canHandle(registry, "read") === true
//   - Tool spec introspection: ToolLoop.spec(registry, "read")
//
// Example:
//   const loop = toolLoopFromRegistry(registry, "read");
//   const r = await loop.run({ path: "AGENTS.md" }, { cwd, signal, hooks });

import type { Loop, LoopContext } from "./loop.js";
import { ToolRegistry, type Tool, type ToolContext } from "../tools/registry.js";
import type { ToolResult } from "../../types.js";

export interface ToolInput {
  /** Validated args for the tool. The tool's own `validate()` is the
   *  source of truth — callers should pass the result of validate(),
   *  not raw model output. */
  args: Record<string, unknown>;
}

export interface ToolOutput {
  result: ToolResult;
  /** The tool that ran (for inspection). */
  tool: string;
  /** True if the registry found and dispatched the tool. */
  dispatched: boolean;
}

/** A Loop<"tool"> backed by a specific tool in a registry. */
export interface ToolLoop extends Loop<"tool", ToolInput, ToolOutput> {}

/** Build a ToolLoop for a named tool. The tool must already be
 *  registered in the registry. */
export function toolLoopFromRegistry(registry: ToolRegistry, toolName: string): ToolLoop {
  return {
    kind: "tool",
    description: "single tool execution against " + toolName,
    async run(input: ToolInput, ctx: LoopContext): Promise<ToolOutput> {
      const tool = registry.get(toolName);
      if (!tool) {
        return {
          tool: toolName,
          dispatched: false,
          result: {
            toolCallId: "",
            display: "unknown tool: " + toolName,
            content: "unknown tool: " + toolName + ". Available: " + registry.list().map((t) => t.spec.name).join(", "),
            isError: true,
          },
        };
      }
      let args = input.args;
      try {
        // Run validate() to give the tool a chance to normalize.
        // Tools that don't validate (validate() is identity) still work.
        args = tool.validate(input.args);
      } catch (e) {
        return {
          tool: toolName,
          dispatched: true,
          result: {
            toolCallId: "",
            display: toolName + " validation failed",
            content: toolName + " validation failed: " + (e as Error).message,
            isError: true,
          },
        };
      }
      const toolCtx: ToolContext = {
        cwd: ctx.cwd,
        signal: ctx.signal,
        limits: { bashTimeoutMs: 30_000, readMaxBytes: 200_000, maxToolResultBytes: 200_000, requestTimeoutMs: 120_000 },
        log: (m) => ctx.hooks?.onInfo?.(m),
      };
      try {
        const result = await tool.run(args, toolCtx);
        ctx.hooks?.onToolCallEnd?.(toolName, result.isError);
        return { tool: toolName, dispatched: true, result };
      } catch (e) {
        const err = e as Error;
        const r: ToolResult = {
          toolCallId: "",
          display: toolName + " crashed: " + err.message,
          content: toolName + " crashed: " + err.message,
          isError: true,
        };
        ctx.hooks?.onToolCallEnd?.(toolName, true);
        return { tool: toolName, dispatched: true, result: r };
      }
    },
  };
}

/** Lightweight helper: can this registry dispatch `toolName`? */
export function canHandle(registry: ToolRegistry, toolName: string): boolean {
  return registry.get(toolName) !== undefined;
}

/** Read-only: get the spec for a tool. Returns null if not registered. */
export function specFor(registry: ToolRegistry, toolName: string): Tool | null {
  return registry.get(toolName) ?? null;
}
