// Tool registry. Every tool implements this interface; the agent
// loop dispatches via the registry.

import type { ToolResult, ToolSpec } from "../../types.js";
import { ToolError } from "../../util/errors.js";

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  /** Settings for runtime limits (timeouts, byte caps). */
  limits: { bashTimeoutMs: number; readMaxBytes: number; maxToolResultBytes?: number; maxSteps?: number; requestTimeoutMs?: number };
  /** Logger hook. */
  log: (msg: string) => void;
  /** Optional runtime services that some tools need. */
  services?: ToolServices;
}

/** Services some tools need. All optional; tools must check for undefined. */
export interface ToolServices {
  spawnSubagent?: (input: {
    agent: string;
    prompt: string;
    model?: string;
    providerId?: string;
    cwd?: string;
  }) => Promise<{ status: "ok" | "error" | "cancelled" | "max_steps"; text: string; usage: { inputTokens: number; outputTokens: number }; steps: number; error?: string; agentName: string }>;
  loadSkill?: (name: string) => Promise<{ name: string; description: string; content: string } | null>;
  listSkills?: () => Array<{ name: string; description: string }>;
  readMemory?: () => string;
  appendMemory?: (text: string) => Promise<void>;
  searchMemory?: (query: string) => Promise<string>;
  readTodo?: () => string[];
  writeTodo?: (items: string[]) => Promise<void>;
  httpFetch?: (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number }) => Promise<{ status: number; body: string; contentType: string }>;
  webSearch?: (query: string, maxResults?: number) => Promise<Array<{ title: string; url: string; snippet: string }>>;
  /** Active LLM provider (for generate_image and omni helpers). */
  provider?: import("../../types.js").Provider;
  /** Returns the current approval config (settable from settings). */
  getApproval?: () => import("../../agent/approval.js").ApprovalConfig;
  /** Asks the user interactively for a decision. Returns "allow-once",
   *  "allow-always", or "deny". The host (TUI, web) decides how to
   *  surface the prompt. If unset, the tool falls back to a static
   *  "needs approval" error so non-interactive callers still get a
   *  structured response. */
  askApproval?: (command: string, reason: string) => Promise<"allow-once" | "allow-always" | "deny">;
}

export interface Tool {
  readonly spec: ToolSpec;
  /** Validate raw args from the model. Throw ToolError on bad input. */
  validate(args: unknown): Record<string, unknown>;
  /** Execute the tool. Must not throw on user errors; return isError=true. */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  register(t: Tool): void {
    this.tools.set(t.spec.name, t);
  }
  /** Internal: register a tool whose run() takes a different ctx shape.
   *  Used by the runtime for spawn_subagent, skill, etc. */
  _registerRaw(t: Tool): void {
    this.tools.set(t.spec.name, t);
  }
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
  list(): Tool[] {
    return [...this.tools.values()];
  }
  specs(): ToolSpec[] {
    return this.list().map((t) => t.spec);
  }
}

export function parseToolArgs(name: string, argsJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch (e) {
    throw new ToolError(name, `invalid JSON arguments: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(name, `arguments must be a JSON object, got ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

export function asString(v: unknown, name: string, opts: { allowEmpty?: boolean; maxLen?: number } = {}): string {
  if (typeof v !== "string") throw new ToolError(name, `${name} must be a string, got ${typeof v}`);
  if (!opts.allowEmpty && v.length === 0) throw new ToolError(name, `${name} must not be empty`);
  if (opts.maxLen && v.length > opts.maxLen) {
    throw new ToolError(name, `${name} exceeds max length ${opts.maxLen} (got ${v.length})`);
  }
  return v;
}

export function asNumber(v: unknown, name: string, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolError(name, `${name} must be a number`);
  if (opts.integer && !Number.isInteger(v)) throw new ToolError(name, `${name} must be an integer`);
  if (opts.min !== undefined && v < opts.min) throw new ToolError(name, `${name} must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new ToolError(name, `${name} must be <= ${opts.max}`);
  return v;
}
