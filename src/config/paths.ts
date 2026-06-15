// Resolved filesystem paths for CodingHarness state.
// All state lives under $CH_HOME (default ~/.codingharness) so the
// tool is self-contained and easy to wipe.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

function expand(p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  return p;
}

function home(): string {
  return process.env.CODINGHARNESS_HOME
    ? expand(process.env.CODINGHARNESS_HOME)
    : process.env.CH_HOME
    ? expand(process.env.CH_HOME)
    : join(homedir(), ".codingharness");
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
} as const;

export function ensurePaths(): void {
  for (const dir of [paths.home, paths.sessions, paths.logs, paths.cache, paths.extensions, paths.prompts, paths.skills, paths.agents, paths.cron, paths.memory, paths.context, paths.workflows]) {
    mkdirSync(dir, { recursive: true });
  }
}
