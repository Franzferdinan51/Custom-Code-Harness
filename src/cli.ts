#!/usr/bin/env node
// CLI entrypoint. Subcommand router: `ch <subcommand> [args...]`.
//
// Subcommands follow the same pattern as `grok` / `grok agent` /
// `codex` / `claude`: a short noun, with mode-specific defaults.
// The legacy flag-style options (`-p`, `--doctor`, etc.) are still
// accepted for backward compatibility.

import { parseArgs } from "node:util";
import { spawn, execFile } from "node:child_process";
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
  /** Force the simple line-based REPL (`ch repl --simple`, `--no-tui`). */
  noTui?: boolean;
  /** Force the legacy OpenTUI TUI (`ch tui --legacy`, `CH_FORCE_TUI=1`). */
  legacy?: boolean;
  noOpen?: boolean;
  // Per-subcommand flag (used by `ch mcp`):
  stdio?: boolean;
  approveBash?: boolean;
  allowRemote?: boolean;
  lint?: boolean;
  fix?: boolean;
  oauth?: boolean;
  authChoice?: string;
  apiKey?: string;
  /** `ch goals revert <id> --to <n>` — target iteration for the
   *  revert (Q4 recommendation: revert to a specific
   *  currentIteration). Parsed globally so parseArgs consumes the
   *  value and doesn't leak it into positional args. */
  to?: string;
  /** Active mission id. Forwarded to `HarnessRuntime` so the
   *  GoalStore is constructed with the right per-mission file
   *  and the CLI surfaces the active mission in `ch info` /
   *  `ch goals` output. When unset, the runtime defaults to
   *  `DEFAULT_MISSION` ("default"). */
  mission?: string;
}

const SUBCOMMANDS = new Map<string, { description: string; usage: string; run: SubcommandHandler }>();
function registerSubcommand(name: string, description: string, usage: string, run: SubcommandHandler) {
  SUBCOMMANDS.set(name, { description, usage, run });
}

registerSubcommand("chat", "Start an interactive chat session. Default uses the streaming REPL; pass --legacy for the OpenTUI TUI, --no-tui for the simple line REPL.",
  "ch chat [--cwd <path>] [--provider <id>] [--model <name>] [-c | -r | -s <id>] [--legacy | --no-tui]",
  async (ctx) => { return startReplSession(ctx); });

registerSubcommand("repl", "Start the streaming REPL (the new default). Pass --no-tui for the simple line REPL, --legacy for the OpenTUI TUI.",
  "ch repl [--cwd <path>] [--provider <id>] [--model <name>] [-c | -r | -s <id>] [--legacy | --no-tui]",
  async (ctx) => { return startReplSession(ctx); });

registerSubcommand("tui", "Start the streaming REPL. Pass --legacy for the OpenTUI TUI. Env: CH_FORCE_TUI=1 forces legacy, CH_FORCE_REPL=1 forces the streaming REPL.",
  "ch tui [--legacy]",
  async (ctx) => { return startReplSession(ctx); });

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
  "ch goal <objective>  [--max-steps=N]  [--provider <id>] [--model <name>]  [--mission <id>]",
  async (ctx) => { return runGoalCmd(ctx); });

registerSubcommand("think", "Show or set the thinking level (off|minimal|low|medium|high|xhigh).",
  "ch think [level]",
  async (ctx) => { return runThinkCmd(ctx); });

registerSubcommand("verbose", "Show or toggle verbose runtime logging.",
  "ch verbose [on|off|toggle]",
  async (ctx) => { return runVerboseCmd(ctx); });

registerSubcommand("trace", "Show or toggle trace output for tool calls.",
  "ch trace [on|off|toggle]",
  async (ctx) => { return runTraceCmd(ctx); });

registerSubcommand("info", "Show runtime info: version, paths, provider, model.",
  "ch info [--json]",
  async (ctx) => { return runInfoCmd(ctx); });

registerSubcommand("loop", "Re-send the previous (or new) prompt N times, with optional sentinel.",
  "ch loop [N] [sentinel] <prompt>  (or: ch loop N)",
  async (ctx) => { return runLoopCmd(ctx); });

registerSubcommand("doctor", "Run diagnostics (OpenClaw-style: --lint --json --fix).",
  "ch doctor [--lint] [--json] [--fix]",
  async (ctx) => { return runDoctorCmd(ctx); });

registerSubcommand("welcome", "Print the quick-start card (4 commands to get going).",
  "ch welcome",
  async (_ctx) => { return runWelcomeCmd(); });

registerSubcommand("onboard", "First-run setup wizard (OpenClaw-style auth choices).",
  "ch onboard [--provider <id>] [--oauth | --api-key <key>]",
  async (ctx) => { return runOnboardCmd(ctx); });

registerSubcommand("provider", "Show, switch, or set up a provider (interactive on first run).",
  "ch provider [list|setup <id> [key]|set-key <id> <key>|models [id]|<id> [model]]",
  async (ctx) => { return runProviderCmd(ctx); });

registerSubcommand("diag", "Run a connectivity / latency check against the current provider + model.",
  "ch diag [--json]",
  async (ctx) => { return runDiagCmd(ctx); });

registerSubcommand("tokens", "Show the rough token count of the active session's messages.",
  "ch tokens",
  async (ctx) => { return runTokensCmd(ctx); });

registerSubcommand("skills", "List installed skills (or show one).",
  "ch skills [list|show <name>]",
  async (ctx) => { return listSkillsCmd(ctx); });

registerSubcommand("agents", "List available sub-agents (or show details for one).",
  "ch agents [list|show <name>]",
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

registerSubcommand("tree", "Show the active session tree (or the session selected with --session/--resume).",
  "ch tree [--session <id>|--resume <id>|-c]",
  async (ctx) => { return runTreeCmd(ctx); });

registerSubcommand("fork", "Fork the active session from a previous user message.",
  "ch fork [--session <id>|--resume <id>|-c] [user-message-id]",
  async (ctx) => { return runForkCmd(ctx); });

registerSubcommand("todo", "View or edit the in-session todo list.",
  "ch todo [list|add <text>|set <text>...|clear]",
  async (ctx) => { return runTodoCmd(ctx); });

registerSubcommand("compact", "Compact the active session and print the outcome.",
  "ch compact [--preview|--dry-run] [--session <id>|--resume <id>|-c] [instructions]",
  async (ctx) => { return runCompactCmd(ctx); });

registerSubcommand("init", "Generate a starter .codingharness/AGENTS.md in the current directory.",
  "ch init",
  async (ctx) => { return runInitCmd(ctx); });

registerSubcommand("serve", "Run a headless HTTP server that exposes the agent over an API + web UI (OpenCode-style sidecar).",
  "ch serve [--port <n>] [--host <addr>] [--no-open]",
  async (ctx) => { return runServeCmd(ctx); });

registerSubcommand("attach", "Attach a terminal REPL to a running ch serve instance (OpenCode attach).",
  "ch attach <url>   e.g. ch attach http://127.0.0.1:7777",
  async (ctx) => { return runAttachCmd(ctx); });

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

registerSubcommand("goals", "List, show, remove, revert, or clear persisted goals (Codex-style /goal lifecycle).",
  "ch goals [list|show <id>|remove <id>|revert <id> [--to <n>]|clear] [--json] [--mission <id>]",
  async (ctx) => { return runGoalsCmd(ctx); });

registerSubcommand("council", "Run a multi-agent council deliberation on a question (consensus or adversarial).",
  "ch council <question> [--mode consensus|adversarial] [--provider <id>] [--model <name>] [--rounds N] [--json] [--mission <id>]",
  async (ctx) => { return runCouncilCmd(ctx); });

// ---------- Help / version ----------

const VERSION = "0.2.2";

function showHelp(cmd?: string): number {
  if (cmd && SUBCOMMANDS.has(cmd)) {
    const s = SUBCOMMANDS.get(cmd)!;
    process.stdout.write(s.usage + "\n\n" + s.description + "\n");
    return 0;
  }
  // Grouped subcommand layout. Easy to scan; new users see "Get started"
  // first, then categories. Mirrors the desktop app's Quick Actions row.
  const groups: Array<{ title: string; blurb: string; names: string[] }> = [
    { title: "Get started", blurb: "Open the harness (OpenCode: serve + attach + web + desktop).",
      names: ["chat", "tui", "repl", "serve", "attach", "web", "desktop", "welcome", "onboard", "provider"] },
    { title: "Run a prompt", blurb: "One-shot, autonomous, or multi-step.",
      names: ["run", "agent", "code", "goal", "loop"] },
    { title: "Inspect & manage", blurb: "Sessions, memory, skills, scheduling, goals.",
      names: ["sessions", "tree", "fork", "todo", "compact", "memory", "skills", "agents", "skill", "cron", "init", "export", "goals"] },
    { title: "Settings", blurb: "Thinking level and model preferences.",
      names: ["think", "verbose", "trace"] },
    { title: "Health",         blurb: "Connectivity and diagnostics.",
      names: ["doctor", "diag", "tokens", "info"] },
    { title: "Integrate",      blurb: "MCP server, updates.",
      names: ["mcp", "update"] },
  ];
  const lines: string[] = [
    "CodingHarness — a versatile terminal coding harness.",
    "",
    "Usage: ch <subcommand> [args...]",
    "",
    "Quick start (OpenCode server-first + OpenClaw onboarding):",
    "  ch                        # open the TUI",
    "  ch serve                  # start the shared HTTP sidecar",
    "  ch attach http://127.0.0.1:7777   # terminal client to that server",
    "  ch web / ch desktop       # browser or Electron shell (same backend)",
    "  ch onboard --provider minimax --oauth   # OpenClaw-style provider auth",
    "  ch doctor --lint --json   # CI-friendly health check",
    "",
  ];
  for (const g of groups) {
    lines.push(g.title + " — " + g.blurb);
    for (const name of g.names) {
      const s = SUBCOMMANDS.get(name);
      if (!s) continue;
      lines.push("  " + name.padEnd(10) + s.description);
    }
    lines.push("");
  }
  lines.push("Run `ch help <subcommand>` for details on a specific command.");
  lines.push("Inside the TUI, type `/help` for the slash-command reference.");
  lines.push("");
  lines.push("Common options (work with most subcommands):");
  lines.push("  --cwd <path>          Working directory (default: process.cwd)");
  lines.push("  --provider <id>       Provider id (default: lmstudio — openai, anthropic, ...)");
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
  lines.push("  OPENROUTER_API_KEY, OPENROUTER_BASE_URL, OPENROUTER_MODEL");
  lines.push("  LMSTUDIO_API_KEY, LMSTUDIO_BASE_URL, LMSTUDIO_MODEL, LM_API_TOKEN");
  lines.push("  CH_HOME (default ~/.codingharness)");
  lines.push("  CH_FORCE_TUI=1  force the legacy OpenTUI TUI (for CI / scripts)");
  lines.push("  CH_FORCE_REPL=1 force the new streaming REPL");
  lines.push("  CODINGHARNESS_DEBUG=1 for verbose logging");
  lines.push("  NO_COLOR=1 to disable ANSI");
  lines.push("");
  lines.push("Examples:");
  lines.push("  ch");
  lines.push("  ch agent \"add a /healthcheck slash command\"");
  lines.push("  ch code \"explain src/cli.ts\"");
  lines.push("  ch goal \"wire up OAuth for the dashboard\" --max-steps=8");
  lines.push("  ch think high            # raise the thinking level");
  lines.push("  ch verbose on            # print extra runtime details");
  lines.push("  ch trace on              # print tool-call traces");
  lines.push("  ch loop 5 \"run the test suite until it passes\"");
  lines.push("  ch tree                  # inspect the active session tree");
  lines.push("  ch compact --preview     # preview a session compaction");
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
        legacy: { type: "boolean" },
        "no-open": { type: "boolean" },
        check: { type: "boolean" },
        channel: { type: "string" },
        stdio: { type: "boolean" },
        "approve-bash": { type: "boolean" },
        "allow-remote": { type: "boolean" },
        lint: { type: "boolean" },
        fix: { type: "boolean" },
        oauth: { type: "boolean" },
        "auth-choice": { type: "string" },
        "api-key": { type: "string" },
        to: { type: "string" },
        mission: { type: "string" },
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
    legacy: !!parsed.values.legacy,
    noOpen: !!parsed.values["no-open"],
    stdio: !!parsed.values.stdio,
    approveBash: !!parsed.values["approve-bash"],
    allowRemote: !!parsed.values["allow-remote"],
    lint: !!parsed.values.lint,
    fix: !!parsed.values.fix,
    oauth: !!parsed.values.oauth,
    authChoice: parsed.values["auth-choice"] ? String(parsed.values["auth-choice"]) : undefined,
    apiKey: parsed.values["api-key"] ? String(parsed.values["api-key"]) : undefined,
    to: parsed.values.to ? String(parsed.values.to) : undefined,
    mission: parsed.values.mission ? String(parsed.values.mission) : undefined,
  };
}

// ---------- Subcommand handlers ----------

async function hydrateRuntimeSession(runtime: HarnessRuntime, ctx: SubcommandContext): Promise<void> {
  if (ctx.sessionId) {
    await runtime.setSession(ctx.sessionId);
    return;
  }
  if (ctx.resume) {
    await runtime.setSession(ctx.resume);
    return;
  }
  if (ctx.cont) {
    const { Session } = await import("./agent/session.js");
    const list = await Session.list(1);
    if (list[0]) await runtime.setSession(list[0].id);
  }
}

async function startReplSession(ctx: SubcommandContext & { initialPrompt?: string }): Promise<number> {
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;

  // Decide which surface to launch. Order of precedence:
  //   1. Env vars:  CH_FORCE_TUI=1 → legacy OpenTUI TUI
  //                 CH_FORCE_REPL=1 → streaming REPL (forces TTY-bypass)
  //   2. CLI flags: --legacy → OpenTUI TUI; --no-tui → simple line REPL
  //   3. TTY:       simple REPL on pipe; streaming REPL on TTY;
  //                 OpenTUI TUI on TTY if user explicitly opted in.
  // The new default is the streaming REPL — same UX shape as Codex /
  // Claude Code / DuckHive. The OpenTUI four-pane TUI is still on disk
  // and reachable via `ch tui --legacy` (or `CH_FORCE_TUI=1`).
  const forceTui = process.env.CH_FORCE_TUI === "1";
  const forceRepl = process.env.CH_FORCE_REPL === "1";
  const wantLegacy = ctx.legacy || forceTui;
  const wantSimple = ctx.noTui || (forceRepl && !isTuiCapable() && process.stdin.isTTY === false);

  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });

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

  if (wantLegacy) {
    if (!isTuiCapable()) {
      // Legacy OpenTUI requires a real TTY. Fall back to the streaming
      // REPL so the user still gets an interactive surface.
      return runNewRepl(runtime, ctx);
    }
    try {
      return await runTui(runtime, ctx);
    } catch (e) {
      // @opentui/core lives in optionalDependencies. If the user installed
      // the package without it, the lazy dynamic import in tui-app.ts will
      // throw ERR_MODULE_NOT_FOUND the first time --legacy is requested.
      // Fall back to the streaming REPL with a clear warning so the user
      // knows how to recover.
      const msg = (e as Error)?.message ?? String(e);
      if (/Cannot find (?:module|package) ['"]@opentui\/core['"]|ERR_MODULE_NOT_FOUND.*@opentui/.test(msg)) {
        process.stderr.write(
          c.yellow("warning: ") +
          "the legacy OpenTUI TUI requires @opentui/core, which is not installed.\n" +
          "        Falling back to the streaming REPL. To enable the legacy TUI, run:\n" +
          "          npm install @opentui/core\n" +
          "        (or: `ch repl` for the streaming REPL, `ch repl --no-tui` for the line REPL)\n"
        );
        return runNewRepl(runtime, ctx);
      }
      throw e;
    }
  }

  if (wantSimple) {
    return runSimpleRepl(runtime, ctx);
  }

  // Default: new streaming REPL. The driver itself detects a pipe and
  // falls back to the simple line REPL (so piping stdin still works).
  return runNewRepl(runtime, ctx);
}

async function runNewRepl(runtime: HarnessRuntime, ctx: SubcommandContext & { initialPrompt?: string }): Promise<number> {
  const { runReplV2 } = await import("./ui/repl-v2.js");
  return runReplV2(runtime, { cwd: ctx.cwd, initialPrompt: ctx.initialPrompt });
}

async function runSimpleRepl(runtime: HarnessRuntime, ctx: SubcommandContext & { initialPrompt?: string }): Promise<number> {
  const { startRepl } = await import("./ui/repl.js");
  if (ctx.initialPrompt) await runtime.runUserTurn(ctx.initialPrompt);

  if (process.stdout.isTTY) {
    const provider = runtime.providerId() ?? "(no provider)";
    const model = runtime.model() ?? "(no model)";
    const thinking = runtime.settings.thinking ?? "medium";
    const flags = [
      runtime.settings.ui?.verbose ? "verbose" : "",
      runtime.settings.ui?.trace ? "trace" : "",
    ].filter(Boolean).join(" · ");
    process.stdout.write(c.bold("CodingHarness") + c.gray(" · ") + c.cyan(provider) + c.gray(" · ") + c.gray(model) + c.gray(" · ") + c.dim("thinking " + thinking) + (flags ? c.gray(" · ") + c.dim(flags) : "") + c.gray(" · ") + c.dim(ctx.cwd) + "\n");
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

  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
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
        system: await runtime.buildSystemPrompt(),
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

/**
 * `ch goal` — drive the goal state machine end-to-end.
 *
 * Phase 1 (port from agnt-gg/agnt): the goal record is a real state
 * machine, not a one-shot runner. We:
 *   1. Create a new goal in the `pending` loop state.
 *   2. Loop up to `maxSteps` iterations: planning → executing →
 *      evaluating. After each iteration we call `evaluate(goal)` and
 *      either advance to `done` (pass) or `re-planning` (fail). The
 *      runner calls `runAgent` from `src/agent/loop.ts` for the
 *      planning and executing steps.
 *   3. On terminal state, mark `status` (complete | failed) and print.
 *
 * The state machine is the same code path used by the `/goal` slash
 * command; the CLI just drives it directly without TTY capture.
 */
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
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
  const provider = runtime.providerRegistry.default();
  if (!provider) { process.stderr.write("error: no provider configured\n"); return 1; }
  const model = runtime.model();
  if (!model) { process.stderr.write("error: no model configured\n"); return 1; }

  // Phase 1 (p1-unify wireup): drive the goal through the unified
  // `Loop<"goal">` factory. The bridge to `runAgent` is provided as
  // the loop's `runAgent` input — the loop owns the state machine
  // and the lifecycle hooks, the CLI owns the user-facing output.
  const { GoalStore, formatGoalLine, goalLoop } =
    await import("./agent/goals.js");
  const { runAgent, DEFAULT_LIMITS } = await import("./agent/loop.js");
  type SuccessCriteria = import("./agent/goals.js").SuccessCriteria;
  const store = new GoalStore();

  // Optional: pull success criteria from --success <csv> if user passed it.
  let successCriteria: SuccessCriteria | undefined;
  const successArg = ctx.args.find((a) => a.startsWith("--success="));
  if (successArg) {
    successCriteria = {
      deliverables: successArg.slice("--success=".length).split(",").map((s) => s.trim()).filter(Boolean),
    };
  }

  // Bridge to runAgent. We rebuild a fresh system prompt + a single
  // user turn per state, so the model sees an isolated state.
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());

  const callAgent = async (phase: "planning" | "executing", context: { previousOutput?: string }): Promise<string> => {
    const system = await runtime.buildSystemPrompt();
    const prompt = phase === "planning"
      ? [
          "Goal mode: plan",
          "Objective: " + objective,
          "",
          "Produce a numbered, minimal plan (3-7 steps) to achieve this in the current repository.",
          "After the plan, write exactly: Ready to execute.",
        ].join("\n")
      : [
          "Goal mode: execute",
          "Objective: " + objective,
          "Plan summary: " + (context.previousOutput ?? "(no plan)").slice(0, 500),
          "",
          "Continue from the plan and execute the next step in the repository.",
          "If the objective is complete, say exactly: GOAL COMPLETE",
          "If you cannot continue, say exactly: GOAL BLOCKED: <reason>",
        ].join("\n");
    const messages: Array<{ role: "user"; content: string }> = [{ role: "user", content: prompt }];
    const result = await runAgent({
      provider,
      model,
      system,
      messages,
      tools: runtime.tools,
      cwd: ctx.cwd,
      signal: ac.signal,
      limits: { ...DEFAULT_LIMITS, maxSteps: 4, requestTimeoutMs: 30_000 },
    });
    return result.final.content;
  };

  try {
    const loop = goalLoop();
    const out = await loop.run(
      {
        objective,
        maxIterations: maxSteps,
        model,
        ...(ctx.provider !== undefined ? { providerId: ctx.provider } : {}),
        ...(successCriteria !== undefined ? { successCriteria } : {}),
        store,
        runAgent: async (phase, loopCtx) => {
          const content = await callAgent(phase, { previousOutput: loopCtx?.previousOutput });
          return { content, steps: 1 };
        },
      },
      {
        cwd: ctx.cwd,
        signal: ac.signal,
        hooks: {
          onInfo: (msg) => process.stdout.write(msg + "\n"),
          onState: (state) => {
            // The loop also drives onStateChange on the store; this
            // mirrors the iteration counter into the CLI's stdout.
            process.stdout.write("[goal] " + state + "\n");
          },
          onError: (err) => process.stderr.write("[goal] error: " + err.message + "\n"),
        },
      },
    );
    const final = out.goal;
    process.stdout.write(formatGoalLine(final) + "\n");
    if (out.finalText) {
      process.stdout.write("\n  result:\n");
      for (const line of out.finalText.split("\n")) process.stdout.write("    " + line + "\n");
    }
    return out.ok ? 0 : 1;
  } catch (e) {
    process.stderr.write("error: " + (e as Error).message + "\n");
    return 1;
  }
}

async function runThinkCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
  const cmd = BUILTIN_REGISTRY.get("think");
  if (!cmd) { process.stderr.write("error: /think command missing\n"); return 1; }
  const arg = ctx.args.join(" ").trim();
  const out = await cmd.run(arg, { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runVerboseCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
  const cmd = BUILTIN_REGISTRY.get("verbose");
  if (!cmd) { process.stderr.write("error: /verbose command missing\n"); return 1; }
  const arg = ctx.args.join(" ").trim();
  const out = await cmd.run(arg, { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runTraceCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
  const cmd = BUILTIN_REGISTRY.get("trace");
  if (!cmd) { process.stderr.write("error: /trace command missing\n"); return 1; }
  const arg = ctx.args.join(" ").trim();
  const out = await cmd.run(arg, { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

/** `ch info` — print a structured snapshot of the running install so
 *  the user can answer "where is my config?", "which provider is
 *  default?", "what version is this?" in a single command. */
async function runInfoCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const { collectRuntimeInfo, renderRuntimeInfo } = await import("./runtime/info.js");
  if (ctx.json) {
    process.stdout.write(JSON.stringify(collectRuntimeInfo(ctx.cwd), null, 2) + "\n");
    return 0;
  }
  process.stdout.write(renderRuntimeInfo(ctx.cwd) + "\n");
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
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
  // Phase 1 (p1-unify): the loop command is now a `Loop<"mission">`
  // wrapper. The mission loop owns the long-running semantics
  // (resumes, persists, sub-goals) — the slash command still does
  // the per-iteration N-times prompt because the `loop` is a
  // re-prompt pattern, not an objective-driven pattern. We register
  // the mission loop on the runtime for observability.
  const { missionLoop } = await import("./agent/loops/mission.js");
  void missionLoop();
  const cmd = BUILTIN_REGISTRY.get("loop");
  if (!cmd) { process.stderr.write("error: /loop command missing\n"); return 1; }
  const argsStr = n + " " + (sentinel || "");
  const out = await cmd.run(argsStr, { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runDoctorCmd(ctx: SubcommandContext): Promise<number> {
  const {
    runDiagnostics,
    renderDiagnostics,
    renderDiagnosticsJson,
    summarizeDiagnostics,
    applyDoctorFixes,
  } = await import("./doctor.js");
  let items = await runDiagnostics({ cwd: ctx.cwd });
  if (ctx.fix) {
    const applied = applyDoctorFixes(items);
    if (applied.length > 0) {
      for (const line of applied) process.stdout.write("fixed: " + line + "\n");
      items = await runDiagnostics({ cwd: ctx.cwd });
    }
  }
  if (ctx.json) {
    process.stdout.write(renderDiagnosticsJson(items) + "\n");
  } else {
    process.stdout.write(renderDiagnostics(items) + "\n");
  }
  const summary = summarizeDiagnostics(items);
  if (ctx.lint && !summary.ok) return 1;
  if (ctx.lint && summary.warnings > 0) return 2;
  return summary.errors > 0 ? 1 : 0;
}

/** Print the same quick-start card the TUI shows on launch. Shared
 *  source of truth lives in `slash/builtin.ts` so the four surfaces
 *  (TUI banner, /welcome slash, ch welcome CLI, web onboarding) stay
 *  in lockstep. */
async function runWelcomeCmd(): Promise<number> {
  const { renderQuickStart } = await import("./slash/builtin.js");
  process.stdout.write(renderQuickStart() + "\n");
  process.stdout.write("\nType `ch help` for the full subcommand list.\n");
  return 0;
}

/** `ch onboard` — first-run setup wizard. Same shape as the `/onboard`
 *  slash command, but prints to stdout so the user can read it
 *  without launching the TUI. */
async function runOnboardCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const { HarnessRuntime } = await import("./runtime.js");
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
  const providerId = ctx.provider ?? ctx.authChoice;
  const useOauth = !!ctx.oauth || (ctx.authChoice?.includes("oauth") ?? false);

  if (providerId) {
    const { getProviderPreset } = await import("./providers/presets.js");
    const preset = getProviderPreset(providerId);
    if (!preset) {
      process.stderr.write("unknown provider: " + providerId + "\n");
      return 2;
    }
    if (providerId === "codex" && (useOauth || preset.defaultAuthMode === "oauth")) {
      return runProviderCmd({ ...ctx, args: ["login", "codex"] });
    }
    if (useOauth && preset.authModes.includes("oauth")) {
      const { createInterface } = await import("node:readline");
      const { execFile } = await import("node:child_process");
      process.stdout.write("OpenClaw-style OAuth setup for " + preset.label + "\n");
      if (preset.authLaunchUrl) {
        process.stdout.write("  1. Sign in: " + preset.authLaunchUrl + "\n");
        const cmd = process.platform === "darwin" ? "open" :
                    process.platform === "win32" ? "start" : "xdg-open";
        const args = process.platform === "win32" ? ["", preset.authLaunchUrl] : [preset.authLaunchUrl];
        await new Promise<void>((resolve) => {
          execFile(cmd, args, () => resolve());
        }).catch(() => { /* browser open is best-effort */ });
      }
      process.stdout.write("  2. Paste the OAuth/session token below.\n");
      const token = await new Promise<string>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question("OAuth token: ", (answer) => { rl.close(); resolve(answer.trim()); });
      });
      if (!token || token.length < 8) {
        process.stderr.write("token too short (≥8 chars)\n");
        return 2;
      }
      runtime.settings.providers[providerId] = {
        id: providerId,
        authMode: "oauth",
        oauthToken: token,
        baseUrl: preset.defaultBaseUrl,
        model: preset.defaultModel,
      };
      runtime.settings.defaultProvider = providerId;
      runtime.settings.defaultModel = preset.defaultModel;
      const { saveSettings } = await import("./config/settings.js");
      saveSettings(runtime.settings);
      process.stdout.write("✓ saved OAuth token for " + preset.label + "\n");
      return 0;
    }
    if (ctx.apiKey) {
      const save = await runtime.saveProviderApiKey(providerId, ctx.apiKey);
      if (!save.ok) {
        process.stderr.write("could not save key: " + (save.reason ?? "unknown") + "\n");
        return 1;
      }
      process.stdout.write("✓ saved API key for " + preset.label + "\n");
      return 0;
    }
    const { renderProviderSetup } = await import("./provider/setup.js");
    process.stdout.write(renderProviderSetup(preset) + "\n");
    process.stdout.write("\nTip: ch onboard --provider " + providerId + " --oauth\n");
    process.stdout.write("     ch onboard --provider " + providerId + " --api-key <key>\n");
    return 0;
  }

  const cmd = BUILTIN_REGISTRY.get("onboard");
  if (!cmd) { process.stderr.write("error: /onboard command missing\n"); return 1; }
  const out = await cmd.run("", { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runAttachCmd(ctx: SubcommandContext): Promise<number> {
  const url = ctx.args[0];
  if (!url) {
    process.stderr.write("usage: ch attach <url>\n");
    process.stderr.write("example: ch attach http://127.0.0.1:7777\n");
    process.stderr.write("\nStart a server first:  ch serve --port 7777\n");
    return 2;
  }
  const { runAttachClient } = await import("./attach-client.js");
  return runAttachClient({ baseUrl: url });
}

/** `ch provider` — list, set up, set a key, or fast-switch.
 *  Mirrors `/provider` so the two surfaces can't disagree. */
async function runProviderCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const { HarnessRuntime } = await import("./runtime.js");
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
  const sub = ctx.args[0];

  // `ch provider list` — catalog.
  if (sub === "list") {
    const { renderProviderList } = await import("./provider/setup.js");
    process.stdout.write(renderProviderList() + "\n");
    return 0;
  }

  // `ch provider setup [id] [key]` — interactive setup.
  if (sub === "setup") {
    const { renderProviderSetup, parseProviderSetupArgs, renderProviderList } = await import("./provider/setup.js");
    const { getProviderPreset } = await import("./providers/presets.js");
    const setupArgs = ctx.args.slice(1).join(" ");
    if (!setupArgs.trim()) {
      process.stdout.write(renderProviderList() + "\n");
      return 0;
    }
    const parsed = parseProviderSetupArgs(setupArgs);
    if (!parsed) {
      process.stderr.write("no such provider. try: ch provider list\n");
      return 2;
    }
    const preset = getProviderPreset(parsed.providerId)!;
    // `ch provider setup <id>` (no key) — print the setup card.
    if (!parsed.apiKey) {
      process.stdout.write(renderProviderSetup(preset) + "\n");
      return 0;
    }
    // `ch provider setup <id> <key>` — save and verify.
    const save = await runtime.saveProviderApiKey(parsed.providerId, parsed.apiKey);
    if (!save.ok) {
      process.stderr.write("could not save key: " + (save.reason ?? "unknown") + "\n");
      return 1;
    }
    process.stdout.write("✓ saved API key for " + preset.label + "\n");
    process.stdout.write("  default model: " + (runtime.model() ?? preset.defaultModel) + "\n");
    process.stdout.write("\nRunning diag to verify...\n");
    try {
      const diag = await runtime.runDiag();
      process.stdout.write(diag.ok
        ? "✓ diag ok — first byte " + diag.firstByteMs + "ms, " + diag.totalMs + "ms total\n"
        : "✗ diag failed: " + (diag.error ?? "no response") + "\n");
      if (!diag.ok) return 1;
    } catch (e) {
      process.stderr.write("✗ diag crashed: " + (e as Error).message + "\n");
      return 1;
    }
    return 0;
  }

  // `ch provider set-key <id> <key>` — non-interactive save.
  if (sub === "set-key") {
    const id = ctx.args[1];
    const key = ctx.args.slice(2).join(" ");
    if (!id || !key) {
      process.stderr.write("usage: ch provider set-key <id> <key>\n");
      return 2;
    }
    const save = await runtime.saveProviderApiKey(id, key);
    if (!save.ok) {
      process.stderr.write("could not save key: " + (save.reason ?? "unknown") + "\n");
      return 1;
    }
    process.stdout.write("✓ saved API key for " + id + "\n");
    return 0;
  }

  // `ch provider login codex` — Codex device-code OAuth.
  if (sub === "login") {
    const target = ctx.args[1];
    if (target !== "codex") {
      process.stderr.write("usage: ch provider login codex\n");
      return 2;
    }
    const { buildCodexBrowserAuthUrl } = await import("./providers/oauth/codex.js");
    const { execFile } = await import("node:child_process");
    process.stdout.write("Starting Codex (ChatGPT) device-code login…\n");
    const login = await runtime.loginCodexOAuth({
      onProgress: (m) => { process.stdout.write(m + "\n"); },
      onDeviceCode: async (prompt) => {
        process.stdout.write("\nSign in with ChatGPT:\n");
        process.stdout.write("  URL:  " + buildCodexBrowserAuthUrl(prompt) + "\n");
        process.stdout.write("  Code: " + prompt.userCode + "\n\n");
      },
      openBrowser: async (url) => {
        const cmd = process.platform === "darwin" ? "open" :
                    process.platform === "win32" ? "start" : "xdg-open";
        const args = process.platform === "win32" ? ["", url] : [url];
        await new Promise<void>((resolve, reject) => {
          execFile(cmd, args, (err) => err ? reject(err) : resolve());
        }).catch(() => {
          process.stdout.write("(could not open browser — copy the URL above)\n");
        });
      },
    });
    if (!login.ok) {
      process.stderr.write("✗ login failed: " + (login.reason ?? "unknown") + "\n");
      return 1;
    }
    process.stdout.write("✓ Codex OAuth saved\n");
    process.stdout.write("  model: " + (runtime.model() ?? "(unset)") + "\n");
    return 0;
  }

  // `ch provider models [id]` — live /v1/models discovery.
  if (sub === "models") {
    const targetId = ctx.args[1] ?? runtime.providerId();
    if (!targetId) {
      process.stderr.write("usage: ch provider models [id]\n");
      return 2;
    }
    const provider = runtime.providerRegistry.get(targetId);
    if (!provider) {
      process.stderr.write("provider not configured: " + targetId + "\n");
      return 1;
    }
    if (typeof provider.listModels !== "function") {
      process.stderr.write("provider " + targetId + " does not support model discovery\n");
      return 1;
    }
    try {
      const models = await provider.listModels();
      if (models.length === 0) {
        process.stdout.write("(no models returned from " + targetId + " — server may be offline)\n");
        return 0;
      }
      process.stdout.write("Models served by " + targetId + " (" + models.length + "):\n");
      for (const m of models) process.stdout.write("  " + m + "\n");
      return 0;
    } catch (e) {
      process.stderr.write("listModels failed: " + (e as Error).message + "\n");
      return 1;
    }
  }

  // `ch provider` (no args) or `ch provider <id> [model]` — fast switch.
  const cmd = BUILTIN_REGISTRY.get("provider");
  if (!cmd) { process.stderr.write("error: /provider command missing\n"); return 1; }
  const out = await cmd.run(ctx.args.join(" "), { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function listSkillsCmd(ctx: SubcommandContext): Promise<number> {
  const { SkillRegistry } = await import("./agent/skills.js");
  const reg = new SkillRegistry({ cwd: ctx.cwd });
  // `ch skills show <name>` — focused one-skill view, same shape
  // as `/skill show <name>` inside the TUI.
  const sub = ctx.args[0];
  if (sub === "show") {
    const name = ctx.args[1];
    if (!name) {
      process.stderr.write("usage: ch skills show <name>\n");
      return 2;
    }
    const s = await reg.load(name);
    if (!s) {
      process.stderr.write("no such skill: " + name + "\n");
      return 1;
    }
    const meta = (await reg.list()).find((x) => x.name === name);
    const lines: string[] = [];
    lines.push("Skill: " + name);
    if (meta?.description) lines.push("  " + meta.description);
    lines.push("");
    lines.push(s.content);
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  }
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
  // `ch agents show <name>` — focused one-agent view, same shape
  // as `/agents <name>` inside the TUI. Both go through the same
  // formatting helpers so the two surfaces never drift.
  const sub = ctx.args[0];
  if (sub === "show" || sub === "get") {
    const name = ctx.args[1];
    if (!name) {
      process.stderr.write("usage: ch agents show <name>\n");
      return 2;
    }
    const a = reg.get(name);
    if (!a) {
      process.stderr.write("no such agent: " + name + "\n");
      return 1;
    }
    const lines: string[] = [];
    lines.push(a.name + (a.builtin ? " (built-in)" : ""));
    lines.push("  " + a.description);
    if (a.tags && a.tags.length > 0) lines.push("  tags: " + a.tags.join(", "));
    if (a.tools && a.tools.length > 0) lines.push("  tools: " + a.tools.join(", "));
    else if (a.tools !== undefined) lines.push("  tools: (none — read-only)");
    else lines.push("  tools: (inherits all parent tools)");
    if (a.maxSteps) lines.push("  max steps: " + a.maxSteps);
    if (a.model) lines.push("  model: " + a.model);
    if (a.providerId) lines.push("  provider: " + a.providerId);
    if (a.systemPrompt) {
      lines.push("  system prompt:");
      for (const line of a.systemPrompt.split("\n")) lines.push("    " + line);
    }
    if (a.systemPromptAppend) {
      lines.push("  appends:");
      for (const line of a.systemPromptAppend.split("\n")) lines.push("    " + line);
    }
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  }
  if (sub && sub !== "list") {
    // `ch agents <name>` — short form of `show`. If a single
    // argument matches a known agent name, show its details;
    // otherwise assume the user meant `list` and include the
    // unknown name in the error.
    const a = reg.get(sub);
    if (a) {
      // Tail-call the show branch by re-running with `show`.
      return listAgentsCmd({ ...ctx, args: ["show", sub] });
    }
    process.stderr.write("unknown subcommand or agent: " + sub + "\n");
    process.stderr.write("usage: ch agents [list|show <name>]\n");
    return 2;
  }
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
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
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
  const noOpen = !!ctx.noOpen;
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
  const stdio = !!ctx.stdio;
  const approveBash = !!ctx.approveBash;
  if (stdio) {
    return runMcpStdio(ctx, approveBash);
  }
  const port = parseInt(ctx.port ?? "3456", 10);
  const host = ctx.host ?? "127.0.0.1";
  const allowRemote = !!ctx.allowRemote;
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
  return new Promise<void>((resolve, reject) => {
    const cmd = process.platform === "darwin" ? "open" :
                process.platform === "win32" ? "start" : "xdg-open";
    const args = process.platform === "win32" ? ["", url] : [url];
    execFile(cmd, args, (err) => err ? reject(err) : resolve());
  });
}

async function runUpdateCmd(ctx: SubcommandContext): Promise<number> {
  // `channel` and `check` are parsed by the legacy flag-mode parseArgs, not
  // buildContext — read them defensively so a future move doesn't silently
  // break this path.
  const legacyCtx = ctx as SubcommandContext & { channel?: string; check?: boolean };
  const channel = legacyCtx.channel ?? "stable";
  const checkOnly = !!legacyCtx.check;
  const { runUpdate } = await import("./updater.js");
  return runUpdate({ cwd: ctx.cwd, channel, checkOnly });
}

async function runDiagCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: true });
  const r = await runtime.runDiag();
  if (ctx.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    if (!r.ok) {
      process.stdout.write(c.red("✗ diag failed") + "\n");
      process.stdout.write("  provider: " + (r.provider ?? "(none)") + "\n");
      process.stdout.write("  model:    " + (r.model ?? "(none)") + "\n");
      process.stdout.write("  error:    " + (r.error ?? "(unknown)") + "\n");
    } else {
      process.stdout.write(c.green("✓ diag ok") + "\n");
      process.stdout.write("  provider:  " + r.provider + "\n");
      process.stdout.write("  model:     " + r.model + "\n");
      process.stdout.write("  first-byte:" + r.firstByteMs + " ms\n");
      process.stdout.write("  total:     " + r.totalMs + " ms\n");
      process.stdout.write("  tokens:    " + r.inputTokens + " in / " + r.outputTokens + " out\n");
      if (r.reply) process.stdout.write("  reply:     " + JSON.stringify(r.reply) + "\n");
    }
  }
  return r.ok ? 0 : 1;
}

async function runTokensCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: false });
  const id = runtime.sessionId();
  if (!id) {
    process.stderr.write("no active session — start one with `ch chat` or pass a prompt\n");
    return 1;
  }
  const { Session, sessionToMessages } = await import("./agent/session.js");
  const { roughTokenCount } = await import("./agent/compaction.js");
  const s = await Session.open(id);
  const msgs = sessionToMessages(s);
  if (msgs.length === 0) {
    process.stdout.write("session has no messages yet\n");
    return 0;
  }
  const total = roughTokenCount(msgs);
  if (ctx.json) {
    process.stdout.write(JSON.stringify({ session: id, messages: msgs.length, tokens: total, breakdown: msgs.map((m) => ({ role: m.role, tokens: roughTokenCount([m]) })) }, null, 2) + "\n");
  } else {
    process.stdout.write("session:   " + id + "\n");
    process.stdout.write("messages:  " + msgs.length + "\n");
    process.stdout.write("tokens:    " + total + " (rough)\n");
    process.stdout.write("by role:\n");
    for (const m of msgs.slice(-10)) {
      process.stdout.write("  " + m.role.padEnd(10) + roughTokenCount([m]) + "\n");
    }
    if (msgs.length > 10) process.stdout.write("  …(" + (msgs.length - 10) + " earlier messages omitted)\n");
  }
  return 0;
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

async function runTreeCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
  try {
    await hydrateRuntimeSession(runtime, ctx);
  } catch (e) {
    process.stderr.write(c.red("error: ") + (e as Error).message + "\n");
    return 1;
  }
  const cmd = BUILTIN_REGISTRY.get("tree");
  if (!cmd) { process.stderr.write("error: /tree command missing\n"); return 1; }
  const out = await cmd.run("", { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runForkCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
  try {
    await hydrateRuntimeSession(runtime, ctx);
  } catch (e) {
    process.stderr.write(c.red("error: ") + (e as Error).message + "\n");
    return 1;
  }
  const cmd = BUILTIN_REGISTRY.get("fork");
  if (!cmd) { process.stderr.write("error: /fork command missing\n"); return 1; }
  const out = await cmd.run(ctx.args.join(" "), { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

/** `ch todo [list|add <text>|set <text>...|clear]` — view or edit
 *  the in-session todo list. Delegates to the /todo slash command
 *  so the two surfaces can't drift. */
async function runTodoCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
  try {
    await hydrateRuntimeSession(runtime, ctx);
  } catch (e) {
    process.stderr.write(c.red("error: ") + (e as Error).message + "\n");
    return 1;
  }
  const cmd = BUILTIN_REGISTRY.get("todo");
  if (!cmd) { process.stderr.write("error: /todo command missing\n"); return 1; }
  const out = await cmd.run(ctx.args.join(" "), { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
}

async function runCompactCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
  try {
    await hydrateRuntimeSession(runtime, ctx);
  } catch (e) {
    process.stderr.write(c.red("error: ") + (e as Error).message + "\n");
    return 1;
  }
  const cmd = BUILTIN_REGISTRY.get("compact");
  if (!cmd) { process.stderr.write("error: /compact command missing\n"); return 1; }
  const out = await cmd.run(ctx.args.join(" "), { cwd: ctx.cwd, runtime: () => runtime });
  if (typeof out === "string" && out.length > 0) process.stdout.write(out + "\n");
  return 0;
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
        legacy: { type: "boolean" },
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
  return startReplSession({ args: [], cwd: String(opts.cwd ?? process.cwd()), ephemeral: !!opts["no-session"], provider: opts.provider ? String(opts.provider) : undefined, model: opts.model ? String(opts.model) : undefined, sessionId: opts.session ? String(opts.session) : undefined, cont: !!opts.continue, resume: opts.resume ? String(opts.resume) : undefined, noTui: !!opts["no-tui"], legacy: !!opts.legacy });
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

async function runGoalsCmd(ctx: SubcommandContext): Promise<number> {
  ensurePaths();
  const { GoalStore, formatGoalLine, DEFAULT_MISSION } = await import("./agent/goals.js");
  const mission = ctx.mission ?? DEFAULT_MISSION;
  const store = new GoalStore({ mission });
  const sub = ctx.args[0];

  if (!sub || sub === "list") {
    const all = store.list();
    if (all.length === 0) {
      process.stdout.write("(no goals in mission \"" + mission + "\" — run `ch goal <objective>` to create one)\n");
      return 0;
    }
    if (ctx.json) {
      process.stdout.write(JSON.stringify(all, null, 2) + "\n");
      return 0;
    }
    process.stdout.write("Goals in mission \"" + mission + "\" (" + all.length + "):\n");
    for (const g of all) process.stdout.write("  " + formatGoalLine(g) + "\n");
    return 0;
  }

  if (sub === "show") {
    const id = ctx.args[1];
    if (!id) { process.stderr.write("usage: ch goals show <id>\n"); return 2; }
    const g = store.get(id);
    if (!g) { process.stderr.write("no such goal: " + id + "\n"); return 1; }
    if (ctx.json) { process.stdout.write(JSON.stringify(g, null, 2) + "\n"); return 0; }
    process.stdout.write(renderGoalDetail(g) + "\n");
    return 0;
  }

  if (sub === "remove") {
    const id = ctx.args[1];
    if (!id) { process.stderr.write("usage: ch goals remove <id>\n"); return 2; }
    const ok = store.remove(id);
    if (!ok) { process.stderr.write("no such goal: " + id + "\n"); return 1; }
    process.stdout.write("✓ removed " + id + "\n");
    return 0;
  }

  if (sub === "revert") {
    // `ch goals revert <id> --to <n>` — Q4 recommendation: revert to
    // a specific `currentIteration`. `--to` defaults to 1, the
    // "revert the last step" case. The goal is moved to the planning
    // state with the requested `currentIteration` so the next run
    // re-plans and re-executes from that point. Validates that
    // `--to` is a positive integer; bad input is a usage error
    // (exit code 2). Unknown id is a runtime error (exit code 1).
    const id = ctx.args[1];
    if (!id) { process.stderr.write("usage: ch goals revert <id> [--to <n>]\n"); return 2; }
    // `ctx.to` is set by `buildContext()` from `--to <n>` /
    // `--to=<n>`. When the user omits `--to` it is undefined and
    // we fall through to the default (1).
    const target = ctx.to !== undefined ? parseInt(ctx.to, 10) : 1;
    if (!Number.isFinite(target) || target < 1) {
      process.stderr.write("error: --to must be a positive integer (got " + (ctx.to ?? "(unset)") + ")\n");
      return 2;
    }
    if (!store.get(id)) { process.stderr.write("no such goal: " + id + "\n"); return 1; }
    // Revert to the "planning" state with the requested iteration —
    // this is the natural re-entry point for the goal-runner, which
    // re-runs planning→executing→evaluating starting from
    // `currentIteration`.
    const reverted = store.revert(id, "planning", { targetIteration: target });
    if (!reverted) { process.stderr.write("no such goal: " + id + "\n"); return 1; }
    if (ctx.json) {
      process.stdout.write(JSON.stringify(reverted, null, 2) + "\n");
      return 0;
    }
    process.stdout.write("✓ reverted " + id + " to iteration " + target + " (loopStatus=" + reverted.loopStatus + ")\n");
    return 0;
  }

  if (sub === "clear") {
    const n = store.clear();
    process.stdout.write("✓ cleared " + n + " terminal goal" + (n === 1 ? "" : "s") + "\n");
    return 0;
  }

  process.stderr.write("usage: ch goals [list|show <id>|remove <id>|revert <id> [--to <n>]|clear] [--json] [--mission <id>]\n");
  return 2;
}

function renderGoalDetail(g: import("./agent/goals.js").GoalRecord): string {
  const lines: string[] = [];
  lines.push("Goal: " + g.id);
  lines.push("  status:     " + g.status);
  lines.push("  steps:      " + g.stepsTaken + "/" + g.maxSteps);
  lines.push("  loop:       " + g.loopStatus + (g.currentIteration ? " (iter " + g.currentIteration + ")" : ""));
  if (g.lastError) lines.push("  lastError:  " + g.lastError);
  lines.push("  created:    " + new Date(g.createdAt).toISOString());
  lines.push("  updated:    " + new Date(g.updatedAt).toISOString());
  if (g.model) lines.push("  model:      " + g.model);
  if (g.providerId) lines.push("  provider:   " + g.providerId);
  if (g.mission) lines.push("  mission:    " + g.mission);
  if (g.parentGoalId) lines.push("  parent:     " + g.parentGoalId);
  if (g.successCriteria) {
    const d = g.successCriteria.deliverables ?? [];
    if (d.length > 0) {
      lines.push("  deliverables:");
      for (const x of d) lines.push("    - " + x);
    }
  }
  if (g.evaluations && g.evaluations.length > 0) {
    lines.push("  evaluations (" + g.evaluations.length + "):");
    for (const ev of g.evaluations) {
      const pass = ev.passed ? "✓" : "✗";
      lines.push("    " + pass + " iter " + ev.iteration + "  score=" + ev.score + "  " + ev.feedback);
    }
  }
  lines.push("  objective:");
  for (const line of g.objective.split("\n")) lines.push("    " + line);
  if (g.finalText) {
    lines.push("");
    lines.push("  result:");
    for (const line of g.finalText.split("\n")) lines.push("    " + line);
  }
  return lines.join("\n");
}

async function runCouncilCmd(ctx: SubcommandContext): Promise<number> {
  const args = ctx.args ?? [];
  let mode: "consensus" | "adversarial" = "consensus";
  let rounds: number | undefined;
  const questionParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--mode" && args[i + 1]) { mode = args[++i] as "consensus" | "adversarial"; continue; }
    if (a.startsWith("--mode=")) { mode = a.slice("--mode=".length) as "consensus" | "adversarial"; continue; }
    if (a === "--rounds" && args[i + 1]) { rounds = parseInt(args[++i]!, 10); continue; }
    if (a.startsWith("--rounds=")) { rounds = parseInt(a.slice("--rounds=".length), 10); continue; }
    if (a === "--provider" || a === "--model") { i++; continue; }
    if (a.startsWith("--provider=") || a.startsWith("--model=")) continue;
    if (a === "--json") continue;
    questionParts.push(a);
  }
  const question = questionParts.join(" ").trim();
  if (!question) {
    process.stderr.write("usage: ch council <question> [--mode consensus|adversarial] [--provider <id>] [--model <name>] [--rounds N] [--json]\n");
    return 2;
  }
  if (mode !== "consensus" && mode !== "adversarial") {
    process.stderr.write(c.red("error: ") + "invalid --mode: " + mode + " (use 'consensus' or 'adversarial')\n");
    return 2;
  }
  if (rounds !== undefined && (!Number.isFinite(rounds) || rounds < 1)) {
    process.stderr.write(c.red("error: ") + "--rounds must be a positive integer\n");
    return 2;
  }
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: ctx.ephemeral, mission: ctx.mission ?? "default" });
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());

  const { runCouncil, BUILTIN_COUNCILORS, DEFAULT_COUNCIL_ROSTER, renderCouncilResult, councilAsGoalLoop } =
    await import("./agent/council.js");
  // Phase 1 (p1-unify wireup): the council deliberation runs as a
  // `Loop<"goal">` lifecycle. The CLI keeps the rich transcript
  // output by performing the actual `runCouncil()` call inside the
  // loop's `runAgent` bridge — that way the goal's plan/execute/
  // evaluate state machine wraps the deliberation, and the goal
  // itself is persisted to the store (visible via `ch goals list`).
  const { GoalStore } = await import("./agent/goals.js");
  const store = new GoalStore();
  const roster = DEFAULT_COUNCIL_ROSTER.map((role) => BUILTIN_COUNCILORS[role]);

  try {
    // Hold the rich `CouncilResult` so the JSON / human transcript
    // output stays identical to the pre-wireup CLI.
    let richResult: Awaited<ReturnType<typeof runCouncil>> | null = null;
    const loop = councilAsGoalLoop();
    const out = await loop.run(
      {
        objective: question,
        maxIterations: 1,
        successCriteria: {
          deliverables: ["council: synthesize a final answer from " + roster.map((r) => r.role).join(", ")],
        },
        store,
        runAgent: async (phase, loopCtx) => {
          if (phase === "planning") {
            return {
              content: "council plan: one subagent per councilor (" +
                roster.map((r) => r.role).join(", ") + ") + synthesizer",
              steps: 0,
            };
          }
          // executing: do the actual council deliberation, capture
          // the rich result for the JSON / transcript output, and
          // return the synthesizer's final answer as the loop's
          // content so the goal's finalText reflects the council.
          richResult = await runCouncil(question, {
            mode,
            councilors: roster,
            maxRounds: rounds,
            model: ctx.model,
            providerId: ctx.provider,
            cwd: ctx.cwd,
            signal: ac.signal,
          }, {
            spawn: async (opts) => {
              // Bridge CouncilDeps.spawn to SubAgentManager.spawn by
              // registering a temporary ephemeral agent per call. This
              // keeps the council decoupled from the agent registry.
              const { AgentRegistry } = await import("./agent/agents.js");
              const reg = new AgentRegistry({ cwd: opts.cwd });
              const def = {
                name: "__councilor_" + Math.random().toString(36).slice(2, 8),
                description: "Ephemeral councilor",
                systemPromptAppend: opts.system,
                tools: [], // councilors: text-only, no tools
                maxSteps: 1,
                model: opts.model,
                providerId: opts.providerId,
                builtin: false,
              };
              reg.register(def);
              const { SubAgentManager } = await import("./agent/subagent.js");
              const mgr = new SubAgentManager(runtime.providerRegistry, runtime.settings, { cwd: opts.cwd });
              // Swap the registry so SubAgentManager picks up our
              // ephemeral def by name.
              (mgr as unknown as { agents: typeof reg }).agents = reg;
              const r = await mgr.spawn({
                agent: def.name,
                prompt: opts.prompt,
                model: opts.model,
                providerId: opts.providerId,
                cwd: opts.cwd,
                signal: opts.signal,
                ephemeral: true,
              });
              if (r.status === "ok") return { text: r.text, usage: r.usage };
              throw new Error(r.error ?? "councilor failed: " + r.status);
            },
          });
          return {
            content: richResult.final,
            steps: richResult.transcript.length,
          };
        },
      },
      {
        cwd: ctx.cwd,
        signal: ac.signal,
        hooks: {
          onInfo: (msg) => process.stdout.write(msg + "\n"),
          onState: (state) => process.stdout.write("[council:goal] " + state + "\n"),
          onError: (err) => process.stderr.write("[council:goal] error: " + err.message + "\n"),
        },
      },
    );
    if (!richResult) {
      // The loop completed without ever invoking runAgent (e.g. it
      // already had a matching goal in the store). Re-run the
      // council directly so the user still gets a transcript.
      richResult = await runCouncil(question, {
        mode,
        councilors: roster,
        maxRounds: rounds,
        model: ctx.model,
        providerId: ctx.provider,
        cwd: ctx.cwd,
        signal: ac.signal,
      }, {
        spawn: async (opts) => {
          const { AgentRegistry } = await import("./agent/agents.js");
          const reg = new AgentRegistry({ cwd: opts.cwd });
          const def = {
            name: "__councilor_" + Math.random().toString(36).slice(2, 8),
            description: "Ephemeral councilor",
            systemPromptAppend: opts.system,
            tools: [],
            maxSteps: 1,
            model: opts.model,
            providerId: opts.providerId,
            builtin: false,
          };
          reg.register(def);
          const { SubAgentManager } = await import("./agent/subagent.js");
          const mgr = new SubAgentManager(runtime.providerRegistry, runtime.settings, { cwd: opts.cwd });
          (mgr as unknown as { agents: typeof reg }).agents = reg;
          const r = await mgr.spawn({
            agent: def.name,
            prompt: opts.prompt,
            model: opts.model,
            providerId: opts.providerId,
            cwd: opts.cwd,
            signal: opts.signal,
            ephemeral: true,
          });
          if (r.status === "ok") return { text: r.text, usage: r.usage };
          throw new Error(r.error ?? "councilor failed: " + r.status);
        },
      });
    }
    if (ctx.json) {
      process.stdout.write(JSON.stringify(richResult, null, 2) + "\n");
    } else {
      process.stdout.write(renderCouncilResult(richResult) + "\n");
    }
    return out.ok ? 0 : 1;
  } catch (e) {
    process.stderr.write(c.red("error: ") + (e as Error).message + "\n");
    return 1;
  }
}

main().then((code) => { process.exit(code); }).catch((e) => {
  process.stderr.write(c.red("fatal: ") + (e as Error).message + "\n");
  if (process.env.CODINGHARNESS_DEBUG) console.error(e);
  process.exit(1);
});
