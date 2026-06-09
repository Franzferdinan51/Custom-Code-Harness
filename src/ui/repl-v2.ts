// Codex/Claude-Code/DuckHive-style streaming REPL — the new default
// `ch` interface, replacing the OpenTUI full-screen TUI.
//
// Design contract: `plans/plan_phase1/notes/agnt-port-plan.md` §4.
// The legacy OpenTUI TUI still lives in `src/ui/tui.ts` and is reachable
// via `ch tui --legacy`. This file is the streaming REPL that ships as
// the default for `ch`, `ch chat`, `ch tui`, and `ch repl` when stdin
// is a TTY.
//
// Layout (per the spike spec):
//
//   ch · session 7f2a · opus-4.5 · codingharness
//   ─────────────────────────────────────────────────────────────────
//   user  ▸ wire up OAuth for the dashboard
//   ─── thinking ──
//   The user wants OAuth. I should plan: inspect current state, then…
//   ─── plan ──
//   1. read src/server.ts to find the auth hooks
//   ...
//   [tool] spawn_subagent  agent=implement  prompt="…"
//     ✓ [sub:implement status=ok steps=4 tokens=2100in/850out]
//   assistant ▸ done. Files: src/server/auth.ts (new)…
//   ─────────────────────────────────────────────────────────────────
//   ch › add a /healthcheck slash command_
//   opus-4.5 · 2.1k in / 0.9k out · 4 steps · 8.2s · session 7f2a · /help
//
// Implementation notes:
//  - Uses `node:readline` for input. Zero new deps.
//  - The transcript is a flat list of `TranscriptEntry` items — printed
//    lines only. No virtual DOM, no diffing. We just append.
//  - The pure rendering helpers (`renderHeader`, `renderFooter`,
//    `renderToolCall`, etc.) are exported so `repl.test.ts` can
//    unit-test them without a TTY.
//  - Multi-line input: a trailing `\` on a line continues the prompt;
//    a bare Enter sends. This matches the spec exactly.

import { createInterface, type Interface } from "node:readline";
import { c } from "./colors.js";
import type { HarnessRuntime } from "../runtime.js";
import { runAgent, DEFAULT_LIMITS } from "../agent/loop.js";
import { sessionToMessages } from "../agent/session.js";
import { BUILTIN_REGISTRY } from "../slash/builtin.js";
import { tryParseSlash } from "../slash/registry.js";
import { type ApprovalDecision } from "./approval-modal.js";

// ---------- Public types ----------

export interface ReplV2Status {
  model: string;
  provider: string;
  session: string;
  cwd: string;
  tokensIn: number;
  tokensOut: number;
  steps: number;
  /** Wall-clock duration of the last turn, ms. 0 when idle. */
  lastTurnMs: number;
}

export interface ReplV2Options {
  cwd: string;
  initialPrompt?: string;
  status?: Partial<ReplV2Status>;
}

export interface ReplV2TranscriptEntry {
  kind: "user" | "assistant" | "thinking" | "plan" | "tool" | "info" | "error" | "system";
  /** Text payload. For tool entries, this is the result display string;
   *  for a tool's "run" line, leave it empty and pass the args via `meta`. */
  text: string;
  meta?: string;
  toolName?: string;
  toolStatus?: "run" | "ok" | "err";
}

// ---------- Pure rendering helpers ----------
// These are the testable surface. No I/O, no global state.

/** Render the header line that sits above the transcript. */
export function renderHeader(s: ReplV2Status): string {
  const session = s.session && s.session !== "—" ? s.session.slice(0, 8) : "—";
  return c.bold("ch") + c.gray(" · session ") + c.cyan(session) + c.gray(" · ") + c.cyan(s.model) + c.gray(" · ") + c.dim(s.cwd);
}

/** Render the footer (status) line. */
export function renderFooter(s: ReplV2Status): string {
  const session = s.session && s.session !== "—" ? s.session.slice(0, 8) : "—";
  const tokens = formatTokens(s.tokensIn, s.tokensOut);
  const steps = s.steps > 0 ? c.gray(s.steps + " steps") : c.gray("ready");
  const wall = s.lastTurnMs > 0 ? c.gray("· " + formatMs(s.lastTurnMs)) : "";
  return c.dim(s.model) + c.gray(" · ") + c.dim(tokens) + c.gray(" · ") + steps + c.gray(" · ") + wall + c.gray(" · session ") + c.cyan(session) + c.gray(" · ") + c.dim("/help");
}

/** Render a user prompt as it appears in the transcript. */
export function renderUserLine(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return c.green("user  ▸ ") + oneLine;
}

/** Render a complete assistant turn (already streamed). */
export function renderAssistantLine(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return c.bold("assistant ▸ ") + trimmed;
}

/** Render a "thinking" block. */
export function renderThinkingBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return c.dim("─── thinking ───\n") + c.dim(trimmed) + c.dim("\n─────────────");
}

/** Render a plan block. */
export function renderPlanBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return c.cyan("─── plan ───\n") + c.cyan(trimmed) + c.cyan("\n────────────");
}

/**
 * Render a tool call as an inline callout box.
 *
 *   [tool] spawn_subagent  agent=implement  prompt="…"
 *     ✓ [sub:implement status=ok steps=4 tokens=2100in/850out]
 *
 * When `detail` is short it sits on one line; when long, the second
 * line is truncated to 80 cols to keep the transcript scannable.
 */
export function renderToolCall(name: string, args: string, st: "run" | "ok" | "err", detail?: string): string {
  const argText = args ? truncateArgs(args) : "";
  const mark = st === "ok" ? c.green("✓") : st === "err" ? c.red("✗") : c.yellow("⋯");
  const color = st === "ok" ? c.green : st === "err" ? c.red : c.yellow;
  const header = c.gray("[") + color("tool") + c.gray("] ") + color(name) + (argText ? c.gray("  ") + c.dim(argText) : "");
  if (!detail) return header;
  return header + "\n  " + mark + " " + c.dim(truncateLine(detail, 80));
}

/** Render an info line. */
export function renderInfoLine(text: string): string {
  return c.cyan("· ") + text;
}

/** Render an error line. */
export function renderErrorLine(text: string): string {
  return c.red("! ") + text;
}

/** Render a system line (e.g. "/ help, / quit, etc."). */
export function renderSystemLine(text: string): string {
  return c.dim("· ") + text;
}

/** Render a slash command's output as a framed block (when multi-line). */
export function renderFramedBlock(title: string, body: string): string {
  const lines: string[] = [];
  lines.push(c.cyan("┌─ ") + c.bold(title));
  for (const line of body.split("\n")) lines.push(c.cyan("│  ") + line);
  lines.push(c.cyan("└─"));
  return lines.join("\n");
}

// ---------- Pure parsing helpers ----------

/**
 * Split a raw line into `(continues, text)`. A trailing `\` (with
 * optional whitespace) means "more on the next line" — strip the
 * backslash and signal continuation. Otherwise the line is complete.
 *
 * Matches the spec: `\` + Enter inserts a newline, Enter alone sends.
 *
 * A literal trailing backslash is escaped as `\\` so the prompt
 * doesn't stay open. We use a negative lookbehind so a `\\` at the
 * end does NOT trigger continuation.
 */
export function parseLineForContinuation(raw: string): { continues: boolean; text: string } {
  // (?<!\\)  negative lookbehind — fail if the previous char is `\`
  // \\       literal backslash
  // \s*$     optional trailing whitespace, then end of string
  if (/(?<!\\)\\\s*$/.test(raw)) {
    const body = raw.replace(/(?<!\\)\\\s*$/, "");
    const unescaped = body.replace(/\\\\/g, "\\");
    return { continues: true, text: unescaped + "\n" };
  }
  const unescaped = raw.replace(/\\\\/g, "\\");
  return { continues: false, text: unescaped };
}

/**
 * Build the prompt strings for the REPL. The first line uses `ch › `,
 * continuation lines use `... > ` so the user can see at a glance
 * whether they're inside a multi-line block.
 */
export function buildPrompts(): { primary: string; continuation: string } {
  return {
    primary: c.cyan("ch") + c.gray(" › "),
    continuation: c.gray("... › "),
  };
}

// ---------- Internal helpers ----------

function truncateArgs(args: string): string {
  // Try to pretty-print JSON object args as `key=value key=value`
  // (matches the spec sketch in §4.5). Fall back to a whitespace
  // collapse + 60-char cap when the args are not a JSON object.
  const obj = tryParseJsonObject(args);
  if (obj) {
    const parts: string[] = [];
    let used = 0;
    for (const [k, v] of Object.entries(obj)) {
      const s = summarizeValue(v);
      const piece = k + "=" + s;
      if (used + piece.length + 1 > 60) {
        parts.push("…");
        break;
      }
      parts.push(piece);
      used += piece.length + 1;
    }
    return parts.join(" ");
  }
  const trimmed = args.replace(/\s+/g, " ").trim();
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "…" : trimmed;
}

function tryParseJsonObject(s: string): Record<string, unknown> | null {
  const trimmed = s.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function summarizeValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") {
    const s = v.length > 24 ? v.slice(0, 21) + "…" : v;
    return JSON.stringify(s);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[" + v.length + "]";
  if (typeof v === "object") return "{…}";
  return String(v);
}

function truncateLine(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

function formatTokens(inTok: number, outTok: number): string {
  if (inTok === 0 && outTok === 0) return "0 in / 0 out";
  // Use the "1.2k" form for any count >= 100, raw for smaller. This
  // matches the spec sketch ("2.1k in / 0.9k out") and keeps the
  // footer from spamming the user with long integers.
  const fmt = (n: number) => {
    if (n >= 100) return (n / 1000).toFixed(1) + "k";
    return String(n);
  };
  return fmt(inTok) + " in / " + fmt(outTok) + " out";
}

function formatMs(ms: number): string {
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

function summarizeText(text: string, max = 36): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "—";
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

// ---------- The driver ----------

const RUNTIME_VERSION = "0.2.2";

/**
 * Run the streaming REPL. Returns when the user quits (Ctrl+D, /quit,
 * /exit, EOF on stdin, or SIGTERM).
 */
export async function runReplV2(
  runtime: HarnessRuntime,
  ctx: ReplV2Options,
): Promise<number> {
  const isTTY = !!process.stdin.isTTY && !!process.stdout.isTTY;

  // Non-TTY: fall through to the simple batch REPL. The legacy
  // `ch repl` path already handles this; calling this function with
  // a pipe stdin is treated as a one-shot prompt.
  if (!isTTY) {
    const { startRepl } = await import("./repl.js");
    if (ctx.initialPrompt) await runtime.runUserTurn(ctx.initialPrompt);
    return new Promise<number>((resolve) => {
      const repl = startRepl({
        onLine: async (line) => { await runtime.runUserTurn(line); },
      });
      const onSig = () => { repl.close(); resolve(0); };
      process.once("SIGINT", onSig);
      process.once("SIGTERM", onSig);
      const tick = setInterval(() => { if (runtime.shouldExit()) { clearInterval(tick); repl.close(); resolve(0); } }, 200);
    });
  }

  const status: ReplV2Status = {
    model: runtime.model() ?? "—",
    provider: runtime.providerId() ?? "—",
    session: runtime.sessionId() ?? "—",
    cwd: ctx.cwd,
    tokensIn: 0,
    tokensOut: 0,
    steps: 0,
    lastTurnMs: 0,
    ...ctx.status,
  };

  const prompts = buildPrompts();
  const transcript: ReplV2TranscriptEntry[] = [];
  let currentStreamText = "";
  let currentStreamTarget: "assistant" | "thinking" = "assistant";
  let currentTurnStart = 0;
  let busy = false;
  let quitRequested = false;
  let lastFooter = "";

  // --- Rendering helpers (closure over `status` + `transcript`) ---

  const printRaw = (s: string) => {
    if (rl) {
      rl.write(null as unknown as string);
      process.stdout.write(s + "\n");
      rl.prompt(true);
    } else {
      process.stdout.write(s + "\n");
    }
  };

  const redrawFooter = () => {
    const line = renderFooter(status);
    if (line === lastFooter) return;
    lastFooter = line;
    if (rl) {
      // Reprint the footer above the prompt. We don't try to clear
      // and rewrite the line in place — the transcript is already
      // scrolling, so a single footer line right above the prompt
      // is enough to keep the user oriented.
      rl.write(null as unknown as string);
      process.stdout.write(line + "\n");
      rl.prompt(true);
    }
  };

  const pushEntry = (e: ReplV2TranscriptEntry) => {
    transcript.push(e);
  };

  const renderEntry = (e: ReplV2TranscriptEntry): string => {
    switch (e.kind) {
      case "user":      return renderUserLine(e.text);
      case "assistant": return renderAssistantLine(e.text);
      case "thinking":  return renderThinkingBlock(e.text);
      case "plan":      return renderPlanBlock(e.text);
      case "tool":      return renderToolCall(e.toolName ?? "tool", e.meta ?? "", e.toolStatus ?? "ok", e.text);
      case "info":      return renderInfoLine(e.text);
      case "error":     return renderErrorLine(e.text);
      case "system":    return renderSystemLine(e.text);
    }
  };

  // --- Readline setup ---

  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: prompts.primary,
  });
  let activePrompt = prompts.primary;
  rl.setPrompt(activePrompt);
  rl.prompt();

  // --- Banner ---

  printRaw(renderHeader(status));
  if (runtime.isFirstRun?.()) {
    printRaw(renderInfoLine("no provider is configured yet. type /onboard to set one up, or /provider list to see what's supported."));
  } else {
    printRaw(renderSystemLine("type /help for commands. /goal is for multi-step work. \\ + Enter inserts a newline."));
  }

  // --- Approval flow (used by the bash tool) ---

  const clearApproval = runtime.setApprovalRequestHandler(async (command, reason) => {
    return askApprovalCli(command, reason);
  });

  // --- Output handler (used by `runtime.runUserTurn`) ---

  const clearOutput = runtime.setOutputHandler({
    onTextDelta: (t) => {
      currentStreamText += t;
    },
    onToolCallStart: (tc) => {
      // Flush any in-progress stream first so the callout lands at a
      // natural break in the transcript.
      if (currentStreamText) {
        pushEntry({ kind: currentStreamTarget, text: currentStreamText });
        const out = renderEntry(transcript[transcript.length - 1]!);
        if (out) printRaw(out);
        currentStreamText = "";
        currentStreamTarget = "assistant";
      }
      pushEntry({ kind: "tool", toolName: tc.name, meta: tc.argsJson, toolStatus: "run", text: "" });
      const out = renderEntry(transcript[transcript.length - 1]!);
      if (out) printRaw(out);
    },
    onToolCallEnd: (tc, r) => {
      // Push the result as its own entry so the callout shows the
      // final status icon. The args/meta stay on the run line above.
      pushEntry({ kind: "tool", toolName: tc.name, meta: tc.argsJson, toolStatus: r.isError ? "err" : "ok", text: r.display });
      const out = renderEntry(transcript[transcript.length - 1]!);
      if (out) printRaw(out);
    },
    onUsage: (u) => {
      status.tokensIn = u.inputTokens;
      status.tokensOut = u.outputTokens;
      redrawFooter();
    },
    onInfo: (text) => {
      if (!text) return;
      pushEntry({ kind: "info", text });
      const out = renderEntry(transcript[transcript.length - 1]!);
      if (out) printRaw(out);
    },
    onError: (e) => {
      pushEntry({ kind: "error", text: e.message });
      const out = renderEntry(transcript[transcript.length - 1]!);
      if (out) printRaw(out);
    },
    onTurnEnd: () => {
      if (currentStreamText) {
        pushEntry({ kind: currentStreamTarget, text: currentStreamText });
        const out = renderEntry(transcript[transcript.length - 1]!);
        if (out) printRaw(out);
        currentStreamText = "";
        currentStreamTarget = "assistant";
      }
    },
  });

  // --- Slash command dispatch + prompt run ---

  const setComposerMode = (mode: "plan" | "build") => {
    runtime.setComposerMode?.(mode);
    pushEntry({ kind: "info", text: "workflow set to " + mode });
    printRaw(renderEntry(transcript[transcript.length - 1]!));
  };

  const handleLine = async (raw: string) => {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) return;
    if (busy) {
      // Stash the line for the next turn — matches the spec's
      // mid-run steer behavior. We don't have a real SteerQueue yet
      // (Phase 1 deliverable is the REPL), so we just drop a hint.
      pushEntry({ kind: "info", text: "(busy — /steer is not yet implemented; ignoring: " + summarizeText(line, 36) + ")" });
      printRaw(renderEntry(transcript[transcript.length - 1]!));
      return;
    }
    busy = true;
    try {
      await dispatchLine(line);
    } catch (e) {
      pushEntry({ kind: "error", text: (e as Error).message });
      printRaw(renderEntry(transcript[transcript.length - 1]!));
    } finally {
      status.lastTurnMs = Date.now() - currentTurnStart;
      busy = false;
      redrawFooter();
    }
  };

  const dispatchLine = async (line: string) => {
    // Echo the user's input into the transcript first.
    pushEntry({ kind: "user", text: line });
    printRaw(renderEntry(transcript[transcript.length - 1]!));

    // Slash command?
    const parsed = tryParseSlash(line);
    if (parsed) {
      if (parsed.name === "plan" || parsed.name === "build") {
        setComposerMode(parsed.name);
        return;
      }
      const cmd = BUILTIN_REGISTRY.get(parsed.name);
      if (cmd) {
        try {
          const out = await cmd.run(parsed.args, { cwd: ctx.cwd, runtime: () => runtime });
          if (typeof out === "string" && out.length > 0) {
            // Multi-line output renders as a framed block so the user
            // can scan it as one unit. Short single-line results stay
            // as info messages.
            if (out.includes("\n") && out.length > 80) {
              pushEntry({ kind: "system", text: "/" + parsed.name + "\n" + out });
              printRaw(renderFramedBlock("/" + parsed.name, out));
            } else {
              pushEntry({ kind: "info", text: out });
              printRaw(renderEntry(transcript[transcript.length - 1]!));
            }
          } else if (cmd.name === "quit" || cmd.name === "exit") {
            quitRequested = true;
            try { rl.close(); } catch {}
            return;
          }
        } catch (e) {
          pushEntry({ kind: "error", text: (e as Error).message });
          printRaw(renderEntry(transcript[transcript.length - 1]!));
        }
        return;
      }
      pushEntry({ kind: "info", text: "unknown command: /" + parsed.name + " — use /help" });
      printRaw(renderEntry(transcript[transcript.length - 1]!));
      return;
    }

    await runPrompt(line);
  };

  const runPrompt = async (prompt: string) => {
    currentTurnStart = Date.now();
    status.session = runtime.sessionId() ?? status.session;

    let session;
    try {
      session = await runtime.ensureSession();
    } catch (e) {
      pushEntry({ kind: "error", text: "session error: " + (e as Error).message });
      printRaw(renderEntry(transcript[transcript.length - 1]!));
      return;
    }

    const { expandInputPrefixes } = await import("../util/input-prefixes.js");
    const expanded = await expandInputPrefixes(prompt, ctx.cwd);
    const effectivePrompt = expanded.prompt;
    const framedPrompt = framePromptForComposerMode(effectivePrompt, runtime.getComposerMode?.() ?? "build");
    await session.append({ kind: "message", message: { role: "user", content: framedPrompt } });
    const messages = sessionToMessages(session);

    const provider = runtime.providerRegistry.default();
    if (!provider) {
      pushEntry({ kind: "error", text: "no provider configured. set OPENAI_API_KEY or run /provider" });
      printRaw(renderEntry(transcript[transcript.length - 1]!));
      return;
    }
    const model = runtime.model();
    if (!model) {
      pushEntry({ kind: "error", text: "no model set. run /model <name>" });
      printRaw(renderEntry(transcript[transcript.length - 1]!));
      return;
    }

    pushEntry({ kind: "info", text: "thinking…" });
    printRaw(renderEntry(transcript[transcript.length - 1]!));

    try {
      const result = await runAgent({
        provider, model,
        system: await runtime.buildSystemPrompt(),
        messages,
        tools: runtime.tools,
        cwd: ctx.cwd,
        signal: new AbortController().signal,
        limits: { ...DEFAULT_LIMITS, bashTimeoutMs: runtime.settings.tools?.bashTimeoutMs ?? DEFAULT_LIMITS.bashTimeoutMs, readMaxBytes: runtime.settings.tools?.readMaxBytes ?? DEFAULT_LIMITS.readMaxBytes },
        failoverChain: runtime.buildFailoverChain(),
        hooks: {
          // The output handler is already wired via runtime.setOutputHandler;
          // runAgent will dispatch to it because it's registered.
        },
        onComplete: (m) => { void session.append({ kind: "message", message: m }); },
      });
      status.steps = result.steps;
      // Drain any leftover stream text.
      if (currentStreamText) {
        pushEntry({ kind: currentStreamTarget, text: currentStreamText });
        const out = renderEntry(transcript[transcript.length - 1]!);
        if (out) printRaw(out);
        currentStreamText = "";
        currentStreamTarget = "assistant";
      }
    } catch (e) {
      pushEntry({ kind: "error", text: "agent crashed: " + (e as Error).message });
      printRaw(renderEntry(transcript[transcript.length - 1]!));
    }
  };

  // --- Readline event loop ---

  let multilineBuf = "";
  rl.on("line", (raw) => {
    const parsed = parseLineForContinuation(raw);
    if (parsed.continues) {
      multilineBuf += parsed.text;
      activePrompt = prompts.continuation;
      rl.setPrompt(activePrompt);
      rl.prompt(true);
      return;
    }
    const fullLine = (multilineBuf + parsed.text).trim();
    multilineBuf = "";
    activePrompt = prompts.primary;
    rl.setPrompt(activePrompt);
    void handleLine(fullLine).then(() => {
      if (!quitRequested) rl.prompt(true);
    });
  });
  rl.on("close", () => {
    quitRequested = true;
  });

  // --- Initial prompt? ---

  if (ctx.initialPrompt && ctx.initialPrompt.trim().length > 0) {
    setTimeout(() => { void handleLine(ctx.initialPrompt!); }, 50);
  }

  // First-time footer so the user knows the model/tokens shape.
  redrawFooter();

  // --- Wait for quit / signal ---

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (quitRequested || runtime.shouldExit()) {
        clearInterval(check);
        resolve();
      }
    }, 200);
    process.once("SIGTERM", () => { quitRequested = true; });
  });

  clearOutput();
  clearApproval();
  try { rl.close(); } catch {}
  return 0;
}

// ---------- Approval (CLI/REPL) ----------

/**
 * Approval flow for the streaming REPL — a tiny line-mode modal.
 *
 * The full TUI modal lives in `./approval-modal.ts` and depends on
 * OpenTUI; the streaming REPL doesn't pull OpenTUI, so we ship a
 * minimal ANSI version. The behavior is the same: y / a / n / Esc.
 */
async function askApprovalCli(command: string, reason: string): Promise<ApprovalDecision> {
  process.stdout.write("\n");
  process.stdout.write(c.yellow("⚠ Bash command requires approval\n"));
  process.stdout.write(c.dim("  Reason: " + reason + "\n"));
  process.stdout.write(c.dim("  Command: " + truncateForApproval(command) + "\n"));
  process.stdout.write(c.cyan("  approve? [y] once · [a] always · [n] deny · [Esc] cancel  "));
  return new Promise<ApprovalDecision>((resolve) => {
    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      if (s === "\r" || s === "\n" || s === "y" || s === "Y") {
        cleanup(); process.stdout.write("\n"); resolve("allow-once");
      } else if (s === "a" || s === "A") {
        cleanup(); process.stdout.write("\n"); resolve("allow-always");
      } else if (s === "n" || s === "N" || s === "\x1b") {
        cleanup(); process.stdout.write("\n"); resolve("deny");
      }
    };
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      try { process.stdin.setRawMode?.(false); } catch {}
    };
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode?.(true); } catch {}
      process.stdin.resume();
      process.stdin.on("data", onData);
    } else {
      // Non-TTY fallback: default to deny so we never silently approve.
      cleanup();
      process.stdout.write("\n");
      resolve("deny");
    }
  });
}

function truncateForApproval(s: string): string {
  return s.length > 64 ? s.slice(0, 61) + "…" : s;
}

// ---------- Prompt framing (mirrors tui-app.ts) ----------

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
