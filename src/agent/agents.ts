// Sub-agent definitions.
//
// A sub-agent is an isolated agent run with its own:
//   - system prompt
//   - provider/model (or inherited from parent)
//   - tool allowlist (or inherited)
//   - max steps
//   - working directory (or inherited)
//
// Built-ins (explore, plan, review, summarize, implement, test) are
// hard-coded. Users can add more by dropping JSON files into
// ~/.codingharness/agents/<name>.json or .codingharness/agents/.

import { paths } from "../config/paths.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentDefinition {
  /** Stable id, e.g. "explore", "plan", "review", or user-defined. */
  name: string;
  /** Short description for /agents. */
  description: string;
  /** System prompt override. If omitted, the parent prompt + role is used. */
  systemPrompt?: string;
  /** Additional system prompt lines appended to the parent. */
  systemPromptAppend?: string;
  /** Force a specific provider id. */
  providerId?: string;
  /** Force a specific model. */
  model?: string;
  /** Tool allowlist. If undefined, inherits parent tools. If [], allows none. */
  tools?: string[];
  /** Max steps override. */
  maxSteps?: number;
  /** Working directory override. */
  cwd?: string;
  /** Tags for routing (e.g. ["fast", "cheap"]). */
  tags?: string[];
  /** Built-in flag. Built-ins cannot be overridden by user files. */
  builtin?: boolean;
}

const BUILTINS: AgentDefinition[] = [
  {
    name: "explore",
    description: "Read-only explorer. Search code, summarize files, never edit. Use for understanding a codebase.",
    systemPromptAppend:
      "You are a read-only explorer. NEVER write, edit, or run commands that modify state. " +
      "Use read, grep, find, ls, and bash (read-only commands like cat, head, tail, ls, rg). " +
      "Return a concise structured summary: what you found, where it lives, and any follow-up questions.",
    tools: ["read", "grep", "find", "ls", "bash"],
    maxSteps: 12,
    tags: ["read-only", "fast"],
    builtin: true,
  },
  {
    name: "plan",
    description: "Produces a structured plan for a goal. Does not execute.",
    systemPromptAppend:
      "You are a planning agent. Given a goal, produce a numbered, minimal plan (3-7 steps). " +
      "For each step: action, files involved, success criterion. Do NOT execute. Do NOT modify files. " +
      "End with: 'Ready to execute. Use tools.'",
    tools: ["read", "grep", "find", "ls"],
    maxSteps: 6,
    tags: ["read-only"],
    builtin: true,
  },
  {
    name: "review",
    description: "Reviews recent code changes (git diff or given file set) for bugs, security, performance, and style.",
    systemPromptAppend:
      "You are a code reviewer. Review the provided code for: correctness, security issues, " +
      "performance problems, error handling, and adherence to project conventions. " +
      "Be specific. Cite file:line. Suggest concrete fixes. Do not edit files — only report.",
    tools: ["read", "bash", "grep"],
    maxSteps: 16,
    tags: ["read-only"],
    builtin: true,
  },
  {
    name: "summarize",
    description: "Compresses a long text, file, or transcript into a short summary. No side effects.",
    systemPromptAppend:
      "You are a summarizer. Produce a structured summary: key points, decisions, open questions, " +
      "and any TODOs. Keep it under 500 words unless asked otherwise. Read-only.",
    tools: ["read", "grep"],
    maxSteps: 4,
    tags: ["read-only", "fast"],
    builtin: true,
  },
  {
    name: "implement",
    description: "Implements a well-specified change. Has full tool access. Use after a plan.",
    systemPromptAppend:
      "You are an implementation agent. Execute the plan you were given step by step. " +
      "After each substantive edit, verify with a build or test. Report completion with file:line references.",
    maxSteps: 48,
    tags: ["write", "long-running"],
    builtin: true,
  },
  {
    name: "test",
    description: "Runs tests and reports results. Iterates on failures with surgical edits.",
    systemPromptAppend:
      "You are a test runner. Run the project's test suite. If tests fail, read the failure, " +
      "make the smallest possible fix to the source (not the test unless the test is wrong), " +
      "and re-run. Report each cycle. Stop when tests pass or you have made 3 attempts.",
    tools: ["bash", "read", "edit", "grep"],
    maxSteps: 24,
    tags: ["write", "iterative"],
    builtin: true,
  },
];

/** Registry of agent definitions, built-ins + user files. */
export class AgentRegistry {
  private byName = new Map<string, AgentDefinition>();

  constructor(opts: { cwd?: string } = {}) {
    for (const b of BUILTINS) this.byName.set(b.name, b);
    // User-level
    for (const a of loadFromDir(paths.agents)) this.byName.set(a.name, a);
    // Project-level
    if (opts.cwd) {
      for (const a of loadFromDir(join(opts.cwd, ".codingharness", "agents"))) {
        if (this.byName.get(a.name)?.builtin) {
          // Project can't override built-ins; skip.
          continue;
        }
        this.byName.set(a.name, a);
      }
    }
  }

  get(name: string): AgentDefinition | undefined {
    return this.byName.get(name);
  }

  /** Programmatic registration. Built-ins cannot be overridden.
   *  Used by ephemeral features (e.g. Council) that need a custom
   *  agent definition per turn without writing it to disk. */
  register(def: AgentDefinition): AgentDefinition {
    if (this.byName.get(def.name)?.builtin) {
      throw new Error("cannot override built-in agent: " + def.name);
    }
    this.byName.set(def.name, def);
    return def;
  }

  list(): AgentDefinition[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): string[] {
    return this.list().map((a) => a.name);
  }
}

function loadFromDir(dir: string): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: AgentDefinition[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf-8")) as AgentDefinition;
      if (!raw.name) continue;
      out.push({ ...raw, builtin: false });
    } catch {
      // Bad JSON: skip silently, but in a real CLI we'd log this.
    }
  }
  return out;
}

/** Build the system prompt for a sub-agent, given the parent runtime. */
export function buildAgentSystemPrompt(parentPrompt: string, def: AgentDefinition): string {
  const parts: string[] = [];
  parts.push(parentPrompt);
  parts.push("");
  parts.push("---");
  parts.push("You are running as a sub-agent named: " + def.name);
  parts.push("Description: " + def.description);
  if (def.systemPrompt) {
    parts.push("");
    parts.push(def.systemPrompt);
  }
  if (def.systemPromptAppend) {
    parts.push("");
    parts.push(def.systemPromptAppend);
  }
  return parts.join("\n");
}
