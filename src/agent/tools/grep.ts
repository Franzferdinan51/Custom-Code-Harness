// grep: content search. Uses a JS-based fallback so we don't depend
// on ripgrep. For very large codebases this is slower than rg, but it
// has no external dependency and never crashes on weird file types.

import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext } from "./registry.js";
import { asNumber, asString, parseToolArgs } from "./registry.js";
import type { ToolSpec } from "../../types.js";

const pExecFile = promisify(execFile);
const MAX_FILE_BYTES = 5_000_000;
const MAX_MATCHES = 500;
const DEFAULT_IGNORE = ["node_modules", ".git", "dist", "build", "coverage", ".cache", ".next", "out"];

interface GrepArgs {
  pattern: string;
  path?: string;
  include?: string;
  case_sensitive: boolean;
}

const spec: ToolSpec = {
  name: "grep",
  description:
    "Search for a regex pattern in files. Returns file paths and matching line numbers. " +
    "Skips common build/dependency directories. Output is capped at 500 matches.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (JavaScript regex syntax)" },
      path: { type: "string", description: "Directory or file to search. Default: cwd." },
      include: { type: "string", description: "Glob-ish filter: only files whose name matches (e.g. '*.ts')" },
      case_sensitive: { type: "boolean", description: "Default true." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

export const grepTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("grep", JSON.stringify(rawArgs));
    const out: GrepArgs = {
      pattern: asString(a.pattern, "pattern", { allowEmpty: false, maxLen: 4_000 }),
      path: a.path !== undefined ? asString(a.path, "path", { maxLen: 4_096 }) : undefined,
      include: a.include !== undefined ? asString(a.include, "include", { maxLen: 256 }) : undefined,
      case_sensitive: typeof a.case_sensitive === "boolean" ? a.case_sensitive : true,
    };
    return out as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const raw = rawArgs as unknown as GrepArgs;
    const base = raw.path
      ? isAbsolute(raw.path) ? raw.path : resolve(ctx.cwd, raw.path)
      : ctx.cwd;
    let regex: RegExp;
    try {
      regex = new RegExp(raw.pattern, raw.case_sensitive ? "g" : "gi");
    } catch (e) {
      return { toolCallId: "", display: "grep: bad regex", content: "bad regex: " + (e as Error).message, isError: true };
    }
    let files: string[];
    try {
      const ignoreArgs: string[] = [];
      for (const d of DEFAULT_IGNORE) {
        ignoreArgs.push("-not", "-path", "*/" + d + "/*");
      }
      const out = await pExecFile("find", [base, "-type", "f", ...ignoreArgs], { maxBuffer: 10_000_000 });
      files = out.stdout.split("\n").filter(Boolean);
    } catch {
      files = await jsWalk(base, DEFAULT_IGNORE);
    }
    const includeRe = raw.include ? globToRegex(raw.include) : null;
    const matches: string[] = [];
    let scanned = 0;
    outer: for (const f of files) {
      if (includeRe && !includeRe.test(f)) continue;
      try {
        const text = await readFile(f, { encoding: "utf-8" });
        if (text.includes("\0")) continue; // binary
        if (text.length > MAX_FILE_BYTES) continue;
        scanned++;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i] ?? "")) {
            matches.push(f + ":" + (i + 1) + ": " + lines[i]);
            if (matches.length >= MAX_MATCHES) {
              matches.push("... (truncated at " + MAX_MATCHES + " matches)");
              break outer;
            }
          }
        }
      } catch {
        continue;
      }
    }
    return {
      toolCallId: "",
      display: "grep: " + matches.length + " match" + (matches.length === 1 ? "" : "es") + " in " + scanned + " files",
      content: matches.length === 0 ? "(no matches)" : matches.join("\n"),
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
  const { readdir } = await import("node:fs/promises");
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
