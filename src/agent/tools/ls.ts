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
      // Slice to `max_entries + 1` so we can detect overflow before
      // stat'ing. Each stat is a separate syscall; the cap is
      // applied AFTER sorting so the user always sees the same
      // first N entries regardless of stat latency.
      // `raw.max_entries` is set by `validate()` to MAX_ENTRIES
      // (2000) when the caller didn't supply one, but a raw
      // `tool.run({ ... }, ctx)` call (e.g. from a test or from
      // a future direct caller) may pass `undefined`. Use
      // `raw.max_entries ?? MAX_ENTRIES` so the slice/loop
      // math is robust to either path. Pre-fix the same code
      // was a `count >= raw.max_entries` check where
      // `undefined >= 0` is false — the loop ran fine but the
      // math here is `slice(0, undefined + 1)` = `slice(0, NaN)`
      // = `[]`, returning "(empty)" on a 1-entry dir.
      const maxEntries = raw.max_entries ?? MAX_ENTRIES;
      const toRender = filtered.slice(0, maxEntries + 1);
      // Pre-stat every FILE entry in parallel. Pre-fix this was
      // sequential `await stat(...)` per entry, which on a
      // 2000-entry dir made `ls` take 2-5 seconds on macOS where
      // each stat is a roundtrip to the FS.
      const sizes = await Promise.all(
        toRender.map(async (e) => {
          if (!e.isFile()) return "";
          try {
            const s = await stat(target + "/" + e.name);
            return s.size.toString();
          } catch { return "?"; }
        })
      );
      const lines: string[] = [];
      for (let i = 0; i < toRender.length; i++) {
        if (i === maxEntries) {
          lines.push("... (truncated at " + maxEntries + " entries)");
          break;
        }
        const e = toRender[i]!;
        const kind = e.isDirectory() ? "dir" : e.isFile() ? "file" : "other";
        lines.push(kind.padEnd(4) + "  " + (sizes[i] ?? "").padStart(10) + "  " + e.name);
      }
      const count = Math.min(toRender.length, maxEntries);
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
