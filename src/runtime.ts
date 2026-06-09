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
import { DelegationManager } from "./agent/delegation.js";
import { GoalStore } from "./agent/goals.js";
import { SkillRegistry } from "./agent/skills.js";
import { MemoryStore } from "./agent/memory.js";
import { loadContextFiles, formatContextForPrompt } from "./agent/context.js";
import { loadExtensions } from "./agent/extensions.js";
import { compact as runCompaction, roughTokenCount, previewCompaction, formatCompactionPreview } from "./agent/compaction.js";
import { paths } from "./config/paths.js";
import type { ChatMessage, ToolCall, ToolResult, Provider, ProviderRequest } from "./types.js";
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
  onReasoningDelta?: (text: string) => void;
  onImageDelta?: (image: { url: string; mimeType?: string }) => void;
  onToolCallStart?: (toolCall: ToolCall) => void;
  onToolCallEnd?: (toolCall: ToolCall, result: ToolResult) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  onInfo?: (text: string) => void;
  onError?: (error: Error) => void;
  onTurnEnd?: () => void;
}

/**
 * Result of a `runDiag()` connectivity / latency probe. Returned from
 * `HarnessRuntime.runDiag()` and surfaced unchanged by the `/diag` slash
 * command, the `ch diag` CLI subcommand, and the `GET /v1/diag` HTTP
 * endpoint. Shape is stable — external dashboards can depend on it.
 */
export interface DiagResult {
  ok: boolean;
  provider?: string;
  model?: string;
  /** Time from request start to the first streamed event. 0 on error. */
  firstByteMs: number;
  /** Time from request start to completion. */
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Truncated model reply (usually "pong" for the canned prompt). */
  reply?: string;
  /** Set when `ok === false`. */
  error?: string;
}

export class HarnessRuntime implements SlashRuntime {
  readonly cwd: string;
  readonly settings: Settings;
  readonly providerRegistry: ProviderRegistry;
  readonly subagents: SubAgentManager;
  /** Phase 1: discriminated union for sub-work (agent / goal /
   *  async_tool / human_approval, plus Phase 2 stubs). */
  readonly delegations: DelegationManager;
  readonly skills: SkillRegistry;
  readonly memory: MemoryStore;
  readonly tools: ToolRegistry;
  /** Persisted goal store. */
  readonly goalStore: GoalStore;
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
  /** Stack of prompts that were rewound via `undoLastTurn()`. The next
   *  `redoLastTurn()` call pops the most recent one and re-sends it.
   *  Cleared whenever the user switches sessions, clears history, or
   *  forks. */
  private redoStack: string[] = [];
  private lastTokensIn = 0;
  private lastTokensOut = 0;
  private verbose = false;
  private trace = false;
  private composerMode: "plan" | "build" = "build";
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
    this.goalStore = new GoalStore();
    this.delegations = new DelegationManager({
      providers: this.providerRegistry,
      settings: this.settings,
      cwd: this.cwd,
      subagent: this.subagents,
      goalStore: this.goalStore,
    });
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
    this.verbose = !!this.settings.ui?.verbose;
    this.trace = !!this.settings.ui?.trace;
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
  async setProviderAndModel(providerId: string, model?: string, opts?: { persistSettings?: boolean }): Promise<void> {
    this.settings.defaultProvider = providerId;
    if (model) this.settings.defaultModel = model;
    else {
      const p = this.settings.providers[providerId];
      if (p?.model) this.settings.defaultModel = p.model;
    }
    this.providerRegistry.invalidate(providerId);
    if (opts?.persistSettings !== false) {
      try { saveSettings(this.settings); } catch { /* best-effort */ }
    }
  }

  /**
   * Save an API key for a provider, persist settings, and (best effort)
   * invalidate the cached provider so the new key is picked up on the
   * next call. Returns whether the key looks plausible.
   *
   * This is the entry point for `/provider setup`, `ch provider set-key`,
   * and the `ch onboard` wizard. It does NOT echo the key back to the
   * user — we surface only "saved" / "looks invalid" so the secret
   * doesn't leak through scrollback or `ch info` output.
   */
  async saveProviderApiKey(
    providerId: string,
    apiKey: string,
    opts?: { makeDefault?: boolean; model?: string; baseUrl?: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    const { getProviderPreset } = await import("./providers/presets.js");
    const preset = getProviderPreset(providerId);
    const optionalAuth = preset?.authModes.includes("optional") ?? false;
    const trimmed = apiKey.trim();
    if (trimmed.length === 0 && !optionalAuth) return { ok: false, reason: "empty key" };
    if (trimmed.length > 0 && trimmed.length < 8) return { ok: false, reason: "key is too short to be a real API key" };
    if (!this.settings.providers[providerId]) {
      if (preset) {
        this.settings.providers[providerId] = {
          id: preset.id,
          baseUrl: preset.defaultBaseUrl,
          model: preset.defaultModel,
          authMode: preset.defaultAuthMode,
        };
      } else {
        return { ok: false, reason: "unknown provider: " + providerId };
      }
    }
    const p = this.settings.providers[providerId]!;
    if (trimmed.length > 0) p.apiKey = trimmed;
    else delete p.apiKey;
    if (opts?.baseUrl) p.baseUrl = opts.baseUrl.trim();
    if (opts?.model) p.model = opts.model;
    if (opts?.makeDefault !== false) {
      this.settings.defaultProvider = providerId;
      this.settings.defaultModel = p.model;
    }
    try { saveSettings(this.settings); } catch { /* best-effort */ }
    this.providerRegistry.invalidate(providerId);
    return { ok: true };
  }

  /** Save Codex OAuth tokens from a device-code login flow. */
  async saveCodexOAuthTokens(tokens: import("./providers/oauth/codex.js").CodexOAuthTokens, opts?: { makeDefault?: boolean; model?: string }): Promise<{ ok: boolean; reason?: string }> {
    const { saveCodexOAuthTokens: persist } = await import("./providers/oauth/codex.js");
    if (!tokens.accessToken || !tokens.refreshToken) {
      return { ok: false, reason: "missing OAuth tokens" };
    }
    persist(this.settings, tokens, opts);
    this.providerRegistry.invalidate("codex");
    return { ok: true };
  }

  /** Run the Codex device-code OAuth login flow (CLI / slash / web). */
  async loginCodexOAuth(hooks?: import("./providers/oauth/codex.js").CodexOAuthLoginHooks): Promise<{ ok: boolean; reason?: string }> {
    const { loginCodexOAuth } = await import("./providers/oauth/codex.js");
    try {
      const tokens = await loginCodexOAuth(hooks);
      await this.saveCodexOAuthTokens(tokens, { makeDefault: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  /** True when no provider is configured at all (no env vars, no
   *  settings.json, no default). Used to trigger the onboarding
   *  prompt on first launch. */
  isFirstRun(): boolean {
    // LM Studio is pre-configured as the primary local provider — only
    // prompt onboarding when no default provider/model is usable.
    if (this.settings.defaultProvider && this.settings.defaultModel) return false;
    const envHasHostedKey = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MINIMAX_API_KEY", "XAI_API_KEY", "CODEX_OAUTH_TOKEN"]
      .some((name) => !!process.env[name] && process.env[name]!.length > 0);
    return !envHasHostedKey;
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

  /**
   * Run a connectivity / latency check against the current default
   * provider. Streams a single tiny prompt and reports:
   *   - whether the provider responded successfully
   *   - first-byte latency (ms from request start to first event)
   *   - total latency (ms from request start to done)
   *   - input / output / total tokens
   *   - the model's literal reply (typically "ok" or similar)
   *
   * The HTTP `/v1/diag` endpoint and the `ch diag` CLI subcommand both
   * delegate to this so the three surfaces (slash, CLI, REST) return
   * the exact same shape.
   */
  async runDiag(): Promise<DiagResult> {
    const empty: DiagResult = { ok: false, firstByteMs: 0, totalMs: 0, inputTokens: 0, outputTokens: 0 };
    const provider = this.providerRegistry.default();
    if (!provider) {
      return { ...empty, provider: this.providerId(), model: this.model(), error: "no provider configured" };
    }
    const model = this.settings.defaultModel;
    if (!model) {
      return { ...empty, provider: provider.id, model: "(none)", error: "no model configured — run /model" };
    }
    const started = Date.now();
    let firstByteMs: number | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let reply = "";
    let sawAnyEvent = false;
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(new Error("diag timeout after 30s")), 30_000);
    try {
      const req: ProviderRequest = {
        model,
        system: "You are a connectivity check. Reply with the single word: pong",
        messages: [{ role: "user", content: "ping" }],
        tools: [],
        maxTokens: 32,
        temperature: 0,
        signal: ac.signal,
      };
      for await (const ev of provider.stream(req)) {
        if (!sawAnyEvent) { firstByteMs = Date.now() - started; sawAnyEvent = true; }
        if (ev.type === "text") reply += ev.text ?? "";
        else if (ev.type === "usage" && ev.usage) { inputTokens = ev.usage.inputTokens; outputTokens = ev.usage.outputTokens; }
        else if (ev.type === "error") throw new Error(ev.error?.message ?? "provider error");
      }
      return {
        ok: true,
        provider: provider.id,
        model,
        firstByteMs: firstByteMs ?? 0,
        totalMs: Date.now() - started,
        inputTokens,
        outputTokens,
        reply: reply.trim().slice(0, 200),
      };
    } catch (e) {
      return {
        ok: false,
        provider: provider.id,
        model,
        firstByteMs: firstByteMs ?? 0,
        totalMs: Date.now() - started,
        inputTokens,
        outputTokens,
        error: (e as Error).message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Rewind the active session to the previous user message. Pushes
   * the rewound-to prompt onto a redo stack so `/redo` can replay it.
   * Returns the prompt that was rewound to, or null if there's nothing
   * to undo.
   */
  async undoLastTurn(): Promise<string | null> {
    if (!this.session) return null;
    const s = this.session;
    const entries = s.allEntries();
    // Find the last assistant entry, then walk back to the user message before it.
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.type === "assistant") {
        for (let j = i - 1; j >= 0; j--) {
          const prev = entries[j]!;
          if (prev.type === "user" && prev.payload.kind === "message") {
            const rewoundPrompt = prev.payload.message.content;
            s.rewindTo(prev.id);
            // Cap the redo stack at 10 so a long editing session doesn't
            // grow without bound. Most edits are 1–3 undos deep.
            this.redoStack.push(rewoundPrompt);
            if (this.redoStack.length > 10) this.redoStack.shift();
            return rewoundPrompt;
          }
        }
        return null;
      }
    }
    return null;
  }

  /** Re-send the most recently undone prompt. Pops from the redo stack
   *  and forwards to `runUserTurn`. Returns the prompt that was re-sent
   *  (so the slash command can confirm to the user), or null if the
   *  redo stack is empty. */
  async redoLastTurn(): Promise<string | null> {
    const prompt = this.redoStack.pop();
    if (prompt === undefined) return null;
    await this.runUserTurn(prompt);
    return prompt;
  }

  /** Number of prompts on the redo stack. Exposed for diagnostics /
   *  the TUI status bar. */
  getRedoStackDepth(): number { return this.redoStack.length; }

  async setSession(id: string): Promise<void> { this.session = await Session.open(id); this.lastUserPrompt = null; this.redoStack = []; }
  sessionId(): string | undefined { return this.session?.id; }
  clearHistory(): void { void Session.create({ cwd: this.cwd }).then((s) => { this.session = s; this.lastUserPrompt = null; this.redoStack = []; }); }
  quit(): void { this.shouldQuit = true; }
  shouldExit(): boolean { return this.shouldQuit; }
  print(s: string): void {
    if (this.outputHandler?.onInfo) {
      this.outputHandler.onInfo(s);
      return;
    }
    process.stdout.write(s + "\n");
  }
  setThinking(level: string): void {
    this.thinking = level;
    this.settings.thinking = level as Settings["thinking"];
    try { saveSettings(this.settings); } catch { /* best-effort */ }
  }
  setVerbose(enabled: boolean): void {
    this.verbose = enabled;
    this.settings.ui = { ...(this.settings.ui ?? {}), verbose: enabled };
    try { saveSettings(this.settings); } catch { /* best-effort */ }
  }
  setTrace(enabled: boolean): void {
    this.trace = enabled;
    this.settings.ui = { ...(this.settings.ui ?? {}), trace: enabled };
    try { saveSettings(this.settings); } catch { /* best-effort */ }
  }
  setComposerMode(mode: "plan" | "build"): void { this.composerMode = mode === "plan" ? "plan" : "build"; }
  getComposerMode(): "plan" | "build" { return this.composerMode; }
  setPersonality(name: string | null): void { this.personality = name; }

  // ---- The real work ----

  async runUserTurn(
    userInput: string,
    opts: {
      captureText?: (s: string) => void;
      attachments?: Array<{ type?: string; url: string; mimeType?: string }>;
    } = {},
  ): Promise<void> {
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

    const { expandInputPrefixes } = await import("./util/input-prefixes.js");
    const expanded = await expandInputPrefixes(userInput, this.cwd);
    const effectiveInput = expanded.prompt;

    this.lastUserPrompt = effectiveInput;
    const session = await this.ensureSession();
    if (!this.ephemeral) {
      const { buildUserContentParts } = await import("./providers/omni.js");
      const contentParts = buildUserContentParts(effectiveInput, opts.attachments);
      await session.append({
        kind: "message",
        message: {
          role: "user",
          content: effectiveInput,
          ...(contentParts ? { contentParts } : {}),
        },
      });
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
    if (this.verbose) {
      this.print(c.dim("  (verbose: " + messages.length + " messages, thinking " + this.thinking + ")"));
    }
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
          onReasoningDelta: (t) => {
            outputHandler?.onReasoningDelta?.(t);
            if (!outputHandler?.onReasoningDelta && this.settings.ui?.showReasoning !== false) {
              process.stdout.write(c.dim(t));
            }
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
  /** Look up a single agent definition by name. Returns undefined
   *  when the agent isn't registered. Used by `/agents <name>` and
   *  the future `ch agents show <name>` CLI subcommand. */
  getAgent(name: string) { return this.subagents.get(name); }
  /** Read the current in-session todo list. Same data the `todo`
   *  tool sees when the agent invokes it. */
  readTodo(): string[] { return this.todoItems; }
  /** Replace the in-session todo list. Persists to the session
   *  JSONL so reloads see it. */
  async writeTodo(items: string[]): Promise<void> {
    this.todoItems = items;
    if (this.session) {
      try { await this.session.append({ kind: "meta", data: { todo: items } }); } catch { /* best-effort */ }
    }
  }

  // ---- Internals ----

  /**
   * Build the `services` map that tools receive in their ToolContext.
   * Public so unit tests can exercise `spawnSubagent` and the other
   * service functions directly (without going through the agent loop).
   */
  buildToolServices(provider: Provider, model: string) {
    const rt = this;
    return {
      spawnSubagent: async (input: { agent: string; prompt: string; model?: string; providerId?: string; cwd?: string }) => {
        const ac = new AbortController();
        // Stash the listener so we can remove the EXACT same one in `finally`.
        // (Previously this used an inline arrow — removeListener could never
        //  match it, so SIGINT listeners accumulated across sub-agent calls.)
        const onSig = () => ac.abort();
        process.once("SIGINT", onSig);
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
          process.removeListener("SIGINT", onSig);
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
      provider,
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

  /**
   * Build the system prompt used for the current model turn. Public so
   * `ch run --json` and other one-shot modes can stream with the same
   * system prompt as the REPL/TUI/Web UI.
   */
  async buildSystemPrompt(): Promise<string> {
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

    // Memory recall (3-layer BM25). Best-effort: any failure here
    // is caught and logged, never throws. Uses the most recent
    // user prompt as the query. We surface only the top 5 hits
    // because the persistent memory block above already has the
    // full text; recall is for the LLM's attention budget.
    if (this.lastUserPrompt && this.lastUserPrompt.trim().length >= 4) {
      try {
        const { MemoryLayerStore } = await import("./agent/memory-layers.js");
        const store = new MemoryLayerStore();
        const recallHits = await store.search(this.lastUserPrompt, 5);
        if (recallHits && recallHits.trim().length > 0) {
          parts.push("# Memory recall (BM25, 3-layer)");
          parts.push("Relevant notes from your persistent memory for this query:");
          parts.push(recallHits.slice(0, 2_000));
          parts.push("");
        }
      } catch (e) {
        // Best-effort: a broken recall path must not break the
        // agent loop.
        try { (await import("./util/logger.js")).log.warn("memory-recall: " + (e as Error).message); } catch { /* ignore */ }
      }
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
