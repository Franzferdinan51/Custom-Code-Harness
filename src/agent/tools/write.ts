// write: write a file atomically (write to .tmp, then rename).
// This is one of the most important reliability fixes — half-written
// files are the #1 source of "I ran the agent and now my code is
// corrupted" pain.

import { writeFile, rename, mkdir, stat } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import type { Tool, ToolContext } from "./registry.js";
import { asString, parseToolArgs } from "./registry.js";
import type { ToolSpec } from "../../types.js";

interface WriteArgs {
  path: string;
  content: string;
}

const spec: ToolSpec = {
  name: "write",
  description:
    "Write a file. Creates parent directories if needed. Writes atomically via a temp file + rename, " +
    "so a crash mid-write cannot corrupt the destination. Overwrites the file if it already exists.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or cwd-relative path to write" },
      content: { type: "string", description: "Full file contents" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

export const writeTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("write", JSON.stringify(rawArgs));
    const out: WriteArgs = {
      path: asString(a.path, "path", { allowEmpty: false, maxLen: 4_096 }),
      content: asString(a.content, "content", { allowEmpty: true, maxLen: 5_000_000 }),
    };
    return out as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const raw = rawArgs as unknown as WriteArgs;
    const abs = isAbsolute(raw.path) ? raw.path : resolve(ctx.cwd, raw.path);
    try {
      await mkdir(dirname(abs), { recursive: true });
      let existed = false;
      try { const s = await stat(abs); existed = s.isFile(); } catch {}
      const tmp = abs + "." + randomBytes(6).toString("hex") + ".tmp";
      await writeFile(tmp, raw.content, "utf-8");
      await rename(tmp, abs);
      return {
        toolCallId: "",
        display: "wrote " + abs + " (" + raw.content.length + " bytes" + (existed ? ", replaced" : "") + ")",
        content: "wrote " + raw.content.length + " bytes to " + abs,
        isError: false,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { toolCallId: "", display: "write failed: " + abs, content: "write failed: " + msg, isError: true };
    }
  },
};
