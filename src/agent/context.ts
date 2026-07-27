// Context file loader. Walks the cwd up to the root, collecting
// AGENTS.md and CLAUDE.md (the conventional names for project-level
// agent instructions). Then layers in the user's own context
// directories.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve, sep, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { paths } from "../config/paths.js";

export interface ContextFile {
  path: string;
  source: "global" | "user" | "project" | "user-codingharness" | "user-grokbot";
  body: string;
}

/** Project + workspace context files (GrokBot SOUL/TOOLS + OpenCode AGENTS.md). */
const FILE_NAMES = ["AGENTS.md", "CLAUDE.md", "SOUL.md", "TOOLS.md"];

export async function loadContextFiles(cwd: string, opts: { includeUserCodingharness?: boolean } = {}): Promise<ContextFile[]> {
  const out: ContextFile[] = [];

  // 1. Global: $CH_HOME/AGENTS.md
  const globalFile = join(paths.context, "AGENTS.md");
  if (existsSync(globalFile)) {
    out.push({ path: globalFile, source: "global", body: await safeRead(globalFile) });
  }

  // 2. User: ~/.agents/AGENTS.md, ~/.grokbot/AGENTS.md,
  //    and the legacy ~/.codingharness/AGENTS.md (pre-rebrand).
  const userFiles = [
    join(homedir(), ".agents", "AGENTS.md"),
    join(homedir(), ".grokbot", "AGENTS.md"),
    join(homedir(), ".codingharness", "AGENTS.md"),
  ];
  for (const f of userFiles) {
    if (existsSync(f)) {
      out.push({ path: f, source: "user", body: await safeRead(f) });
    }
  }

  // 3. Project: walk up from cwd to root, collecting AGENTS.md / CLAUDE.md.
  const seen = new Set<string>();
  let cur = resolve(cwd);
  if (!isAbsolute(cur)) cur = resolve(cur);
  // Don't walk forever; cap at 16 levels.
  for (let i = 0; i < 16; i++) {
    for (const name of FILE_NAMES) {
      const f = join(cur, name);
      if (existsSync(f) && !seen.has(f)) {
        seen.add(f);
        out.push({ path: f, source: "project", body: await safeRead(f) });
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // 4. .grokbot/AGENTS.md and legacy .codingharness/AGENTS.md in
  //    cwd (explicit). Both are emitted with source 'user-grokbot'
  //    / 'user-codingharness' for callers that need to distinguish
  //    workspace-level context from global user context.
  if (opts.includeUserCodingharness !== false) {
    const localDirs = [
      { dir: join(cwd, ".grokbot"), source: "user-grokbot" as const },
      { dir: join(cwd, ".codingharness"), source: "user-codingharness" as const },
    ];
    for (const { dir, source } of localDirs) {
      const f = join(dir, "AGENTS.md");
      if (existsSync(f) && !seen.has(f)) {
        out.push({ path: f, source, body: await safeRead(f) });
      }
    }
  }

  return out;
}

async function safeRead(f: string): Promise<string> {
  try { return await readFile(f, "utf-8"); }
  catch { return ""; }
}

/** Format context files for the system prompt. */
export function formatContextForPrompt(files: ContextFile[]): string {
  if (files.length === 0) return "";
  const parts: string[] = ["# Project context"];
  for (const f of files) {
    if (!f.body.trim()) continue;
    parts.push("\n## " + f.path + " (" + f.source + ")\n");
    parts.push(f.body.trim());
  }
  return parts.join("\n");
}
