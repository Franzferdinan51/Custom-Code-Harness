// ls: list directory contents.

import { readdir, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import type { Tool, ToolContext } from "./registry.js";
import { asNumber, asString, parseToolArgs } from "./registry.js";
import type { ToolSpec } from "../../types.js";

interface LsArgs {
  path?: string;
  show_hidden: boolean;
  max_entries: number;
}

const MAX_ENTRIES = 2_000;

const spec: ToolSpec = {
  name: "ls",
  description:
    "List a directory. Returns name, kind (dir/file), and size for each entry. " +
    "Capped at 2000 entries. Hidden files (starting with .) are excluded unless show_hidden=true.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list. Default: cwd." },
      show_hidden: { type: "boolean", description: "Include hidden files. Default false." },
      max_entries: { type: "number", description: "Override the cap. Default 2000, max 10000." },
    },
    additionalProperties: false,
  },
};

export const lsTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("ls", JSON.stringify(rawArgs));
    const out: LsArgs = {
      path: a.path !== undefined ? asString(a.path, "path", { maxLen: 4_096 }) : undefined,
      show_hidden: typeof a.show_hidden === "boolean" ? a.show_hidden : false,
      max_entries:
        a.max_entries !== undefined
          ? asNumber(a.max_entries, "max_entries", { integer: true, min: 1, max: 10_000 })
          : MAX_ENTRIES,
    };
    return out as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const raw = rawArgs as unknown as LsArgs;
    const target = raw.path
      ? isAbsolute(raw.path) ? raw.path : resolve(ctx.cwd, raw.path)
      : ctx.cwd;
    try {
      const st = await stat(target);
      if (!st.isDirectory()) {
        return { toolCallId: "", display: "ls: not a directory: " + target, content: "not a directory: " + target, isError: true };
      }
      const entries = await readdir(target, { withFileTypes: true });
      const filtered = raw.show_hidden ? entries : entries.filter((e) => !e.name.startsWith("."));
      filtered.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const lines: string[] = [];
      let count = 0;
      for (const e of filtered) {
        if (count >= raw.max_entries) {
          lines.push("... (truncated at " + raw.max_entries + " entries)");
          break;
        }
        const kind = e.isDirectory() ? "dir" : e.isFile() ? "file" : "other";
        let size = "";
        if (e.isFile()) {
          try {
            const s = await stat(target + "/" + e.name);
            size = s.size.toString();
          } catch { size = "?"; }
        }
        lines.push(kind.padEnd(4) + "  " + size.padStart(10) + "  " + e.name);
        count++;
      }
      return {
        toolCallId: "",
        display: "ls " + target + " (" + count + " entries)",
        content: lines.length === 0 ? "(empty)" : lines.join("\n"),
        isError: false,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { toolCallId: "", display: "ls failed: " + target, content: "ls failed: " + msg, isError: true };
    }
  },
};
