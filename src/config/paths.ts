// Resolved filesystem paths for GrokBot state.
// All state lives under $GROKBOT_HOME (default ~/.grokbot) so the
// tool is self-contained and easy to wipe.
//
// Backward-compat (pre-GrokBot / pre-2026-07-26 installs):
//   - $CODINGHARNESS_HOME still overrides; legacy value wins
//     over the new default to keep existing installs on disk.
//   - If neither env var is set and neither $GROKBOT_HOME nor
//     $CODINGHARNESS_HOME is in the environment, paths.home
//     returns ~/.grokbot for a fresh install but transparently
//     returns ~/.codingharness when only the legacy dir is
//     present (so existing user data is found and migrated
//     lazily on first read — no copy step, no data loss).

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

function expand(p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  return p;
}

function home(): string {
  // New identity first.
  if (process.env.GROKBOT_HOME) return expand(process.env.GROKBOT_HOME);
  // Legacy override (preserves installed state for users
  // who set CODINGHARNESS_HOME before the 2026-07-26 rebrand).
  if (process.env.CODINGHARNESS_HOME) return expand(process.env.CODINGHARNESS_HOME);
  if (process.env.CH_HOME) return expand(process.env.CH_HOME);
  // No env var: prefer the new dir if it already exists,
  // otherwise fall back to the legacy dir if it does
  // (transparent migration of existing user data).
  const grokbotDir = join(homedir(), ".grokbot");
  const codingHarnessDir = join(homedir(), ".codingharness");
  if (existsSync(grokbotDir)) return grokbotDir;
  if (existsSync(codingHarnessDir)) return codingHarnessDir;
  return grokbotDir;
}

/** All paths. Evaluated lazily so tests can override $CH_HOME. */
export const paths = {
  get home() { return home(); },
  get settings() { return join(home(), "settings.json"); },
  get providers() { return join(home(), "providers.json"); },
  get sessions() { return join(home(), "sessions"); },
  get logs() { return join(home(), "logs"); },
  get cache() { return join(home(), "cache"); },
  get extensions() { return join(home(), "extensions"); },
  get prompts() { return join(home(), "prompts"); },
  get skills() { return join(home(), "skills"); },
  get agents() { return join(home(), "agents"); },
  get cron() { return join(home(), "cron"); },
  get memory() { return join(home(), "memory"); },
  get context() { return join(home(), "context"); },
  /** Workflow records — one JSON file per workflow at
   *  `<id>.json`. Created lazily on first write by
   *  `WorkflowStore` (see `src/agent/workflow-store.ts`). The
   *  per-file layout (not a JSONL log, not SQLite) matches the
   *  audit's git-versionable framing and the `session.ts`
   *  pattern. */
  get workflows() { return join(home(), "workflows"); },
  /** Legacy single-file v1/v2 location. New code reads/writes the
   *  per-mission state via `goalsMissionFile(mission)` instead.
   *  Kept here as a sentinel so the legacy migration can detect
   *  and move v1/v2 data on first access. */
  get goals() { return join(home(), "goals.json"); },
  /** Directory holding the per-mission goal stores. Created
   *  lazily by the GoalStore constructor. */
  get goalsDir() { return join(home(), "goals"); },
  /** State file for the given mission. New missions
   *  start at `$CH_HOME/goals/<mission>/state.json`. */
  goalsMissionFile(mission: string): string {
    return join(home(), "goals", mission, "state.json");
  },
  /** Crash-resilience queue for async_tool delegations. Persisted
   *  to disk on every state change so a kill mid-run can be replayed
   *  on the next startup. See `AsyncToolQueueStore`. */
  get asyncToolQueue() { return join(home(), "async-tool-queue.json"); },
  /** On-disk cache for the 4th memory layer's vector embeddings.
   *  Keyed by line number (raw notes) or `lesson:N` (lessons), so
   *  re-indexing only re-embeds new lines. See
   *  `src/agent/memory-vector.ts`. */
  get memoryEmbeddingsFile() { return join(home(), "memory", "MEMORY.embeddings.json"); },
  /** Installed MCP (Model Context Protocol) servers — JSON object
   *  keyed by server id. Each entry holds the transport (stdio /
   *  http), the launch command (for stdio) or URL (for http), the
   *  server version advertised during `initialize`, the install
   *  timestamp, and the discovered tool list. The single-file
   *  layout matches `settings.json` / `providers.json` — small
   *  enough to be human-editable and fast to read on every
   *  delegation dispatch. See `src/agent/mcp-store.ts`. */
  get mcpJson() { return join(home(), "mcp.json"); },
} as const;

export function ensurePaths(): void {
  for (const dir of [paths.home, paths.sessions, paths.logs, paths.cache, paths.extensions, paths.prompts, paths.skills, paths.agents, paths.cron, paths.memory, paths.context, paths.workflows]) {
    mkdirSync(dir, { recursive: true });
  }
}
