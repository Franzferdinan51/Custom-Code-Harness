// todo tool — an in-session todo list. Persists in the session JSONL
// and is exposed to the model so it can plan its own work and check
// off items as it goes. This is pi's "no built-in to-dos" stance
// inverted — we ship one because it's actually useful for long runs.

import type { Tool, ToolContext } from "./registry.js";
import { asString, parseToolArgs } from "./registry.js";
import type { ToolSpec } from "../../types.js";

interface TodoArgs {
  action: "list" | "set" | "add" | "clear";
  items_json?: string;
  item?: string;
}

const spec: ToolSpec = {
  name: "todo",
  description:
    "Manage an in-session todo list. Use 'set' to replace the list (JSON array of strings), " +
    "'add' to append, 'list' to view, 'clear' to empty. The list is included in your context on every turn.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "One of: list, set, add, clear" },
      items_json: { type: "string", description: "For 'set': JSON array of strings" },
      item: { type: "string", description: "For 'add': a single todo item" },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

export const todoTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("todo", JSON.stringify(rawArgs));
    const action = asString(a.action, "action", { allowEmpty: false, maxLen: 16 });
    if (!["list", "set", "add", "clear"].includes(action)) {
      throw new Error("action must be one of: list, set, add, clear");
    }
    return {
      action,
      items_json: a.items_json !== undefined ? asString(a.items_json, "items_json", { maxLen: 200_000 }) : undefined,
      item: a.item !== undefined ? asString(a.item, "item", { maxLen: 4_000 }) : undefined,
    } as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const args = rawArgs as unknown as TodoArgs;
    const read = ctx.services?.readTodo;
    const write = ctx.services?.writeTodo;
    if (!read || !write) {
      return { toolCallId: "", display: "todo: no runtime", content: "todo runtime not configured", isError: true };
    }
    try {
      let items = read();
      if (args.action === "list") {
        return { toolCallId: "", display: "todo: " + items.length + " item" + (items.length === 1 ? "" : "s"), content: items.length === 0 ? "(empty)" : items.map((t, i) => (i + 1) + ". " + t).join("\n"), isError: false };
      }
      if (args.action === "clear") {
        await write([]);
        return { toolCallId: "", display: "todo: cleared", content: "cleared", isError: false };
      }
      if (args.action === "set") {
        if (!args.items_json) return { toolCallId: "", display: "todo: missing items_json", content: "set requires items_json", isError: true };
        let parsed: unknown;
        try { parsed = JSON.parse(args.items_json); } catch (e) { return { toolCallId: "", display: "todo: bad json", content: "bad items_json: " + (e as Error).message, isError: true }; }
        if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
          return { toolCallId: "", display: "todo: bad shape", content: "items_json must be a JSON array of strings", isError: true };
        }
        await write(parsed as string[]);
        return { toolCallId: "", display: "todo: set " + (parsed as string[]).length, content: "ok", isError: false };
      }
      if (args.action === "add") {
        if (!args.item) return { toolCallId: "", display: "todo: missing item", content: "add requires item", isError: true };
        items = [...items, args.item];
        await write(items);
        return { toolCallId: "", display: "todo: added", content: "ok (" + items.length + " items)", isError: false };
      }
      return { toolCallId: "", display: "todo: bad action", content: "unknown action", isError: true };
    } catch (e) {
      return { toolCallId: "", display: "todo crashed", content: "todo crashed: " + (e as Error).message, isError: true };
    }
  },
};
