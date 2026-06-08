// Tests for provider failover (v0.2.2).
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { runAgent, DEFAULT_LIMITS } from "../agent/loop.js";
import { ProviderRegistry } from "../providers/registry.js";
import { defaultToolRegistry } from "../agent/tools/index.js";
import type { Provider, ProviderStreamEvent, ChatMessage, ProviderRequest } from "../types.js";

/** A test provider that always throws on stream(). */
class FailingProvider implements Provider {
  id = "fail";
  displayName = "FailingProvider";
  async isConfigured(): Promise<{ ok: boolean; reason?: string }> { return { ok: true }; }
  async *stream(_req: ProviderRequest): AsyncGenerator<ProviderStreamEvent, void, void> {
    throw new Error("primary is down");
  }
}

/** A test provider that streams a fixed text response. */
class StubProvider implements Provider {
  id: string;
  displayName = "Stub";
  constructor(id: string, public readonly text: string) { this.id = id; }
  async isConfigured(): Promise<{ ok: boolean; reason?: string }> { return { ok: true }; }
  async *stream(_req: ProviderRequest): AsyncGenerator<ProviderStreamEvent, void, void> {
    yield { type: "text", text: this.text } as ProviderStreamEvent;
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } } as ProviderStreamEvent;
    yield { type: "done" } as ProviderStreamEvent;
  }
}

function makeReq(provider: Provider, model: string, failoverChain?: Array<{ provider: Provider; model: string }>) {
  return {
    provider, model, system: "you are a test",
    messages: [{ role: "user" as const, content: "hi" }] as ChatMessage[],
    tools: defaultToolRegistry(),
    cwd: process.cwd(),
    signal: new AbortController().signal,
    limits: { ...DEFAULT_LIMITS, requestTimeoutMs: 5_000 },
    failoverChain,
  };
}

test("failover: when primary throws, secondary provider is tried", async () => {
  const primary = new FailingProvider();
  const fallback = new StubProvider("fallback", "from-fallback");
  const infos: string[] = [];
  const r = await runAgent({
    ...makeReq(primary, "primary-model", [{ provider: fallback, model: "fallback-model" }]),
    hooks: { onInfo: (m) => infos.push(m) },
  });
  assert.match(r.final.content, /from-fallback/);
  assert.ok(infos.some((m) => m.includes("failing over")), "expected a 'failing over' info message");
});

test("failover: when chain is empty (no failover set), error surfaces as assistant message", async () => {
  const primary = new FailingProvider();
  const errors: Error[] = [];
  const r = await runAgent({
    ...makeReq(primary, "primary-model"),
    hooks: { onError: (e) => errors.push(e) },
  });
  assert.ok(errors.length >= 1, "expected the primary error to be reported");
  assert.match(r.final.content, /Provider error/);
});

test("failover: providerRegistry.get returns undefined for unconfigured provider", () => {
  const reg = new ProviderRegistry({
    providers: {},
    defaultProvider: "openai",
    defaultModel: "gpt-4o",
  } as never);
  assert.equal(reg.get("never-configured"), undefined);
});

test("ALL OK", () => {});
