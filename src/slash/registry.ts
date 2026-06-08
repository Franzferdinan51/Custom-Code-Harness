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
