// skill tool — load a named skill's content into context.
// Skills are SKILL.md files in ~/.codingharness/skills/, .codingharness/skills/,
// or from any registered source. The tool returns the full body so the
// model can read it.

import type { Tool, ToolContext } from "./registry.js";
import { asString, parseToolArgs } from "./registry.js";
import type { ToolSpec } from "../../types.js";

interface SkillArgs {
  action: "list" | "load";
  name?: string;
}

const spec: ToolSpec = {
  name: "skill",
  description:
    "List available skills or load a specific skill by name. A skill is a SKILL.md file " +
    "in ~/.codingharness/skills/ or .codingharness/skills/. Loading a skill returns its " +
    "full content for you to read and apply.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "One of: list, load" },
      name: { type: "string", description: "For 'load': the skill name" },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

export const skillTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("skill", JSON.stringify(rawArgs));
    const action = asString(a.action, "action", { allowEmpty: false, maxLen: 16 });
    if (!["list", "load"].includes(action)) {
      throw new Error("action must be one of: list, load");
    }
    return {
      action,
      name: a.name !== undefined ? asString(a.name, "name", { maxLen: 64 }) : undefined,
    } as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const args = rawArgs as unknown as SkillArgs;
    const svc = ctx.services;
    if (!svc) return { toolCallId: "", display: "skill: no runtime", content: "skill runtime not configured", isError: true };
    try {
      if (args.action === "list") {
        const list = svc.listSkills?.() ?? [];
        const text = list.length === 0
          ? "(no skills installed)"
          : list.map((s, i) => (i + 1) + ". " + s.name + " — " + s.description).join("\n");
        return { toolCallId: "", display: "skills: " + list.length, content: text, isError: false };
      }
      if (args.action === "load") {
        if (!args.name) return { toolCallId: "", display: "skill: missing name", content: "load requires name", isError: true };
        const skill = await svc.loadSkill?.(args.name);
        if (!skill) return { toolCallId: "", display: "skill: not found", content: "no skill named: " + args.name, isError: true };
        return { toolCallId: "", display: "skill: " + skill.name, content: skill.content, isError: false };
      }
      return { toolCallId: "", display: "skill: bad action", content: "unknown action", isError: true };
    } catch (e) {
      return { toolCallId: "", display: "skill crashed", content: "skill crashed: " + (e as Error).message, isError: true };
    }
  },
};
