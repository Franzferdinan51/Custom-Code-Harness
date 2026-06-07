// Prompt templates. Markdown files dropped into
// ~/.codingharness/prompts/ or .codingharness/prompts/ become
// /-commands. The filename (minus .md) is the command name.
//
// Example: ~/.codingharness/prompts/review.md is invoked with `/review`
// and its body is appended to the user message (with optional {{vars}}).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { paths } from "../config/paths.js";

export interface PromptTemplate {
  name: string;
  description: string;
  body: string;
  path: string;
}

export function loadPromptTemplates(cwd: string): PromptTemplate[] {
  const out: PromptTemplate[] = [];
  const dirs = [
    paths.prompts,
    join(homedir(), ".agents", "prompts"),
    join(cwd, ".codingharness", "prompts"),
    join(cwd, ".agents", "prompts"),
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try { entries = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of entries) {
      const path = join(dir, f);
      try { if (!statSync(path).isFile()) continue; } catch { continue; }
      const name = basename(f, ".md");
      if (seen.has(name)) continue; // first-wins
      seen.add(name);
      try {
        const body = readFileSync(path, "utf-8");
        const description = firstNonEmptyLine(body) || name;
        out.push({ name, description, body, path });
      } catch { /* ignore */ }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function firstNonEmptyLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) return t.replace(/^#+\s*/, "").slice(0, 200);
    return t.slice(0, 200);
  }
  return "";
}

/** Expand {{var}} placeholders. Unknown vars are left as-is. */
export function expandTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] ?? m : m;
  });
}
