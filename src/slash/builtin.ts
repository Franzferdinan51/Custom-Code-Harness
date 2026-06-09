// All built-in slash commands. Primary CLI/desktop influences:
//   OpenCode — server-first (`ch serve` + `ch attach`), @file / !shell
//              prefixes, Build/Plan modes, desktop sidecar shell.
//   OpenClaw — `/status`, `/think`, `/verbose`, `/trace`, doctor --lint,
//              onboard auth choices, SOUL.md/TOOLS.md workspace context.
// Also borrowed from Hermes, pi, openclaude, and goose.

import type { SlashCommand, SlashContext, SlashRuntime } from "./registry.js";
import { SlashRegistry, tryParseSlash } from "./registry.js";
import { c } from "../ui/colors.js";
import { formatUSD } from "../agent/cost.js";
import { Session, sessionToMessages } from "../agent/session.js";
import { exportSession, defaultExportDir } from "../agent/trajectory.js";
import { compact as runCompaction, roughTokenCount, defaultCutoff, previewCompaction, formatCompactionPreview } from "../agent/compaction.js";
import { CronStore, formatSchedule, parseHumanSchedule, nextRun } from "../agent/cron.js";
import { expandTemplate, loadPromptTemplates } from "../agent/prompts.js";
import { runDiagnostics, renderDiagnostics } from "../doctor.js";
import type { AgentDefinition } from "../agent/agents.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

// ---------- /help ----------

const HELP_GROUPS: Array<{ id: string; title: string; blurb: string }> = [
  { id: "workflow", title: "Workflow",  blurb: "Run, schedule, or repeat work." },
  { id: "session",  title: "Session",   blurb: "Control the conversation history and branches." },
  { id: "model",    title: "Model",     blurb: "Switch provider or model on the fly." },
  { id: "context",  title: "Context",   blurb: "Manage memory, skills, and loaded context." },
  { id: "tools",    title: "Tools",     blurb: "Sub-agents, shell approval, and project setup." },
  { id: "settings", title: "Settings",  blurb: "Personality, thinking level, and approval." },
  { id: "status",   title: "Status",    blurb: "Inspect cost, tokens, sessions, and health." },
];

/** The 4 commands we show to a brand-new user. Kept in one place so the
 *  TUI banner, the `/help` quick-start, the web UI onboarding card, and
 *  the `ch welcome` subcommand all stay in sync. */
export const QUICK_START: ReadonlyArray<{ cmd: string; label: string; hint: string }> = [
  { cmd: "help",     label: "/help",     hint: "Show all commands (grouped)" },
  { cmd: "model",    label: "/model",    hint: "Switch model — /model <name>" },
  { cmd: "goal",     label: "/goal",     hint: "Multi-step objective — /goal <task>" },
  { cmd: "status",   label: "/status",   hint: "Session, model, and tool summary" },
];

const helpCommand: SlashCommand = {
  name: "help",
  description: "Show available slash commands (or details on one).",
  group: "session",
  usage: "/help [command]",
  run(args, ctx) {
    const want = args.trim();
    if (want) {
      const cmd = BUILTIN_REGISTRY.get(want);
      if (!cmd) return "no such command: /" + want + " — try /help for the full list.";
      const lines = [
        "/" + cmd.name + " — " + cmd.description,
        cmd.usage ? "  " + cmd.usage : "  /" + cmd.name,
        cmd.group ? "  group: " + cmd.group : "",
        "",
        "Tip: /help alone shows every command, grouped.",
      ].filter(Boolean);
      return lines.join("\n");
    }
    // Quick start at the top, then grouped reference.
    const lines: string[] = [];
    lines.push("Quick start — type these to get going:");
    for (const q of QUICK_START) {
      lines.push("  " + q.label.padEnd(14) + q.hint);
    }
    lines.push("");
    lines.push("Full reference (use /help <name> for details on any command):");
    const byGroup = new Map<string, SlashCommand[]>();
    for (const c of BUILTIN_REGISTRY.list()) {
      const g = c.group ?? "other";
      const arr = byGroup.get(g) ?? [];
      arr.push(c);
      byGroup.set(g, arr);
    }
    for (const g of HELP_GROUPS) {
      const items = byGroup.get(g.id);
      if (!items?.length) continue;
      lines.push("");
      lines.push(g.title + " — " + g.blurb);
      for (const c of items) {
        const use = c.usage ? c.usage : "/" + c.name;
        lines.push("  " + use.padEnd(34) + c.description);
      }
    }
    // Catch any commands that landed in a group not in HELP_GROUPS.
    const known = new Set(HELP_GROUPS.map((g) => g.id));
    const extra = [...byGroup.entries()].filter(([k]) => !known.has(k));
    if (extra.length > 0) {
      lines.push("");
      lines.push("Other:");
      for (const [, items] of extra) {
        for (const c of items) {
          const use = c.usage ? c.usage : "/" + c.name;
          lines.push("  " + use.padEnd(34) + c.description);
        }
      }
    }
    lines.push("");
    lines.push("Keys: Tab completes · Ctrl+G inserts /goal · Ctrl+C aborts · Ctrl+D quits.");
    return lines.join("\n");
  },
};

// ---------- /welcome ----------

/** Print a short, easy-to-scan quick-start. Designed for first-run and
 *  "I forgot how to use this" moments — it fits in 6 lines and points
 *  at /help for the full reference. Shared with the TUI banner and the
 *  `ch welcome` CLI subcommand. */
export function renderQuickStart(opts: { title?: string; showHeader?: boolean } = {}): string {
  const title = opts.title ?? "Welcome to CodingHarness";
  const lines: string[] = [];
  if (opts.showHeader !== false) {
    lines.push(title);
    lines.push("A few things to try:");
  }
  for (const q of QUICK_START) {
    lines.push("  " + q.label.padEnd(14) + q.hint);
  }
  lines.push("");
  lines.push("Workflow modes:");
  lines.push("  /plan          Frame the next prompt as planning and scope.");
  lines.push("  /build         Frame the next prompt as implementation.");
  lines.push("");
  lines.push("Session ops:");
  lines.push("  /tree          Inspect the current session tree.");
  lines.push("  /fork          Branch from a prior user turn.");
  lines.push("  /compact       Summarize older context.");
  lines.push("  /export        Export the current session.");
  lines.push("");
  lines.push("OpenCode-style server workflow:");
  lines.push("  ch serve                  Start the shared HTTP sidecar");
  lines.push("  ch attach http://127.0.0.1:7777   Terminal client to that server");
  lines.push("  ch web / ch desktop       Browser or Electron (same backend)");
  lines.push("");
  lines.push("Input prefixes:  @src/cli.ts  (attach file)   !git status  (run shell)");
  lines.push("Type any prompt to start. Inside the TUI, /help shows every command.");
  return lines.join("\n");
}

const welcomeCommand: SlashCommand = {
  name: "welcome",
  description: "Show the quick-start card (4 commands to get going).",
  group: "session",
  usage: "/welcome",
  run() { return renderQuickStart({ title: "Quick start" }); },
};

/** First-run wizard. On a fresh install, walks the user through
 *  picking a provider, saving a key, and confirming the connection
 *  works. On a configured install, prints a one-line "you're all
 *  set" summary and points at /provider for changes. */
const onboardCommand: SlashCommand = {
  name: "onboard",
  description: "First-run setup wizard: pick a provider, save a key, test it.",
  group: "session",
  usage: "/onboard",
  async run(_a, ctx) {
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
    const lines: string[] = [];
    if (rt.isFirstRun?.()) {
      lines.push("Welcome to CodingHarness!");
      lines.push("");
      lines.push("LM Studio is the default (http://127.0.0.1:1234/v1). OpenAI, Grok, MiniMax, and Codex are first-class hosted providers.");
      lines.push("");
      lines.push("Step 1:  start LM Studio locally, or pick a hosted provider below.");
      const { renderProviderList } = await import("../provider/setup.js");
      lines.push(renderProviderList());
      lines.push("");
      lines.push("Step 2:  save a key for the one you picked:");
      lines.push("  /provider setup <id> <your-key>");
      lines.push("");
      lines.push("Step 3:  I'll run /diag automatically to confirm the key works.");
      lines.push("          If it fails, /provider setup <id> again to overwrite.");
      lines.push("");
      lines.push("Tip: you can paste the key with a leading space to avoid some shells logging it.");
    } else {
      lines.push("You're already set up.");
      lines.push("  provider:  " + (rt.providerId() ?? "(unset)"));
      lines.push("  model:     " + (rt.model() ?? "(unset)"));
      lines.push("");
      lines.push("To change provider or model:  /provider <id> [model]");
      lines.push("To set up a different one:    /provider setup <id>");
      lines.push("To see all options:           /provider list");
    }
    return lines.join("\n");
  },
};

// ---------- /clear / /new / /reset ----------

const clearCommand: SlashCommand = {
  name: "clear",
  description: "Start a new in-memory branch (keeps the session id, clears the visible history).",
  group: "session",
  run(_a, ctx) { ctx.runtime?.().clearHistory(); return "history cleared"; },
};

const newCommand: SlashCommand = {
  name: "new",
  description: "Start a brand-new session (new id). Persisted.",
  group: "session",
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
  group: "session",
  run(_a, ctx) { ctx.runtime?.().clearHistory(); return "history reset"; },
};

// ---------- /cost ----------

const costCommand: SlashCommand = {
  name: "cost",
  description: "Show cumulative token usage and cost for this session.",
  group: "status",
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
  group: "settings",
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
  group: "session",
  run(_a, ctx) { ctx.runtime?.().quit(); },
};

const exitCommand: SlashCommand = {
  name: "exit",
  description: "Alias for /quit.",
  group: "session",
  run(_a, ctx) { ctx.runtime?.().quit(); },
};

// ---------- /session / /sessions ----------

const sessionCommand: SlashCommand = {
  name: "session",
  description: "Show the current session id and entry count.",
  group: "session",
  run(_a, ctx) {
    const rt = ctx.runtime?.();
    return "session: " + (rt?.sessionId() ?? "(none)");
  },
};

const sessionsCommand: SlashCommand = {
  name: "sessions",
  description: "List recent sessions, show details, or send a message to one.",
  group: "session",
  usage: "/sessions [list|show <id>|send <id> <text>|fork <id>]",
  async run(args, ctx) {
    const parts = args.trim().split(/\s+/).filter((s) => s.length > 0);
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
    if (sub === "search" && parts.length >= 2) {
      const query = parts.slice(1).join(" ").trim();
      if (!query) return "usage: /sessions search <query>";
      const list = await Session.search(query, 12);
      if (list.length === 0) return "(no matching sessions)";
      const out = ["Matching sessions:"];
      for (const m of list) {
        const when = new Date(m.updatedAt).toISOString().slice(0, 19).replace("T", " ");
        const name = m.name ? " (" + m.name + ")" : "";
        out.push("  " + m.id + "  " + when + "  " + m.entryCount + " entries" + name);
        if (m.preview) out.push("    " + m.preview);
      }
      return out.join("\n");
    }
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
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
    return "usage: /sessions [list|search <query>|show <id>|send <id> <text>|fork <id>]";
  },
};

// ---------- /resume ----------

const resumeCommand: SlashCommand = {
  name: "resume",
  description: "List recent sessions, or resume a specific one.",
  group: "session",
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
  group: "model",
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
  description: "Show, switch, or set up a provider (interactive on first run).",
  group: "model",
  usage: "/provider [id] [model] | /provider setup [id [key]] | /provider login codex | /provider list | /provider models [id]",
  async run(args, ctx) {
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
    const trimmed = args.trim();
    // `/provider` with no args — show current, plus a setup hint
    // when the user has no provider configured yet.
    if (!trimmed) {
      const id = rt.providerId() ?? "(unset)";
      const model = rt.model() ?? "(unset)";
      const lines = [
        "Provider: " + id,
        "Model:    " + model,
      ];
      if (rt.isFirstRun?.()) {
        const { renderProviderList } = await import("../provider/setup.js");
        lines.push("");
        lines.push("Looks like a first run — let's set one up:");
        lines.push(renderProviderList());
      } else {
        lines.push("");
        lines.push("Switch:  /provider <id> [model]   (e.g. /provider openai gpt-4o)");
        lines.push("Setup:   /provider setup           (interactive)");
        lines.push("List:    /provider list            (all providers)");
        lines.push("Models:  /provider models [id]     (live /v1/models)");
        lines.push("OAuth:   /provider login codex    (ChatGPT device-code sign-in)");
      }
      return lines.join("\n");
    }
    // `/provider login codex` — device-code OAuth for ChatGPT/Codex.
    if (trimmed === "login codex" || trimmed.startsWith("login codex ")) {
      const { buildCodexBrowserAuthUrl } = await import("../providers/oauth/codex.js");
      const { execFile } = await import("node:child_process");
      const lines: string[] = [];
      const login = await rt.loginCodexOAuth?.({
        onProgress: (m) => { lines.push(m); },
        onDeviceCode: async (prompt) => {
          lines.push("");
          lines.push("Sign in with ChatGPT:");
          lines.push("  1. Open: " + buildCodexBrowserAuthUrl(prompt));
          lines.push("  2. Enter code: " + prompt.userCode);
          lines.push("");
        },
        openBrowser: async (url) => {
          const cmd = process.platform === "darwin" ? "open" :
                      process.platform === "win32" ? "start" : "xdg-open";
          const args = process.platform === "win32" ? ["", url] : [url];
          await new Promise<void>((resolve, reject) => {
            execFile(cmd, args, (err) => err ? reject(err) : resolve());
          }).catch(() => { lines.push("(could not open browser — copy the URL above)"); });
        },
      });
      if (!login?.ok) {
        return "✗ Codex login failed: " + (login?.reason ?? "unknown error");
      }
      lines.push("✓ Codex OAuth saved");
      lines.push("  provider: codex");
      lines.push("  model:    " + (rt.model() ?? "(unset)"));
      return lines.join("\n");
    }
    // `/provider list` — show the catalog.
    if (trimmed === "list") {
      const { renderProviderList } = await import("../provider/setup.js");
      return renderProviderList();
    }
    // `/provider models [id]` — list models advertised by a running
    // provider's /v1/models endpoint. Defaults to the current provider.
    if (trimmed === "models" || trimmed.startsWith("models ")) {
      const targetId = trimmed.startsWith("models ") ? trimmed.slice("models ".length).trim() : rt.providerId();
      if (!targetId) return "no current provider. use: /provider models <id>";
      if (!rt.providerRegistry) return "this runtime does not expose a provider registry";
      const provider = rt.providerRegistry.get(targetId);
      if (!provider) return "provider not configured: " + targetId;
      if (typeof provider.listModels !== "function") {
        return "provider " + targetId + " does not support model discovery";
      }
      try {
        const models = await provider.listModels();
        if (models.length === 0) {
          return "no models returned from " + targetId + " (server may be offline or /v1/models not exposed)";
        }
        const lines = [
          "Models served by " + targetId + " (" + models.length + "):",
          ...models.map((m: string) => "  " + m),
        ];
        return lines.join("\n");
      } catch (e) {
        return "listModels failed for " + targetId + ": " + (e as Error).message;
      }
    }
    // `/provider setup ...` — interactive setup wizard.
    if (trimmed.startsWith("setup")) {
      const setupArgs = trimmed.slice("setup".length).trim();
      const { getProviderPreset } = await import("../providers/presets.js");
      const { renderProviderSetup, parseProviderSetupArgs } = await import("../provider/setup.js");
      if (!setupArgs) {
        // No provider given — show the picker.
        const { renderProviderList } = await import("../provider/setup.js");
        return renderProviderList();
      }
      const parsed = parseProviderSetupArgs(setupArgs);
      if (!parsed) {
        return "no such provider. try: /provider list";
      }
      const preset = getProviderPreset(parsed.providerId)!;
      // `/provider setup <id>` (no key) — show the setup card.
      if (!parsed.apiKey) {
        return renderProviderSetup(preset);
      }
      // `/provider setup <id> <key>` — save and verify.
      const save = await rt.saveProviderApiKey?.(parsed.providerId, parsed.apiKey);
      if (!save) {
        return "(runtime doesn't support saving keys — try setting " +
          preset.apiKeyEnv[0] + " in your shell)";
      }
      if (!save.ok) {
        return "could not save key: " + (save.reason ?? "unknown");
      }
      // Persist + run a quick diag to confirm it works.
      const lines = [
        "✓ saved API key for " + preset.label,
        "  default model: " + (rt.model() ?? preset.defaultModel),
        "",
        "Running /diag to verify the connection...",
      ];
      try {
        const diag = await rt.runDiag?.();
        if (diag) {
          lines.push(diag.ok
            ? "✓ diag ok — first byte " + diag.firstByteMs + "ms, " + diag.totalMs + "ms total"
            : "✗ diag failed: " + (diag.error ?? "no response"));
        }
      } catch (e) {
        lines.push("✗ diag crashed: " + (e as Error).message);
      }
      return lines.join("\n");
    }
    // `/provider <id> [model]` — the original fast-switch.
    const parts = trimmed.split(/\s+/);
    await rt.setProviderAndModel(parts[0]!, parts[1]);
    return "provider set to " + parts[0] + (parts[1] ? " (model " + parts[1] + ")" : "");
  },
};

const planModeCommand: SlashCommand = {
  name: "plan",
  description: "Switch the current workflow framing to plan mode.",
  group: "workflow",
  usage: "/plan",
  run(_args, ctx) {
    ctx.runtime?.().setComposerMode?.("plan");
    return "workflow set to plan";
  },
};

const buildModeCommand: SlashCommand = {
  name: "build",
  description: "Switch the current workflow framing to build mode.",
  group: "workflow",
  usage: "/build",
  run(_args, ctx) {
    ctx.runtime?.().setComposerMode?.("build");
    return "workflow set to build";
  },
};

// ---------- /goal (unchanged from v1, but now uses the new structure) ----------

const goalCommand: SlashCommand = {
  name: "goal",
  description: "Run the agent toward a high-level objective. Auto-plans, executes step-by-step, reports when done.",
  group: "workflow",
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
  const startedAt = Date.now();
  // Persist the goal so /goals and ch goals can see it. Tolerate
  // any failure (read-only filesystem, etc.) — goal mode should
  // still work in-memory.
  let goalId: string | null = null;
  try {
    const { GoalStore } = await import("../agent/goals.js");
    const store = new GoalStore();
    const rec = store.add({
      objective,
      maxSteps,
      model: rt.model(),
      providerId: rt.providerId(),
    });
    goalId = rec.id;
    store.markInProgress(rec.id);
    rt.print("[goal] " + rec.id + " (use /goals to inspect)");
  } catch (e) {
    rt.print("[goal] persistence unavailable, running in-memory: " + (e as Error).message);
  }
  rt.setGoalActivity?.({
    mode: "goal",
    objective,
    phase: "planning",
    step: 0,
    maxSteps,
    startedAt,
    updatedAt: startedAt,
    statusText: "Planning approach",
  });
  rt.print("[goal] planning (max " + maxSteps + " steps)...");
  await rt.sendPrompt([
    "Goal mode: plan",
    "Objective: " + objective,
    "",
    "Produce a numbered, minimal plan (3-7 steps) to achieve this in the current repository.",
    "After the plan, write exactly: Ready to execute. Use tools.",
  ].join("\n"), { silent: true });
  for (let step = 1; step <= maxSteps; step++) {
    rt.setGoalActivity?.({
      mode: "goal",
      objective,
      phase: "executing",
      step,
      maxSteps,
      startedAt,
      updatedAt: Date.now(),
      statusText: "Running step " + step + " of " + maxSteps,
    });
    rt.print("[goal] step " + step + "/" + maxSteps + "...");
    if (goalId) {
      try {
        const { GoalStore } = await import("../agent/goals.js");
        new GoalStore().recordStep(goalId);
      } catch { /* best-effort */ }
    }
    const response = await rt.sendPromptWithCapture([
      "Goal mode: execute",
      "Objective: " + objective,
      "Step: " + step + "/" + maxSteps,
      "",
      "Continue from your plan and execute the next step in the repository.",
      "If the objective is complete, say exactly: GOAL COMPLETE",
      "If you cannot continue, say exactly: GOAL BLOCKED: <reason>",
    ].join("\n"));
    const lc = response.toLowerCase();
    if (lc.includes("goal complete")) {
      rt.setGoalActivity?.({
        mode: "goal",
        objective,
        phase: "complete",
        step,
        maxSteps,
        startedAt,
        updatedAt: Date.now(),
        statusText: "Completed in " + step + " step" + (step === 1 ? "" : "s"),
      });
      rt.print("[goal] done in " + step + " step" + (step === 1 ? "" : "s"));
      if (goalId) {
        try {
          const { GoalStore } = await import("../agent/goals.js");
          new GoalStore().update(goalId, { status: "complete", stepsTaken: step, finalText: response.slice(0, 2000) });
        } catch { /* best-effort */ }
      }
      return "goal complete in " + step + " step(s) [" + goalId + "]";
    }
    if (lc.includes("goal blocked")) {
      rt.setGoalActivity?.({
        mode: "goal",
        objective,
        phase: "blocked",
        step,
        maxSteps,
        startedAt,
        updatedAt: Date.now(),
        statusText: "Blocked while executing step " + step,
      });
      rt.print("[goal] blocked");
      if (goalId) {
        try {
          const { GoalStore } = await import("../agent/goals.js");
          new GoalStore().update(goalId, { status: "blocked", stepsTaken: step, finalText: response.slice(0, 2000) });
        } catch { /* best-effort */ }
      }
      return "goal blocked [" + goalId + "]";
    }
  }
  rt.setGoalActivity?.({
    mode: "goal",
    objective,
    phase: "blocked",
    step: maxSteps,
    maxSteps,
    startedAt,
    updatedAt: Date.now(),
    statusText: "Reached max steps (" + maxSteps + ")",
  });
  rt.print("[goal] reached max steps (" + maxSteps + ")");
  if (goalId) {
    try {
      const { GoalStore } = await import("../agent/goals.js");
      new GoalStore().update(goalId, { status: "failed", stepsTaken: maxSteps });
    } catch { /* best-effort */ }
  }
  return "goal did not complete within " + maxSteps + " steps [" + goalId + "]";
}

// ---------- /goals ----------

const goalsCommand: SlashCommand = {
  name: "goals",
  description: "List, show, or manage persisted goals (Codex-style /goal lifecycle).",
  group: "workflow",
  usage: "/goals [list|show <id>|clear|remove <id>]",
  async run(args, ctx) {
    const { GoalStore, formatGoalLine } = await import("../agent/goals.js");
    let store: InstanceType<typeof GoalStore>;
    try {
      store = new GoalStore();
    } catch (e) {
      return "(goal persistence unavailable: " + (e as Error).message + ")";
    }
    const parts = args.trim().split(/\s+/);
    const sub = parts[0];
    if (!sub || sub === "list") {
      const all = store.list();
      if (all.length === 0) return "(no goals — use /goal <objective> to create one)";
      const active = store.listActive();
      const lines: string[] = [];
      lines.push("Active goals (" + active.length + "/" + all.length + "):");
      for (const g of active) lines.push("  " + formatGoalLine(g));
      if (active.length < all.length) {
        lines.push("");
        lines.push("(use /goals show <id> to see a terminal one)");
      }
      return lines.join("\n");
    }
    if (sub === "show") {
      const id = parts[1];
      if (!id) return "usage: /goals show <id>";
      const g = store.get(id);
      if (!g) return "no such goal: " + id;
      const lines: string[] = [];
      lines.push("Goal: " + g.id);
      lines.push("  status:   " + g.status);
      lines.push("  steps:    " + g.stepsTaken + "/" + g.maxSteps);
      lines.push("  created:  " + new Date(g.createdAt).toISOString());
      lines.push("  updated:  " + new Date(g.updatedAt).toISOString());
      lines.push("  objective: " + g.objective);
      if (g.finalText) lines.push("  result:   " + g.finalText.slice(0, 200) + (g.finalText.length > 200 ? "…" : ""));
      return lines.join("\n");
    }
    if (sub === "remove") {
      const id = parts[1];
      if (!id) return "usage: /goals remove <id>";
      return store.remove(id) ? "✓ removed " + id : "no such goal: " + id;
    }
    if (sub === "clear") {
      const n = store.clear();
      return "✓ cleared " + n + " terminal goal" + (n === 1 ? "" : "s");
    }
    return "usage: /goals [list|show <id>|remove <id>|clear]";
  },
};

// ---------- /council ----------

const councilCommand: SlashCommand = {
  name: "council",
  description: "Run a multi-agent council deliberation on a question (consensus or adversarial).",
  group: "workflow",
  usage: "/council <question> [--mode=consensus|adversarial]",
  async run(args, ctx) {
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
    const m = args.match(/^(.*?)(?:\s+--mode=(\w+))?\s*$/s);
    if (!m || !m[1]?.trim()) return "usage: /council <question> [--mode=consensus|adversarial]";
    const question = m[1].trim();
    const mode = (m[2] === "adversarial" || m[2] === "consensus") ? m[2] : "consensus";
    const { runCouncil, BUILTIN_COUNCILORS, DEFAULT_COUNCIL_ROSTER, renderCouncilResult } =
      await import("../agent/council.js");
    const roster = DEFAULT_COUNCIL_ROSTER.map((role) => BUILTIN_COUNCILORS[role]);
    const ac = new AbortController();
    rt.print("[council] starting " + mode + " deliberation (" + roster.length + " voices)...");
    try {
      const result = await runCouncil(question, {
        mode,
        councilors: roster,
        cwd: ctx.cwd,
        signal: ac.signal,
        model: rt.model(),
        providerId: rt.providerId(),
      }, {
        // Slash-runtime adapter: use the runtime's sendPromptWithCapture
        // for each councilor. The TUI/REPL doesn't have a full
        // sub-agent harness available, so we treat the system prompt
        // as a prefix the runtime will respect. This is a
        // best-effort v0 — the CLI `ch council` is the rich path.
        spawn: async (opts) => {
          const composed = opts.system + "\n\n" + opts.prompt;
          const text = await rt.sendPromptWithCapture(composed);
          return { text, usage: { inputTokens: 0, outputTokens: 0 } };
        },
      });
      rt.print(renderCouncilResult(result));
      return "council complete in " + result.durationMs + "ms";
    } catch (e) {
      return "council failed: " + (e as Error).message;
    }
  },
};

// ---------- /loop ----------

const loopCommand: SlashCommand = {
  name: "loop",
  description: "Re-send the previous prompt N times, optionally until a sentinel is detected.",
  group: "workflow",
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
      const r = await rt.sendPromptWithCapture([
        "Loop mode: continue",
        "Iteration: " + i + "/" + n,
        "",
        sentinel
          ? "If the task is done, output the sentinel '" + sentinel + "' exactly."
          : "If the task is done, output the sentinel 'LOOP DONE' exactly. Otherwise continue.",
      ].join("\n"));
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
  group: "status",
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
  group: "status",
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
  group: "settings",
  usage: "/think <level>",
  async run(args, ctx) {
    const rt = ctx.runtime?.() as { settings?: { thinking?: string }; setThinking?: (l: string) => void } | undefined;
    const level = args.trim();
    const valid = ["off", "minimal", "low", "medium", "high", "xhigh"];
    if (!level) {
      return "thinking level: " + (rt?.settings?.thinking ?? "medium") + "\n(use /think <level>)";
    }
    if (!valid.includes(level)) return "valid levels: " + valid.join(", ");
    // Persist in settings via the runtime so CLI, slash, and desktop stay aligned.
    rt?.setThinking?.(level);
    return "thinking level set to " + level;
  },
};

const verboseCommand: SlashCommand = {
  name: "verbose",
  description: "Show or toggle verbose runtime logging.",
  group: "settings",
  usage: "/verbose [on|off|toggle]",
  run(args, ctx) {
    const rt = ctx.runtime?.() as { settings?: { ui?: { verbose?: boolean } }; setVerbose?: (enabled: boolean) => void } | undefined;
    const current = !!rt?.settings?.ui?.verbose;
    const arg = args.trim();
    if (!arg) {
      return "verbose: " + (current ? "on" : "off") + "\n(use /verbose on|off|toggle)";
    }
    const next = arg === "on" ? true : arg === "off" ? false : arg === "toggle" ? !current : null;
    if (next === null) return "usage: /verbose [on|off|toggle]";
    rt?.setVerbose?.(next);
    return "verbose " + (next ? "enabled" : "disabled");
  },
};

const traceCommand: SlashCommand = {
  name: "trace",
  description: "Show or toggle trace output for tool calls.",
  group: "settings",
  usage: "/trace [on|off|toggle]",
  run(args, ctx) {
    const rt = ctx.runtime?.() as { settings?: { ui?: { trace?: boolean } }; setTrace?: (enabled: boolean) => void } | undefined;
    const current = !!rt?.settings?.ui?.trace;
    const arg = args.trim();
    if (!arg) {
      return "trace: " + (current ? "on" : "off") + "\n(use /trace on|off|toggle)";
    }
    const next = arg === "on" ? true : arg === "off" ? false : arg === "toggle" ? !current : null;
    if (next === null) return "usage: /trace [on|off|toggle]";
    rt?.setTrace?.(next);
    return "trace " + (next ? "enabled" : "disabled");
  },
};

// ---------- /retry / /undo / /redo ----------

const retryCommand: SlashCommand = {
  name: "retry",
  description: "Re-run the last user prompt.",
  group: "session",
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
  group: "session",
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
  description: "Compact older messages into a summary. Supports --preview and --dry-run.",
  group: "context",
  usage: "/compact [--preview|--dry-run] [instructions]",
  async run(args, ctx) {
    const rt = ctx.runtime?.() as { compactNow?: (opts: { dryRun?: boolean; instructions?: string }) => Promise<string> } | undefined;
    if (!rt) return "(no runtime)";
    if (typeof rt.compactNow !== "function") return "(runtime doesn't support /compact)";
    const flags = new Set<string>();
    let instructions = "";
    for (const tok of args.trim().split(/\s+/)) {
      if (tok.startsWith("--")) flags.add(tok.slice(2));
      else if (tok) instructions = instructions ? instructions + " " + tok : tok;
    }
    return rt.compactNow({ dryRun: flags.has("preview") || flags.has("dry-run"), instructions: instructions || undefined });
  },
};

// ---------- /memory ----------

const memoryCommand: SlashCommand = {
  name: "memory",
  description: "Read, append to, or search persistent memory.",
  group: "context",
  usage: "/memory [read|add <text>|search <query>|user]",
  async run(args, ctx) {
    const rt = ctx.runtime?.() as { memory?: { read(): string; append(t: string): Promise<void>; search(q: string): Promise<string>; readUser(): string; appendUser(t: string): Promise<void> } } | undefined;
    if (!rt?.memory) return "(memory store not available)";
    const parts = args.trim().split(/\s+/).filter((s) => s.length > 0);
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
  description: "List skills, show one, or load one into the conversation.",
  group: "tools",
  usage: "/skill [list|show <name>|load <name>]",
  async run(args, ctx) {
    const rt = ctx.runtime?.() as { skills?: { list(): Promise<Array<{ name: string; description: string }>>; load(n: string): Promise<{ content: string } | null> } } | undefined;
    if (!rt?.skills) return "(skill registry not available)";
    const trimmed = args.trim();
    // Parse "<sub> <name>" so `/skill show foo` and `/skill load foo`
    // are both first-class, while `/skill <name>` still works as a
    // shorthand for `load` (the original behavior).
    const parts = trimmed.split(/\s+/).filter((s) => s.length > 0);
    const sub = parts[0] ?? "list";
    const name = parts[1];

    if (sub === "list" || (!name && (sub === "list" || sub === ""))) {
      const list = await rt.skills.list();
      if (list.length === 0) return "(no skills installed — drop SKILL.md into ~/.codingharness/skills/<name>/)";
      return list.map((s, i) => (i + 1) + ". " + s.name + " — " + s.description).join("\n");
    }

    if (sub === "show") {
      if (!name) return "usage: /skill show <name>";
      const loaded = await rt.skills.load(name);
      if (!loaded) return "no such skill: " + name + " — try /skill list";
      const meta = await rt.skills.list();
      const m = meta.find((s) => s.name === name);
      const lines: string[] = [];
      lines.push("Skill: " + name);
      if (m?.description) lines.push("  " + m.description);
      lines.push("");
      lines.push(loaded.content);
      return lines.join("\n");
    }

    // `/skill <name>` (no subcommand) — load the skill, original behavior.
    // We also handle the `load <name>` form so scripts can be explicit.
    const targetName = sub === "load" ? name : sub;
    if (!targetName) return "usage: /skill [list|show <name>|load <name>]";
    const loaded = await rt.skills.load(targetName);
    if (!loaded) return "no such skill: " + targetName + " — try /skill list";
    return "Loaded skill: " + targetName + "\n\n" + loaded.content;
  },
};

// ---------- /agents ----------

const agentsCommand: SlashCommand = {
  name: "agents",
  description: "List available sub-agents (or show details for one).",
  group: "tools",
  usage: "/agents [name]",
  async run(args, ctx) {
    const rt = ctx.runtime?.() as
      | { listAgents?: () => Array<{ name: string; description: string; builtin?: boolean }>; getAgent?: (n: string) => AgentDefinition | undefined }
      | undefined;
    if (!rt?.listAgents) return "(sub-agent registry not available)";
    const want = args.trim();
    // Focused one-agent view when a name is given. Useful for
    // "what does /implement actually do?" without scrolling a list.
    if (want) {
      const a = rt.getAgent?.(want);
      if (!a) return "no such agent: " + want + " — try /agents alone for the full list.";
      const lines: string[] = [];
      lines.push(a.name + (a.builtin ? " (built-in)" : ""));
      lines.push("  " + a.description);
      if (a.tags && a.tags.length > 0) {
        lines.push("  tags: " + a.tags.join(", "));
      }
      if (a.tools && a.tools.length > 0) {
        lines.push("  tools: " + a.tools.join(", "));
      } else if (a.tools !== undefined) {
        lines.push("  tools: (none — read-only)");
      } else {
        lines.push("  tools: (inherits all parent tools)");
      }
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
      return lines.join("\n");
    }
    const list = rt.listAgents();
    if (list.length === 0) return "(no agents registered)";
    return list.map((a, i) => (i + 1) + ". " + a.name + (a.builtin ? " (built-in)" : "") + " — " + a.description).join("\n");
  },
};

// ---------- /cron ----------

const cronCommand: SlashCommand = {
  name: "cron",
  description: "Manage scheduled jobs. 'add <schedule> <prompt>' / list / remove / run / enable / disable",
  group: "workflow",
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
  group: "tools",
  async run(_a, ctx) {
    const items = await runDiagnostics({ cwd: ctx.cwd });
    return renderDiagnostics(items);
  },
};

// ---------- /tokens ----------

const tokensCommand: SlashCommand = {
  name: "tokens",
  description: "Show the rough token count of the active session's messages.",
  group: "status",
  usage: "/tokens",
  async run(_a, ctx) {
    const id = ctx.runtime?.().sessionId();
    if (!id) return "no active session — start one with /new or pass a prompt";
    const s = await Session.open(id);
    const msgs = sessionToMessages(s);
    if (msgs.length === 0) return "session has no messages yet";
    const tokens = roughTokenCount(msgs);
    const breakdown: Array<{ role: string; tokens: number; chars: number }> = [];
    for (const m of msgs) {
      const c = (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).length;
      breakdown.push({ role: m.role, tokens: roughTokenCount([m]), chars: c });
    }
    const lines: string[] = [];
    lines.push(c.bold("Session tokens (rough)"));
    lines.push("  total:    " + tokens + " (~" + Math.round(tokens * 4) + " chars)");
    lines.push("  messages: " + msgs.length);
    lines.push("  by role:");
    for (const b of breakdown.slice(-10)) {
      lines.push("    " + b.role.padEnd(10) + b.tokens + " (~" + b.chars + " chars)");
    }
    if (breakdown.length > 10) lines.push("    …(" + (breakdown.length - 10) + " earlier messages omitted)");
    return lines.join("\n");
  },
};

// ---------- /info ----------

/** Show a snapshot of the running install: paths, provider, model,
 *  thinking level, approval mode. Same shape as `ch info` — both
 *  delegate to the same pretty-printer so the surfaces never drift. */
const infoCommand: SlashCommand = {
  name: "info",
  description: "Show runtime info: version, paths, provider, model, thinking.",
  group: "status",
  usage: "/info",
  async run(_a, ctx) {
    const { renderRuntimeInfo } = await import("../runtime/info.js");
    return renderRuntimeInfo(ctx.cwd);
  },
};

const diagCommand: SlashCommand = {
  name: "diag",
  description: "Connectivity / latency check against the current provider + model.",
  group: "tools",
  usage: "/diag",
  async run(_a, ctx) {
    const rt = ctx.runtime?.() as { runDiag?: () => Promise<{ ok: boolean; provider?: string; model?: string; firstByteMs: number; totalMs: number; inputTokens: number; outputTokens: number; reply?: string; error?: string }> } | undefined;
    if (!rt?.runDiag) return "(diag not available in this runtime)";
    const r = await rt.runDiag();
    if (!r.ok) {
      return [
        c.red("✗ diag failed"),
        "  provider: " + (r.provider ?? "(none)"),
        "  model:    " + (r.model ?? "(none)"),
        "  error:    " + (r.error ?? "(unknown)"),
      ].join("\n");
    }
    return [
      c.green("✓ diag ok"),
      "  provider:  " + r.provider,
      "  model:     " + r.model,
      "  first-byte:" + r.firstByteMs + " ms",
      "  total:     " + r.totalMs + " ms",
      "  tokens:    " + r.inputTokens + " in / " + r.outputTokens + " out",
      r.reply ? "  reply:     " + JSON.stringify(r.reply) : "",
    ].filter(Boolean).join("\n");
  },
};

// ---------- /init ----------

/** Write a starter `.codingharness/AGENTS.md`. The body is generated
 *  from the project layout (package.json, Cargo.toml, go.mod, etc.),
 *  so the user gets a real first draft with build/test commands
 *  pre-filled — not a blank template. If a file already exists, we
 *  refuse to overwrite (the user has to delete it or move it). */
const initCommand: SlashCommand = {
  name: "init",
  description: "Generate a starter .codingharness/AGENTS.md in the current directory.",
  group: "tools",
  usage: "/init [--force] [--no-detect]",
  async run(args, ctx) {
    const path = ctx.cwd + "/.codingharness/AGENTS.md";
    const flags = new Set(args.split(/\s+/).filter((s) => s.startsWith("-")));
    const force = flags.has("--force") || flags.has("-f");
    if (existsSync(path) && !force) {
      return path + " already exists — re-run with --force to overwrite.";
    }
    mkdirSync(ctx.cwd + "/.codingharness", { recursive: true });

    let body: string;
    let detected: string;
    if (flags.has("--no-detect")) {
      // Bypass detection and write the legacy blank template. Useful
      // for tests and for users who want a pristine doc.
      body = [
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
      ].join("\n");
      detected = "blank template (--no-detect)";
    } else {
      const { detectProject, renderAgentsTemplate } = await import("../project/init.js");
      const facts = detectProject(ctx.cwd);
      body = renderAgentsTemplate(facts);
      detected = facts.stack === "unknown"
        ? "no manifest found — wrote a minimal starter"
        : "detected " + facts.stack + " project";
    }
    writeFileSync(path, body);
    return "wrote " + path + " (" + detected + ")";
  },
};

// ---------- /tree / /fork / /export ----------

import { renderSessionTree } from "./tree-render.js";

const treeCommand: SlashCommand = {
  name: "tree",
  description: "Show the session tree (with branching).",
  group: "context",
  async run(_a, ctx) {
    const rt = ctx.runtime?.();
    const live = rt?.getSession?.() ?? null;
    const id = live?.id ?? rt?.sessionId();
    if (!id) return "no active session";
    const s = live ?? await Session.open(id);
    const entries = s.allEntries();
    if (entries.length === 0) return "(empty session)";
    return renderSessionTree(entries, s.meta.head ?? "");
  },
};

/** View or edit the in-session todo list. Mirrors the `todo` tool
 *  the agent uses — so when the user runs `/todo add foo`, the
 *  next agent turn sees "foo" in the list and checks it off. */
const todoCommand: SlashCommand = {
  name: "todo",
  description: "View or edit the in-session todo list (list | add | set | clear).",
  group: "context",
  usage: "/todo [list|add <text>|set <text>...|clear]",
  async run(args, ctx) {
    const rt = ctx.runtime?.();
    if (!rt) return "(no runtime)";
    if (!rt.readTodo || !rt.writeTodo) return "(runtime doesn't expose a todo list)";
    const trimmed = args.trim();
    if (!trimmed || trimmed === "list") {
      const items = rt.readTodo();
      if (items.length === 0) return "(empty — try: /todo add \"first thing to do\")";
      return items.map((t, i) => (i + 1) + ". " + t).join("\n");
    }
    if (trimmed === "clear") {
      await rt.writeTodo([]);
      return "cleared todo list";
    }
    if (trimmed.startsWith("add ")) {
      const item = trimmed.slice("add ".length).trim();
      if (!item) return "usage: /todo add <text>";
      const items = [...rt.readTodo(), item];
      await rt.writeTodo(items);
      return "added (" + items.length + " item" + (items.length === 1 ? "" : "s") + ")";
    }
    if (trimmed.startsWith("set ")) {
      // /todo set a | b | c  — split by `|` OR whitespace when no `|`.
      // Prefer `|` because todo items often contain spaces.
      const rest = trimmed.slice("set ".length).trim();
      if (!rest) return "usage: /todo set <text>...  (separate items with | or newlines)";
      const items = rest.includes("|")
        ? rest.split("|").map((s) => s.trim()).filter(Boolean)
        : rest.split(/\s+/).filter(Boolean);
      if (items.length === 0) return "(no items parsed)";
      await rt.writeTodo(items);
      return "set " + items.length + " item" + (items.length === 1 ? "" : "s");
    }
    return "usage: /todo [list|add <text>|set <text>...|clear]";
  },
};

const forkCommand: SlashCommand = {
  name: "fork",
  description: "Fork the current session from a previous user message.",
  group: "session",
  usage: "/fork [user-message-id]",
  async run(args, ctx) {
    const rt = ctx.runtime?.();
    const live = rt?.getSession?.() ?? null;
    const id = live?.id ?? rt?.sessionId();
    if (!id) return "no active session";
    const s = live ?? await Session.open(id);
    const entries = s.allEntries();
    const userEntries = entries.filter((e) => e.type === "user");
    const target = args.trim() || userEntries[userEntries.length - 2]?.id;
    if (!target) return "no user message to fork from";
    const child = await s.fork(target);
    return "forked into " + child.id + " (from " + target + ")";
  },
};

const exportCommand: SlashCommand = {
  name: "export",
  description: "Export a session as a training-friendly JSONL trajectory.",
  group: "session",
  usage: "/export [session-id|latest] [--format hermes|openai|share] [--out <dir>]",
  async run(args, ctx) {
    const parts = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
    let sessionId: string | null = null;
    let latest = false;
    let format: "hermes" | "openai" | "share" = "openai";
    let outDir: string | undefined;
    for (let i = 0; i < parts.length; i++) {
      const a = parts[i]!;
      if (a === "--latest" || a === "latest") { latest = true; continue; }
      if (a.startsWith("--format=")) { format = a.slice("--format=".length) as typeof format; continue; }
      if (a === "--format" && parts[i + 1]) { format = parts[++i] as typeof format; continue; }
      if (a.startsWith("--out=")) { outDir = a.slice("--out=".length); continue; }
      if (a === "--out" && parts[i + 1]) { outDir = parts[++i]; continue; }
      if (a.startsWith("--")) continue;
      if (!sessionId) sessionId = a;
    }
    if (!["hermes", "openai", "share"].includes(format)) {
      return "invalid format: " + format + " (use hermes, openai, or share)";
    }
    const rt = ctx.runtime?.();
    let session: Session | null = rt?.getSession?.() ?? null;
    if (!session && sessionId) {
      session = await Session.open(sessionId);
    } else if (!session && rt?.sessionId?.()) {
      session = await Session.open(rt.sessionId()!);
    } else if (!session && (latest || !sessionId)) {
      const list = await Session.list(1);
      if (list.length === 0) return "no sessions to export";
      session = await Session.open(list[0]!.id);
    }
    if (!session) {
      return "no active session";
    }
    const r = await exportSession(session, { format, outDir: outDir ?? defaultExportDir() });
    return "exported " + r.lineCount + " line" + (r.lineCount === 1 ? "" : "s") + " to " + r.path;
  },
};

// ---------- /prompts (template loader) ----------

const promptsCommand: SlashCommand = {
  name: "prompts",
  description: "List or run a prompt template by name.",
  group: "tools",
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

// ---------- /mcp ----------

const mcpCommand: SlashCommand = {
  name: "mcp",
  description: "Show MCP server usage and connection hints.",
  group: "tools",
  usage: "/mcp [status|stdio|http]",
  async run(args, ctx) {
    const rt = ctx.runtime?.();
    const mode = args.trim() || "status";
    const lines = [
      "CodingHarness MCP support is built in.",
      "",
      "Use `ch mcp --stdio` to expose the tool registry over stdio for local MCP clients.",
      "Use `ch mcp --port <n>` to run the HTTP/SSE server on a loopback port.",
      "The desktop app can also autostart the MCP sidecar and show its URL in the Desktop settings section.",
    ];
    if (mode === "status") {
      lines.push("");
      lines.push("Current runtime:");
      lines.push("  provider: " + (rt?.providerId?.() ?? "(unset)"));
      lines.push("  model:    " + (rt?.model?.() ?? "(unset)"));
      lines.push("  session:  " + (rt?.sessionId?.() ?? "(unset)"));
    } else if (mode === "stdio") {
      lines.push("");
      lines.push("stdio transport:");
      lines.push("  ch mcp --stdio");
      lines.push("  stdin/stdout carry JSON-RPC 2.0; stderr is for logs only.");
    } else if (mode === "http") {
      lines.push("");
      lines.push("HTTP transport:");
      lines.push("  ch mcp --port 3456 --host 127.0.0.1");
      lines.push("  POST /mcp, GET /health, GET /sse");
    } else {
      lines.push("");
      lines.push("usage: /mcp [status|stdio|http]");
    }
    return lines.join("\n");
  },
};

// ---------- /personality ----------

const personalityCommand: SlashCommand = {
  name: "personality",
  description: "Load a SOUL.md personality file from ~/.codingharness/personalities/<name>.md.",
  group: "settings",
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

const commandsCommand: SlashCommand = {
  name: "commands",
  description: "Browse available slash commands with descriptions and usage.",
  group: "session",
  usage: "/commands [name]",
  run(args, ctx) {
    // Delegate to /help so the grouping + quick-start stay in lockstep.
    return helpCommand.run(args, ctx);
  },
};

// ---------- Registry export ----------

export const BUILTIN_REGISTRY = new SlashRegistry();
BUILTIN_REGISTRY.register(commandsCommand);
BUILTIN_REGISTRY.register(helpCommand);
BUILTIN_REGISTRY.register(welcomeCommand);
BUILTIN_REGISTRY.register(onboardCommand);
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
BUILTIN_REGISTRY.register(planModeCommand);
BUILTIN_REGISTRY.register(buildModeCommand);
BUILTIN_REGISTRY.register(goalCommand);
BUILTIN_REGISTRY.register(goalsCommand);
BUILTIN_REGISTRY.register(councilCommand);
BUILTIN_REGISTRY.register(loopCommand);
BUILTIN_REGISTRY.register(exportCommand);
BUILTIN_REGISTRY.register(statusCommand);
BUILTIN_REGISTRY.register(usageCommand);
BUILTIN_REGISTRY.register(thinkCommand);
BUILTIN_REGISTRY.register(verboseCommand);
BUILTIN_REGISTRY.register(traceCommand);
BUILTIN_REGISTRY.register(retryCommand);
BUILTIN_REGISTRY.register(undoCommand);
BUILTIN_REGISTRY.register(compactCommand);
BUILTIN_REGISTRY.register(memoryCommand);
BUILTIN_REGISTRY.register(skillCommand);
BUILTIN_REGISTRY.register(agentsCommand);
BUILTIN_REGISTRY.register(cronCommand);
BUILTIN_REGISTRY.register(doctorCommand);
BUILTIN_REGISTRY.register(diagCommand);
BUILTIN_REGISTRY.register(tokensCommand);
BUILTIN_REGISTRY.register(infoCommand);
BUILTIN_REGISTRY.register(initCommand);
BUILTIN_REGISTRY.register(treeCommand);
BUILTIN_REGISTRY.register(todoCommand);
BUILTIN_REGISTRY.register(forkCommand);
BUILTIN_REGISTRY.register(promptsCommand);
BUILTIN_REGISTRY.register(mcpCommand);
BUILTIN_REGISTRY.register(personalityCommand);
BUILTIN_REGISTRY.register(costCommand);
BUILTIN_REGISTRY.register(approvalCommand);
