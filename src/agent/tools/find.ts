// find: locate files by name. Wraps `find` when available, falls back
// to a JS walker. Output is capped.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, isAbsolute } from "node:path";
import { readdir } from "node:fs/promises";
import type { Tool, ToolContext } from "./registry.js";
import { asString, parseToolArgs } from "./registry.js";
import type { ToolSpec } from "../../types.js";

const pExecFile = promisify(execFile);
const MAX_RESULTS = 1_000;
const DEFAULT_IGNORE = ["node_modules", ".git", "dist", "build", "coverage", ".cache", ".next", "out"];

interface FindArgs {
  pattern: string;
  path?: string;
}

const spec: ToolSpec = {
  name: "find",
  description:
    "Locate files by name. Supports a glob-ish pattern (e.g. '*.ts', 'package.json'). " +
    "Skips common build/dependency directories. Output is capped at 1000 results.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Filename pattern (glob-ish, not a regex)" },
      path: { type: "string", description: "Directory to search. Default: cwd." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

export const findTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("find", JSON.stringify(rawArgs));
    const out: FindArgs = {
      pattern: asString(a.pattern, "pattern", { allowEmpty: false, maxLen: 256 }),
      path: a.path !== undefined ? asString(a.path, "path", { maxLen: 4_096 }) : undefined,
    };
    return out as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const raw = rawArgs as unknown as FindArgs;
    const base = raw.path
      ? isAbsolute(raw.path) ? raw.path : resolve(ctx.cwd, raw.path)
      : ctx.cwd;
    let results: string[];
    try {
      const ignoreArgs: string[] = [];
      for (const d of DEFAULT_IGNORE) {
        ignoreArgs.push("-not", "-path", "*/" + d + "/*");
      }
      const out = await pExecFile(
        "find",
        [base, "-type", "f", "-name", raw.pattern, ...ignoreArgs],
        { maxBuffer: 10_000_000 }
      );
      results = out.stdout.split("\n").filter(Boolean);
    } catch {
      // Fallback: JS walk, simple glob match.
      const all = await jsWalk(base, DEFAULT_IGNORE);
      const re = globToRegex(raw.pattern);
      results = all.filter((p) => re.test(p.split("/").pop() ?? ""));
    }
    if (results.length > MAX_RESULTS) {
      results = results.slice(0, MAX_RESULTS);
      results.push("... (truncated at " + MAX_RESULTS + " results)");
    }
    return {
      toolCallId: "",
      display: "find: " + results.length + " result" + (results.length === 1 ? "" : "s"),
      content: results.length === 0 ? "(no results)" : results.join("\n"),
      isError: false,
    };
  },
};

function globToRegex(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (ch === ".") re += "\\.";
    else re += ch.replace(/[\\+^$|{}()\[\]]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

async function jsWalk(dir: string, ignore: string[]): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (ignore.some((ig) => e.name === ig)) continue;
      const p = d + "/" + e.name;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  }
  await walk(dir);
  return out;
}
