// Slash command system. Built-in commands registered at startup;
// users can register more by dropping markdown files into prompts/ or
// via settings.json.

export interface SlashContext {
  /** Current working directory. */
  cwd: string;
  /** Optional ref to the harness runtime (lazy-resolved to avoid cycles). */
  runtime?: () => SlashRuntime;
}

export interface GoalActivityState {
  mode: "goal";
  objective: string;
  phase: "planning" | "executing" | "complete" | "blocked";
  step: number;
  maxSteps: number;
  startedAt: number;
  updatedAt: number;
  statusText?: string;
}

export interface SlashRuntime {
  /** Get the live session object if the host exposes one. */
  getSession?(): import("../agent/session.js").Session | null;
  /** Current provider id. */
  providerId(): string | undefined;
  /** Current model. */
  model(): string | undefined;
  /** Switch provider/model. */
  setProviderAndModel(providerId: string, model?: string, opts?: { persistSettings?: boolean }): Promise<void>;
  /** Replace the active session. */
  setSession(id: string): Promise<void>;
  /** Get the active session id (or undefined if no session). */
  sessionId(): string | undefined;
  /** Clear the conversation history (start a new in-memory branch). */
  clearHistory(): void;
  /** Quit the CLI. */
  quit(): void;
  /** Print to the user. */
  print(s: string): void;
  /** Run a one-shot prompt and stream output. */
  sendPrompt(prompt: string, opts?: { silent?: boolean }): Promise<void>;
  /** Run a one-shot prompt and return the full text response (no streaming). */
  sendPromptWithCapture(prompt: string): Promise<string>;
  /** Set the thinking level. */
  setThinking?(level: string): void;
  /** Set the workflow framing used for plain prompts. */
  setComposerMode?(mode: "plan" | "build"): void;
  /** Read the current workflow framing. */
  getComposerMode?(): "plan" | "build";
  /** Set the personality. null clears. */
  setPersonality?(name: string | null): void;
  /** Persistent memory store. */
  memory?: {
    read(): string;
    append(text: string): Promise<void>;
    search(query: string): Promise<string>;
    readUser(): string;
    appendUser(text: string): Promise<void>;
  };
  /** Skill registry. */
  skills?: {
    list(): Promise<Array<{ name: string; description: string }>>;
    load(name: string): Promise<{ content: string } | null>;
  };
  /** List sub-agents. */
  listAgents?(): Array<{ name: string; description: string; builtin?: boolean }>;
  /** Look up a single sub-agent by name. Used by `/agents <name>`
   *  for the focused one-agent view. Returns undefined when the
   *  agent isn't registered. */
  getAgent?(name: string): import("../agent/agents.js").AgentDefinition | undefined;
  /** Update live goal-mode activity for hosts like the desktop UI. */
  setGoalActivity?(state: GoalActivityState | null): void;
  /** Read current goal-mode activity, if any. */
  getGoalActivity?(): GoalActivityState | null;
  /**
   * Run a connectivity / latency check against the current default
   * provider. Returns the structured result; the `/diag` slash command
   * formats it for the TUI. Returns `null` if the runtime does not
   * support it (e.g. in tests with a stubbed runtime).
   */
  runDiag?(): Promise<import("../runtime.js").DiagResult>;
  /** Save an API key for a provider. Returns `{ok, reason?}`. Used
   *  by `/provider setup <id> <key>` and the onboarding wizard. */
  saveProviderApiKey?(providerId: string, apiKey: string, opts?: { makeDefault?: boolean; model?: string }): Promise<{ ok: boolean; reason?: string }>;
  /** Run Codex device-code OAuth login. */
  loginCodexOAuth?(hooks?: import("../providers/oauth/codex.js").CodexOAuthLoginHooks): Promise<{ ok: boolean; reason?: string }>;
  /** True when no provider is configured at all. The TUI uses this
   *  on launch to print an onboarding hint instead of a generic welcome. */
  isFirstRun?(): boolean;
  /** Read the current in-session todo list. The same data the
   *  `todo` tool sees when the agent invokes it. */
  readTodo?(): string[];
  /** Replace the in-session todo list. Persists to the session
   *  JSONL via the runtime's todo service so reloads see it. */
  writeTodo?(items: string[]): Promise<void>;
  /** Provider registry, for `/provider models [id]` and similar
   *  lookups that need to resolve a non-default provider by id. */
  providerRegistry?: import("../providers/registry.js").ProviderRegistry;
  /** Rewind the active session to the previous user message. The
   *  runtime pushes the rewound-to prompt onto a redo stack so
   *  `redoLastTurn()` can replay it. Returns the prompt that was
   *  rewound to, or null if there's nothing to undo. */
  undoLastTurn?(): Promise<string | null>;
  /** Re-send the most recently undone prompt. Pops from the runtime's
   *  redo stack and forwards to `runUserTurn`. Returns the prompt
   *  that was re-sent, or null if the redo stack is empty. */
  redoLastTurn?(): Promise<string | null>;
  /** Number of prompts currently on the redo stack. Exposed for
   *  diagnostics and the TUI status bar. */
  getRedoStackDepth?(): number;
  /**
   * The mid-run steer queue (agnt-gg /steer primitive). When the
   * REPL is busy, the user's text is stashed here and applied to
   * the last `role: "tool"` message on the next turn boundary.
   *
   * The `/steer` slash command uses this hook to inspect, drop, or
   * clear queued entries. Hosts that don't support steer (the
   * legacy CLI, the desktop, tests) can leave this unset — the
   * slash command prints a friendly "not available" message.
   */
  steerQueue?: {
    /** Snapshot of queued entries in queue order. */
    list(): Array<{ id: number; text: string; queuedAt: number }>;
    /** Remove a specific entry by id. Returns the removed entry or
     *  null when the id is unknown. */
    remove(id: number): unknown;
    /** Empty the queue. */
    clear(): void;
  };
}

export interface SlashCommand {
  name: string;
  description: string;
  /** Optional grouping hint for help UIs. */
  group?: string;
  /** Optional usage string, e.g. "/model [name]" */
  usage?: string;
  /** Run the command. Return a message to print, or throw on user error. */
  run(args: string, ctx: SlashContext): Promise<string | void> | string | void;
}

export class SlashRegistry {
  private cmds = new Map<string, SlashCommand>();
  register(c: SlashCommand): void {
    this.cmds.set(c.name, c);
  }
  get(name: string): SlashCommand | undefined {
    return this.cmds.get(name);
  }
  list(): SlashCommand[] {
    return [...this.cmds.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  names(): string[] {
    return this.list().map((c) => c.name);
  }
}

/** Try to parse a user input as a slash command. Returns null if not. */
export function tryParseSlash(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const m = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/);
  if (!m) return null;
  return { name: m[1]!, args: (m[2] ?? "").trim() };
}
