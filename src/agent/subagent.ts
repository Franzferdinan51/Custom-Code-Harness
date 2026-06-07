// SubAgentManager — the heart of the parallel-agent system.
//
// The main agent can spawn a sub-agent by name (e.g. "explore",
// "plan", "review", or any user-defined agent). The sub-agent runs
// in isolation, with its own messages, tool allowlist, model, and
// step budget. When it finishes, only its final text is returned
// to the parent — the sub-agent's intermediate steps stay in its
// own session.
//
// Sub-agents can be run in two modes:
//   - sequential (default): parent waits, gets the result
//   - parallel: many sub-agents at once, all results returned
//
// Built-in agent types and their tool allowlists live in agents.ts.

import { runAgent, DEFAULT_LIMITS } from "./loop.js";
import { defaultToolRegistry, ToolRegistry } from "./tools/index.js";
import type { ChatMessage, Provider, ToolSpec, ToolResult } from "../types.js";
import { AgentRegistry, buildAgentSystemPrompt, type AgentDefinition } from "./agents.js";
import { Session, sessionToMessages } from "./session.js";
import { ProviderRegistry } from "../providers/registry.js";
import { log } from "../util/logger.js";
import type { Settings } from "../config/settings.js";

export interface SubAgentResult {
  agentName: string;
  status: "ok" | "error" | "cancelled" | "max_steps";
  /** Final text reply. */
  text: string;
  /** Token usage attributed to the sub-agent. */
  usage: { inputTokens: number; outputTokens: number };
  /** Steps used. */
  steps: number;
  /** Session id of the sub-agent's run (for resume / inspection). */
  sessionId?: string;
  /** Error message if status=error. */
  error?: string;
}

export interface SubAgentSpawnInput {
  /** Name from AgentRegistry. Falls back to "explore" if unknown. */
  agent: string;
  /** The prompt for the sub-agent. */
  prompt: string;
  /** Optional session id to fork from. */
  parentSessionId?: string;
  /** Override model. */
  model?: string;
  /** Override provider id. */
  providerId?: string;
  /** Cwd override. */
  cwd?: string;
  /** AbortSignal. */
  signal: AbortSignal;
  /** When true, do not persist the sub-agent's session. */
  ephemeral?: boolean;
}

export class SubAgentManager {
  private agents: AgentRegistry;
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly settings: Settings,
    opts: { cwd?: string } = {}
  ) {
    this.agents = new AgentRegistry({ cwd: opts.cwd });
  }

  list(): AgentDefinition[] { return this.agents.list(); }
  get(name: string): AgentDefinition | undefined { return this.agents.get(name); }

  /** Spawn one sub-agent and wait for the result. */
  async spawn(input: SubAgentSpawnInput): Promise<SubAgentResult> {
    const def = this.agents.get(input.agent) ?? this.agents.get("explore");
    if (!def) {
      return { agentName: input.agent, status: "error", text: "", usage: { inputTokens: 0, outputTokens: 0 }, steps: 0, error: "no agent definitions loaded" };
    }
    return await this.runOne(def, input);
  }

  /** Spawn N sub-agents in parallel, each with its own prompt. */
  async spawnMany(inputs: SubAgentSpawnInput[]): Promise<SubAgentResult[]> {
    return await Promise.all(inputs.map((i) => this.spawn(i)));
  }

  /** Build the `spawn_subagent` tool spec for the main agent. */
  toolSpec(): ToolSpec {
    return {
      name: "spawn_subagent",
      description:
        "Spawn an isolated sub-agent to handle a subtask. The sub-agent gets its own context, " +
        "model, and tool allowlist. Returns only the final text. " +
        "Available agents: " + this.agents.names().join(", ") + ". " +
        "Use 'explore' for read-only research, 'plan' for planning, 'review' for code review, " +
        "'summarize' to compress text, 'implement' for full edit access, 'test' for running tests.",
      parameters: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: "Sub-agent name. One of: " + this.agents.names().join(", "),
          },
          prompt: {
            type: "string",
            description: "The task / question for the sub-agent. Be specific.",
          },
          model: { type: "string", description: "Optional model override" },
          provider: { type: "string", description: "Optional provider id override" },
        },
        required: ["agent", "prompt"],
        additionalProperties: false,
      },
    };
  }

  /** Build a tool runner that the main agent loop can dispatch. */
  toolRunner(): {
    spec: ToolSpec;
    run: (args: Record<string, unknown>, ctx: { cwd: string; signal: AbortSignal }) => Promise<ToolResult>;
  } {
    const spec = this.toolSpec();
    return {
      spec,
      run: async (raw, ctx) => {
        const agent = String(raw.agent ?? "");
        const prompt = String(raw.prompt ?? "");
        const model = raw.model ? String(raw.model) : undefined;
        const provider = raw.provider ? String(raw.provider) : undefined;
        if (!agent) return { toolCallId: "", display: "spawn_subagent: missing agent", content: "missing required arg: agent", isError: true };
        if (!prompt) return { toolCallId: "", display: "spawn_subagent: missing prompt", content: "missing required arg: prompt", isError: true };
        try {
          const r = await this.spawn({
            agent,
            prompt,
            model,
            providerId: provider,
            cwd: ctx.cwd,
            signal: ctx.signal,
          });
          const header = "[sub-agent:" + r.agentName + " status=" + r.status + " steps=" + r.steps + " tokens=" + r.usage.inputTokens + "in/" + r.usage.outputTokens + "out]";
          if (r.status === "ok") {
            return { toolCallId: "", display: header, content: header + "\n\n" + r.text, isError: false };
          }
          return { toolCallId: "", display: header, content: header + "\n\n" + (r.error ?? r.text ?? "(no output)"), isError: r.status === "error" };
        } catch (e) {
          return { toolCallId: "", display: "spawn_subagent crashed", content: "spawn_subagent crashed: " + (e as Error).message, isError: true };
        }
      },
    };
  }

  // ---------- internals ----------

  private async runOne(def: AgentDefinition, input: SubAgentSpawnInput): Promise<SubAgentResult> {
    const providerId = input.providerId ?? def.providerId;
    const model = input.model ?? def.model;
    const provider = this.resolveProvider(providerId, model);
    if (!provider) {
      return { agentName: def.name, status: "error", text: "", usage: { inputTokens: 0, outputTokens: 0 }, steps: 0, error: "no provider available" };
    }
    const usedModel = model ?? this.settings.defaultModel ?? "default";

    // Build a filtered tool registry if the agent specifies one.
    const parentTools = defaultToolRegistry();
    const tools = def.tools ? filterTools(parentTools, def.tools) : parentTools;

    // Build a session so the sub-agent's history is preserved.
    let session: Session | null = null;
    let messages: ChatMessage[] = [];
    if (!input.ephemeral) {
      session = await Session.create({
        cwd: input.cwd ?? process.cwd(),
        model: usedModel,
        provider: provider.id,
      });
      await session.append({ kind: "message", message: { role: "user", content: input.prompt } });
      messages = sessionToMessages(session);
    } else {
      messages = [{ role: "user", content: input.prompt }];
    }

    const parentPrompt = "You are a sub-agent. Working directory: " + (input.cwd ?? process.cwd()) + ".";
    const systemPrompt = buildAgentSystemPrompt(parentPrompt, def);

    const limits = {
      ...DEFAULT_LIMITS,
      maxSteps: def.maxSteps ?? DEFAULT_LIMITS.maxSteps,
    };

    // Forward text events to stdout so the user sees the sub-agent
    // working. Errors are caught at the runAgent boundary already.
    const onText = (text: string) => {
      const tag = "  [sub:" + def.name + "] ";
      process.stdout.write("\n" + tag + text.replace(/\n/g, "\n" + tag));
    };

    try {
      const result = await runAgent({
        provider,
        model: usedModel,
        system: systemPrompt,
        messages,
        tools,
        cwd: input.cwd ?? process.cwd(),
        signal: input.signal,
        limits,
        hooks: {
          onTextDelta: onText,
          onToolCallStart: (tc) => {
            process.stdout.write("\n" + "  [sub:" + def.name + " → " + tc.name + "]\n");
          },
          onToolCallEnd: (_tc, r) => {
            process.stdout.write("  [sub:" + def.name + " " + (r.isError ? "✗" : "✓") + " " + r.display + "]\n");
          },
        },
        onComplete: (m) => {
          if (session) void session.append({ kind: "message", message: m });
        },
      });

      const status: SubAgentResult["status"] = input.signal.aborted
        ? "cancelled"
        : result.steps >= limits.maxSteps
          ? "max_steps"
          : "ok";
      if (session) await session.flush();
      return {
        agentName: def.name,
        status,
        text: result.final.content ?? "",
        usage: result.usage,
        steps: result.steps,
        sessionId: session?.id,
      };
    } catch (e) {
      log.error("sub-agent crashed", e);
      return {
        agentName: def.name,
        status: "error",
        text: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        steps: 0,
        error: (e as Error).message,
      };
    }
  }

  private resolveProvider(providerId: string | undefined, _model: string | undefined): Provider | null {
    if (providerId) return this.providers.get(providerId) ?? null;
    return this.providers.default() ?? null;
  }
}

function filterTools(parent: ToolRegistry, names: string[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const n of names) {
    const t = parent.get(n);
    if (t) r.register(t);
  }
  return r;
}
