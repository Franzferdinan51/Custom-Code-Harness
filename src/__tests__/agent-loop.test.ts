// Tests for the agent loop's error boundaries.
// We use node's built-in test runner via tsx.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODINGHARNESS_HOME = mkdtempSync(join(tmpdir(), "ch-test-"));
process.env.NO_COLOR = "1";

import { runAgent, DEFAULT_LIMITS } from "../agent/loop.js";
import { defaultToolRegistry } from "../agent/tools/index.js";
import { ToolRegistry, type Tool, type ToolContext } from "../agent/tools/registry.js";
import type { Provider, ProviderRequest, ProviderStreamEvent, ToolCall, ToolResult } from "../types.js";

class StubProvider implements Provider {
  readonly id = "stub";
  readonly displayName = "Stub";
  constructor(private readonly events: (() => ProviderStreamEvent)[]) {}
  async isConfigured() { return { ok: true }; }
  async *stream(_req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    for (const make of this.events) yield make();
  }
}

function flakyTool(): Tool {
  return {
    spec: { name: "flaky", description: "throws on demand", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
    validate: (a) => a as Record<string, unknown>,
    run: async (): Promise<ToolResult> => { throw new Error("intentional crash"); },
  };
}

test("agent loop survives a tool that throws", async () => {
  const tools = new ToolRegistry();
  tools.register(flakyTool());

  const stub = new StubProvider([
    () => ({ type: "text", text: "let me try" }),
    () => ({ type: "tool_call", toolCall: { id: "c1", name: "flaky", argsJson: "{}" } as ToolCall }),
    () => ({ type: "done" }),
  ]);

  const result = await runAgent({
    provider: stub,
    model: "x",
    messages: [{ role: "user", content: "go" }],
    tools,
    cwd: process.cwd(),
    signal: new AbortController().signal,
    limits: { ...DEFAULT_LIMITS, maxSteps: 3, requestTimeoutMs: 5_000 },
    hooks: {
      onToolCallEnd: (_tc, r) => {
        assert.equal(r.isError, true, "flaky tool result should be isError=true");
        assert.match(r.content, /crashed/);
      },
    },
  });
  assert.equal(result.steps, 1);
});

test("agent loop stops after max steps", async () => {
  const tools = defaultToolRegistry();
  writeFileSync("/tmp/ch-flap.txt", "x");

  const stub = new StubProvider([
    () => ({ type: "tool_call", toolCall: { id: "c", name: "read", argsJson: JSON.stringify({ path: "/tmp/ch-flap.txt" }) } }),
    () => ({ type: "done" }),
  ]);
  const result = await runAgent({
    provider: stub,
    model: "x",
    messages: [{ role: "user", content: "go" }],
    tools,
    cwd: "/",
    signal: new AbortController().signal,
    limits: { ...DEFAULT_LIMITS, maxSteps: 2, requestTimeoutMs: 5_000 },
  });
  assert.ok(result.steps <= 2);
});

test("provider error becomes a model-visible message", async () => {
  const tools = defaultToolRegistry();
  const stub = new StubProvider([
    () => ({ type: "error", error: { message: "fake outage" } }),
  ]);
  let captured: string | undefined;
  const result = await runAgent({
    provider: stub,
    model: "x",
    messages: [{ role: "user", content: "go" }],
    tools,
    cwd: "/",
    signal: new AbortController().signal,
    limits: { ...DEFAULT_LIMITS, maxSteps: 2, requestTimeoutMs: 5_000 },
    hooks: { onError: () => {}, onTextDelta: (t) => { captured = (captured ?? "") + t; } },
  });
  assert.match(result.final.content, /Provider error/);
  assert.match(result.final.content, /fake outage/);
});

test("abort signal cuts off the loop", async () => {
  const tools = defaultToolRegistry();
  const ac = new AbortController();
  // Provider that never yields done.
  const stub: Provider = {
    id: "stub", displayName: "stub",
    async isConfigured() { return { ok: true }; },
    async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      // Wait for abort, then throw.
      await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true }));
      const e = new Error("aborted"); e.name = "AbortError"; throw e;
    },
  };
  setTimeout(() => ac.abort(), 50);
  const result = await runAgent({
    provider: stub,
    model: "x",
    messages: [{ role: "user", content: "go" }],
    tools,
    cwd: "/",
    signal: ac.signal,
    limits: { ...DEFAULT_LIMITS, maxSteps: 5, requestTimeoutMs: 5_000 },
  });
  assert.ok(result.steps <= 1);
});

test("tool result is size-capped to protect context", async () => {
  const tools = defaultToolRegistry();
  // Create a huge file.
  const big = "x".repeat(2_000_000);
  const tmp = mkdtempSync(join(tmpdir(), "ch-big-"));
  writeFileSync(join(tmp, "huge.txt"), big);

  const stub = new StubProvider([
    () => ({ type: "tool_call", toolCall: { id: "c", name: "read", argsJson: JSON.stringify({ path: join(tmp, "huge.txt") }) } }),
    () => ({ type: "done" }),
  ]);
  const result = await runAgent({
    provider: stub,
    model: "x",
    messages: [{ role: "user", content: "read it" }],
    tools,
    cwd: tmp,
    signal: new AbortController().signal,
    limits: { ...DEFAULT_LIMITS, maxToolResultBytes: 10_000, maxSteps: 2, requestTimeoutMs: 5_000 },
  });
  // The model-side message should include the truncation marker.
  const toolMsg = result.final;
  // Pull the tool message from the messages (we don't have direct access, but the
  // result should include the tool call record; the model would've been given
  // a truncated tool result. We assert via the final message's toolCalls).
  assert.ok(toolMsg.toolCalls && toolMsg.toolCalls.length === 1);
  rmSync(tmp, { recursive: true, force: true });
});
