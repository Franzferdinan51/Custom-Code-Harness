// Skill registry — loads skills from disk following the
// agentskills.io convention. Each skill is a directory containing
// a SKILL.md (required) and optional helper files.
//
// Discovery order (project overrides user overrides bundled):
//   1. $CWD/.codingharness/skills/<name>/SKILL.md
//   2. $CWD/.agents/skills/<name>/SKILL.md  (agentskills.io path)
//   3. $CH_HOME/skills/<name>/SKILL.md
//   4. ~/.agents/skills/<name>/SKILL.md    (agentskills.io path)

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { paths } from "../config/paths.js";
import { log } from "../util/logger.js";

export interface Skill {
  name: string;
  description: string;
  /** Full body of SKILL.md (without frontmatter). */
  content: string;
  /** Absolute path of the SKILL.md file. */
  path: string;
  /** Where the skill was discovered. */
  source: "project" | "user" | "global";
}

export class SkillRegistry {
  private cache = new Map<string, Skill>();
  private cwd: string;

  constructor(opts: { cwd: string }) {
    this.cwd = opts.cwd;
  }

  /** List all discovered skills. Re-scans if cache is empty. */
  async list(): Promise<Skill[]> {
    if (this.cache.size === 0) await this.scan();
    return [...this.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<Skill | null> {
    if (this.cache.size === 0) await this.scan();
    return this.cache.get(name) ?? null;
  }

  /** Alias for get() that returns just the content. */
  async load(name: string): Promise<{ name: string; description: string; content: string } | null> {
    const s = await this.get(name);
    if (!s) return null;
    return { name: s.name, description: s.description, content: s.content };
  }

  /** Force a re-scan. */
  invalidate(): void { this.cache.clear(); }

  private async scan(): Promise<void> {
    const sources: Array<{ dir: string; source: Skill["source"] }> = [
      { dir: join(this.cwd, ".codingharness", "skills"), source: "project" },
      { dir: join(this.cwd, ".agents", "skills"), source: "project" },
      { dir: paths.skills, source: "user" },
      { dir: join(homedir(), ".agents", "skills"), source: "global" },
    ];

    for (const { dir, source } of sources) {
      if (!existsSync(dir)) continue;
      let entries: string[];
      try { entries = await readdir(dir); } catch { continue; }
      for (const e of entries) {
        const skillFile = join(dir, e, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        try {
          const raw = await readFile(skillFile, "utf-8");
          const parsed = parseSkillMarkdown(e, raw, skillFile, source);
          // First one wins (project > user > global), so don't overwrite.
          if (!this.cache.has(parsed.name)) this.cache.set(parsed.name, parsed);
        } catch (err) {
          log.warn(`skill: failed to read ${skillFile}: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Build a compact catalog string for inclusion in the system prompt. */
  async catalogForPrompt(): Promise<string> {
    const all = await this.list();
    if (all.length === 0) return "";
    const lines = ["Available skills (use the skill tool to load any of these):"];
    for (const s of all) lines.push("- " + s.name + " — " + s.description);
    return lines.join("\n");
  }
}

/** Parse a SKILL.md. The file may have YAML frontmatter; we only
 *  consume name/description from it. Everything after the frontmatter
 *  is the skill body. */
export function parseSkillMarkdown(name: string, raw: string, path: string, source: Skill["source"]): Skill {
  let description = "";
  let content = raw;
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end > 0) {
      const front = raw.slice(3, end).trim();
      content = raw.slice(end + 4).replace(/^\n+/, "");
      for (const line of front.split("\n")) {
        const m = line.match(/^(name|description):\s*(.+?)\s*$/);
        if (m) {
          if (m[1] === "name" && m[2]) name = m[2];
          if (m[1] === "description" && m[2]) description = m[2];
        }
      }
    }
  }
  // If no description, take the first non-empty paragraph.
  if (!description) {
    const m = content.match(/^#\s+(.+)$/m);
    if (m && m[1]) description = m[1];
    else {
      const para = content.split(/\n\s*\n/).find((p) => p.trim().length > 0) ?? "";
      description = para.replace(/[#*`]/g, "").trim().slice(0, 140);
    }
  }
  return { name, description, content, path, source };
}
