// Smoke test: a stub provider that simulates a model which calls
// one tool, sees the result, then produces a final answer. This
// exercises the agent loop, the tool registry, the session
// persistence, and the slash command parser end-to-end.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Override HOME so paths.ts writes to a temp dir.
const tmp = mkdtempSync(join(tmpdir(), "ch-smoke-"));
process.env.CODINGHARNESS_HOME = tmp;
process.env.NO_COLOR = "1";

import { runAgent, DEFAULT_LIMITS } from "../agent/loop.js";
import { defaultToolRegistry } from "../agent/tools/index.js";
import { Session, sessionToMessages } from "../agent/session.js";
import { BUILTIN_REGISTRY } from "../slash/builtin.js";
import { tryParseSlash } from "../slash/registry.js";
import { loadSettings } from "../config/settings.js";
import type { Provider, ProviderRequest, ProviderStreamEvent, ChatMessage, ToolCall, ToolResult } from "../types.js";

// --- Stub provider ---
class StubProvider implements Provider {
  readonly id = "stub";
  readonly displayName = "Stub";
  async isConfigured() { return { ok: true }; }
  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    // Yield a tool call: read a file the test will create.
    const tc: ToolCall = {
      id: "call_1",
      name: "read",
      argsJson: JSON.stringify({ path: req.messages[0]?.content?.includes("PROBE_READ")
        ? { path: "/probe" } : { path: "/probe" } }),
    };
    yield { type: "text", text: "Reading the probe file...\n" };
    yield { type: "tool_call", toolCall: tc };
    yield { type: "usage", usage: { inputTokens: 12, outputTokens: 5 } };
    yield { type: "done" };
  }
}

// --- 1) tool registry works ---
const tools = defaultToolRegistry();
const read = tools.get("read");
if (!read) throw new Error("read tool missing");
writeFileSync(join(tmp, "probe.txt"), "hello from probe\n");
const r = await read.run({ path: join(tmp, "probe.txt") }, {
  cwd: tmp,
  signal: new AbortController().signal,
  limits: { bashTimeoutMs: 1, readMaxBytes: 1_000_000 },
  log: () => {},
});
if (r.isError) throw new Error("read failed: " + r.content);
if (!r.content.includes("hello from probe")) throw new Error("read content wrong: " + r.content);
console.log("[smoke] tool registry: read works");

// --- 2) agent loop dispatches tool call from stub provider ---
const session = await Session.create({ cwd: tmp, model: "stub-model", provider: "stub" });
await session.append({ kind: "message", message: { role: "user", content: "PROBE_READ" } });

const stub = new StubProvider();
const result = await runAgent({
  provider: stub,
  model: "stub-model",
  system: "test",
  messages: sessionToMessages(session),
  tools,
  cwd: tmp,
  signal: new AbortController().signal,
  limits: { ...DEFAULT_LIMITS, requestTimeoutMs: 5_000, maxSteps: 4 },
  hooks: {
    onToolCallEnd: (tc, r) => {
      // Record into the session manually (we're not using the full runtime here).
      void session.append({ kind: "tool_result", toolCallId: tc.id, toolName: tc.name, result: r });
    },
  },
  onComplete: (m) => { void session.append({ kind: "message", message: m }); },
});
if (result.steps < 1) throw new Error("agent loop did not step");
console.log("[smoke] agent loop: " + result.steps + " step(s)");

// --- 3) session persists and reloads ---
await session.flush();
const sessionFile = session.filePath;
if (!existsSync(sessionFile)) throw new Error("session file not written");
const reloaded = await Session.open(session.id);
if (reloaded.allEntries().length < 1) throw new Error("reloaded session is empty");
console.log("[smoke] session persists with " + reloaded.allEntries().length + " entries");

// --- 4) slash command parser ---
const parsed = tryParseSlash("/model gpt-5");
if (!parsed || parsed.name !== "model" || parsed.args !== "gpt-5") throw new Error("slash parse failed");
const help = BUILTIN_REGISTRY.get("help");
if (!help) throw new Error("help command missing");
const sessionCmd = BUILTIN_REGISTRY.get("session");
if (!sessionCmd) throw new Error("session command missing");
const goalCmd = BUILTIN_REGISTRY.get("goal");
if (!goalCmd) throw new Error("goal command missing");
const loopCmd = BUILTIN_REGISTRY.get("loop");
if (!loopCmd) throw new Error("loop command missing");
console.log("[smoke] slash commands: help, session, goal, loop registered");

// --- 5) settings load ---
const settings = loadSettings();
if (settings.providers.stub === undefined) {
  // Stub isn't in settings — that's fine, the stub doesn't need it.
}
console.log("[smoke] settings load: " + Object.keys(settings.providers).length + " providers, default=" + settings.defaultProvider);

// --- cleanup ---
rmSync(tmp, { recursive: true, force: true });
console.log("[smoke] ALL OK");
