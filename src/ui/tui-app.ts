// TUI application: wires the TUI primitives to the HarnessRuntime.
// This is the "REPL" when running in a TTY — the user sees a
// full-screen TUI instead of a line-based REPL.

import type { HarnessRuntime } from "../runtime.js";
import type { Tui } from "./tui.js";
import { createTui } from "./tui.js";
import { BUILTIN_REGISTRY } from "../slash/builtin.js";
import { tryParseSlash } from "../slash/registry.js";
import { runAgent, DEFAULT_LIMITS } from "../agent/loop.js";
import { sessionToMessages } from "../agent/session.js";

/** Is the current environment TUI-capable? */
export function isTuiCapable(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

/** Run the TUI. Returns when the user quits. */
export async function runTui(runtime: HarnessRuntime, ctx: { cwd: string; initialPrompt?: string }): Promise<number> {
  const slashNames = BUILTIN_REGISTRY.names();
  const tui: Tui = createTui({
    slashNames,
    runtime,
    status: {
      model: runtime.model() ?? "—",
      provider: runtime.providerId() ?? "—",
      session: runtime.sessionId() ?? "—",
      cwd: ctx.cwd,
      tokensIn: 0,
      tokensOut: 0,
      steps: 0,
      thinking: "medium",
    },
  });

  // Wire the approval flow: when the bash tool flags a command, pop
  // the TUI modal. "allow-always" gets persisted to settings.json by
  // the runtime's services.askApproval wrapper.
  const clearApproval = runtime.setApprovalRequestHandler((command, reason) =>
    tui.askApproval(command, reason)
  );

  tui.start();
  tui.addMessage({ kind: "info", text: "Welcome to CodingHarness v" + RUNTIME_VERSION + ". Type /help for commands." });

  // Clean up the approval handler on exit.
  process.once("exit", clearApproval);

  // When the user submits a prompt, run it through the runtime.
  tui.onSubmit(async (raw) => {
    // Try slash command first.
    const parsed = tryParseSlash(raw);
    if (parsed) {
      const cmd = BUILTIN_REGISTRY.get(parsed.name);
      if (cmd) {
        tui.addMessage({ kind: "system", text: "/ " + parsed.name + " " + parsed.args });
        try {
          const out = await cmd.run(parsed.args, { cwd: ctx.cwd, runtime: () => runtime });
          if (typeof out === "string" && out.length > 0) {
            tui.addMessage({ kind: "info", text: out });
          } else if (cmd.name === "quit" || cmd.name === "exit") {
            tui.stop();
            process.exit(0);
          }
        } catch (e) {
          tui.addMessage({ kind: "error", text: (e as Error).message });
        }
        return;
      }
      tui.addMessage({ kind: "info", text: "unknown command: /" + parsed.name + " — use /help" });
      return;
    }
    await runPrompt(runtime, raw, tui, ctx.cwd);
  });

  tui.onAction((a) => {
    if (a.action === "cancel") {
      tui.addMessage({ kind: "info", text: "(cancelled)" });
    } else if (a.action === "eof") {
      tui.addMessage({ kind: "info", text: "goodbye." });
      tui.stop();
      setTimeout(() => process.exit(0), 50);
    } else if (a.action === "scroll-up") {
      // handled in tui.ts
    } else if (a.action === "scroll-down") {
      // handled in tui.ts
    }
  });

  // Initial prompt?
  if (ctx.initialPrompt && ctx.initialPrompt.trim().length > 0) {
    setTimeout(() => { void runPrompt(runtime, ctx.initialPrompt!, tui, ctx.cwd); }, 200);
  }

  return new Promise<number>((resolve) => {
    process.on("SIGINT", () => {
      // Don't quit on first SIGINT; let the agent loop catch it.
      // The user has to press Ctrl+C again to actually exit.
    });
    process.on("SIGTERM", () => { tui.stop(); resolve(0); });
    // The TUI loop runs in the same event loop. Resolving happens when the
    // user types /quit or hits Ctrl+D (action: eof), or we get a signal.
  });
}

const RUNTIME_VERSION = "0.2.2";

async function runPrompt(runtime: HarnessRuntime, prompt: string, tui: Tui, cwd: string): Promise<void> {
  // Initialize or load a session.
  let session;
  try {
    session = await runtime.ensureSession();
  } catch (e) {
    tui.addMessage({ kind: "error", text: "session error: " + (e as Error).message });
    return;
  }

  // Persist user message.
  await session.append({ kind: "message", message: { role: "user", content: prompt } });
  const messages = sessionToMessages(session);

  const provider = runtime.providerRegistry.default();
  if (!provider) { tui.addMessage({ kind: "error", text: "no provider configured. Set OPENAI_API_KEY or run /provider." }); return; }
  const model = runtime.model();
  if (!model) { tui.addMessage({ kind: "error", text: "no model set. Run /model <name>." }); return; }

  tui.setInfo("thinking...");
  tui.setStatus({ session: runtime.sessionId() ?? "—" });

  const ac = new AbortController();
  const onSig = () => { try { ac.abort(); } catch {} tui.setInfo("aborted"); };
  process.once("SIGINT", onSig);

  try {
    const result = await runAgent({
      provider, model,
      system: await runtime["buildSystemPrompt"](),
      messages,
      tools: runtime.tools,
      cwd,
      signal: ac.signal,
      limits: { ...DEFAULT_LIMITS, bashTimeoutMs: runtime.settings.tools?.bashTimeoutMs ?? DEFAULT_LIMITS.bashTimeoutMs, readMaxBytes: runtime.settings.tools?.readMaxBytes ?? DEFAULT_LIMITS.readMaxBytes },
      hooks: {
        onTextDelta: (t) => tui.appendText(t),
        onToolCallStart: (tc) => tui.addToolCall(tc.name, tc.argsJson, "run"),
        onToolCallEnd: (tc, r) => {
          // Update the last tool message status.
          // We do this by adding a new line; if a previous "run" exists
          // for the same name+args, we could replace it but for v1
          // we just append a status line.
          tui.addToolCall(tc.name, tc.argsJson, r.isError ? "err" : "ok", r.display);
        },
        onUsage: (u) => {
          tui.setStatus({ tokensIn: u.inputTokens, tokensOut: u.outputTokens });
        },
        onError: (e) => { tui.addMessage({ kind: "error", text: e.message }); },
        onInfo: () => {},
      },
      onComplete: (m) => {
        void session.append({ kind: "message", message: m });
      },
    });
    tui.endStream();
    tui.setInfo("");
    tui.setStatus({ steps: result.steps });
  } catch (e) {
    tui.endStream();
    tui.addMessage({ kind: "error", text: "agent crashed: " + (e as Error).message });
  } finally {
    process.removeListener("SIGINT", onSig);
  }
}
