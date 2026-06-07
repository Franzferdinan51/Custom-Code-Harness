// spawn_subagent tool — exposed to the main agent so it can delegate
// to a sub-agent. The actual spawn logic lives in SubAgentManager;
// this is the thin tool-shaped wrapper that the registry dispatches.

import type { Tool, ToolContext } from "./registry.js";
import { asString, parseToolArgs } from "./registry.js";
import type { ToolSpec } from "../../types.js";

interface SpawnArgs {
  agent: string;
  prompt: string;
  model?: string;
  provider?: string;
}

const spec: ToolSpec = {
  name: "spawn_subagent",
  description:
    "Spawn an isolated sub-agent to handle a subtask. The sub-agent gets its own context, " +
    "model, and tool allowlist. Returns only the final text. " +
    "Use 'explore' for read-only research, 'plan' for planning, 'review' for code review, " +
    "'summarize' to compress text, 'implement' for full edit access, 'test' for running tests.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Sub-agent name (e.g. explore, plan, review, summarize, implement, test)" },
      prompt: { type: "string", description: "The task / question for the sub-agent. Be specific." },
      model: { type: "string", description: "Optional model override" },
      provider: { type: "string", description: "Optional provider id override" },
    },
    required: ["agent", "prompt"],
    additionalProperties: false,
  },
};

export const spawnSubagentTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("spawn_subagent", JSON.stringify(rawArgs));
    return {
      agent: asString(a.agent, "agent", { allowEmpty: false, maxLen: 64 }),
      prompt: asString(a.prompt, "prompt", { allowEmpty: false, maxLen: 200_000 }),
      model: a.model !== undefined ? asString(a.model, "model", { maxLen: 256 }) : undefined,
      provider: a.provider !== undefined ? asString(a.provider, "provider", { maxLen: 64 }) : undefined,
    } as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const args = rawArgs as unknown as SpawnArgs;
    const svc = ctx.services?.spawnSubagent;
    if (!svc) {
      return { toolCallId: "", display: "spawn_subagent: no runtime", content: "sub-agent manager not configured", isError: true };
    }
    try {
      const r = await svc({
        agent: args.agent,
        prompt: args.prompt,
        model: args.model,
        providerId: args.provider,
        cwd: ctx.cwd,
      });
      const header = "[sub-agent:" + r.agentName + " status=" + r.status + " steps=" + r.steps + " tokens=" + r.usage.inputTokens + "in/" + r.usage.outputTokens + "out]";
      if (r.status === "ok") {
        return { toolCallId: "", display: header, content: header + "\n\n" + (r.text || "(no text)"), isError: false };
      }
      return { toolCallId: "", display: header, content: header + "\n\n" + (r.error ?? r.text ?? "(no output)"), isError: r.status === "error" };
    } catch (e) {
      return { toolCallId: "", display: "spawn_subagent crashed", content: "spawn_subagent crashed: " + (e as Error).message, isError: true };
    }
  },
};
