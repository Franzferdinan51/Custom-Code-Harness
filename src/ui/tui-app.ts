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
  tui.setComposerMode?.(runtime.getComposerMode?.() ?? "build");
  const setComposerMode = (mode: "plan" | "build") => {
    runtime.setComposerMode?.(mode);
    tui.setComposerMode?.(mode);
    tui.setInfo(mode === "plan" ? "plan mode enabled" : "build mode enabled");
  };

  // Wire the approval flow: when the bash tool flags a command, pop
  // the TUI modal. "allow-always" gets persisted to settings.json by
  // the runtime's services.askApproval wrapper.
  const clearApproval = runtime.setApprovalRequestHandler((command, reason) =>
    tui.askApproval(command, reason)
  );

  tui.start();
  // tui.start() already paints the quick-start banner; no need to add
  // a duplicate "Welcome" line.

  // First-run hint. If no provider is configured, surface a one-time
  // nudge so the user knows /provider / /onboard exist. We don't
  // interrupt their flow — just a small note at the top of the log.
  if (runtime.isFirstRun?.()) {
    tui.addMessage({ kind: "system", text: "Heads up: no provider is configured yet. Type /onboard to set one up, or /provider list to see what's supported." });
  }

  // Clean up the approval handler on exit.
  process.once("exit", clearApproval);

  // When the user submits a prompt, run it through the runtime.
  tui.onSubmit(async (raw) => {
    // Try slash command first.
    const parsed = tryParseSlash(raw);
    if (parsed) {
      if (parsed.name === "plan" || parsed.name === "build") {
        setComposerMode(parsed.name);
        tui.addMessage({ kind: "info", text: "workflow set to " + parsed.name });
        tui.setRunState({
          phase: "complete",
          title: "/" + parsed.name,
          detail: "workflow switched to " + parsed.name,
        });
        return;
      }
      const cmd = BUILTIN_REGISTRY.get(parsed.name);
      if (cmd) {
        tui.addMessage({ kind: "system", text: "/ " + parsed.name + " " + parsed.args });
        tui.setRunState({
          phase: "running",
          title: "/" + parsed.name,
          detail: parsed.args.length > 0 ? summarizeText(parsed.args, 32) : "running without arguments",
        });
        const clearOutput = runtime.setOutputHandler({
          onTextDelta: (t) => tui.appendText(t),
          onToolCallStart: (tc) => tui.addToolCall(tc.name, tc.argsJson, "run"),
          onToolCallEnd: (tc, r) => tui.addToolCall(tc.name, tc.argsJson, r.isError ? "err" : "ok", r.display),
          onInfo: (text) => tui.addMessage({ kind: "info", text }),
          onError: (error) => tui.addMessage({ kind: "error", text: error.message }),
          onTurnEnd: () => tui.endStream(),
        });
        try {
          const out = await cmd.run(parsed.args, { cwd: ctx.cwd, runtime: () => runtime });
          if (typeof out === "string" && out.length > 0) {
            // Multi-line output (provider setup card, /help, etc.)
            // renders as a framed block so the user can scan it as
            // a single unit. Short single-line results still use the
            // compact "info" message style.
            if (out.includes("\n") && out.length > 80) {
              tui.addBlock("/" + parsed.name, out);
            } else {
              tui.addMessage({ kind: "info", text: out });
            }
          } else if (cmd.name === "quit" || cmd.name === "exit") {
            tui.stop();
            process.exit(0);
          }
          tui.setRunState({
            phase: "complete",
            title: "/" + parsed.name,
            detail: parsed.args.length > 0 ? summarizeText(parsed.args, 32) : "completed",
          });
        } catch (e) {
          tui.addMessage({ kind: "error", text: (e as Error).message });
          tui.setRunState({
            phase: "error",
            title: "/" + parsed.name,
            detail: summarizeText((e as Error).message, 32),
          });
        } finally {
          clearOutput();
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

  const { expandInputPrefixes } = await import("../util/input-prefixes.js");
  const expanded = await expandInputPrefixes(prompt, cwd);
  const effectivePrompt = expanded.prompt;

  // Persist user message.
  const framedPrompt = framePromptForComposerMode(effectivePrompt, runtime.getComposerMode?.() ?? "build");
  await session.append({ kind: "message", message: { role: "user", content: framedPrompt } });
  const messages = sessionToMessages(session);

  const provider = runtime.providerRegistry.default();
  if (!provider) { tui.addMessage({ kind: "error", text: "no provider configured. Set OPENAI_API_KEY or run /provider." }); return; }
  const model = runtime.model();
  if (!model) { tui.addMessage({ kind: "error", text: "no model set. Run /model <name>." }); return; }

  tui.setInfo("thinking...");
  tui.setStatus({ session: runtime.sessionId() ?? "—" });
  tui.setRunState({
    phase: "running",
    title: "agent turn",
      detail: summarizeText(prompt, 36),
  });

  const ac = new AbortController();
  const onSig = () => {
    try { ac.abort(); } catch {}
    tui.setInfo("aborted");
    tui.setRunState({
      phase: "error",
      title: "agent turn",
      detail: "aborted: " + summarizeText(prompt, 36),
    });
  };
  process.once("SIGINT", onSig);

  try {
    const result = await runAgent({
      provider, model,
      system: await runtime.buildSystemPrompt(),
      messages,
      tools: runtime.tools,
      cwd,
      signal: ac.signal,
      limits: { ...DEFAULT_LIMITS, bashTimeoutMs: runtime.settings.tools?.bashTimeoutMs ?? DEFAULT_LIMITS.bashTimeoutMs, readMaxBytes: runtime.settings.tools?.readMaxBytes ?? DEFAULT_LIMITS.readMaxBytes },
      failoverChain: runtime.buildFailoverChain(),
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
        onInfo: (text) => {
          // onInfo fires for "thinking...", retries, provider notes, etc.
          // Surface them as transient info banners so the user sees
          // what's happening without scrolling into the agent log.
          if (text) tui.setInfo(text);
        },
      },
      onComplete: (m) => {
        void session.append({ kind: "message", message: m });
      },
    });
    tui.endStream();
    tui.setInfo("");
    tui.setStatus({ steps: result.steps });
    tui.setRunState({
      phase: "complete",
      title: "agent turn",
      detail: "steps " + result.steps + " · " + summarizeText(prompt, 36),
    });
  } catch (e) {
    tui.endStream();
    tui.addMessage({ kind: "error", text: "agent crashed: " + (e as Error).message });
    tui.setRunState({
      phase: "error",
      title: "agent turn",
      detail: summarizeText((e as Error).message, 36),
    });
  } finally {
    process.removeListener("SIGINT", onSig);
  }
}

function framePromptForComposerMode(prompt: string, mode: "plan" | "build"): string {
  if (prompt.trim().startsWith("/")) return prompt;
  if (mode === "plan") {
    return [
      "Plan mode:",
      "Treat the user's request as a planning task in the current repository.",
      "Do not propose file edits unless the user explicitly asks for implementation.",
      "Return a concise plan, key files or areas to inspect, and any risks or unknowns.",
      "",
      "User request:",
      prompt,
    ].join("\n");
  }
  return [
    "Build mode:",
    "Treat the user's request as an implementation task in the current repository.",
    "Prefer concrete edits, clear next steps, and concise explanations.",
    "If details are missing, make sensible assumptions and state them briefly.",
    "",
    "User request:",
    prompt,
  ].join("\n");
}

function summarizeText(text: string, max = 36): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "—";
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}
