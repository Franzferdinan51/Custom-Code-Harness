// Tests for the /diag and /tokens slash commands, and the
// HarnessRuntime.runDiag() helper that backs them. Also covers the
// small bug fixes shipped alongside: buildSystemPrompt being public
// and the sub-agent SIGINT listener not leaking across calls.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_REGISTRY } from "../slash/builtin.js";
import { HarnessRuntime } from "../runtime.js";
import type { Provider, ProviderStreamEvent } from "../types.js";

process.env.CODINGHARNESS_HOME = mkdtempSync(join(tmpdir(), "ch-diag-"));

/** Build a minimal Provider stub. The `stream` function can be
 *  overridden per-test for behavior (ok / error / tokens). */
function stubProvider(overrides: { stream?: (req: never) => AsyncIterable<ProviderStreamEvent> } = {}): Provider {
  return {
    id: "openai",
    displayName: "openai",
    async isConfigured() { return { ok: true }; },
    async *stream() { yield { type: "done" }; },
    ...(overrides.stream ? { stream: overrides.stream as Provider["stream"] } : {}),
  };
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ch-diag-"));
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  return home;
}

test("buildSystemPrompt is public and returns a non-empty system prompt", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
    const sys = await rt.buildSystemPrompt();
    assert.ok(typeof sys === "string" && sys.length > 50, "system prompt should be non-trivial");
    assert.match(sys, /CodingHarness/);
    assert.match(sys, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("runDiag() reports a clear error when no provider is configured", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
    // No OPENAI_API_KEY, etc. — the registry will be empty.
    const r = await rt.runDiag();
    assert.equal(r.ok, false);
    assert.ok(r.error, "expected an error message");
    assert.equal(typeof r.firstByteMs, "number");
    assert.equal(typeof r.totalMs, "number");
    assert.equal(r.inputTokens, 0);
    assert.equal(r.outputTokens, 0);
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("runDiag() reports a clear error when no model is configured", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
    // Pretend a provider exists but with no model. We register a stub
    // provider so the registry doesn't try to build a real one, then
    // wipe the model so runDiag's "no model" path fires.
    rt.providerRegistry.register("openai", stubProvider());
    rt.settings.defaultProvider = "openai";
    rt.settings.defaultModel = undefined;
    const r = await rt.runDiag();
    assert.equal(r.ok, false);
    assert.equal(r.provider, "openai");
    assert.ok(r.error && /model/i.test(r.error), "error should mention model");
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("runDiag() handles a streaming provider that throws", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
    rt.providerRegistry.register("openai", stubProvider({
      stream: async function* () {
        yield { type: "text", text: "starting" } as ProviderStreamEvent;
        throw new Error("simulated network failure");
      },
    }));
    rt.settings.defaultProvider = "openai";
    rt.settings.defaultModel = "gpt-test";
    const r = await rt.runDiag();
    assert.equal(r.ok, false);
    assert.equal(r.provider, "openai");
    assert.equal(r.model, "gpt-test");
    assert.match(r.error ?? "", /simulated network failure/);
    assert.ok(r.firstByteMs >= 0);
    assert.ok(r.totalMs >= r.firstByteMs);
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("runDiag() returns ok=true on a successful streaming provider", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
    rt.providerRegistry.register("openai", stubProvider({
      stream: async function* () {
        // Simulate a small delay before first byte.
        await new Promise((r) => setTimeout(r, 5));
        yield { type: "text", text: "pong" } as ProviderStreamEvent;
        yield { type: "usage", usage: { inputTokens: 12, outputTokens: 4 } } as ProviderStreamEvent;
        yield { type: "done" } as ProviderStreamEvent;
      },
    }));
    rt.settings.defaultProvider = "openai";
    rt.settings.defaultModel = "gpt-test";
    const r = await rt.runDiag();
    assert.equal(r.ok, true);
    assert.equal(r.provider, "openai");
    assert.equal(r.model, "gpt-test");
    assert.equal(r.reply, "pong");
    assert.equal(r.inputTokens, 12);
    assert.equal(r.outputTokens, 4);
    assert.ok(r.firstByteMs >= 0);
    assert.ok(r.totalMs >= r.firstByteMs);
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("/diag is registered and reports a friendly error when runDiag is missing", async () => {
  const diag = BUILTIN_REGISTRY.get("diag");
  assert.ok(diag, "/diag should be registered");
  const out = await diag!.run("", { cwd: "/", runtime: () => ({}) as never });
  assert.equal(out, "(diag not available in this runtime)");
});

test("/diag renders the success path with the model's reply", async () => {
  const diag = BUILTIN_REGISTRY.get("diag");
  assert.ok(diag);
  const rt = {
    async runDiag() {
      return {
        ok: true,
        provider: "openai",
        model: "gpt-test",
        firstByteMs: 142,
        totalMs: 380,
        inputTokens: 12,
        outputTokens: 4,
        reply: "pong",
      };
    },
  };
  const out = await diag!.run("", { cwd: "/", runtime: () => rt as never });
  assert.match(out!, /diag ok/);
  assert.match(out!, /openai/);
  assert.match(out!, /gpt-test/);
  assert.match(out!, /142 ms/);
  assert.match(out!, /380 ms/);
  assert.match(out!, /12 in \/ 4 out/);
  assert.match(out!, /"pong"/);
});

test("/diag renders the failure path with an error message", async () => {
  const diag = BUILTIN_REGISTRY.get("diag");
  assert.ok(diag);
  const rt = {
    async runDiag() {
      return {
        ok: false,
        provider: "openai",
        model: "gpt-test",
        firstByteMs: 0,
        totalMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        error: "no API key",
      };
    },
  };
  const out = await diag!.run("", { cwd: "/", runtime: () => rt as never });
  assert.match(out!, /diag failed/);
  assert.match(out!, /no API key/);
});

test("/tokens prints a token breakdown for the active session", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const { Session } = await import("../agent/session.js");
    const s = await Session.create({ cwd: home, name: "tokens-fixture" });
    await s.append({ kind: "message", message: { role: "user", content: "hello world this is a test prompt with several words in it" } });
    await s.append({ kind: "message", message: { role: "assistant", content: "sure, here is a reply that has its own length and content" } });
    await s.flush();
    const tokens = BUILTIN_REGISTRY.get("tokens");
    assert.ok(tokens, "/tokens should be registered");
    const out = await tokens!.run("", { cwd: home, runtime: () => ({ sessionId: () => s.id }) as never });
    assert.match(out!, /Session tokens/);
    assert.match(out!, /messages:\s*2/);
    assert.match(out!, /total:\s*\d+/);
    assert.match(out!, /user/);
    assert.match(out!, /assistant/);
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("/tokens with no active session returns a helpful message", async () => {
  const tokens = BUILTIN_REGISTRY.get("tokens");
  assert.ok(tokens);
  const out = await tokens!.run("", { cwd: "/", runtime: () => ({ sessionId: () => undefined }) as never });
  assert.match(out!, /no active session/);
});

test("subagent spawn does not leak SIGINT listeners across calls", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    // Register a stub provider so buildToolServices has a real
    // `provider.id` to record cost against.
    const provider = stubProvider();
    const before = process.listenerCount("SIGINT");
    for (let i = 0; i < 3; i++) {
      const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
      rt.providerRegistry.register("openai", provider);
      // Stub the subagent manager to resolve immediately so the spawn
      // call returns before SIGINT could fire.
      (rt as unknown as { subagents: { spawn: (i: unknown) => Promise<unknown> } }).subagents.spawn = async () => ({ agentName: "explore", status: "ok", text: "", usage: { inputTokens: 0, outputTokens: 0 }, steps: 0 });
      const services = rt.buildToolServices(provider, "model");
      for (let j = 0; j < 5; j++) {
        await services.spawnSubagent({ agent: "explore", prompt: "noop" });
      }
    }
    const after = process.listenerCount("SIGINT");
    assert.equal(after, before, "subagent spawns must not leave behind SIGINT listeners");
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
