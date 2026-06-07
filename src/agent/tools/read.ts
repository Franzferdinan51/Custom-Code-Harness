// read: read a file from disk, returning its contents (size-capped).

import { readFile, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import type { Tool, ToolContext } from "./registry.js";
import { asNumber, asString, parseToolArgs } from "./registry.js";
import type { ToolSpec } from "../../types.js";

interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

const spec: ToolSpec = {
  name: "read",
  description:
    "Read a file's contents. Returns the file text, optionally sliced by line range. " +
    "Use offset/limit to read parts of a large file in chunks.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or cwd-relative path to the file" },
      offset: { type: "number", description: "1-indexed line number to start from (inclusive)" },
      limit: { type: "number", description: "Maximum number of lines to return" },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const readTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("read", JSON.stringify(rawArgs));
    const out: ReadArgs = {
      path: asString(a.path, "path", { allowEmpty: false, maxLen: 4_096 }),
      offset: a.offset !== undefined ? asNumber(a.offset, "offset", { integer: true, min: 1 }) : undefined,
      limit: a.limit !== undefined ? asNumber(a.limit, "limit", { integer: true, min: 1, max: 5_000 }) : undefined,
    };
    return out as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const raw = rawArgs as unknown as ReadArgs;
    const abs = isAbsolute(raw.path) ? raw.path : resolve(ctx.cwd, raw.path);
    try {
      const st = await stat(abs);
      if (!st.isFile()) {
        return { toolCallId: "", display: "not a file: " + abs, content: "not a file: " + abs, isError: true };
      }
      if (st.size > ctx.limits.readMaxBytes * 4) {
        ctx.log("read: " + abs + " is large (" + st.size + " bytes), will truncate to " + ctx.limits.readMaxBytes);
      }
      const text = await readFile(abs, "utf-8");
      const cap = ctx.limits.readMaxBytes;
      let body: string = text.length > cap ? text.slice(0, cap) + "\n\n... (truncated at " + cap + " bytes; " + (text.length - cap) + " bytes remain)" : text;
      if (raw.offset || raw.limit) {
        const lines = body.split("\n");
        const start = (raw.offset ?? 1) - 1;
        const end = raw.limit ? start + raw.limit : lines.length;
        const slice = lines.slice(start, end);
        const header = "lines " + (start + 1) + "-" + Math.min(end, lines.length) + " of " + lines.length + ":";
        body = header + "\n" + slice.map((l, i) => String(start + i + 1).padStart(6) + "  " + l).join("\n");
      }
      return { toolCallId: "", display: "read " + abs, content: body, isError: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { toolCallId: "", display: "read failed: " + abs, content: "read failed: " + msg, isError: true };
    }
  },
};
