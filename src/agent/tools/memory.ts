// memory tool — lets the agent read, append to, and search the
// persistent memory file. Backed by MemoryStore (see memory.ts).

import type { Tool, ToolContext } from "./registry.js";
import { asString, parseToolArgs } from "./registry.js";
import type { ToolSpec } from "../../types.js";

interface MemoryArgs {
  action: "read" | "append" | "search";
  text?: string;
  query?: string;
}

const spec: ToolSpec = {
  name: "memory",
  description:
    "Persistent cross-session memory. Use 'read' to see what's remembered, " +
    "'append' to add a new note, 'search' to find notes matching a query. " +
    "Use this to remember user preferences, project facts, or anything that should survive across sessions.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "One of: read, append, search" },
      text: { type: "string", description: "For 'append': the note to add" },
      query: { type: "string", description: "For 'search': a substring or keyword to find" },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

export const memoryTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("memory", JSON.stringify(rawArgs));
    const action = asString(a.action, "action", { allowEmpty: false, maxLen: 16 });
    if (!["read", "append", "search"].includes(action)) {
      throw new Error("action must be one of: read, append, search");
    }
    return {
      action,
      text: a.text !== undefined ? asString(a.text, "text", { maxLen: 10_000 }) : undefined,
      query: a.query !== undefined ? asString(a.query, "query", { maxLen: 500 }) : undefined,
    } as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const args = rawArgs as unknown as MemoryArgs;
    const svc = ctx.services;
    if (!svc) return { toolCallId: "", display: "memory: no runtime", content: "memory runtime not configured", isError: true };
    try {
      if (args.action === "read") {
        const text = svc.readMemory?.() ?? "";
        return { toolCallId: "", display: "memory read", content: text || "(empty)", isError: false };
      }
      if (args.action === "append") {
        if (!args.text) return { toolCallId: "", display: "memory: missing text", content: "append requires text", isError: true };
        await svc.appendMemory?.(args.text);
        return { toolCallId: "", display: "memory: appended", content: "ok", isError: false };
      }
      if (args.action === "search") {
        if (!args.query) return { toolCallId: "", display: "memory: missing query", content: "search requires query", isError: true };
        const found = await svc.searchMemory?.(args.query) ?? "";
        return { toolCallId: "", display: "memory: search", content: found || "(no matches)", isError: false };
      }
      return { toolCallId: "", display: "memory: bad action", content: "unknown action", isError: true };
    } catch (e) {
      return { toolCallId: "", display: "memory crashed", content: "memory crashed: " + (e as Error).message, isError: true };
    }
  },
};
