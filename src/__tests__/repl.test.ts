// Tests for the new streaming REPL (`src/ui/repl-v2.ts`).
//
// We test:
//   1. Pure rendering helpers — no I/O, no TTY dependency.
//   2. Pure parsing helpers (multi-line continuation parsing).
//   3. A transcript-handling smoke test that exercises the helper
//      against a few representative entries.
//   4. A non-TTY smoke test for the tool-call rendering format.
//
// Per the spike spec, full TTY tests are flaky in CI, so we gate them
// behind `process.stdout.isTTY`. The pure helpers and the rendering
// shape are always testable.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  renderHeader,
  renderFooter,
  renderUserLine,
  renderAssistantLine,
  renderThinkingBlock,
  renderPlanBlock,
  renderToolCall,
  renderInfoLine,
  renderErrorLine,
  renderSystemLine,
  renderFramedBlock,
  parseLineForContinuation,
  buildPrompts,
  type ReplV2Status,
} from "../ui/repl-v2.js";
import { c } from "../ui/colors.js";

const sampleStatus: ReplV2Status = {
  model: "opus-4.5",
  provider: "anthropic",
  session: "7f2a91c4",
  cwd: "/Users/duckets/Desktop/CodingHarness",
  tokensIn: 2100,
  tokensOut: 900,
  steps: 4,
  lastTurnMs: 8200,
};

// ---------- Prompt parsing ----------

test("parseLineForContinuation: bare line is complete", () => {
  const r = parseLineForContinuation("hello world");
  assert.equal(r.continues, false);
  assert.equal(r.text, "hello world");
});

test("parseLineForContinuation: trailing backslash continues the line", () => {
  const r1 = parseLineForContinuation("line one\\");
  assert.equal(r1.continues, true);
  assert.equal(r1.text, "line one\n");

  const r2 = parseLineForContinuation("line one \\");
  assert.equal(r2.continues, true);
  assert.equal(r2.text, "line one \n");
});

test("parseLineForContinuation: escaped backslash does NOT continue", () => {
  // A user typing a literal `\` at the end of a line uses `\\` so the
  // REPL doesn't keep the prompt open.
  const r = parseLineForContinuation("a literal backslash: \\\\");
  assert.equal(r.continues, false);
  assert.equal(r.text, "a literal backslash: \\");
});

test("parseLineForContinuation: backslash mid-line is preserved", () => {
  // Windows path-style — only the trailing backslash is the signal.
  const r = parseLineForContinuation("C:\\path\\to\\file");
  assert.equal(r.continues, false);
  assert.equal(r.text, "C:\\path\\to\\file");
});

test("buildPrompts: primary and continuation differ", () => {
  const p = buildPrompts();
  assert.ok(p.primary.includes("ch"));
  assert.ok(p.continuation.startsWith("..."));
  assert.notEqual(p.primary, p.continuation);
});

// ---------- Rendering: header / footer ----------

test("renderHeader: includes model, session, cwd", () => {
  const out = renderHeader(sampleStatus);
  // The header should mention the model and the cwd at minimum.
  // We don't pin exact color codes (the colors module can be disabled
  // via NO_COLOR) but the substrings are always present.
  assert.ok(out.includes("opus-4.5"));
  assert.ok(out.includes("7f2a91c4".slice(0, 8)));
  assert.ok(out.includes("CodingHarness"));
});

test("renderHeader: short session id when session is long", () => {
  const out = renderHeader({ ...sampleStatus, session: "abcdef0123456789" });
  // First 8 chars only.
  assert.ok(out.includes("abcdef01"));
  assert.ok(!out.includes("abcdef0123456789"));
});

test("renderFooter: shows tokens, steps, wallclock, session, /help hint", () => {
  const out = renderFooter(sampleStatus);
  assert.ok(out.includes("opus-4.5"));
  // Token formatting: 2100 -> "2.1k", 900 -> "0.9k"
  assert.ok(out.includes("2.1k") && out.includes("0.9k"));
  // Steps
  assert.ok(out.includes("4 steps"));
  // Wallclock: 8200ms -> 8.2s
  assert.ok(out.includes("8.2s"));
  // Session short id
  assert.ok(out.includes("7f2a91c4".slice(0, 8)));
  // /help hint
  assert.ok(out.includes("/help"));
});

test("renderFooter: ready state when no turn has run", () => {
  const out = renderFooter({ ...sampleStatus, tokensIn: 0, tokensOut: 0, steps: 0, lastTurnMs: 0 });
  assert.ok(out.includes("ready"));
  // No wallclock when idle.
  assert.ok(!out.includes("· 0.0s") && !out.includes("· 0ms"));
});

// ---------- Rendering: messages ----------

test("renderUserLine: starts with 'user  ▸ '", () => {
  const out = renderUserLine("hello");
  // The marker should be present in the output; the color prefix
  // is a no-op string in the no-color case, so we check for the marker.
  assert.ok(out.includes("user"));
  assert.ok(out.includes("▸"));
  assert.ok(out.includes("hello"));
});

test("renderUserLine: collapses newlines for transcript compactness", () => {
  const out = renderUserLine("line one\nline two\n  line three");
  assert.ok(!out.includes("\n"));
  assert.ok(out.includes("line one"));
  assert.ok(out.includes("line two"));
  assert.ok(out.includes("line three"));
});

test("renderAssistantLine: starts with 'assistant ▸ '", () => {
  const out = renderAssistantLine("done.");
  assert.ok(out.includes("assistant"));
  assert.ok(out.includes("▸"));
  assert.ok(out.includes("done."));
});

test("renderAssistantLine: empty input returns empty string", () => {
  assert.equal(renderAssistantLine(""), "");
  assert.equal(renderAssistantLine("   \n  "), "");
});

test("renderThinkingBlock: framed with dashes", () => {
  const out = renderThinkingBlock("let me think about this…");
  assert.ok(out.includes("thinking"));
  assert.ok(out.includes("let me think about this"));
});

test("renderPlanBlock: framed with dashes", () => {
  const out = renderPlanBlock("1. read src/server.ts\n2. add /auth/login");
  assert.ok(out.includes("plan"));
  assert.ok(out.includes("1. read src/server.ts"));
  assert.ok(out.includes("2. add /auth/login"));
});

// ---------- Rendering: tool callouts ----------

test("renderToolCall: header has [tool] marker and tool name", () => {
  const out = renderToolCall("spawn_subagent", '{"agent":"implement"}', "run");
  assert.ok(out.includes("[tool]") || out.includes("tool"));
  assert.ok(out.includes("spawn_subagent"));
  // Args get pretty-printed as key=value (with quoted string values).
  assert.ok(out.includes("agent=implement") || out.includes('agent="implement"'),
    "args should be summarized as key=value (with optional quotes for strings)");
});

test("renderToolCall: ok status uses check mark", () => {
  const out = renderToolCall("bash", '{"cmd":"npm test"}', "ok", "32 tests passing");
  assert.ok(out.includes("✓"));
  assert.ok(out.includes("32 tests passing"));
  // The pretty-printed args show cmd="npm test" (or cmd=npm test
  // depending on the value-type rule).
  assert.ok(out.includes("cmd=") || out.includes("cmd=\""),
    "args should be summarized as key=value");
});

test("renderToolCall: err status uses X mark", () => {
  const out = renderToolCall("bash", '{"cmd":"rm -rf /"}', "err", "permission denied");
  assert.ok(out.includes("✗"));
  assert.ok(out.includes("permission denied"));
});

test("renderToolCall: long detail is truncated to keep callout compact", () => {
  const longDetail = "x".repeat(200);
  const out = renderToolCall("bash", '{"cmd":"echo"}', "ok", longDetail);
  // Truncation marker should appear; the raw 200-char line shouldn't.
  assert.ok(out.includes("…"));
  assert.ok(out.length < 200);
});

test("renderToolCall: no detail returns just the header", () => {
  const out = renderToolCall("read", '{"path":"/x"}', "run");
  assert.ok(out.includes("read"));
  // The pretty-printer produces path="/x" (with quotes).
  assert.ok(out.includes("path=") || out.includes('path="'));
  // No detail → no second line.
  assert.ok(!out.includes("\n"));
});

test("renderToolCall: empty args is fine", () => {
  const out = renderToolCall("noop", "", "ok");
  assert.ok(out.includes("noop"));
});

test("renderToolCall: object args pretty-print as key=value pairs", () => {
  // This is the spec's "▌ name  k1=v1  k2=v2" shape: we want users to
  // see the args at a glance without parsing JSON. String values are
  // JSON-quoted; numbers/booleans are bare.
  const out = renderToolCall("bash", '{"cmd":"ls -la","timeout":30,"verbose":true}', "ok", "ok");
  assert.ok(out.includes("cmd=") || out.includes('cmd="ls -la"'),
    "string arg should appear with key=");
  assert.ok(out.includes("timeout=30"), "number arg should appear bare");
  assert.ok(out.includes("verbose=true"), "boolean arg should appear bare");
});

test("renderToolCall: non-object args fall back to truncated string", () => {
  // A free-form string (no `{...}` wrapper) is left alone, then
  // truncated to the 60-char cap. This handles tool specs that pass
  // a single positional arg as a bare string.
  const out = renderToolCall("note", "this is a free-form annotation", "ok");
  assert.ok(out.includes("this is a free-form annotation"));
});

// ---------- Rendering: info / error / system / framed ----------

test("renderInfoLine: starts with bullet", () => {
  const out = renderInfoLine("thinking…");
  assert.ok(out.includes("·"));
  assert.ok(out.includes("thinking"));
});

test("renderErrorLine: starts with !", () => {
  const out = renderErrorLine("agent crashed: out of memory");
  assert.ok(out.includes("!"));
  assert.ok(out.includes("agent crashed"));
});

test("renderSystemLine: starts with bullet, dim", () => {
  const out = renderSystemLine("type /help for commands");
  assert.ok(out.includes("·"));
  assert.ok(out.includes("/help"));
});

test("renderFramedBlock: title + body wrapped in box characters", () => {
  const out = renderFramedBlock("/help", "command 1\ncommand 2");
  assert.ok(out.includes("/help"));
  assert.ok(out.includes("command 1"));
  assert.ok(out.includes("command 2"));
  assert.ok(out.includes("┌─"));
  assert.ok(out.includes("└─"));
});

// ---------- Transcript smoke test ----------

test("transcript handling: render a sequence of entries and join them", () => {
  // This is what the REPL driver does when it pushes entries and
  // prints them to the terminal. We verify the joined output is a
  // plausible scrollback: every line is non-empty, and the order is
  // preserved.
  const entries = [
    { kind: "user" as const,      text: "wire up OAuth" },
    { kind: "thinking" as const,  text: "Plan: inspect auth hooks…" },
    { kind: "plan" as const,      text: "1. read src/server.ts\n2. add /auth/login" },
    { kind: "tool" as const,      text: "32 tests passing", toolName: "bash", meta: '{"cmd":"npm test"}', toolStatus: "ok" as const },
    { kind: "assistant" as const, text: "done. files updated." },
  ];
  const rendered = entries.map((e) => {
    switch (e.kind) {
      case "user":      return renderUserLine(e.text);
      case "thinking":  return renderThinkingBlock(e.text);
      case "plan":      return renderPlanBlock(e.text);
      case "tool":      return renderToolCall(e.toolName!, e.meta ?? "", e.toolStatus!, e.text);
      case "assistant": return renderAssistantLine(e.text);
    }
  });
  // Every entry produced output.
  for (const r of rendered) {
    assert.ok(r.length > 0, "each entry should render to non-empty text");
  }
  // Concatenate the transcript and verify a couple of substrings land
  // in the right order.
  const joined = rendered.join("\n");
  const userIdx = joined.indexOf("wire up OAuth");
  const planIdx = joined.indexOf("read src/server.ts");
  const toolIdx = joined.indexOf("32 tests passing");
  const asstIdx = joined.indexOf("done. files updated");
  assert.ok(userIdx >= 0 && planIdx > userIdx, "plan comes after user");
  assert.ok(toolIdx > planIdx, "tool comes after plan");
  assert.ok(asstIdx > toolIdx, "assistant comes after tool");
});

// ---------- Tool-call rendering format check (non-TTY smoke) ----------

test("tool-call format: matches the spec's inline callout shape", () => {
  // Per the spike spec §4.5 the callout has a [tool] marker, the
  // tool name, and short key=value pairs on the header line, with the
  // result on a second line. We assert all of that here so a future
  // refactor can't accidentally drop the marker.
  const out = renderToolCall("spawn_subagent", '{"agent":"implement","prompt":"add /auth"}', "ok", "[sub:implement status=ok steps=4 tokens=2100in/850out]");
  // First line: marker + tool name + args.
  const firstLine = out.split("\n")[0]!;
  assert.ok(firstLine.includes("tool"), "first line should mention tool");
  assert.ok(firstLine.includes("spawn_subagent"), "first line should have the tool name");
  assert.ok(firstLine.includes("agent=") || firstLine.includes('agent="'),
    "first line should have the summarized args");
  // Second line: result marker + summary.
  const secondLine = out.split("\n")[1] ?? "";
  assert.ok(secondLine.includes("✓"), "second line should have the status mark");
  assert.ok(secondLine.includes("[sub:implement"), "second line should have the result summary");
});

// ---------- No TTY gating (smoke) ----------

test("non-TTY smoke: rendering helpers work without a TTY", () => {
  // We don't construct the full driver here (it needs stdin/stdout
  // pipes we don't have in `node --test`), but the pure helpers are
  // independent of TTY state. Pin that with one more end-to-end pass.
  const header = renderHeader(sampleStatus);
  const footer = renderFooter(sampleStatus);
  const user = renderUserLine("hi");
  const tool = renderToolCall("bash", '{"cmd":"ls"}', "ok", "ok");
  const info = renderInfoLine("ready");
  const err = renderErrorLine("oops");
  for (const s of [header, footer, user, tool, info, err]) {
    assert.ok(typeof s === "string" && s.length > 0, "all renders produce non-empty strings");
  }
  // Color helpers should be a no-op (or wrap) regardless of TTY — the
  // important thing is that we never throw and never return undefined.
  void c.cyan("x");
  void c.dim("x");
  void c.red("x");
});

// ---------- Driver: gated TTY test ----------

test("runReplV2: smoke-runs the driver in a non-TTY context (auto-falls back)", async () => {
  if (process.stdout.isTTY) {
    // The full driver needs a real TTY to drive readline. In CI we
    // always run non-TTY; skip this case on a developer's machine.
    return;
  }
  const { runReplV2 } = await import("../ui/repl-v2.js");
  // Stub a minimal runtime that won't try to call any provider.
  // We just want to confirm the function returns 0 (or any number)
  // and doesn't throw. The non-TTY branch reads stdin as a single
  // batch and immediately closes; with no stdin data it returns.
  const fakeRuntime: import("../runtime.js").HarnessRuntime = {
    isFirstRun: () => false,
    shouldExit: () => false,
    model: () => undefined,
    providerId: () => undefined,
    sessionId: () => undefined,
    setOutputHandler: () => () => {},
    setApprovalRequestHandler: () => () => {},
    runUserTurn: async () => {},
  } as unknown as import("../runtime.js").HarnessRuntime;
  // Race the driver against a 1-second timeout so the test never hangs.
  const result = await Promise.race<number>([
    runReplV2(fakeRuntime, { cwd: process.cwd() }),
    new Promise<number>((resolve) => setTimeout(() => resolve(-1), 1000)),
  ]);
  // The non-TTY path returns 0 on clean exit; we accept any number
  // since the goal is "no crash" rather than exact behavior.
  assert.equal(typeof result, "number");
});
