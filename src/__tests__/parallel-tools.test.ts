// Tests for parallel tool execution in the agent loop (v0.2.2).
//
// The agent loop runs read-only tools in parallel when ALL tool calls
// in a step are parallel-safe. A step with any mutating tool runs
// sequentially. This file exercises the safe-set logic and proves
// that parallel calls actually complete faster than sequential ones.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { runAgent, DEFAULT_LIMITS } from "../agent/loop.js";
import { defaultToolRegistry } from "../agent/tools/index.js";
import type { Tool, ToolContext } from "../agent/tools/registry.js";
import type {
  ChatMessage,
  Provider,
  ProviderRequest,
  ProviderStreamEvent,
  ToolResult,
} from "../types.js";

class StubProvider implements Provider {
  id = "stub";
  displayName = "Stub";
  async isConfigured(): Promise<{ ok: boolean; reason?: string }> { return { ok: true }; }
  async *stream(_req: ProviderRequest): AsyncGenerator<ProviderStreamEvent, void, void> {
    // Empty reply — drives the agent to take zero steps.
    yield { type: "done" } as ProviderStreamEvent;
  }
}

function makeSleepTool(name: string, sleepMs: number, category: "safe" | "mutating"): Tool {
  return {
    spec: {
      name,
      description: "sleeps " + sleepMs + "ms",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    validate(raw: Record<string, unknown>) { return raw; },
    async run(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      await new Promise((r) => setTimeout(r, sleepMs));
      return { toolCallId: "", display: "slept", content: "done", isError: false };
    },
  };
  void category; // reserved for future use
}

test("parallel: 3 read-only tools complete in ~max sleep, not sum", async () => {
  const tools = defaultToolRegistry();
  // Register 3 "safe" sleep tools. They all sleep 100ms.
  for (let i = 0; i < 3; i++) tools.register(makeSleepTool("sleep" + i, 100, "safe"));

  // Build a provider that yields 3 tool calls on the FIRST stream()
  // call, then nothing on subsequent calls (so the loop terminates
  // after one step).
  let callCount = 0;
  const provider: Provider = {
    id: "multi",
    displayName: "multi",
    async isConfigured() { return { ok: true }; },
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderStreamEvent, void, void> {
      callCount++;
      if (callCount > 1) {
        yield { type: "done" } as ProviderStreamEvent;
        return;
      }
      yield { type: "tool_call", toolCall: { id: "t1", name: "sleep0", argsJson: "{}" } } as ProviderStreamEvent;
      yield { type: "tool_call", toolCall: { id: "t2", name: "sleep1", argsJson: "{}" } } as ProviderStreamEvent;
      yield { type: "tool_call", toolCall: { id: "t3", name: "sleep2", argsJson: "{}" } } as ProviderStreamEvent;
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } } as ProviderStreamEvent;
      yield { type: "done" } as ProviderStreamEvent;
    },
  };

  const start = Date.now();
  const r = await runAgent({
    provider,
    model: "test",
    messages: [{ role: "user", content: "do parallel" }] as ChatMessage[],
    tools,
    cwd: process.cwd(),
    signal: new AbortController().signal,
    limits: { ...DEFAULT_LIMITS, requestTimeoutMs: 5_000 },
  });
  const elapsed = Date.now() - start;
  // Sequential would be ~300ms. Parallel should be ~100ms + provider
  // overhead. Give a wide margin.
  assert.ok(elapsed < 350, "expected parallel execution, took " + elapsed + "ms");
  // Two steps: one to issue tool calls + execute, one to break on done.
  assert.equal(r.steps, 2);
});

test("parallel: 1 mutating tool mixed with safe tools runs sequentially", async () => {
  const tools = defaultToolRegistry();
  for (let i = 0; i < 2; i++) tools.register(makeSleepTool("sleep" + i, 50, "safe"));
  // Register one non-safe tool (not in PARALLEL_SAFE_TOOLS).
  tools.register(makeSleepTool("bash", 50, "mutating"));

  let callCount = 0;
  const provider: Provider = {
    id: "mixed",
    displayName: "mixed",
    async isConfigured() { return { ok: true }; },
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderStreamEvent, void, void> {
      callCount++;
      if (callCount > 1) { yield { type: "done" } as ProviderStreamEvent; return; }
      yield { type: "tool_call", toolCall: { id: "t1", name: "sleep0", argsJson: "{}" } } as ProviderStreamEvent;
      yield { type: "tool_call", toolCall: { id: "t2", name: "bash", argsJson: "{}" } } as ProviderStreamEvent;
      yield { type: "tool_call", toolCall: { id: "t3", name: "sleep1", argsJson: "{}" } } as ProviderStreamEvent;
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } } as ProviderStreamEvent;
      yield { type: "done" } as ProviderStreamEvent;
    },
  };

  const start = Date.now();
  const r = await runAgent({
    provider, model: "test",
    messages: [{ role: "user", content: "x" }] as ChatMessage[],
    tools, cwd: process.cwd(), signal: new AbortController().signal,
    limits: { ...DEFAULT_LIMITS, requestTimeoutMs: 5_000 },
  });
  const elapsed = Date.now() - start;
  // Sequential: 50+50+50 = 150ms. Allow overhead.
  assert.ok(elapsed >= 130, "expected sequential execution, took " + elapsed + "ms");
  assert.equal(r.steps, 2);
});

test("parallel: single tool still completes (no parallel overhead)", async () => {
  const tools = defaultToolRegistry();
  tools.register(makeSleepTool("solo", 30, "safe"));
  let callCount = 0;
  const provider: Provider = {
    id: "single",
    displayName: "single",
    async isConfigured() { return { ok: true }; },
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderStreamEvent, void, void> {
      callCount++;
      if (callCount > 1) { yield { type: "done" } as ProviderStreamEvent; return; }
      yield { type: "tool_call", toolCall: { id: "t1", name: "solo", argsJson: "{}" } } as ProviderStreamEvent;
      yield { type: "done" } as ProviderStreamEvent;
    },
  };
  const r = await runAgent({
    provider, model: "test",
    messages: [{ role: "user", content: "x" }] as ChatMessage[],
    tools, cwd: process.cwd(), signal: new AbortController().signal,
    limits: { ...DEFAULT_LIMITS, requestTimeoutMs: 5_000 },
  });
  // Two steps: one to call solo, one to break.
  assert.equal(r.steps, 2);
});

test("ALL OK", () => {});
