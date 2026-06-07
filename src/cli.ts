#!/usr/bin/env node
// CLI entrypoint. Subcommand router: `ch <subcommand> [args...]`.
//
// Subcommands follow the same pattern as `grok` / `grok agent` /
// `codex` / `claude`: a short noun, with mode-specific defaults.
// The legacy flag-style options (`-p`, `--doctor`, etc.) are still
// accepted for backward compatibility.

import { parseArgs } from "node:util";
import { ensurePaths } from "./config/paths.js";
import { loadSettings } from "./config/settings.js";
import { HarnessRuntime } from "./runtime.js";
import { startRepl } from "./ui/repl.js";
import { c } from "./ui/colors.js";
import { log } from "./util/logger.js";
import { tryParseSlash } from "./slash/registry.js";
import { BUILTIN_REGISTRY } from "./slash/builtin.js";

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
}

const SUBCOMMANDS = new Map<string, { description: string; usage: string; run: SubcommandHandler }>();
function registerSubcommand(name: string, description: string, usage: string, run: SubcommandHandler) {
  SUBCOMMANDS.set(name, { description, usage, run });
}

registerSubcommand("chat", "Start an interactive chat session (the default).",
  "ch chat [--cwd <path>] [--provider <id>] [--model <name>] [-c | -r | -s <id>]",
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

registerSubcommand("serve", "Run a headless HTTP server that exposes the agent over an API.",
  "ch serve [--port <n>] [--host <addr>]",
  async (ctx) => { return runServeCmd(ctx); });

// ---------- Help / version ----------

const VERSION = "0.2.0";

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
  const order = ["chat", "run", "agent", "code", "goal", "loop", "doctor", "skills", "agents", "skill", "memory", "cron", "sessions", "init", "serve"];
  for (const name of order) {
    const s = SUBCOMMANDS.get(name);
    if (!s) continue;
    lines.push("  " + name.padEnd(10) + s.description);
  }
  lines.push("");
  lines.push("Run `ch help <subcommand>` for details. Inside the REPL, type `/help` for slash commands.");
  lines.push("");
  lines.push("Common options (work with most subcommands):");
  lines.push("  --cwd <path>          Working directory (default: process.cwd)");
  lines.push("  --provider <id>       Provider id (openai, anthropic, openrouter, ...)");
  lines.push("  --model <name>        Model name (e.g. gpt-4o, claude-sonnet-4-5)");
  lines.push("  -c, --continue        Continue the most recent session");
  lines.push("  -r, --resume [id]     Resume a session (lists if no id)");
  lines.push("  -s, --session <id>    Use a specific session");
  lines.push("  --no-session          Ephemeral mode (do not save)");
  lines.push("  -j, --json            Output events as JSON lines (one-shot modes)");
  lines.push("  -p, --print <text>    Print mode (one-shot)");
  lines.push("");
  lines.push("Environment:");
  lines.push("  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL");
  lines.push("  ANTHROPIC_API_KEY, ANTHROPIC_MODEL");
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
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

// ---------- Main router ----------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    // Default: REPL.
    return startReplSession({ args: [], cwd: process.cwd(), ephemeral: false });
  }

  // First check: is the first arg a flag? Then it's the legacy flag-style mode.
  if (argv[0]!.startsWith("-")) {
    return runLegacyFlagMode(argv);
  }

  // First check: is it help/version?
  if (argv[0] === "help") return showHelp(argv[1]);
  if (argv[0] === "version") { process.stdout.write("CodingHarness " + VERSION + "\n"); return 0; }
  if (argv[0] === "-h" || argv[0] === "--help") return showHelp();
  if (argv[0] === "-v" || argv[0] === "--version") { process.stdout.write("CodingHarness " + VERSION + "\n"); return 0; }

  // Is it a known subcommand?
  const sub = SUBCOMMANDS.get(argv[0]!);
  if (sub) {
    const ctx = await buildContext(argv.slice(1));
    return await sub.run(ctx);
  }

  // Unknown: treat the whole thing as a prompt that starts the REPL with an initial line.
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
  };
}

// ---------- Subcommand handlers ----------

async function startReplSession(ctx: SubcommandContext & { initialPrompt?: string }): Promise<number> {
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;

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

  if (ctx.initialPrompt) {
    await runtime.runUserTurn(ctx.initialPrompt);
  }

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
    // JSON output mode: just stream events as JSONL.
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

  // Default text mode.
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
  // Parse: ch loop [N] [sentinel] <prompt>  OR  ch loop N
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
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    process.stderr.write("error: --port must be 1..65535\n");
    return 2;
  }
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  const runtime = new HarnessRuntime({ cwd: ctx.cwd, ephemeral: false });
  await startServer(runtime, { port, host });
  return 0;
}

// ---------- Lightweight runtime for "no model" subcommands ----------

/** Build a runtime that has settings/memory/skills wired but skips
 *  any provider/model setup. Used by subcommands that don't need
 *  the LLM (memory, cron, sessions, init, etc). */
function makeLightRuntime(ctx: SubcommandContext): HarnessRuntime {
  ensurePaths();
  const settings = loadSettings();
  if (ctx.provider) settings.defaultProvider = ctx.provider;
  if (ctx.model) settings.defaultModel = ctx.model;
  return new HarnessRuntime({ cwd: ctx.cwd, ephemeral: true });
}

// ---------- Legacy flag-mode ----------

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

  // Treat positional as prompt.
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
  return startReplSession({ args: [], cwd: String(opts.cwd ?? process.cwd()), ephemeral: !!opts["no-session"], provider: opts.provider ? String(opts.provider) : undefined, model: opts.model ? String(opts.model) : undefined, sessionId: opts.session ? String(opts.session) : undefined, cont: !!opts.continue, resume: opts.resume ? String(opts.resume) : undefined });
}

// ---------- Headless server ----------

async function startServer(runtime: HarnessRuntime, opts: { port: number; host: string }): Promise<void> {
  // Tiny HTTP API: POST /v1/chat { messages: [{role, content}] } -> { text, usage }
  // GET /v1/status -> { ok, model, provider }
  // GET /v1/sessions -> [...]
  // GET /v1/agents -> [...]
  // GET /v1/skills -> [...]
  const { createServer } = await import("node:http");
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "localhost"));
      if (req.method === "GET" && url.pathname === "/v1/status") {
        const body = JSON.stringify({
          ok: true,
          version: VERSION,
          model: runtime.model(),
          provider: runtime.providerId(),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/agents") {
        const body = JSON.stringify({ agents: runtime.subagents.list() });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/skills") {
        const all = await runtime.skills.list();
        const body = JSON.stringify({ skills: all.map((s) => ({ name: s.name, description: s.description })) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/sessions") {
        const { Session } = await import("./agent/session.js");
        const list = await Session.list(50);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessions: list }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const prompt = messages.length > 0 ? messages[messages.length - 1]?.content ?? "" : "";
        if (!prompt) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no messages" })); return; }
        const { runAgent, DEFAULT_LIMITS } = await import("./agent/loop.js");
        const { sessionToMessages } = await import("./agent/session.js");
        const provider = runtime.providerRegistry.default();
        if (!provider) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no provider" })); return; }
        const model = runtime.model() ?? "default";
        const session = await runtime.ensureSession();
        await session.append({ kind: "message", message: { role: "user", content: prompt } });
        const result = await runAgent({
          provider, model,
          system: await runtime["buildSystemPrompt"](),
          messages: sessionToMessages(session),
          tools: runtime.tools,
          cwd: process.cwd(),
          signal: new AbortController().signal,
          limits: { ...DEFAULT_LIMITS },
        });
        await session.append({ kind: "message", message: result.final });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: result.final.content, usage: result.usage, steps: result.steps }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/spawn") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        const agent = String(body.agent ?? "");
        const prompt = String(body.prompt ?? "");
        if (!agent || !prompt) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "agent and prompt required" })); return; }
        const r = await runtime.subagents.spawn({ agent, prompt, cwd: process.cwd(), signal: new AbortController().signal });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  server.listen(opts.port, opts.host, () => {
    process.stdout.write("CodingHarness server listening on http://" + opts.host + ":" + opts.port + "\n");
    process.stdout.write("  GET  /v1/status    — runtime info\n");
    process.stdout.write("  GET  /v1/agents    — list sub-agents\n");
    process.stdout.write("  GET  /v1/skills    — list skills\n");
    process.stdout.write("  GET  /v1/sessions  — list sessions\n");
    process.stdout.write("  POST /v1/chat      — { messages: [{role, content}] } -> { text, usage, steps }\n");
    process.stdout.write("  POST /v1/spawn     — { agent, prompt } -> sub-agent result\n");
  });
  await new Promise(() => { /* run until killed */ });
}

// ---------- Utilities ----------

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
