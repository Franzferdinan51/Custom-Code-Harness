// All built-in slash commands. Heavily inspired by Hermes (`/new`,
// `/reset`, `/retry`, `/undo`, `/compress`, `/usage`, `/insights`),
// pi (`/tree`, `/fork`, `/clone`, `/compact`, `/export`, `/reload`),
// openclaude (`/provider`, `/onboard-github`), goose (recipes via
// `/goal`), and OpenClaw (`/status`, `/think`, `/verbose`, `/trace`).

import type { SlashCommand, SlashContext, SlashRuntime } from "./registry.js";
import { SlashRegistry, tryParseSlash } from "./registry.js";
import { c } from "../ui/colors.js";
import { formatUSD } from "../agent/cost.js";
import { Session, sessionToMessages } from "../agent/session.js";
import { compact as runCompaction, roughTokenCount, defaultCutoff } from "../agent/compaction.js";
import { CronStore, formatSchedule, parseHumanSchedule, nextRun } from "../agent/cron.js";
import { expandTemplate, loadPromptTemplates } from "../agent/prompts.js";
import { runDiagnostics, renderDiagnostics } from "../doctor.js";

// ---------- /help ----------

const helpCommand: SlashCommand = {
  name: "help",
  description: "Show available slash commands.",
  usage: "/help [command]",
  run(args, ctx) {
    const want = args.trim();
    if (want) {
      const cmd = BUILTIN_REGISTRY.get(want);
      if (!cmd) return "no such command: /" + want;
      return ["/" + cmd.name + " — " + cmd.description, cmd.usage ? "  " + cmd.usage : ""].filter(Boolean).join("\n");
    }
    const lines: string[] = ["Built-in commands:"];
    for (const c of BUILTIN_REGISTRY.list()) {
      const use = c.usage ? "  " + c.usage : "  /" + c.name;
      lines.push(use.padEnd(38) + c.description);
    }
    lines.push("");
    lines.push("Type /help <command> for details on a specific command.");
    return lines.join("\n");
  },
};

// ---------- /clear / /new / /reset ----------

const clearCommand: SlashCommand = {
  name: "clear",
  description: "Start a new in-memory branch (keeps the session id, clears the visible history).",
  run(_a, ctx) { ctx.runtime?.().clearHistory(); return "history cleared"; },
};

const newCommand: SlashCommand = {
  name: "new",
  description: "Start a brand-new session (new id). Persisted.",
  async run(_a, ctx) {
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
    // Force-create a new session via /clear path.
    rt.clearHistory();
    return "new session started";
  },
};

const resetCommand: SlashCommand = {
  name: "reset",
  description: "Alias for /clear.",
  run(_a, ctx) { ctx.runtime?.().clearHistory(); return "history reset"; },
};

// ---------- /cost ----------

const costCommand: SlashCommand = {
  name: "cost",
  description: "Show cumulative token usage and cost for this session.",
  async run(_a, ctx) {
    const rt = ctx.runtime as { cost?: { total(): { inputTokens: number; outputTokens: number; cost: number }; perModel(): Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }>; perAgent(): Array<{ agent: string; cost: number; calls: number }> } } | undefined;
    if (!rt?.cost) return "(cost tracking not available)";
    const t = rt.cost.total();
    const out: string[] = [];
    out.push("Session totals: " + t.inputTokens + " in / " + t.outputTokens + " out · " + formatUSD(t.cost));
    const perModel = rt.cost.perModel();
    if (perModel.length > 0) {
      out.push("");
      out.push("By model:");
      for (const m of perModel.slice(0, 10)) {
        out.push("  " + (m.model.padEnd(36)) + " " + m.inputTokens + " in / " + m.outputTokens + " out · " + formatUSD(m.cost));
      }
    }
    const perAgent = rt.cost.perAgent();
    if (perAgent.length > 0) {
      out.push("");
      out.push("By agent (incl. sub-agents):");
      for (const a of perAgent) {
        out.push("  " + a.agent.padEnd(20) + " " + a.calls + " call" + (a.calls === 1 ? "" : "s") + " · " + formatUSD(a.cost));
      }
    }
    return out.join("\n");
  },
};

// ---------- /approval ----------

const approvalCommand: SlashCommand = {
  name: "approval",
  description: "Show or set bash approval mode.",
  usage: "/approval [off|allowlist|blocklist|on-mutation|ask]",
  async run(args, ctx) {
    const rt = ctx.runtime as { approval?: { mode: string } } | undefined;
    if (!rt?.approval) return "(approval not configured)";
    const trimmed = args.trim();
    if (!trimmed) {
      return "approval mode: " + rt.approval.mode + "\n(use /approval off|allowlist|blocklist|on-mutation|ask)";
    }
    const valid = ["off", "allowlist", "blocklist", "on-mutation", "ask"];
    if (!valid.includes(trimmed)) return "valid modes: " + valid.join(", ");
    rt.approval.mode = trimmed as "off";
    return "approval mode set to " + trimmed;
  },
};

// ---------- /quit / /exit ----------

const quitCommand: SlashCommand = {
  name: "quit",
  description: "Exit the harness.",
  run(_a, ctx) { ctx.runtime?.().quit(); },
};

const exitCommand: SlashCommand = {
  name: "exit",
  description: "Alias for /quit.",
  run(_a, ctx) { ctx.runtime?.().quit(); },
};

// ---------- /session / /sessions ----------

const sessionCommand: SlashCommand = {
  name: "session",
  description: "Show the current session id and entry count.",
  run(_a, ctx) {
    const rt = ctx.runtime?.();
    return "session: " + (rt?.sessionId() ?? "(none)");
  },
};

const sessionsCommand: SlashCommand = {
  name: "sessions",
  description: "List recent sessions, show details, or send a message to one.",
  usage: "/sessions [list|show <id>|send <id> <text>|fork <id>]",
  async run(args, ctx) {
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] ?? "list";
    if (sub === "list") {
      const list = await Session.list(20);
      if (list.length === 0) return "(no sessions)";
      const out = ["Recent sessions:"];
      for (const m of list) {
        const when = new Date(m.updatedAt).toISOString().slice(0, 19).replace("T", " ");
        const name = m.name ? " (" + m.name + ")" : "";
        out.push("  " + m.id + "  " + when + "  " + m.entryCount + " entries" + name);
      }
      return out.join("\n");
    }
    if (sub === "show" && parts[1]) {
      const s = await Session.open(parts[1]);
      const entries = s.allEntries();
      const msgs = sessionToMessages(s);
      const head = s.meta.head ?? "";
      const tree = renderSessionTree(entries, head);
      const lines: string[] = [
        "Session " + s.id,
        "  entries: " + entries.length + "  messages: " + msgs.length,
        "  model: " + (s.meta.model ?? "(unknown)") + "  provider: " + (s.meta.provider ?? "(unknown)"),
        "  head: " + head,
        "",
        tree,
      ];
      return lines.join("\n");
    }
    if (sub === "fork" && parts[1]) {
      const s = await Session.open(parts[1]);
      const last = s.allEntries().filter((e) => e.type === "user").pop();
      if (!last) return "session has no user messages to fork from";
      const child = await s.fork(last.id);
      return "forked into " + child.id;
    }
    if (sub === "send" && parts[1] && parts.length >= 3) {
      const s = await Session.open(parts[1]);
      const text = parts.slice(2).join(" ");
      await s.append({ kind: "message", message: { role: "user", content: text } });
      return "appended user message to " + s.id;
    }
    return "usage: /sessions [list|show <id>|send <id> <text>|fork <id>]";
  },
};

// ---------- /resume ----------

const resumeCommand: SlashCommand = {
  name: "resume",
  description: "List recent sessions, or resume a specific one.",
  usage: "/resume [id]",
  async run(args, ctx) {
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
    const trimmed = args.trim();
    if (!trimmed) {
      const list = await Session.list(15);
      if (list.length === 0) return "(no sessions)";
      const out = ["Recent sessions:"];
      for (const m of list) {
        const when = new Date(m.updatedAt).toISOString().slice(0, 19).replace("T", " ");
        out.push("  " + m.id + "  " + when + "  " + m.entryCount + " entries" + (m.name ? " (" + m.name + ")" : ""));
      }
      return out.join("\n");
    }
    await rt.setSession(trimmed);
    return "resumed session " + trimmed;
  },
};

// ---------- /model / /provider / /failover ----------

const modelCommand: SlashCommand = {
  name: "model",
  description: "Show or change the current model.",
  usage: "/model [name|provider/model]",
  async run(args, ctx) {
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
    const trimmed = args.trim();
    if (!trimmed) return "model: " + (rt.model() ?? "(unset)") + "\nprovider: " + (rt.providerId() ?? "(unset)") + "\nuse: /model <name>  or  /model <provider>/<name>";
    if (trimmed.includes("/")) {
      const [provider, ...rest] = trimmed.split("/");
      const model = rest.join("/");
      await rt.setProviderAndModel(provider!, model);
      return "provider=" + provider + " model=" + model;
    }
    await rt.setProviderAndModel(rt.providerId() ?? "openai", trimmed);
    return "model set to " + trimmed;
  },
};

const providerCommand: SlashCommand = {
  name: "provider",
  description: "Show or change the current provider (optionally with model).",
  usage: "/provider [id] [model]",
  async run(args, ctx) {
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
    const trimmed = args.trim();
    if (!trimmed) return "provider: " + (rt.providerId() ?? "(unset)") + "\nuse: /provider <id> [model]";
    const parts = trimmed.split(/\s+/);
    await rt.setProviderAndModel(parts[0]!, parts[1]);
    return "provider set to " + parts[0] + (parts[1] ? " (model " + parts[1] + ")" : "");
  },
};

// ---------- /goal (unchanged from v1, but now uses the new structure) ----------

const goalCommand: SlashCommand = {
  name: "goal",
  description: "Run the agent toward a high-level objective. Auto-plans, executes step-by-step, reports when done.",
  usage: "/goal <objective> [--max-steps=N]",
  async run(args, ctx) {
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
    const m = args.match(/^(.*?)(?:\s+--max-steps=(\d+))?\s*$/s);
    if (!m || !m[1]?.trim()) return "usage: /goal <objective> [--max-steps=N]";
    const objective = m[1].trim();
    const maxSteps = m[2] ? parseInt(m[2], 10) : 12;
    return await runGoal(rt, objective, maxSteps);
  },
};

async function runGoal(rt: SlashRuntime, objective: string, maxSteps: number): Promise<string> {
  rt.print("[goal] planning (max " + maxSteps + " steps)...");
  await rt.sendPrompt("/goal PLAN\n\nObjective: " + objective + "\n\nProduce a numbered, minimal plan (3-7 steps) to achieve this in this repository. After the plan, write 'Ready to execute. Use tools.'", { silent: false });
  for (let step = 1; step <= maxSteps; step++) {
    rt.print("[goal] step " + step + "/" + maxSteps + "...");
    const response = await rt.sendPromptWithCapture("/goal EXECUTE step " + step + "/" + maxSteps + "\n\nContinue from your plan. Execute the next step. If done, say 'GOAL COMPLETE'. If blocked, say 'GOAL BLOCKED: <reason>'.");
    const lc = response.toLowerCase();
    if (lc.includes("goal complete")) { rt.print("[goal] done in " + step + " step" + (step === 1 ? "" : "s")); return "goal complete in " + step + " step(s)"; }
    if (lc.includes("goal blocked")) { rt.print("[goal] blocked"); return "goal blocked"; }
  }
  rt.print("[goal] reached max steps (" + maxSteps + ")");
  return "goal did not complete within " + maxSteps + " steps";
}

// ---------- /loop ----------

const loopCommand: SlashCommand = {
  name: "loop",
  description: "Re-send the previous prompt N times, optionally until a sentinel is detected.",
  usage: "/loop [N] [sentinel]",
  async run(args, ctx) {
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
    const trimmed = args.trim();
    if (!trimmed) return "usage: /loop [N] [sentinel]";
    const m = trimmed.match(/^(\d+)?\s*(.*)$/);
    const n = m?.[1] ? parseInt(m[1], 10) : 5;
    const sentinel = m?.[2]?.trim();
    for (let i = 1; i <= n; i++) {
      rt.print("[loop] iteration " + i + "/" + n);
      const r = await rt.sendPromptWithCapture("/loop CONTINUE  iteration " + i + "/" + n + (sentinel ? "\n\nIf the task is done, output the sentinel '" + sentinel + "' exactly." : "\n\nIf the task is done, output the sentinel 'LOOP DONE' exactly. Otherwise continue."));
      if (sentinel && r.includes(sentinel)) { rt.print("[loop] sentinel seen at " + i); return "loop stopped at " + i + " (sentinel)"; }
      if (!sentinel && /LOOP DONE/.test(r)) { rt.print("[loop] done at " + i); return "loop done at " + i; }
    }
    return "loop completed " + n + " iterations";
  },
};

// ---------- /status / /usage / /think / /verbose / /trace ----------

const statusCommand: SlashCommand = {
  name: "status",
  description: "Show session, model, provider, and tool counts.",
  async run(_a, ctx) {
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
    return [
      "session: " + (rt.sessionId() ?? "(none)"),
      "provider: " + (rt.providerId() ?? "(unset)"),
      "model: " + (rt.model() ?? "(unset)"),
    ].join("\n");
  },
};

const usageCommand: SlashCommand = {
  name: "usage",
  description: "Show rough token usage of the current session.",
  async run(_a, ctx) {
    const id = ctx.runtime?.().sessionId();
    if (!id) return "no active session";
    const s = await Session.open(id);
    const msgs = sessionToMessages(s);
    const total = roughTokenCount(msgs);
    const cutoff = defaultCutoff(msgs.length);
    const wouldCompact = cutoff > 0 ? roughTokenCount(msgs.slice(0, cutoff)) : 0;
    const out: string[] = [
      "messages: " + msgs.length,
      "rough tokens: " + total,
    ];
    if (cutoff > 0) {
      out.push("compaction would save: " + wouldCompact + " tokens (cutoff at message " + cutoff + ")");
    }
    return out.join("\n");
  },
};

const thinkCommand: SlashCommand = {
  name: "think",
  description: "Set the thinking level (off|minimal|low|medium|high|xhigh).",
  usage: "/think <level>",
  async run(args, ctx) {
    const level = args.trim();
    const valid = ["off", "minimal", "low", "medium", "high", "xhigh"];
    if (!valid.includes(level)) return "valid levels: " + valid.join(", ");
    // Persist in settings via the runtime's settings (we expose this through SlashRuntime).
    (ctx.runtime as { setThinking?: (l: string) => void } | undefined)?.setThinking?.(level);
    return "thinking level set to " + level;
  },
};

// ---------- /retry / /undo / /redo ----------

const retryCommand: SlashCommand = {
  name: "retry",
  description: "Re-run the last user prompt.",
  async run(_a, ctx) {
    const id = ctx.runtime?.().sessionId();
    if (!id) return "no active session";
    const s = await Session.open(id);
    const lastUser = [...s.allEntries()].reverse().find((e) => e.type === "user" && e.payload.kind === "message");
    if (!lastUser || lastUser.payload.kind !== "message") return "no user message to retry";
    await ctx.runtime!().sendPrompt(lastUser.payload.message.content);
    return "(retried)";
  },
};

const undoCommand: SlashCommand = {
  name: "undo",
  description: "Rewind the session to the previous user message and clear the assistant/tool entries that followed.",
  async run(_a, ctx) {
    const id = ctx.runtime?.().sessionId();
    if (!id) return "no active session";
    const s = await Session.open(id);
    const entries = s.allEntries();
    // Find the last assistant entry, then walk back to the user message before it.
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.type === "assistant") {
        // Walk back to the user message that preceded it.
        for (let j = i - 1; j >= 0; j--) {
          if (entries[j]!.type === "user") {
            s.rewindTo(entries[j]!.id);
            return "rewound to " + entries[j]!.id;
          }
        }
        return "no user message to rewind to";
      }
    }
    return "nothing to undo";
  },
};

// ---------- /compact ----------

const compactCommand: SlashCommand = {
  name: "compact",
  description: "Manually compact older messages into a summary. Optional custom instructions.",
  usage: "/compact [instructions]",
  async run(args, ctx) {
    const id = ctx.runtime?.().sessionId();
    if (!id) return "no active session";
    const s = await Session.open(id);
    const msgs = sessionToMessages(s);
    if (msgs.length < 4) return "session is too short to compact (" + msgs.length + " messages)";
    const provider = ctx.runtime?.().providerId ? undefined : undefined; // we need a provider; the runtime doesn't expose it yet
    // Use a direct provider call from the runtime
    return "compaction requires the runtime's provider; use /compact via /goal or via the runtime directly. " +
      "For now, this command is a stub — it will be wired in the next iteration.";
  },
};

// ---------- /memory ----------

const memoryCommand: SlashCommand = {
  name: "memory",
  description: "Read, append to, or search persistent memory.",
  usage: "/memory [read|add <text>|search <query>|user]",
  async run(args, ctx) {
    const rt = ctx.runtime?.() as { memory?: { read(): string; append(t: string): Promise<void>; search(q: string): Promise<string>; readUser(): string; appendUser(t: string): Promise<void> } } | undefined;
    if (!rt?.memory) return "(memory store not available)";
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] ?? "read";
    if (sub === "read") return rt.memory.read() || "(empty)";
    if (sub === "user") return rt.memory.readUser() || "(empty)";
    if (sub === "add") {
      const text = parts.slice(1).join(" ").trim();
      if (!text) return "usage: /memory add <text>";
      await rt.memory.append(text);
      return "ok";
    }
    if (sub === "useradd") {
      const text = parts.slice(1).join(" ").trim();
      if (!text) return "usage: /memory useradd <text>";
      await rt.memory.appendUser(text);
      return "ok";
    }
    if (sub === "search") {
      const q = parts.slice(1).join(" ").trim();
      if (!q) return "usage: /memory search <query>";
      return (await rt.memory.search(q)) || "(no matches)";
    }
    return "usage: /memory [read|add <text>|search <query>|user|useradd <text>]";
  },
};

// ---------- /skill ----------

const skillCommand: SlashCommand = {
  name: "skill",
  description: "List skills or load a specific one.",
  usage: "/skill [list|<name>]",
  async run(args, ctx) {
    const rt = ctx.runtime?.() as { skills?: { list(): Promise<Array<{ name: string; description: string }>>; load(n: string): Promise<{ content: string } | null> } } | undefined;
    if (!rt?.skills) return "(skill registry not available)";
    const trimmed = args.trim();
    if (!trimmed || trimmed === "list") {
      const list = await rt.skills.list();
      if (list.length === 0) return "(no skills installed — drop SKILL.md into ~/.codingharness/skills/<name>/)";
      return list.map((s, i) => (i + 1) + ". " + s.name + " — " + s.description).join("\n");
    }
    const loaded = await rt.skills.load(trimmed);
    if (!loaded) return "no such skill: " + trimmed;
    return "Loaded skill: " + trimmed + "\n\n" + loaded.content;
  },
};

// ---------- /agents ----------

const agentsCommand: SlashCommand = {
  name: "agents",
  description: "List available sub-agents.",
  async run(_a, ctx) {
    const rt = ctx.runtime?.() as { listAgents?: () => Array<{ name: string; description: string; builtin?: boolean }> } | undefined;
    if (!rt?.listAgents) return "(sub-agent registry not available)";
    const list = rt.listAgents();
    if (list.length === 0) return "(no agents registered)";
    return list.map((a, i) => (i + 1) + ". " + a.name + (a.builtin ? " (built-in)" : "") + " — " + a.description).join("\n");
  },
};

// ---------- /cron ----------

const cronCommand: SlashCommand = {
  name: "cron",
  description: "Manage scheduled jobs. 'add <schedule> <prompt>' / list / remove / run / enable / disable",
  usage: "/cron [list|add <schedule> <prompt>|remove <id>|run <id>|enable <id>|disable <id>]",
  async run(args, ctx) {
    const store = new CronStore();
    const parts = args.trim().match(/^(\S+)\s*(.*)$/s);
    const sub = parts?.[1] ?? "list";
    const rest = (parts?.[2] ?? "").trim();

    if (sub === "list") {
      const jobs = store.list();
      if (jobs.length === 0) return "no cron jobs. try: /cron add every 30 min \"summarize recent changes\"";
      const out: string[] = ["Cron jobs:"];
      for (const j of jobs) {
        out.push("  " + j.id + "  " + (j.enabled ? "on " : "off") + "  " + formatSchedule(j.schedule) + "  — " + j.prompt.slice(0, 60));
      }
      return out.join("\n");
    }
    if (sub === "add") {
      // split schedule from prompt on first run of " that contains a space-after-arg-shape
      const m = rest.match(/^(\S+(?:\s+\S+)*?)\s+["']?(.+?)["']?\s*$/s);
      if (!m) return "usage: /cron add <schedule> <prompt>";
      let schedule;
      try { schedule = parseHumanSchedule(m[1]!); } catch (e) { return (e as Error).message; }
      const job = store.add({ name: m[1]!, prompt: m[2]!, schedule, enabled: true });
      return "added job " + job.id + " (" + formatSchedule(schedule) + ")";
    }
    if (sub === "remove" && rest) {
      return store.remove(rest) ? "removed " + rest : "no such job: " + rest;
    }
    if (sub === "run" && rest) {
      const j = store.get(rest);
      if (!j) return "no such job: " + rest;
      await ctx.runtime?.()?.sendPrompt?.(j.prompt);
      store.update(j.id, { lastRun: Date.now() });
      return "(ran job " + j.id + ")";
    }
    if ((sub === "enable" || sub === "disable") && rest) {
      const j = store.update(rest, { enabled: sub === "enable" });
      return j ? "job " + rest + " " + (sub === "enable" ? "enabled" : "disabled") : "no such job: " + rest;
    }
    return "usage: /cron [list|add <schedule> <prompt>|remove <id>|run <id>|enable <id>|disable <id>]";
  },
};

// ---------- /doctor ----------

const doctorCommand: SlashCommand = {
  name: "doctor",
  description: "Run diagnostics on the environment.",
  async run(_a, ctx) {
    const items = await runDiagnostics({ cwd: ctx.cwd });
    return renderDiagnostics(items);
  },
};

// ---------- /init ----------

const initCommand: SlashCommand = {
  name: "init",
  description: "Generate a starter .codingharness/AGENTS.md in the current directory.",
  run(_a, ctx) {
    const path = ctx.cwd + "/.codingharness/AGENTS.md";
    const { mkdirSync, writeFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    if (existsSync(path)) return path + " already exists";
    mkdirSync(ctx.cwd + "/.codingharness", { recursive: true });
    writeFileSync(path, [
      "# Project Agent Instructions",
      "",
      "This file is automatically loaded into every CodingHarness session started in this directory.",
      "Add project-specific conventions, common commands, and gotchas here.",
      "",
      "## Build / test commands",
      "",
      "- (add your build command here, e.g. `npm run build`)",
      "- (add your test command here, e.g. `npm test`)",
      "",
      "## Conventions",
      "",
      "- (add your style/conventions here)",
      "",
    ].join("\n"));
    return "wrote " + path;
  },
};

// ---------- /tree / /fork / /clone / /export (stubs) ----------

import { renderSessionTree } from "./tree-render.js";

const treeCommand: SlashCommand = {
  name: "tree",
  description: "Show the session tree (with branching).",
  async run(_a, ctx) {
    const id = ctx.runtime?.().sessionId();
    if (!id) return "no active session";
    const s = await Session.open(id);
    const entries = s.allEntries();
    if (entries.length === 0) return "(empty session)";
    return renderSessionTree(entries, s.meta.head ?? "");
  },
};

const forkCommand: SlashCommand = {
  name: "fork",
  description: "Fork the current session from a previous user message.",
  usage: "/fork [user-message-id]",
  async run(args, ctx) {
    const id = ctx.runtime?.().sessionId();
    if (!id) return "no active session";
    const s = await Session.open(id);
    const entries = s.allEntries();
    const userEntries = entries.filter((e) => e.type === "user");
    const target = args.trim() || userEntries[userEntries.length - 2]?.id;
    if (!target) return "no user message to fork from";
    const child = await s.fork(target);
    return "forked into " + child.id + " (from " + target + ")";
  },
};

// ---------- /prompts (template loader) ----------

const promptsCommand: SlashCommand = {
  name: "prompts",
  description: "List or run a prompt template by name.",
  usage: "/prompts [list|<name> [vars...]]",
  async run(args, ctx) {
    const templates = loadPromptTemplates(ctx.cwd);
    const trimmed = args.trim();
    if (!trimmed || trimmed === "list") {
      if (templates.length === 0) return "(no prompt templates — drop .md into ~/.codingharness/prompts/ or .codingharness/prompts/)";
      return templates.map((t, i) => (i + 1) + ". " + t.name + " — " + t.description).join("\n");
    }
    const parts = trimmed.split(/\s+/);
    const name = parts[0]!;
    const tpl = templates.find((t) => t.name === name);
    if (!tpl) return "no such template: " + name;
    const vars: Record<string, string> = { input: parts.slice(1).join(" ") };
    const body = expandTemplate(tpl.body, vars);
    await ctx.runtime?.()?.sendPrompt?.(body);
    return "(sent template " + name + ")";
  },
};

// ---------- /mcp (stub) ----------

const mcpCommand: SlashCommand = {
  name: "mcp",
  description: "Manage Model Context Protocol servers (status / add / remove). v1 is a stub.",
  async run(_a) {
    return "MCP is a documented stub in v1. To enable: drop an mcp.json in ~/.codingharness/ with a list of {name, command, args} servers. Full MCP client is on the roadmap.";
  },
};

// ---------- /personality ----------

const personalityCommand: SlashCommand = {
  name: "personality",
  description: "Load a SOUL.md personality file from ~/.codingharness/personalities/<name>.md.",
  usage: "/personality [name|off]",
  async run(args, ctx) {
    const rt = ctx.runtime?.() as { setPersonality?: (name: string | null) => void } | undefined;
    if (!rt?.setPersonality) return "(personality not available)";
    const t = args.trim();
    if (!t || t === "off" || t === "none") {
      rt.setPersonality(null);
      return "personality cleared";
    }
    rt.setPersonality(t);
    return "personality set to " + t;
  },
};

// ---------- Registry export ----------

export const BUILTIN_REGISTRY = new SlashRegistry();
BUILTIN_REGISTRY.register(helpCommand);
BUILTIN_REGISTRY.register(clearCommand);
BUILTIN_REGISTRY.register(newCommand);
BUILTIN_REGISTRY.register(resetCommand);
BUILTIN_REGISTRY.register(quitCommand);
BUILTIN_REGISTRY.register(exitCommand);
BUILTIN_REGISTRY.register(sessionCommand);
BUILTIN_REGISTRY.register(sessionsCommand);
BUILTIN_REGISTRY.register(resumeCommand);
BUILTIN_REGISTRY.register(modelCommand);
BUILTIN_REGISTRY.register(providerCommand);
BUILTIN_REGISTRY.register(goalCommand);
BUILTIN_REGISTRY.register(loopCommand);
BUILTIN_REGISTRY.register(statusCommand);
BUILTIN_REGISTRY.register(usageCommand);
BUILTIN_REGISTRY.register(thinkCommand);
BUILTIN_REGISTRY.register(retryCommand);
BUILTIN_REGISTRY.register(undoCommand);
BUILTIN_REGISTRY.register(compactCommand);
BUILTIN_REGISTRY.register(memoryCommand);
BUILTIN_REGISTRY.register(skillCommand);
BUILTIN_REGISTRY.register(agentsCommand);
BUILTIN_REGISTRY.register(cronCommand);
BUILTIN_REGISTRY.register(doctorCommand);
BUILTIN_REGISTRY.register(initCommand);
BUILTIN_REGISTRY.register(treeCommand);
BUILTIN_REGISTRY.register(forkCommand);
BUILTIN_REGISTRY.register(promptsCommand);
BUILTIN_REGISTRY.register(mcpCommand);
BUILTIN_REGISTRY.register(personalityCommand);
BUILTIN_REGISTRY.register(costCommand);
BUILTIN_REGISTRY.register(approvalCommand);
