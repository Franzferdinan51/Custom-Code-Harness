// edit: targeted string replacement. The model tells us the exact
// "old" text that must exist and the "new" text to swap in. We refuse
// to write if the old text isn't found or appears more than once —
// silent "first match" replacements have corrupted too many files.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import type { Tool, ToolContext } from "./registry.js";
import { asString, parseToolArgs } from "./registry.js";
import type { ToolSpec } from "../../types.js";

interface EditArgs {
  path: string;
  old: string;
  new: string;
  replace_globally: boolean;
}

const spec: ToolSpec = {
  name: "edit",
  description:
    "Replace a unique block of text in a file. Refuses to run if the 'old' text is missing or appears " +
    "more than once (use a larger context snippet to disambiguate). Atomically replaces via temp file + rename.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or cwd-relative path to edit" },
      old: { type: "string", description: "Exact text to find. Must appear exactly once." },
      new: { type: "string", description: "Replacement text" },
      replace_globally: {
        type: "boolean",
        description: "If true, replace every occurrence. Default false (must be unique).",
      },
    },
    required: ["path", "old", "new"],
    additionalProperties: false,
  },
};

export const editTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("edit", JSON.stringify(rawArgs));
    const out: EditArgs = {
      path: asString(a.path, "path", { allowEmpty: false, maxLen: 4_096 }),
      old: asString(a.old, "old", { allowEmpty: false, maxLen: 1_000_000 }),
      new: asString(a.new, "new", { allowEmpty: true, maxLen: 1_000_000 }),
      replace_globally: typeof a.replace_globally === "boolean" ? a.replace_globally : false,
    };
    return out as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const raw = rawArgs as unknown as EditArgs;
    const abs = isAbsolute(raw.path) ? raw.path : resolve(ctx.cwd, raw.path);
    try {
      const current = await readFile(abs, "utf-8");
      const occurrences = countOccurrences(current, raw.old);
      if (occurrences === 0) {
        return {
          toolCallId: "",
          display: "edit: old text not found in " + abs,
          content: "edit: old text not found in " + abs + ". Re-read the file to see the current contents.",
          isError: true,
        };
      }
      if (occurrences > 1 && !raw.replace_globally) {
        return {
          toolCallId: "",
          display: "edit: old text appears " + occurrences + " times in " + abs,
          content:
            "edit: old text appears " + occurrences + " times in " + abs + ". " +
            "Provide more surrounding context to make it unique, or pass replace_globally=true.",
          isError: true,
        };
      }
      const next = raw.replace_globally ? current.split(raw.old).join(raw.new) : current.replace(raw.old, raw.new);
      await mkdir(dirname(abs), { recursive: true });
      const tmp = abs + "." + randomBytes(6).toString("hex") + ".tmp";
      await writeFile(tmp, next, "utf-8");
      await rename(tmp, abs);
      return {
        toolCallId: "",
        display: "edited " + abs + " (" + (raw.replace_globally ? occurrences : 1) + " replacement" + (occurrences === 1 && !raw.replace_globally ? "" : "s") + ")",
        content: "edited " + abs,
        isError: false,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { toolCallId: "", display: "edit failed: " + abs, content: "edit failed: " + msg, isError: true };
    }
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) return count;
    count++;
    pos = idx + needle.length;
  }
}
