#!/usr/bin/env node
// CLI entrypoint. Subcommand router: `ch <subcommand> [args...]`.
//
// Subcommands follow the same pattern as `grok` / `grok agent` /
// `codex` / `claude`: a short noun, with mode-specific defaults.
// The legacy flag-style options (`-p`, `--doctor`, etc.) are still
// accepted for backward compatibility.

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import * as fs from "node:fs";
import { ensurePaths } from "./config/paths.js";
import { loadSettings } from "./config/settings.js";
import { HarnessRuntime } from "./runtime.js";
import { c } from "./ui/colors.js";
import { log } from "./util/logger.js";
import { BUILTIN_REGISTRY } from "./slash/builtin.js";
import { runTui, isTuiCapable } from "./ui/tui-app.js";

// ---------- Subcommand registry ----------

type SubcommandHandler = (ctx: SubcommandContext) => Promise<number>;

interface SubcommandContext {
  args: string[];
  cwd: string;
  ephemeral: boolean;
  provider?: string;
  model?: string;
  sessionId?: string;
  resume?: string;
  cont?: boolean;
  json?: boolean;
  print?: string;
  maxSteps?: string;
  port?: string;
  host?: string;
  noTui?: boolean;
  noOpen?: boolean;
  // Per-subcommand flag (used by `ch mcp`):
  stdio?: boolean;
  approveBash?: boolean;
  allowRemote?: boolean;
}

const SUBCOMMANDS = new Map<string, { description: string; usage: string; run: SubcommandHandler }>();
function registerSubcommand(name: string, description: string, usage: string, run: SubcommandHandler) {
  SUBCOMMANDS.set(name, { description, usage, run });
}

registerSubcommand("chat", "Start an interactive chat session (the default — uses the TUI when available).",
  "ch chat [--cwd <path>] [--provider <id>] [--model <name>] [-c | -r | -s <id>] [--no-tui]",
  async (ctx) => { return startReplSession(ctx); });

registerSubcommand("repl", "Force the simple line-based REPL (no TUI). Useful for piping or old terminals.",
  "ch repl [--cwd <path>] [--provider <id>] [--model <name>] [-c | -r | -s <id>]",
  async (ctx) => { return startReplSession({ ...ctx, noTui: true }); });

registerSubcommand("tui", "Force the full TUI (auto-detected by default in a TTY).",
  "ch tui",
  async (ctx) => { return startReplSession({ ...ctx, noTui: false }); });

registerSubcommand("run", "Quick one-shot: run a single prompt and exit.",
  "ch run <prompt>  [-p, --print] [--provider <id>] [--model <name>] [--cwd <path>]",
  async (ctx) => { return runOneShot(ctx, "run"); });

registerSubcommand("agent", "Autonomous agent mode. Full power: sub-agents, skills, tools.",
  "ch agent <task>  [--provider <id>] [--model <name>] [--cwd <path>]",
  async (ctx) => { return runOneShot(ctx, "agent"); });

registerSubcommand("code", "Code-focused agent. Like `agent` but with a code-editor persona.",
  "ch code <task>  [--provider <id>] [--model <name>] [--cwd <path>]",
  async (ctx) => { return runOneShot(ctx, "code"); });

registerSubcommand("goal", "Run the agent toward a high-level objective (multi-step, auto-planning).",
  "ch goal <objective>  [--max-steps=N]  [--provider <id>] [--model <name>]",
  async (ctx) => { return runGoalCmd(ctx); });

registerSubcommand("loop", "Re-send the previous (or new) prompt N times, with optional sentinel.",
  "ch loop [N] [sentinel] <prompt>  (or: ch loop N)",
  async (ctx) => { return runLoopCmd(ctx); });

registerSubcommand("doctor", "Run diagnostics and print the report.",
  "ch doctor",
  async (ctx) => { return runDoctorCmd(ctx); });

registerSubcommand("skills", "List installed skills.",
  "ch skills",
  async (ctx) => { return listSkillsCmd(ctx); });

registerSubcommand("agents", "List available sub-agents.",
  "ch agents",
  async (ctx) => { return listAgentsCmd(ctx); });

registerSubcommand("skill", "Run a skill: load it and feed to the agent.",
  "ch skill <name> [input...]",
  async (ctx) => { return runSkillCmd(ctx); });

registerSubcommand("memory", "Read, append, or search persistent memory.",
  "ch memory [read|add <text>|search <query>|user|useradd <text>]",
  async (ctx) => { return runMemoryCmd(ctx); });

registerSubcommand("cron", "Manage scheduled jobs.",
  "ch cron [list|add <schedule> <prompt>|remove <id>|run <id>|enable <id>|disable <id>]",
  async (ctx) => { return runCronCmd(ctx); });

registerSubcommand("sessions", "List, show, fork, or send to a session.",
  "ch sessions [list|show <id>|fork <id>|send <id> <text>]",
  async (ctx) => { return runSessionsCmd(ctx); });

registerSubcommand("init", "Generate a starter .codingharness/AGENTS.md in the current directory.",
  "ch init",
  async (ctx) => { return runInitCmd(ctx); });

registerSubcommand("serve", "Run a headless HTTP server that exposes the agent over an API + web UI.",
  "ch serve [--port <n>] [--host <addr>] [--no-open]",
  async (ctx) => { return runServeCmd(ctx); });

registerSubcommand("web", "Start the server AND open the web UI in your default browser.",
  "ch web [--port <n>] [--host <addr>]",
  async (ctx) => { return runWebCmd(ctx); });

registerSubcommand("update", "Update CodingHarness to the latest version and rebuild.",
  "ch update [--check] [--channel stable|beta|dev]",
  async (ctx) => { return runUpdateCmd(ctx); });

registerSubcommand("desktop", "Launch the native desktop app (Electron).",
  "ch desktop [args...]",
  async (ctx) => { return runDesktopCmd(ctx); });

registerSubcommand("mcp", "Run an MCP (Model Context Protocol) server exposing CodingHarness tools.",
  "ch mcp [--port <n>] [--host <addr>] [--stdio] [--approve-bash] [--allow-remote]",
  async (ctx) => { return runMcpCmd(ctx); });

registerSubcommand("export", "Export a session as a training-friendly JSONL trajectory.",
  "ch export [session-id|--latest] [--format hermes|openai|share] [--out <dir>]",
  async (ctx) => { return runExportCmd(ctx); });

// ---------- Help / version ----------

const VERSION = "0.2.2";

function showHelp(cmd?: string): number {
  if (cmd && SUBCOMMANDS.has(cmd)) {
    const s = SUBCOMMANDS.get(cmd)!;
    process.stdout.write(s.usage + "\n\n" + s.description + "\n");
    return 0;
  }
  const lines: string[] = [
    "CodingHarness — a versatile terminal coding harness.",
    "",
    "Usage: ch <subcommand> [args...]",
    "",
    "Subcommands:",
  ];
    const order = ["chat", "repl", "tui", "run", "agent", "code", "goal", "loop", "doctor", "skills", "agents", "skill", "memory", "cron", "sessions", "init", "serve", "web", "desktop", "mcp", "update", "export"];
  for (const name of order) {
    const s = SUBCOMMANDS.get(name);
    if (!s) continue;
    lines.push("  " + name.padEnd(10) + s.description);
  }
  lines.push("");
  lines.push("Run `ch help <subcommand>` for details. Inside the TUI, type `/help` for slash commands.");
  lines.push("");
  lines.push("Common options (work with most subcommands):");
  lines.push("  --cwd <path>          Working directory (default: process.cwd)");
  lines.push("  --provider <id>       Provider id (openai, anthropic, openrouter, ...)");
  lines.push("  --model <name>        Model name (e.g. gpt-4o, claude-sonnet-4-5)");
  lines.push("  -c, --continue        Continue the most recent session");
  lines.push("  -r, --resume [id]     Resume a session (lists if no id)");
  lines.push("  -s, --session <id>    Use a specific session");
  lines.push("  --no-session          Ephemeral mode (do not save)");
  lines.push("  --no-tui              Force the simple REPL (skip the TUI)");
  lines.push("  -j, --json            Output events as JSON lines (one-shot modes)");
  lines.push("  -p, --print <text>    Print mode (one-shot)");
  lines.push("");
  lines.push("Environment:");
  lines.push("  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL");
  lines.push("  CODEX_API_KEY, CODEX_BASE_URL, CODEX_MODEL");
  lines.push("  ANTHROPIC_API_KEY, ANTHROPIC_MODEL");
  lines.push("  XAI_API_KEY, XAI_BASE_URL, XAI_MODEL");
  lines.push("  GROK_API_KEY, GROK_BASE_URL, GROK_MODEL");
  lines.push("  MINIMAX_API_KEY, MINIMAX_BASE_URL, MINIMAX_MODEL");
  lines.push("  LMSTUDIO_API_KEY, LMSTUDIO_BASE_URL, LMSTUDIO_MODEL, LM_API_TOKEN");
  lines.push("  CH_HOME (default ~/.codingharness)");
  lines.push("  CODINGHARNESS_DEBUG=1 for verbose logging");
  lines.push("  NO_COLOR=1 to disable ANSI");
  lines.push("");
  lines.push("Examples:");
  lines.push("  ch");
  lines.push("  ch agent \"add a /healthcheck slash command\"");
  lines.push("  ch code \"explain src/cli.ts\"");
  lines.push("  ch goal \"wire up OAuth for the dashboard\" --max-steps=8");
  lines.push("  ch loop 5 \"run the test suite until it passes\"");
  lines.push("  ch doctor");
  lines.push("  ch sessions");
  lines.push("  ch update");
  lines.push("  ch web    # open the web UI in your default browser");
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

// ---------- Main router ----------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    return startReplSession({ args: [], cwd: process.cwd(), ephemeral: false });
  }

  if (argv[0]!.startsWith("-")) {
    return runLegacyFlagMode(argv);
  }

  if (argv[0] === "help") return showHelp(argv[1]);
  if (argv[0] === "version") { process.stdout.write("CodingHarness " + VERSION + "\n"); return 0; }
  if (argv[0] === "-h" || argv[0] === "--help") return showHelp();
  if (argv[0] === "-v" || argv[0] === "--version") { process.stdout.write("CodingHarness " + VERSION + "\n"); return 0; }

  const sub = SUBCOMMANDS.get(argv[0]!);
  if (sub) {
    const ctx = await buildContext(argv.slice(1));
    return await sub.run(ctx);
  }

  return startReplSession({ args: argv, cwd: process.cwd(), ephemeral: false, initialPrompt: argv.join(" ") });
}

// ---------- Context helper ----------

async function buildContext(args: string[]): Promise<SubcommandContext> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        cwd: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        "no-session": { type: "boolean" },
        continue: { type: "boolean", short: "c" },
        resume: { type: "string", short: "r" },
        session: { type: "string", short: "s" },
        json: { type: "boolean", short: "j" },
        print: { type: "string", short: "p" },
        "max-steps": { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
        "no-tui": { type: "boolean" },
        "no-open": { type: "boolean" },
        check: { type: "boolean" },
        channel: { type: "string" },
        stdio: { type: "boolean" },
        "approve-bash": { type: "boolean" },
        "allow-remote": { type: "boolean" },
      },
      allowPositionals: true,
      strict: false,
    });
  } catch (e) {
    process.stderr.write(c.red("error: ") + (e as Error).message + "\n");
    process.exit(2);
  }
  return {
    args: parsed.positionals,
    cwd: String(parsed.values.cwd ?? process.cwd()),
    ephemeral: !!parsed.values["no-session"],
    provider: parsed.values.provider ? String(parsed.values.provider) : undefined,
    model: parsed.values.model ? String(parsed.values.model) : undefined,
    cont: !!parsed.values.continue,
    resume: parsed.values.resume ? String(parsed.values.resume) : undefined,
    sessionId: parsed.values.session ? String(parsed.values.session) : undefined,
    json: !!parsed.values.json,
    print: parsed.values.print ? String(parsed.values.print) : undefined,
    maxSteps: parsed.values["max-steps"] ? String(parsed.values["max-steps"]) : undefined,
    port: parsed.values.port ? String(parsed.values.port) : undefined,
    host: parsed.values.host ? String(parsed.values.host) : undefined,
    noTui: !!parsed.values["no-tui"],
    noOpen: !!parsed.values["no-open"],
    stdio: !!parsed.values.stdio,
    approveBash: !!parsed.values["approve-bash"],
    allowRemote: !!parsed.values["allow-remote"],
  };
}

// ---------- Subcommand handlers ----------

async function startReplSession(ctx: SubcommandContext & { initialPrompt?: string }): Promise<number> {
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;

  // Decide TUI vs simple REPL.
  const wantTui = !ctx.noTui && isTuiCapable();

  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral });

  if (ctx.sessionId) {
    try { await runtime.setSession(ctx.sessionId); }
    catch (e) { process.stderr.write(c.red("error: ") + (e as Error).message + "\n"); return 1; }
  } else if (ctx.resume) {
    try { await runtime.setSession(ctx.resume); }
    catch (e) { process.stderr.write(c.red("error: ") + (e as Error).message + "\n"); return 1; }
  } else if (ctx.cont) {
    const { Session } = await import("./agent/session.js");
    const list = await Session.list(1);
    if (list[0]) { try { await runtime.setSession(list[0].id); } catch { /* ignore */ } }
  }

  if (wantTui) {
    return runTui(runtime, ctx);
  }

  return runSimpleRepl(runtime, ctx);
}

async function runSimpleRepl(runtime: HarnessRuntime, ctx: SubcommandContext & { initialPrompt?: string }): Promise<number> {
  const { startRepl } = await import("./ui/repl.js");
  if (ctx.initialPrompt) await runtime.runUserTurn(ctx.initialPrompt);

  if (process.stdout.isTTY) {
    const provider = runtime.providerId() ?? "(no provider)";
    const model = runtime.model() ?? "(no model)";
    process.stdout.write(c.bold("CodingHarness") + c.gray(" · ") + c.cyan(provider) + c.gray(" · ") + c.gray(model) + c.gray(" · ") + c.dim(ctx.cwd) + "\n");
    process.stdout.write(c.dim('type /help for commands, ctrl+c to abort a turn, ctrl+d to exit') + "\n\n");
  }

  const repl = startRepl({
    onLine: async (line) => { await runtime.runUserTurn(line); },
    onClose: () => { /* nothing */ },
  });
  process.on("SIGINT", () => { if (runtime.shouldExit()) process.exit(0); repl.abortCurrentTurn(); });

  await new Promise<void>((resolve) => {
    const tick = setInterval(() => { if (runtime.shouldExit()) { clearInterval(tick); resolve(); } }, 200);
  });
  repl.close();
  return 0;
}

async function runOneShot(ctx: SubcommandContext, mode: "run" | "agent" | "code"): Promise<number> {
  let prompt = ctx.args.join(" ").trim();
  if (!prompt && !process.stdin.isTTY) prompt = (await readStdin()).trim();
  if (!prompt) {
    process.stderr.write("error: " + mode + " needs a prompt (or pipe via stdin)\n");
    return 2;
  }
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;

  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral });
  if (ctx.sessionId) { try { await runtime.setSession(ctx.sessionId); } catch (e) { process.stderr.write(c.red("error: ") + (e as Error).message + "\n"); return 1; } }

  if (ctx.json) {
    const { runAgent, DEFAULT_LIMITS } = await import("./agent/loop.js");
    const provider = runtime.providerRegistry.default();
    if (!provider) { process.stderr.write("error: no provider configured\n"); return 1; }
    const model = runtime.model();
    if (!model) { process.stderr.write("error: no model configured\n"); return 1; }
    const { sessionToMessages } = await import("./agent/session.js");
    const session = await runtime.ensureSession();
    await session.append({ kind: "message", message: { role: "user", content: prompt } });
    const messages = sessionToMessages(session);
    let final = "";
    const ac = new AbortController();
    process.once("SIGINT", () => ac.abort());
    try {
      const result = await runAgent({
        provider, model,
        system: await runtime["buildSystemPrompt"](),
        messages,
        tools: runtime.tools,
        cwd: ctx.cwd,
        signal: ac.signal,
        limits: { ...DEFAULT_LIMITS },
        hooks: {
          onTextDelta: (t) => process.stdout.write(JSON.stringify({ type: "text", text: t }) + "\n"),
          onToolCallStart: (tc) => process.stdout.write(JSON.stringify({ type: "tool_call_start", name: tc.name }) + "\n"),
          onToolCallEnd: (tc, r) => process.stdout.write(JSON.stringify({ type: "tool_call_end", name: tc.name, isError: r.isError, display: r.display }) + "\n"),
          onUsage: (u) => process.stdout.write(JSON.stringify({ type: "usage", ...u }) + "\n"),
          onError: (e) => process.stdout.write(JSON.stringify({ type: "error", message: e.message }) + "\n"),
        },
      });
      final = result.final.content;
      await session.append({ kind: "message", message: result.final });
    } catch (e) {
      process.stdout.write(JSON.stringify({ type: "error", message: (e as Error).message }) + "\n");
      return 1;
    }
    process.stdout.write(JSON.stringify({ type: "done", final }) + "\n");
    return 0;
  }

  await runtime.runUserTurn(prompt);
  return 0;
}

async function runGoalCmd(ctx: SubcommandContext): Promise<number> {
  const objective = ctx.args.join(" ").trim();
  if (!objective) {
    process.stderr.write("usage: ch goal <objective> [--max-steps=N]\n");
    return 2;
  }
  const maxSteps = ctx.maxSteps ? parseInt(ctx.maxSteps, 10) : 12;
  if (!Number.isFinite(maxSteps) || maxSteps < 1) {
    process.stderr.write("error: --max-steps must be a positive integer\n");
    return 2;
  }
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral });
  const cmd = BUILTIN_REGISTRY.get("goal");
  if (!cmd) { process.stderr.write("error: /goal command missing\n"); return 1; }
  const out = await cmd.run(objective + " --max-steps=" + maxSteps, { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runLoopCmd(ctx: SubcommandContext): Promise<number> {
  const args = ctx.args;
  let n = 5;
  let sentinel = "";
  let promptParts = args;
  if (args.length > 0 && /^\d+$/.test(args[0]!)) {
    n = parseInt(args[0]!, 10);
    promptParts = args.slice(1);
  }
  if (promptParts.length > 0) sentinel = promptParts[0]!;
  if (!promptParts.slice(sentinel ? 1 : 0).join(" ").trim() && !ctx.cont) {
    process.stderr.write("usage: ch loop [N] [sentinel] <prompt>\n");
    return 2;
  }
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral });
  const cmd = BUILTIN_REGISTRY.get("loop");
  if (!cmd) { process.stderr.write("error: /loop command missing\n"); return 1; }
  const argsStr = n + " " + (sentinel || "");
  const out = await cmd.run(argsStr, { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runDoctorCmd(ctx: SubcommandContext): Promise<number> {
  const { runDiagnostics, renderDiagnostics } = await import("./doctor.js");
  const items = await runDiagnostics({ cwd: ctx.cwd });
  process.stdout.write(renderDiagnostics(items) + "\n");
  return 0;
}

async function listSkillsCmd(ctx: SubcommandContext): Promise<number> {
  const { SkillRegistry } = await import("./agent/skills.js");
  const reg = new SkillRegistry({ cwd: ctx.cwd });
  const all = await reg.list();
  if (all.length === 0) {
    process.stdout.write("(no skills installed — drop SKILL.md into ~/.codingharness/skills/<name>/)\n");
    return 0;
  }
  for (const s of all) process.stdout.write(s.name + " — " + s.description + "\n");
  return 0;
}

async function listAgentsCmd(ctx: SubcommandContext): Promise<number> {
  const { AgentRegistry } = await import("./agent/agents.js");
  const reg = new AgentRegistry({ cwd: ctx.cwd });
  for (const a of reg.list()) {
    process.stdout.write(a.name + (a.builtin ? " (built-in)" : "") + " — " + a.description + "\n");
  }
  return 0;
}

async function runSkillCmd(ctx: SubcommandContext): Promise<number> {
  const name = ctx.args[0];
  if (!name) { process.stderr.write("usage: ch skill <name> [input...]\n"); return 2; }
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral });
  const cmd = BUILTIN_REGISTRY.get("skill");
  if (!cmd) { process.stderr.write("error: /skill command missing\n"); return 1; }
  const out = await cmd.run([name, ...ctx.args.slice(1)].join(" "), { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runMemoryCmd(ctx: SubcommandContext): Promise<number> {
  const cmd = BUILTIN_REGISTRY.get("memory");
  if (!cmd) { process.stderr.write("error: /memory command missing\n"); return 1; }
  const out = await cmd.run(ctx.args.join(" "), { cwd: ctx.cwd, runtime: () => makeLightRuntime(ctx) });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runCronCmd(ctx: SubcommandContext): Promise<number> {
  const cmd = BUILTIN_REGISTRY.get("cron");
  if (!cmd) { process.stderr.write("error: /cron command missing\n"); return 1; }
  const out = await cmd.run(ctx.args.join(" "), { cwd: ctx.cwd, runtime: () => makeLightRuntime(ctx) });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runSessionsCmd(ctx: SubcommandContext): Promise<number> {
  const cmd = BUILTIN_REGISTRY.get("sessions");
  if (!cmd) { process.stderr.write("error: /sessions command missing\n"); return 1; }
  const out = await cmd.run(ctx.args.join(" "), { cwd: ctx.cwd, runtime: () => makeLightRuntime(ctx) });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runInitCmd(ctx: SubcommandContext): Promise<number> {
  const cmd = BUILTIN_REGISTRY.get("init");
  if (!cmd) { process.stderr.write("error: /init command missing\n"); return 1; }
  const out = await cmd.run("", { cwd: ctx.cwd });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runServeCmd(ctx: SubcommandContext): Promise<number> {
  const port = parseInt(ctx.port ?? "7777", 10);
  const host = ctx.host ?? "127.0.0.1";
  const noOpen = !!(ctx as { noOpen?: boolean }).noOpen;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    process.stderr.write("error: --port must be 1..65535\n");
    return 2;
  }
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: false });
  const { startServer } = await import("./server.js");
  await startServer(runtime, { port, host });
  return 0;
}

/**
 * `ch mcp` — run the MCP (Model Context Protocol) server.
 *
 * Exposes our tool registry to MCP-aware clients (Claude Code, Cursor,
 * mcporter, etc.) over JSON-RPC 2.0. Three transports are supported:
 *
 *   - HTTP+SSE (default):  POST /mcp for JSON-RPC, GET /sse for
 *                           Server-Sent Events. Binds to 127.0.0.1
 *                           by default; use --allow-remote to opt in
 *                           to 0.0.0.0 (NOT recommended — the MCP
 *                           server exposes code-execution tools).
 *   - stdio (`--stdio`):    newline-delimited JSON-RPC over
 *                           stdin/stdout. The canonical MCP IPC
 *                           transport; every MCP client can be
 *                           configured to talk to a stdio MCP server
 *                           by pointing it at the binary. The
 *                           Electron desktop uses this when it wants
 *                           in-process IPC without a port.
 *
 * The Electron desktop shell also spawns the HTTP version of this
 * server when the user runs `ch desktop` so external MCP clients can
 * drive the same tools.
 */
async function runMcpCmd(ctx: SubcommandContext): Promise<number> {
  const stdio = !!(ctx as { stdio?: boolean }).stdio;
  const approveBash = !!(ctx as { approveBash?: boolean }).approveBash;
  if (stdio) {
    return runMcpStdio(ctx, approveBash);
  }
  const port = parseInt(ctx.port ?? "3456", 10);
  const host = ctx.host ?? "127.0.0.1";
  const allowRemote = !!(ctx as { allowRemote?: boolean }).allowRemote;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    process.stderr.write("error: --port must be 1..65535\n");
    return 2;
  }
  ensurePaths();
  const { startMcpServer } = await import("./mcp-server.js");
  const r = await startMcpServer({
    port, host, cwd: ctx.cwd, approveBash, allowRemote,
  });
  // Stderr banner so the line is visible even when stdout is
  // redirected (some MCP clients capture stdout).
  process.stderr.write(c.cyan("CodingHarness MCP server listening on ") + r.url + "\n");
  process.stderr.write(c.dim(`  JSON-RPC:  POST ${r.url}/mcp\n`));
  process.stderr.write(c.dim(`  SSE:       GET  ${r.url}/sse\n`));
  process.stderr.write(c.dim(`  Health:    GET  ${r.url}/health\n`));
  process.stderr.write(c.dim(`  Tools:     ${r.tools.length} (${r.tools.filter(t => t.annotations?.destructiveHint).length} destructive)\n`));
  if (r.requiresApiKey) process.stderr.write(c.yellow("  Auth:      Bearer token required (MCP_API_KEY)\n"));
  // SIGINT / SIGTERM: stop the server cleanly.
  const onSig = () => { void r.stop().then(() => process.exit(0)); };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  return new Promise<number>((resolve) => {
    r.server.on("close", () => { process.removeListener("SIGINT", onSig); process.removeListener("SIGTERM", onSig); resolve(0); });
  });
}

async function runMcpStdio(ctx: SubcommandContext, approveBash: boolean): Promise<number> {
  ensurePaths();
  const { startMcpStdioServer } = await import("./mcp-server.js");
  const r = await startMcpStdioServer({
    cwd: ctx.cwd,
    approveBash,
  });
  // Banner to stderr (stdout is reserved for the JSON-RPC wire).
  process.stderr.write(c.cyan("CodingHarness MCP stdio server ready") + "\n");
  process.stderr.write(c.dim(`  Protocol:  ${"2025-06-18"}\n`));
  process.stderr.write(c.dim(`  Tools:     ${r.tools.length}\n`));
  const onSig = () => { void r.stop().then(() => process.exit(0)); };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  await r.done;
  process.removeListener("SIGINT", onSig);
  process.removeListener("SIGTERM", onSig);
  return 0;
}

async function runWebCmd(ctx: SubcommandContext): Promise<number> {
  const port = parseInt(ctx.port ?? "7777", 10);
  const host = ctx.host ?? "127.0.0.1";
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    process.stderr.write("error: --port must be 1..65535\n");
    return 2;
  }
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: false });
  const { startServer } = await import("./server.js");
  const url = `http://${host}:${port}/`;
  // Open the browser after a short delay (let the server start).
  setTimeout(() => { openBrowser(url).catch(() => {}); }, 300);
  await startServer(runtime, { port, host });
  return 0;
}

function openBrowser(url: string): Promise<void> {
  const { execFile } = require("node:child_process") as typeof import("node:child_process");
  return new Promise<void>((resolve, reject) => {
    const cmd = process.platform === "darwin" ? "open" :
                process.platform === "win32" ? "start" : "xdg-open";
    const args = process.platform === "win32" ? ["", url] : [url];
    execFile(cmd, args, (err) => err ? reject(err) : resolve());
  });
}

async function runUpdateCmd(ctx: SubcommandContext): Promise<number> {
  const channel = (ctx as { channel?: string }).channel ?? "stable";
  const checkOnly = !!(ctx as { check?: boolean }).check;
  const { runUpdate } = await import("./updater.js");
  return runUpdate({ cwd: ctx.cwd, channel, checkOnly });
}

/**
 * `ch desktop` — launch the native Electron desktop app.
 *
 * The `ch` binary is globally linked, but Electron is per-project
 * (lives in <project>/node_modules/.bin/electron). We find the
 * project root by:
 *
 *   1. Walking up from CWD looking for a package.json with
 *      "name": "codingharness".
 *   2. Falling back to the script's resolved location (for the
 *      case where `ch desktop` is run via `npm run desktop` from
 *      inside the project).
 *   3. If neither finds it, error with a hint to run from inside
 *      a CodingHarness checkout (or use `npm run electron`).
 */
async function runDesktopCmd(ctx: SubcommandContext): Promise<number> {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    process.stderr.write(c.red("error: ") + "could not locate a CodingHarness project root.\n");
    process.stderr.write("  Run `ch desktop` from inside a CodingHarness checkout, or use\n");
    process.stderr.write("  `npm run electron` from the project root.\n");
    return 1;
  }
  // Prefer the node_modules binary; fall back to the globally-installed one.
  const localBin = join(projectRoot, "node_modules", ".bin", "electron");
  const electronCmd = fs.existsSync(localBin) ? localBin : "electron";
  const args = ctx.args ?? [];
  process.stdout.write(c.dim("launching desktop from " + projectRoot) + "\n");
  const child = spawn(electronCmd, [projectRoot, ...args], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  // Forward exit code. Forward Ctrl+C / SIGTERM.
  const onSig = (sig: NodeJS.Signals) => { try { child.kill(sig); } catch {} };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  return new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => {
      process.removeListener("SIGINT", onSig);
      process.removeListener("SIGTERM", onSig);
      resolve(typeof code === "number" ? code : signal ? 1 : 0);
    });
    child.on("error", (err) => {
      process.stderr.write(c.red("error: ") + "failed to spawn electron: " + err.message + "\n");
      resolve(1);
    });
  });
}

function findProjectRoot(): string | null {
  const { existsSync, readFileSync } = fs;
  // 1. Walk up from CWD.
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const meta = JSON.parse(readFileSync(pkg, "utf-8"));
        if (meta.name === "codingharness") return dir;
      } catch { /* ignore */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 2. Walk up from the script's resolved location (handles
  //    `npm run desktop` from inside the project).
  try {
    const here = fileURLToPath(import.meta.url);
    dir = dirname(here);
    for (let i = 0; i < 8; i++) {
      const pkg = join(dir, "package.json");
      if (existsSync(pkg)) {
        try {
          const meta = JSON.parse(readFileSync(pkg, "utf-8"));
          if (meta.name === "codingharness") return dir;
        } catch { /* ignore */ }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* ignore */ }
  return null;
}

async function runExportCmd(ctx: SubcommandContext): Promise<number> {
  const args = ctx.args ?? [];
  let sessionId: string | null = null;
  let latest = false;
  let format: "hermes" | "openai" | "share" = "openai";
  let outDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--latest" || a === "-l") { latest = true; continue; }
    if (a.startsWith("--format=")) { format = a.slice("--format=".length) as "hermes" | "openai" | "share"; continue; }
    if (a === "--format" && args[i + 1]) { format = args[++i] as "hermes" | "openai" | "share"; continue; }
    if (a.startsWith("--out=")) { outDir = a.slice("--out=".length); continue; }
    if (a === "--out" && args[i + 1]) { outDir = args[++i]!; continue; }
    if (a.startsWith("--")) continue;
    if (!sessionId) { sessionId = a; continue; }
    process.stderr.write(c.yellow("warning: ignoring extra arg: ") + a + "\n");
  }
  if (!["hermes", "openai", "share"].includes(format)) {
    process.stderr.write(c.red("error: ") + "invalid --format: " + format + " (use hermes, openai, or share)\n");
    return 2;
  }
  const { Session } = await import("./agent/session.js");
  const { exportSession, defaultExportDir } = await import("./agent/trajectory.js");
  let session;
  try {
    if (latest || !sessionId) {
      const list = await Session.list(1);
      if (list.length === 0) { process.stderr.write(c.red("error: ") + "no sessions to export\n"); return 1; }
      session = await Session.open(list[0]!.id);
      process.stdout.write(c.dim("exporting latest session: " + list[0]!.id) + "\n");
    } else {
      session = await Session.open(sessionId);
    }
  } catch (e) {
    process.stderr.write(c.red("error: ") + (e as Error).message + "\n");
    return 1;
  }
  try {
    const r = await exportSession(session, { format, outDir: outDir ?? defaultExportDir() });
    process.stdout.write(c.green("✓ exported ") + r.lineCount + " line" + (r.lineCount === 1 ? "" : "s") + " to " + r.path + "\n");
    return 0;
  } catch (e) {
    process.stderr.write(c.red("error: ") + (e as Error).message + "\n");
    return 1;
  }
}

function makeLightRuntime(ctx: SubcommandContext): import("./runtime.js").HarnessRuntime {
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  return new HarnessRuntime({ cwd: ctx.cwd, ephemeral: true });
}

async function runLegacyFlagMode(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        print: { type: "string", short: "p" },
        json: { type: "boolean", short: "j" },
        continue: { type: "boolean", short: "c" },
        resume: { type: "string", short: "r" },
        session: { type: "string", short: "s" },
        "no-session": { type: "boolean" },
        "no-tui": { type: "boolean" },
        cwd: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        doctor: { type: "boolean" },
        skills: { type: "boolean" },
        agents: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: true,
    });
  } catch (e) {
    process.stderr.write(c.red("error: ") + (e as Error).message + "\n");
    return 2;
  }
  const opts = parsed.values;
  if (opts.help) return showHelp();
  if (opts.version) { process.stdout.write("CodingHarness " + VERSION + "\n"); return 0; }
  if (opts.doctor) return runDoctorCmd({ args: [], cwd: String(opts.cwd ?? process.cwd()), ephemeral: false });
  if (opts.skills) return listSkillsCmd({ args: [], cwd: String(opts.cwd ?? process.cwd()), ephemeral: false });
  if (opts.agents) return listAgentsCmd({ args: [], cwd: String(opts.cwd ?? process.cwd()), ephemeral: false });

  const positional = parsed.positionals.join(" ").trim();
  if (opts.print !== undefined) {
    let prompt = String(opts.print);
    if (!prompt) prompt = (await readStdin()).trim();
    if (positional) prompt = positional;
    if (!prompt) { process.stderr.write("error: --print needs a prompt or stdin\n"); return 2; }
    return runOneShot({ args: [prompt], cwd: String(opts.cwd ?? process.cwd()), ephemeral: !!opts["no-session"], provider: opts.provider ? String(opts.provider) : undefined, model: opts.model ? String(opts.model) : undefined, sessionId: opts.session ? String(opts.session) : undefined, json: !!opts.json, print: String(opts.print) }, "agent");
  }
  if (positional) {
    return runOneShot({ args: [positional], cwd: String(opts.cwd ?? process.cwd()), ephemeral: !!opts["no-session"], provider: opts.provider ? String(opts.provider) : undefined, model: opts.model ? String(opts.model) : undefined, sessionId: opts.session ? String(opts.session) : undefined, json: !!opts.json }, "agent");
  }
  if (!process.stdin.isTTY) {
    const stdin = (await readStdin()).trim();
    if (stdin) return runOneShot({ args: [stdin], cwd: String(opts.cwd ?? process.cwd()), ephemeral: !!opts["no-session"], provider: opts.provider ? String(opts.provider) : undefined, model: opts.model ? String(opts.model) : undefined, sessionId: opts.session ? String(opts.session) : undefined, json: !!opts.json }, "agent");
  }
  return startReplSession({ args: [], cwd: String(opts.cwd ?? process.cwd()), ephemeral: !!opts["no-session"], provider: opts.provider ? String(opts.provider) : undefined, model: opts.model ? String(opts.model) : undefined, sessionId: opts.session ? String(opts.session) : undefined, cont: !!opts.continue, resume: opts.resume ? String(opts.resume) : undefined, noTui: !!opts["no-tui"] });
}

async function startServer(runtime: import("./runtime.js").HarnessRuntime, opts: { port: number; host: string }): Promise<void> {
  // Delegated to ./server.js.
  const { startServer: realStartServer } = await import("./server.js");
  await realStartServer(runtime, opts);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => resolve(buf));
  });
}

main().then((code) => { process.exit(code); }).catch((e) => {
  process.stderr.write(c.red("fatal: ") + (e as Error).message + "\n");
  if (process.env.CODINGHARNESS_DEBUG) console.error(e);
  process.exit(1);
});
