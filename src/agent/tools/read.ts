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
      // If the caller asked for a specific line slice, do the slicing
      // on the FULL text first so the line numbers in the output
      // match the original file. Truncation is a last-resort byte cap
      // applied to the already-sliced chunk. (Pre-fix: the slice was
      // applied to the truncated body, so `offset=100000` on a 1 MB
      // file would render lines from the first 200 KB and label
      // them with the original line numbers — wildly wrong.)
      let body: string;
      if (raw.offset || raw.limit) {
        const allLines = text.split("\n");
        const requestedStart = (raw.offset ?? 1) - 1;
        // Clamp `start` into [0, allLines.length) so a past-the-end
        // offset produces an empty slice + a clear "no more lines"
        // header instead of the confusing "lines 5000-5003 of 1001:"
        // the previous code emitted.
        const start = Math.max(0, Math.min(requestedStart, allLines.length));
        const end = raw.limit ? start + raw.limit : allLines.length;
        const slice = allLines.slice(start, end);
        const lastLine = Math.min(end, allLines.length);
        const header = start >= allLines.length
          ? "(offset " + (requestedStart + 1) + " is past the end of the file (" + allLines.length + " lines))"
          : "lines " + (start + 1) + "-" + lastLine + " of " + allLines.length + ":";
        body = header + "\n" + slice.map((l, i) => String(start + i + 1).padStart(6) + "  " + l).join("\n");
      } else {
        body = text;
      }
      if (body.length > cap) {
        body = body.slice(0, cap) + "\n\n... (truncated at " + cap + " bytes; " + (text.length - cap) + " bytes remain)";
      }
      return { toolCallId: "", display: "read " + abs, content: body, isError: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { toolCallId: "", display: "read failed: " + abs, content: "read failed: " + msg, isError: true };
    }
  },
};
