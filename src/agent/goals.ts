// GoalStore — persistent record of /goal runs. Lives at
// $CH_HOME/goals.json. Concept borrowed from DuckHive's persisted
// /goal system (https://github.com/Franzferdinan51/DuckHive).
//
// Phase 0 of the Agent-Teams + DuckHive feature merge.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../config/paths.js";
import { log } from "../util/logger.js";

export type GoalStatus = "pending" | "in_progress" | "complete" | "blocked" | "failed";

export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "complete",
  "blocked",
  "failed",
]);

export interface GoalRecord {
  id: string;
  objective: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  maxSteps: number;
  stepsTaken: number;
  /** Final text from the goal runner, if completed. */
  finalText?: string;
  /** Optional: the model that ran it. */
  model?: string;
  /** Optional: the provider id that ran it. */
  providerId?: string;
}

interface PersistedShape {
  version: 1;
  goals: GoalRecord[];
}

/** Generate a short, sortable, collision-resistant id. */
function newId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return "goal-" + ts + "-" + rand;
}

/** Read the persisted file. Tolerates missing / corrupt file. */
function readPersisted(file: string): GoalRecord[] {
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as PersistedShape;
    if (!parsed || !Array.isArray(parsed.goals)) return [];
    return parsed.goals;
  } catch (e) {
    log.warn("goals: failed to parse " + file + " — starting empty (" + (e as Error).message + ")");
    return [];
  }
}

/** Atomic write: write to a sibling .tmp then rename. */
function writePersisted(file: string, goals: GoalRecord[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  const payload: PersistedShape = { version: 1, goals };
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  renameSync(tmp, file);
}

export class GoalStore {
  private file: string;
  private goals: GoalRecord[];

  constructor(opts: { file?: string } = {}) {
    this.file = opts.file ?? paths.goals;
    this.goals = readPersisted(this.file);
  }

  /** All goals, most-recent first. */
  list(): GoalRecord[] {
    return [...this.goals].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** All ACTIVE goals (pending + in_progress), most-recent first. */
  listActive(): GoalRecord[] {
    return this.list().filter((g) => g.status === "pending" || g.status === "in_progress");
  }

  get(id: string): GoalRecord | null {
    return this.goals.find((g) => g.id === id) ?? null;
  }

  /** Create a new pending goal. Returns the new record. */
  add(input: { objective: string; maxSteps: number; model?: string; providerId?: string }): GoalRecord {
    const now = Date.now();
    const rec: GoalRecord = {
      id: newId(),
      objective: input.objective.trim(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      maxSteps: Math.max(1, Math.floor(input.maxSteps)),
      stepsTaken: 0,
      model: input.model,
      providerId: input.providerId,
    };
    this.goals.push(rec);
    this.flush();
    return rec;
  }

  /** Update an existing record. Returns the new record, or null
   *  if the id is unknown. */
  update(id: string, patch: Partial<Pick<GoalRecord, "status" | "stepsTaken" | "finalText">>): GoalRecord | null {
    const idx = this.goals.findIndex((g) => g.id === id);
    if (idx === -1) return null;
    const cur = this.goals[idx]!;
    const next: GoalRecord = {
      ...cur,
      ...patch,
      updatedAt: Date.now(),
    };
    this.goals[idx] = next;
    this.flush();
    return next;
  }

  /** Remove a single record. Returns true if removed. */
  remove(id: string): boolean {
    const before = this.goals.length;
    this.goals = this.goals.filter((g) => g.id !== id);
    if (this.goals.length === before) return false;
    this.flush();
    return true;
  }

  /** Remove all terminal (complete / blocked / failed) goals.
   *  Returns the number removed. */
  clear(): number {
    const before = this.goals.length;
    this.goals = this.goals.filter((g) => !TERMINAL_GOAL_STATUSES.has(g.status));
    const removed = before - this.goals.length;
    if (removed > 0) this.flush();
    return removed;
  }

  /** Mark a goal in_progress. Convenience for the runner. */
  markInProgress(id: string): GoalRecord | null {
    return this.update(id, { status: "in_progress" });
  }

  /** Increment stepsTaken and return the new value. */
  recordStep(id: string): GoalRecord | null {
    const cur = this.get(id);
    if (!cur) return null;
    return this.update(id, { stepsTaken: cur.stepsTaken + 1 });
  }

  private flush(): void {
    writePersisted(this.file, this.goals);
  }
}

/** Render a goal record as a one-line summary. */
export function formatGoalLine(g: GoalRecord): string {
  const ago = formatAgo(g.createdAt);
  return "[" + g.id + "] " + g.status.padEnd(11) + " " + g.stepsTaken + "/" + g.maxSteps + " steps · " + ago + " — " + truncate(g.objective, 60);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return Math.floor(diff / 1000) + "s ago";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
  return Math.floor(diff / 86_400_000) + "d ago";
}
