// Harness runtime. Wires together provider, agent loop, session,
// sub-agents, skills, memory, context, extensions, and slash
// commands. The REPL drives this.

import { Session, sessionToMessages } from "./agent/session.js";
import { runAgent, DEFAULT_LIMITS } from "./agent/loop.js";
import { defaultToolRegistry, type ToolRegistry } from "./agent/tools/index.js";
import { ProviderRegistry } from "./providers/registry.js";
import { loadSettings, type Settings } from "./config/settings.js";
import { BUILTIN_REGISTRY } from "./slash/builtin.js";
import { tryParseSlash, type GoalActivityState, type SlashRuntime } from "./slash/registry.js";
import { c } from "./ui/colors.js";
import { log } from "./util/logger.js";
import { SubAgentManager } from "./agent/subagent.js";
import { SkillRegistry } from "./agent/skills.js";
import { MemoryStore } from "./agent/memory.js";
import { loadContextFiles, formatContextForPrompt } from "./agent/context.js";
import { loadExtensions } from "./agent/extensions.js";
import { compact as runCompaction, roughTokenCount, previewCompaction, formatCompactionPreview } from "./agent/compaction.js";
import { paths } from "./config/paths.js";
import type { ChatMessage, ToolCall, ToolResult, Provider } from "./types.js";
import { CostTracker, formatUSD, callCost } from "./agent/cost.js";
import { DEFAULT_APPROVAL, type ApprovalConfig } from "./agent/approval.js";
import { saveSettings } from "./config/settings.js";

export interface RuntimeOptions {
  cwd: string;
  ephemeral?: boolean;
  /** Skip AGENTS.md/CLAUDE.md loading. */
  noContext?: boolean;
}

export interface RuntimeOutputHandler {
  onTextDelta?: (text: string) => void;
  onToolCallStart?: (toolCall: ToolCall) => void;
  onToolCallEnd?: (toolCall: ToolCall, result: ToolResult) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  onInfo?: (text: string) => void;
  onError?: (error: Error) => void;
  onTurnEnd?: () => void;
}

export class HarnessRuntime implements SlashRuntime {
  readonly cwd: string;
  readonly settings: Settings;
  readonly providerRegistry: ProviderRegistry;
  readonly subagents: SubAgentManager;
  readonly skills: SkillRegistry;
  readonly memory: MemoryStore;
  readonly tools: ToolRegistry;
  /** Sub-agents spawned during this session. */
  readonly subagentHistory: Array<{ name: string; prompt: string; status: string; at: number; cost: number; steps: number }> = [];

  private session: Session | null = null;
  private ephemeral = false;
  private shouldQuit = false;
  private personality: string | null = null;
  private thinking = "medium";
  private lastCapture = "";
  private loadedContext = "";
  private lastUserPrompt: string | null = null;
  private lastTokensIn = 0;
  private lastTokensOut = 0;
  private verbose = false;
  private trace = false;
  /** Cumulative usage for the lifetime of this Runtime. */
  readonly cost = new CostTracker();
  /** Currently-running sub-agents (for the sidebar). */
  readonly activeSubagents = new Map<string, { prompt: string; startedAt: number; status: "running" | "ok" | "err" }>();
  /** Approval config (settings-driven). */
  approval: ApprovalConfig = DEFAULT_APPROVAL;
  /** When the bash tool needs user approval, the host (TUI modal, web
   *  modal) registers a handler here. If unset, the tool returns a
   *  static "needs approval" error. */
  askApprovalHandler: ((command: string, reason: string) => Promise<"allow-once" | "allow-always" | "deny">) | null = null;
  private outputHandler: RuntimeOutputHandler | null = null;
  private goalActivity: GoalActivityState | null = null;

  /** Register an approval handler. Returns a cleanup function that
   *  removes the handler (used in tests). */
  setApprovalRequestHandler(fn: typeof this.askApprovalHandler): () => void {
    this.askApprovalHandler = fn;
    return () => { if (this.askApprovalHandler === fn) this.askApprovalHandler = null; };
  }

  setOutputHandler(fn: RuntimeOutputHandler | null): () => void {
    this.outputHandler = fn;
    return () => { if (this.outputHandler === fn) this.outputHandler = null; };
  }

  setGoalActivity(state: GoalActivityState | null): void {
    this.goalActivity = state ? { ...state } : null;
  }

  getGoalActivity(): GoalActivityState | null {
    return this.goalActivity ? { ...this.goalActivity } : null;
  }

  constructor(opts: RuntimeOptions) {
    this.cwd = opts.cwd;
    this.ephemeral = opts.ephemeral ?? false;
    this.settings = loadSettings();
    this.providerRegistry = new ProviderRegistry(this.settings);
    this.subagents = new SubAgentManager(this.providerRegistry, this.settings, { cwd: this.cwd });
    this.skills = new SkillRegistry({ cwd: this.cwd });
    this.memory = new MemoryStore();
    this.tools = defaultToolRegistry();
    // Wire approval config from settings.
    if (this.settings.approval) {
      this.approval = {
        mode: this.settings.approval.mode ?? DEFAULT_APPROVAL.mode,
        allowlist: this.settings.approval.allowlist ?? [],
        blocklist: this.settings.approval.blocklist ?? [],
        override: this.settings.approval.override,
      };
    }
  }

  async ensureSession(): Promise<Session> {
    if (this.session) return this.session;
    const provider = this.providerRegistry.default();
    this.session = await Session.create({ cwd: this.cwd, model: this.settings.defaultModel, provider: provider?.id });
    return this.session;
  }
  getSession(): Session | null { return this.session; }

  // ---- SlashRuntime ----
  providerId(): string | undefined { return this.settings.defaultProvider; }
  model(): string | undefined { return this.settings.defaultModel; }
  async   setProviderAndModel(providerId: string, model?: string): Promise<void> {
    this.settings.defaultProvider = providerId;
    if (model) this.settings.defaultModel = model;
    else {
      const p = this.settings.providers[providerId];
      if (p?.model) this.settings.defaultModel = p.model;
    }
  }

  /**
   * Run a manual compaction. Returns the formatted result (preview +
   * outcome) as a string. If `dryRun` is true, returns only the
   * preview without actually summarizing. The /compact slash command
   * uses this so it can stay decoupled from the runtime's internal
   * provider/session details.
   */
  async compactNow(opts: { dryRun?: boolean; instructions?: string } = {}): Promise<string> {
    if (!this.session) return "no active session";
    const provider = this.providerRegistry.default();
    if (!provider) return "no provider configured — set OPENAI_API_KEY or run /provider";
    const model = this.settings.defaultModel;
    if (!model) return "no model configured — run /model <name>";
    const msgs = sessionToMessages(this.session);
    if (msgs.length < 4) return "session is too short to compact (" + msgs.length + " messages)";
    const preview = previewCompaction(msgs);
    const previewStr = formatCompactionPreview(preview, { colorize: true });
    if (opts.dryRun) return previewStr;
    try {
      const r = await runCompaction(provider, model, msgs, { signal: new AbortController().signal });
      await this.session.compact(r.summary, opts.instructions ?? "");
      return previewStr + "\n\n" +
        "  ✓ compacted: " + r.inputTokens + " in / " + r.outputTokens + " out\n" +
        "  summary preview: " + r.summary.split("\n").slice(0, 3).join(" | ").slice(0, 160) + (r.summary.length > 160 ? "…" : "");
    } catch (e) {
      return previewStr + "\n\n  ✗ compaction failed: " + (e as Error).message;
    }
  }
  async setSession(id: string): Promise<void> { this.session = await Session.open(id); this.lastUserPrompt = null; }
  sessionId(): string | undefined { return this.session?.id; }
  clearHistory(): void { void Session.create({ cwd: this.cwd }).then((s) => { this.session = s; this.lastUserPrompt = null; }); }
  quit(): void { this.shouldQuit = true; }
  shouldExit(): boolean { return this.shouldQuit; }
  print(s: string): void {
    if (this.outputHandler?.onInfo) {
      this.outputHandler.onInfo(s);
      return;
    }
    process.stdout.write(s + "\n");
  }
  setThinking(level: string): void { this.thinking = level; }
  setPersonality(name: string | null): void { this.personality = name; }

  // ---- The real work ----

  async runUserTurn(userInput: string, opts: { captureText?: (s: string) => void } = {}): Promise<void> {
    // 1) Slash command?
    const parsed = tryParseSlash(userInput);
    if (parsed) {
      const cmd = BUILTIN_REGISTRY.get(parsed.name);
      if (cmd) {
        try {
          const out = await cmd.run(parsed.args, { cwd: this.cwd, runtime: () => this });
          if (typeof out === "string" && out.length > 0) this.print(out);
        } catch (e) {
          this.print(c.red("error: " + (e as Error).message));
        }
        return;
      }
      this.print(c.yellow("unknown command: /" + parsed.name) + " — use /help");
      return;
    }

    this.lastUserPrompt = userInput;
    const session = await this.ensureSession();
    if (!this.ephemeral) {
      await session.append({ kind: "message", message: { role: "user", content: userInput } });
    }
    const messages = sessionToMessages(session);

    const provider = this.providerRegistry.default();
    if (!provider) { this.print(c.red("no provider configured. set OPENAI_API_KEY or ANTHROPIC_API_KEY, or run /provider")); return; }
    const model = this.settings.defaultModel;
    if (!model) { this.print(c.red("no model configured. run /model <name> or set in settings.json")); return; }

    // 2) Auto-compaction check
    if (this.shouldCompact(messages)) {
      this.print(c.dim("  (compacting — session is getting long)"));
      const preview = previewCompaction(messages);
      this.print(formatCompactionPreview(preview, { colorize: true }));
      await this.compact(provider, model, messages, session, "");
    }

    // 3) Build system prompt with context + skills + personality
    const system = await this.buildSystemPrompt();

    // 4) Build tool services
    const services = this.buildToolServices(provider, model);

    // 5) Run the agent
    const ac = new AbortController();
    const onSig = () => { try { ac.abort(); } catch {} };
    process.once("SIGINT", onSig);

    let sawAnyText = false;
    const outputHandler = this.outputHandler;
    try {
      const result = await runAgent({
        provider,
        model,
        system,
        messages,
        tools: this.tools,
        cwd: this.cwd,
        signal: ac.signal,
        limits: { ...DEFAULT_LIMITS, bashTimeoutMs: this.settings.tools?.bashTimeoutMs ?? DEFAULT_LIMITS.bashTimeoutMs, readMaxBytes: this.settings.tools?.readMaxBytes ?? DEFAULT_LIMITS.readMaxBytes },
        failoverChain: this.buildFailoverChain(),
        hooks: {
          onTextDelta: (t) => {
            if (opts.captureText) opts.captureText(t);
            if (outputHandler?.onTextDelta) {
              outputHandler.onTextDelta(t);
              sawAnyText = true;
              return;
            }
            if (!sawAnyText) { process.stdout.write("\n"); sawAnyText = true; }
            process.stdout.write(t);
          },
          onToolCallStart: (tc) => {
            if (outputHandler?.onToolCallStart) {
              outputHandler.onToolCallStart(tc);
              return;
            }
            process.stdout.write("\n" + c.gray("→ " + tc.name) + " " + c.dim(summarizeArgs(tc.argsJson)) + "\n");
          },
          onToolCallEnd: (tc, r) => {
            if (outputHandler?.onToolCallEnd) {
              outputHandler.onToolCallEnd(tc, r);
            } else {
              const mark = r.isError ? c.red("✗") : c.green("✓");
              process.stdout.write(c.gray("  " + mark + " " + r.display) + "\n");
            }
            if (!this.ephemeral) {
              void session.append({ kind: "tool_result", toolCallId: tc.id, toolName: tc.name, result: r });
              void session.append({ kind: "tool_call_record", toolCall: tc, args: safeParse(tc.argsJson) });
            }
          },
          onUsage: (u) => {
            this.lastTokensIn = u.inputTokens;
            this.lastTokensOut = u.outputTokens;
            this.cost.record(model, provider.id, u.inputTokens, u.outputTokens);
            outputHandler?.onUsage?.(u);
            if (this.settings.ui?.showTokenUsage !== false) {
              if (!outputHandler?.onInfo) {
                const t = this.cost.total();
                process.stdout.write(c.dim("  (tokens in=" + u.inputTokens + " out=" + u.outputTokens + " · session cost " + formatUSD(t.cost) + ")") + "\n");
              }
            }
          },
          onError: (e) => {
            outputHandler?.onError?.(e);
            this.print(c.red("  ! " + e.message));
          },
        },
        onComplete: (m) => {
          if (!this.ephemeral) {
            void session.append({ kind: "message", message: m });
          }
        },
      });
      if (sawAnyText) process.stdout.write("\n");
      this.print(c.dim("  (" + result.steps + " step" + (result.steps === 1 ? "" : "s") + ", " + result.usage.inputTokens + " in / " + result.usage.outputTokens + " out)"));
      if (this.trace) this.print(c.dim("  (trace: " + JSON.stringify(result.final.toolCalls?.map((t) => t.name) ?? []) + ")"));
    } catch (e) {
      this.print(c.red("agent crashed: " + (e as Error).message));
      log.error("agent crash", e);
    } finally {
      outputHandler?.onTurnEnd?.();
      process.removeListener("SIGINT", onSig);
    }
  }

  async sendPrompt(prompt: string, opts: { silent?: boolean } = {}): Promise<void> {
    if (!opts.silent) process.stdout.write(c.cyan("› ") + prompt + "\n");
    await this.runUserTurn(prompt);
  }
  async sendPromptWithCapture(prompt: string): Promise<string> {
    this.lastCapture = "";
    await this.runUserTurn(prompt, { captureText: (s) => { this.lastCapture += s; } });
    return this.lastCapture;
  }

  // ---- Slash helpers exposed to commands ----
  listAgents() { return this.subagents.list(); }

  // ---- Internals ----

  private buildToolServices(provider: Provider, model: string) {
    const rt = this;
    return {
      spawnSubagent: async (input: { agent: string; prompt: string; model?: string; providerId?: string; cwd?: string }) => {
        const ac = new AbortController();
        process.once("SIGINT", () => ac.abort());
        const id = input.agent + ":" + Date.now().toString(36);
        rt.activeSubagents.set(id, { prompt: input.prompt, startedAt: Date.now(), status: "running" });
        try {
          const r = await rt.subagents.spawn({ ...input, cwd: input.cwd ?? rt.cwd, signal: ac.signal });
          rt.activeSubagents.set(id, { prompt: input.prompt, startedAt: Date.now(), status: r.status === "ok" ? "ok" : r.status === "error" ? "err" : "running" });
          // Track sub-agent cost.
          if (r.usage) rt.cost.record(input.model ?? model, input.providerId ?? provider.id, r.usage.inputTokens, r.usage.outputTokens, input.agent);
          rt.subagentHistory.push({ name: input.agent, prompt: input.prompt, status: r.status, at: Date.now(), cost: r.usage ? callCost(input.model ?? model, r.usage.inputTokens, r.usage.outputTokens) : 0, steps: r.steps });
          // Auto-evict after 5s.
          setTimeout(() => rt.activeSubagents.delete(id), 5_000);
          return r;
        } finally {
          process.removeListener("SIGINT", () => ac.abort());
        }
      },
      loadSkill: async (name: string) => {
        const s = await this.skills.get(name);
        return s ? { name: s.name, description: s.description, content: s.content } : null;
      },
      listSkills: async () => {
        const all = await this.skills.list();
        return all.map((s) => ({ name: s.name, description: s.description }));
      },
      readMemory: () => this.memory.read(),
      appendMemory: async (t: string) => { await this.memory.append(t); },
      searchMemory: async (q: string) => { return this.memory.search(q); },
      readTodo: () => this.todoItems,
      writeTodo: async (items: string[]) => { this.todoItems = items; if (this.session) void this.session.append({ kind: "meta", data: { todo: items } }); },
      getApproval: () => this.approval,
      askApproval: async (command: string, reason: string) => {
        if (!this.askApprovalHandler) {
          // No host — return "deny" so the tool surfaces a static error
          // rather than hanging or running the command unapproved.
          return "deny";
        }
        const decision = await this.askApprovalHandler(command, reason);
        if (decision === "allow-always") {
          // Persist the exact command to the allowlist. We escape
          // regex metacharacters and anchor with ^...$ to make it
          // a strict exact-match pattern. The user can hand-edit
          // settings.json to make it broader.
          const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const pattern = "^" + escaped + "$";
          if (!this.approval.allowlist.includes(pattern)) {
            this.approval.allowlist.push(pattern);
            // Mirror to settings.json so the rule survives restarts.
            if (!this.settings.approval) {
              this.settings.approval = { ...this.approval };
            } else {
              this.settings.approval.allowlist = this.approval.allowlist.slice();
            }
            try { saveSettings(this.settings); } catch { /* best-effort */ }
          }
        }
        return decision;
      },
    };
  }
  private todoItems: string[] = [];

  /**
   * Build the failover chain from `settings.failover`. Each entry is
   * `{ provider, model }`. Providers not configured in settings are
   * silently skipped. Returns an empty array when no failover is set.
   * Public so the TUI / server can pass it to `runAgent` directly.
   */
  buildFailoverChain(): Array<{ provider: import("./types.js").Provider; model: string }> {
    const chain: Array<{ provider: import("./types.js").Provider; model: string }> = [];
    const failover = this.settings.failover;
    if (!Array.isArray(failover)) return chain;
    for (const f of failover) {
      const p = this.providerRegistry.get(f.provider);
      if (!p) {
        log.warn(`failover: provider "${f.provider}" not configured — skipping`);
        continue;
      }
      chain.push({ provider: p, model: f.model });
    }
    return chain;
  }

  private async buildSystemPrompt(): Promise<string> {
    const parts: string[] = [];
    parts.push("You are CodingHarness, a coding assistant running in a terminal.");
    parts.push("Working directory: " + this.cwd);
    parts.push("Today's date: " + new Date().toISOString().slice(0, 10));
    parts.push("");
    parts.push("Use the available tools to read, write, edit, and run code. Be concise.");
    parts.push("Prefer editing existing files over rewriting them whole. Prefer running tests/builds before claiming a fix is done.");
    parts.push("When blocked, say so explicitly rather than guessing.");
    parts.push("");
    parts.push("You have a 'spawn_subagent' tool for delegating subtasks. Use it for research, planning, review, " +
      "and parallelizable work — sub-agents have their own context, so they don't pollute yours.");
    parts.push("");

    // Personality (SOUL.md)
    if (this.personality) {
      try {
        const { readFileSync, existsSync } = await import("node:fs");
        const soulPath = paths.context + "/" + this.personality + ".md";
        if (existsSync(soulPath)) {
          parts.push("# Personality");
          parts.push(readFileSync(soulPath, "utf-8"));
          parts.push("");
        }
      } catch { /* ignore */ }
    }

    // Project context (AGENTS.md / CLAUDE.md)
    if (this.settings.loadContextFiles !== false) {
      if (!this.loadedContext) {
        const files = await loadContextFiles(this.cwd);
        this.loadedContext = formatContextForPrompt(files);
      }
      if (this.loadedContext) {
        parts.push(this.loadedContext);
        parts.push("");
      }
    }

    // Persistent memory
    const mem = this.memory.read();
    if (mem && mem.trim().length > 50) {
      parts.push("# Persistent memory");
      parts.push("Notes from previous sessions (relevant context only):");
      parts.push(mem.slice(0, 4_000));
      parts.push("");
    }

    // Skills catalog
    const skillsCatalog = await this.skills.catalogForPrompt();
    if (skillsCatalog) {
      parts.push(skillsCatalog);
      parts.push("");
    }

    // Sub-agent catalog
    const subList = this.subagents.list();
    if (subList.length > 0) {
      parts.push("Available sub-agents (use the spawn_subagent tool to delegate):");
      for (const a of subList) {
        parts.push("- " + a.name + " — " + a.description);
      }
      parts.push("");
    }

    // Thinking hint
    parts.push("Thinking level: " + this.thinking);
    parts.push("");

    return parts.join("\n");
  }

  private shouldCompact(messages: ChatMessage[]): boolean {
    const threshold = this.settings.contextCompactionThreshold ?? 0.85;
    const maxTokens = 100_000; // crude assumption
    const used = roughTokenCount(messages);
    return used > maxTokens * threshold && messages.length > 8;
  }

  private async compact(provider: Provider, model: string, messages: ChatMessage[], session: Session, instructions: string): Promise<void> {
    try {
      const r = await runCompaction(provider, model, messages, { signal: new AbortController().signal });
      await session.compact(r.summary, "");
      this.print(c.dim("  (compacted " + r.inputTokens + " in / " + r.outputTokens + " out)"));
    } catch (e) {
      this.print(c.red("  compaction failed: " + (e as Error).message));
    }
  }
}

function summarizeArgs(argsJson: string): string {
  try {
    const obj = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") parts.push(k + "=" + JSON.stringify(v.length > 60 ? v.slice(0, 60) + "…" : v));
      else parts.push(k + "=" + JSON.stringify(v));
      if (parts.length >= 3) break;
    }
    return parts.join(" ");
  } catch {
    return argsJson.length > 60 ? argsJson.slice(0, 60) + "…" : argsJson;
  }
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}
