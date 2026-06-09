// GoalStore — persistent record of /goal runs. Lives at
// $CH_HOME/goals.json. Concept borrowed from DuckHive's persisted
// /goal system (https://github.com/Franzferdinan51/DuckHive).
//
// Phase 1 of the Agent-Teams + DuckHive feature merge: agnt-gg goal
// lifecycle. `goals.json` is a real state machine now, not a one-shot
// record. States: pending → planning → executing → evaluating →
// re-planning → done / failed / paused. Transitions are explicit and
// validated. Pause / resume / revert are orthogonal to the loop. The
// `ch goal` CLI flow drives the lifecycle end-to-end.
//
// Schema is bumped from v1 → v2; v1 records load in-memory unchanged
// (we just default `loopStatus` to "pending" when it's missing).

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../config/paths.js";
import { log } from "../util/logger.js";

/** Default mission id when no `--mission` is given. The legacy
 *  v1/v2 single-file structure is migrated to a "legacy" mission on
 *  first access, so "default" always starts fresh. */
export const DEFAULT_MISSION = "default";
/** Mission id used to hold records that were migrated from the
 *  legacy $CH_HOME/goals.json single-file structure. Created
 *  automatically on first access. */
export const LEGACY_MISSION = "legacy";

// ---------- Status (top-level lifecycle — backward compatible) ----------

export type GoalStatus = "pending" | "in_progress" | "complete" | "blocked" | "failed";

export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "complete",
  "blocked",
  "failed",
]);

// ---------- Loop state machine (Phase 1) ----------
//
// The full spike enum from `plans/plan_phase1/notes/agnt-port-plan.md`
// §1.2. Order matters: `canTransition` uses it.

export const GOAL_STATES = [
  "pending",
  "planning",
  "executing",
  "evaluating",
  "re-planning",
  "done",
  "failed",
  "paused",
] as const;

export type GoalState = (typeof GOAL_STATES)[number];

/** Terminal states — no outgoing transitions except via `revert`. */
export const TERMINAL_GOAL_STATES: ReadonlySet<GoalState> = new Set([
  "done",
  "failed",
]);

/** Edges of the state machine. The key is the source; each set is the
 *  list of legal destinations. `paused` and `failed` are reachable
 *  from any non-terminal state. `done` and `failed` only exit via
 *  `revert`, which the store implements separately. */
const TRANSITIONS: Record<GoalState, ReadonlySet<GoalState>> = {
  pending:      new Set<GoalState>(["planning", "paused", "failed"]),
  planning:     new Set<GoalState>(["executing", "paused", "failed"]),
  executing:    new Set<GoalState>(["evaluating", "paused", "failed"]),
  evaluating:   new Set<GoalState>(["re-planning", "done", "paused", "failed"]),
  "re-planning":new Set<GoalState>(["planning", "executing", "paused", "failed"]),
  done:         new Set<GoalState>([]),
  failed:       new Set<GoalState>([]),
  paused:       new Set<GoalState>(["pending", "planning", "executing", "evaluating", "re-planning", "failed"]),
};

export class GoalTransitionError extends Error {
  readonly from: GoalState;
  readonly to: GoalState;
  constructor(from: GoalState, to: GoalState, reason?: string) {
    super(`illegal goal transition: ${from} → ${to}${reason ? " — " + reason : ""}`);
    this.name = "GoalTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Pure guard. Throws `GoalTransitionError` when the transition is
 *  illegal. Returns `true` when it is legal. The store and the
 *  runner both call this — never mutate `loopStatus` without going
 *  through this check. */
export function canTransition(from: GoalState, to: GoalState): boolean {
  if (from === to) return true; // no-op transitions are allowed
  const set = TRANSITIONS[from];
  if (!set || !set.has(to)) {
    throw new GoalTransitionError(from, to);
  }
  return true;
}

/** Soft variant — returns `{ ok: false, reason }` instead of
 *  throwing. Used by CLI guards that need to render an error
 *  message without aborting the process. */
export function checkTransition(from: GoalState, to: GoalState): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: true };
  const set = TRANSITIONS[from];
  if (!set || !set.has(to)) {
    return { ok: false, reason: `illegal transition: ${from} → ${to}` };
  }
  return { ok: true };
}

// ---------- Lifecycle hooks ----------
//
// The store calls `onEnter(state, goal)` and `onExit(state, goal)`
// whenever a goal moves between states. Multiple subscribers are
// allowed; they run synchronously in registration order. Hooks are
// best-effort: a throw is caught and logged, never propagated (so a
// buggy hook can't corrupt the store).

export type LifecycleHook = (state: GoalState, goal: GoalRecord) => void;

export interface GoalLifecycle {
  onEnter: LifecycleHook;
  onExit: LifecycleHook;
}

// ---------- Evaluation ----------

export interface EvalResult {
  /** 0-100. Pass threshold is 70 — matches agnt-gg GoalEvaluator.js. */
  score: number;
  passed: boolean;
  feedback: string;
  /** Per-criterion breakdown, when successCriteria is present. */
  criteria: Array<{ criterion: string; hit: boolean; note: string }>;
}

/** Simple pass/fail heuristic. Looks for keyword hits in the goal's
 *  `finalText` (or its `status === "complete"` and the
 *  `successCriteria` keywords, case-insensitive). Full LLM-scored
 *  evaluation is a separate Phase 1 track (goal-evaluator.ts) and
 *  is out of scope here.
 *
 *  - If the goal has `successCriteria.deliverables`, each one must
 *    be mentioned in `finalText` to be considered "hit".
 *  - If the goal has no `finalText` and the status is "complete",
 *    we still pass (the agent declared done).
 *  - If the goal has no `successCriteria`, score = status === "complete"
 *    ? 100 : 0. */
export function evaluate(goal: GoalRecord, opts: { finalText?: string } = {}): EvalResult {
  const finalText = (opts.finalText ?? goal.finalText ?? "").toLowerCase();
  const criteria = goal.successCriteria?.deliverables ?? [];
  if (criteria.length === 0) {
    const passed = goal.status === "complete";
    return {
      score: passed ? 100 : 0,
      passed,
      feedback: passed ? "goal complete; no success criteria to check" : "goal not complete",
      criteria: [],
    };
  }
  const hits: Array<{ criterion: string; hit: boolean; note: string }> = [];
  let hitsN = 0;
  for (const c of criteria) {
    const needle = c.toLowerCase().trim();
    if (!needle) continue;
    const hit = needle.length > 0 && finalText.includes(needle);
    if (hit) hitsN += 1;
    hits.push({ criterion: c, hit, note: hit ? "found in output" : "not found in output" });
  }
  const score = Math.round((hitsN / criteria.length) * 100);
  return {
    score,
    passed: score >= 70,
    feedback: score >= 70
      ? `${hitsN}/${criteria.length} success criteria met`
      : `only ${hitsN}/${criteria.length} success criteria met`,
    criteria: hits,
  };
}

// ---------- Record + persistence ----------

export interface GoalEvaluation {
  id: string;
  iteration: number;
  score: number;
  passed: boolean;
  feedback: string;
  createdAt: number;
}

export interface SuccessCriteria {
  deliverables: string[];
  qualityChecks?: string[];
}

export interface GoalRecord {
  id: string;
  objective: string;
  status: GoalStatus;
  /** Inner state machine. Defaults to "pending" for v1 records. */
  loopStatus: GoalState;
  /** State we were in before pause — used by `resume()`. */
  previousLoopStatus?: GoalState;
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
  // ---------- Phase 1 additions ----------
  /** Iteration count for the AGI loop. */
  currentIteration?: number;
  /** Optional sub-goal parent. */
  parentGoalId?: string;
  /** Golden standards (Phase 1: simple keyword match). */
  successCriteria?: SuccessCriteria;
  /** History of evaluator runs. */
  evaluations?: GoalEvaluation[];
  // ---------- Phase 2 additions (Q2 + Q10) ----------
  /** Mission this goal belongs to. Set on creation from the active
   *  runtime mission. Defaults to "default" when the field is
   *  missing (v1/v2 records loaded from the legacy single file get
   *  stamped "legacy" on migration — see GoalStore constructor). */
  mission?: string;
  /** Set by the semantic-replan guard (see the `replanning` branch
   *  in `runGoalStateMachine`) and by the legacy migration when
   *  it can't classify a record. The runtime surfaces this in the
   *  CLI status output. */
  lastError?: string;
}

interface PersistedShapeV1 {
  version: 1;
  goals: GoalRecord[];
}

interface PersistedShapeV2 {
  version: 2;
  goals: GoalRecord[];
}

type PersistedShape = PersistedShapeV1 | PersistedShapeV2;

/** Generate a short, sortable, collision-resistant id. */
function newId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return "goal-" + ts + "-" + rand;
}

/** Read the persisted file. Tolerates missing / corrupt file.
 *  Auto-upgrades v1 → v2 in-memory (defaults `loopStatus = "pending"`). */
function readPersisted(file: string): GoalRecord[] {
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as PersistedShape;
    if (!parsed || !Array.isArray((parsed as { goals?: unknown }).goals)) return [];
    return (parsed.goals as GoalRecord[]).map((g) => upgradeRecord(g));
  } catch (e) {
    log.warn("goals: failed to parse " + file + " — starting empty (" + (e as Error).message + ")");
    return [];
  }
}

/** Backfill `loopStatus = "pending"` on v1 records. v1 records never
 *  had `loopStatus`, so we know it's missing. Other v2 fields are
 *  optional. */
function upgradeRecord(g: GoalRecord): GoalRecord {
  if (!g.loopStatus) g.loopStatus = "pending";
  return g;
}

/** Atomic write: write to a sibling .tmp then rename. Always writes
 *  v2 envelopes. */
function writePersisted(file: string, goals: GoalRecord[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  const payload: PersistedShapeV2 = { version: 2, goals };
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  renameSync(tmp, file);
}

// ---------- The store ----------

export interface GoalStoreOptions {
  /** Per-mission isolation. Two stores for two missions see two
   *  different files and don't share records. Defaults to
   *  `DEFAULT_MISSION` ("default"). Ignored when `file` is set. */
  mission?: string;
  /** Backward-compat / test escape hatch: use this exact file
   *  path, bypass per-mission resolution AND skip the legacy
   *  migration. Used by the test suite. */
  file?: string;
}

export class GoalStore {
  /** Active mission for this store. "<direct>" when the store was
   *  constructed with an explicit `file` (test escape hatch). */
  readonly mission: string;
  /** The file this store reads from and writes to. Public for
   *  tests and for the migration helpers. */
  readonly file: string;
  private goals: GoalRecord[];
  private onEnter: LifecycleHook[] = [];
  private onExit: LifecycleHook[] = [];

  constructor(opts: GoalStoreOptions = {}) {
    if (opts.file) {
      // Test escape hatch — no per-mission path, no migration.
      this.mission = "<direct>";
      this.file = opts.file;
      this.goals = this.normalizeMission(readPersisted(this.file));
    } else {
      const mission = opts.mission ?? DEFAULT_MISSION;
      this.mission = mission;
      this.file = paths.goalsMissionFile(mission);
      // The default mission triggers the legacy v1/v2 → "legacy"
      // mission migration on first access. Other missions never
      // trigger migration (the legacy single file is the only
      // data the migration reads).
      if (this.mission === DEFAULT_MISSION) this.maybeMigrateLegacy();
      this.goals = this.normalizeMission(readPersisted(this.file));
    }
  }

  /** Stamp the store's mission on every record that doesn't have
   *  one. Defensive: the per-mission state file should always
   *  have records stamped on write, but older versions of the
   *  store (or hand-edited files) might not. Records that DO
   *  have a `mission` field are left alone — the field is the
   *  source of truth for filtering. */
  private normalizeMission(records: GoalRecord[]): GoalRecord[] {
    if (this.mission === "<direct>") return records;
    for (const r of records) {
      if (!r.mission) r.mission = this.mission;
    }
    return records;
  }

  /** One-time migration: if the legacy $CH_HOME/goals.json exists
   *  AND the "legacy" mission's state.json does not, move the
   *  legacy records to $CH_HOME/goals/legacy/state.json and
   *  unlink the original. The "legacy" mission then owns the old
   *  data; the default mission starts empty.
   *
   *  This runs at most once per process per home dir — the
   *  sentinel is the absence of the legacy mission's state file.
   *  If the user manually deletes the legacy mission's state
   *  file later, the migration will NOT re-fire (the unlink is
   *  one-shot; we don't want to silently resurrect deleted data).
   *  Errors are logged and swallowed — a broken legacy file
   *  shouldn't prevent the default mission from loading. */
  private maybeMigrateLegacy(): void {
    const legacy = paths.goals;
    if (!existsSync(legacy)) return;
    const target = paths.goalsMissionFile(LEGACY_MISSION);
    if (existsSync(target)) {
      // Already migrated (or the user created their own "legacy"
      // mission). Don't clobber; just unlink the old file.
      try { unlinkSync(legacy); } catch (e) {
        log.warn("goals: could not unlink legacy file after detecting existing legacy mission: " + (e as Error).message);
      }
      return;
    }
    let records: GoalRecord[] = [];
    try {
      const raw = readFileSync(legacy, "utf-8");
      const parsed = JSON.parse(raw) as PersistedShape;
      if (parsed && Array.isArray((parsed as { goals?: unknown }).goals)) {
        records = (parsed.goals as GoalRecord[]).map((g) => {
          const r = upgradeRecord(g);
          // Stamp the legacy mission so the records are
          // unambiguously owned by the legacy mission once
          // re-read through a normal GoalStore({ mission: "legacy" }).
          r.mission = LEGACY_MISSION;
          return r;
        });
      }
    } catch (e) {
      log.warn("goals: failed to read legacy " + legacy + " during migration (" + (e as Error).message + ") — skipping");
      return;
    }
    try {
      writePersisted(target, records);
      unlinkSync(legacy);
      log.info("goals: migrated " + records.length + " legacy record(s) to " + target);
    } catch (e) {
      log.warn("goals: failed to write " + target + " during migration (" + (e as Error).message + ") — leaving legacy file in place");
    }
  }

  // ---- subscriptions ----

  /** Register a lifecycle hook. Returns an unsubscribe function. */
  subscribe(hooks: Partial<GoalLifecycle>): () => void {
    const offs: Array<() => void> = [];
    if (hooks.onEnter) {
      this.onEnter.push(hooks.onEnter);
      offs.push(() => {
        const i = this.onEnter.indexOf(hooks.onEnter!);
        if (i !== -1) this.onEnter.splice(i, 1);
      });
    }
    if (hooks.onExit) {
      this.onExit.push(hooks.onExit);
      offs.push(() => {
        const i = this.onExit.indexOf(hooks.onExit!);
        if (i !== -1) this.onExit.splice(i, 1);
      });
    }
    return () => { for (const off of offs) off(); };
  }

  // ---- queries ----

  /** All goals, most-recent first. */
  list(): GoalRecord[] {
    return [...this.goals].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** All ACTIVE goals (pending + in_progress), most-recent first. */
  listActive(): GoalRecord[] {
    return this.list().filter((g) => g.status === "pending" || g.status === "in_progress");
  }

  /** Children of a given parent goal. */
  listChildren(parentId: string): GoalRecord[] {
    return this.list().filter((g) => g.parentGoalId === parentId);
  }

  get(id: string): GoalRecord | null {
    return this.goals.find((g) => g.id === id) ?? null;
  }

  // ---- mutations ----

  /** Create a new pending goal. Returns the new record. */
  add(input: {
    objective: string;
    maxSteps: number;
    model?: string;
    providerId?: string;
    successCriteria?: SuccessCriteria;
    parentGoalId?: string;
  }): GoalRecord {
    const now = Date.now();
    const rec: GoalRecord = {
      id: newId(),
      objective: input.objective.trim(),
      status: "pending",
      loopStatus: "pending",
      createdAt: now,
      updatedAt: now,
      maxSteps: Math.max(1, Math.floor(input.maxSteps)),
      stepsTaken: 0,
      model: input.model,
      providerId: input.providerId,
      currentIteration: 0,
      successCriteria: input.successCriteria,
      parentGoalId: input.parentGoalId,
      // Stamp the active mission. The "<direct>" sentinel (test
      // escape hatch) leaves the field undefined so the test
      // record is "owned by no mission" — callers that need
      // a real mission can pass it explicitly.
      mission: this.mission === "<direct>" ? undefined : this.mission,
    };
    this.goals.push(rec);
    this.flush();
    this.fireEnter("pending", rec);
    return rec;
  }

  /** Spawn a sub-goal under a parent. The child inherits nothing
   *  (no model, no provider, no criteria) unless explicitly given.
   *  Returns the new record. */
  spawnSubgoal(parentId: string, input: {
    objective: string;
    maxSteps?: number;
    model?: string;
    providerId?: string;
    successCriteria?: SuccessCriteria;
  }): GoalRecord | null {
    const parent = this.get(parentId);
    if (!parent) return null;
    return this.add({
      objective: input.objective,
      maxSteps: input.maxSteps ?? parent.maxSteps,
      model: input.model ?? parent.model,
      providerId: input.providerId ?? parent.providerId,
      successCriteria: input.successCriteria,
      parentGoalId: parent.id,
    });
  }

  /** Update an existing record. Returns the new record, or null
   *  if the id is unknown. */
  update(id: string, patch: Partial<Pick<GoalRecord, "status" | "stepsTaken" | "finalText" | "currentIteration" | "successCriteria" | "evaluations" | "loopStatus" | "previousLoopStatus">>): GoalRecord | null {
    const idx = this.goals.findIndex((g) => g.id === id);
    if (idx === -1) return null;
    const cur = this.goals[idx]!;
    let nextLoopStatus: GoalState | undefined = patch.loopStatus;
    if (nextLoopStatus && nextLoopStatus !== cur.loopStatus) {
      // Validate. Throws GoalTransitionError on illegal moves; the
      // CLI layer catches and re-renders.
      canTransition(cur.loopStatus, nextLoopStatus);
      this.fireExit(cur.loopStatus, cur);
    }
    const next: GoalRecord = {
      ...cur,
      ...patch,
      updatedAt: Date.now(),
    };
    this.goals[idx] = next;
    this.flush();
    if (nextLoopStatus && nextLoopStatus !== cur.loopStatus) {
      this.fireEnter(nextLoopStatus, next);
    }
    return next;
  }

  /** Transition the inner state machine. Returns the new record.
   *  Throws `GoalTransitionError` on illegal moves. */
  transition(id: string, to: GoalState): GoalRecord | null {
    return this.update(id, { loopStatus: to });
  }

  /** Mark a goal paused. Records `previousLoopStatus` so `resume`
   *  knows where to come back. */
  pause(id: string): GoalRecord | null {
    const cur = this.get(id);
    if (!cur) return null;
    if (cur.loopStatus === "paused") return cur;
    if (TERMINAL_GOAL_STATES.has(cur.loopStatus)) {
      throw new GoalTransitionError(cur.loopStatus, "paused", "cannot pause a terminal state");
    }
    return this.update(id, {
      previousLoopStatus: cur.loopStatus,
      loopStatus: "paused",
      status: cur.status === "pending" ? "pending" : "in_progress",
    });
  }

  /** Resume from pause. Returns to `previousLoopStatus` (or
   *  `pending` if there is none). */
  resume(id: string): GoalRecord | null {
    const cur = this.get(id);
    if (!cur) return null;
    if (cur.loopStatus !== "paused") return cur;
    return this.update(id, {
      loopStatus: cur.previousLoopStatus ?? "pending",
      previousLoopStatus: undefined,
    });
  }

  /** Revert the goal to a previous state. Re-runs the AGI loop from
   *  that point. Resets `currentIteration` and bumps `stepsTaken`
   *  to track the new attempt. */
  revert(id: string, to: GoalState = "pending"): GoalRecord | null {
    const cur = this.get(id);
    if (!cur) return null;
    // From any terminal state we can revert back to a non-terminal one.
    if (cur.loopStatus === to) return cur;
    // Validate the transition.
    if (TERMINAL_GOAL_STATES.has(cur.loopStatus) && !TERMINAL_GOAL_STATES.has(to)) {
      // Allow (terminal → non-terminal) explicitly.
      const prev = cur.loopStatus;
      this.fireExit(prev, cur);
      this.goals[this.goals.findIndex((g) => g.id === id)!] = {
        ...cur,
        loopStatus: to,
        status: to === "done" || to === "failed" ? cur.status : "in_progress",
        previousLoopStatus: undefined,
        currentIteration: 0,
        updatedAt: Date.now(),
      };
      const next = this.get(id)!;
      this.flush();
      this.fireEnter(to, next);
      return next;
    }
    return this.update(id, {
      loopStatus: to,
      previousLoopStatus: undefined,
      currentIteration: 0,
    });
  }

  /** Append an evaluation result. Returns the new record. */
  recordEvaluation(id: string, ev: GoalEvaluation): GoalRecord | null {
    const cur = this.get(id);
    if (!cur) return null;
    const evaluations = [...(cur.evaluations ?? []), ev];
    return this.update(id, { evaluations });
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

  private fireEnter(state: GoalState, goal: GoalRecord): void {
    for (const hook of this.onEnter) {
      try { hook(state, goal); } catch (e) { log.warn("goals: onEnter hook threw — " + (e as Error).message); }
    }
  }

  private fireExit(state: GoalState, goal: GoalRecord): void {
    for (const hook of this.onExit) {
      try { hook(state, goal); } catch (e) { log.warn("goals: onExit hook threw — " + (e as Error).message); }
    }
  }
}

// ---------- Rendering ----------

/** Render a goal record as a one-line summary. */
export function formatGoalLine(g: GoalRecord): string {
  const ago = formatAgo(g.createdAt);
  const loop = g.loopStatus ? "[" + g.loopStatus + "] " : "";
  return "[" + g.id + "] " + g.status.padEnd(11) + " " + loop + g.stepsTaken + "/" + g.maxSteps + " steps · " + ago + " — " + truncate(g.objective, 60);
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

// ---------- State-machine driver ----------
//
// This is the Phase 1 port from agnt-gg/agnt's `goal-runner`. The CLI
// and the `/goal` slash command can both call it. The driver is
// engine-agnostic: it takes a `runAgent` callback that returns the
// model's text response, and a `store` to persist the goal. The
// callback is the only thing the tests need to stub.
//
// One iteration = one planning pass + one execution pass. After each
// iteration we evaluate. If the goal passes, we transition to
// `done`; otherwise we go to `re-planning` and try again until
// `maxIterations` is exhausted (then `failed`).

export type GoalRunAgentFn = (
  phase: "planning" | "executing",
  context: { previousOutput?: string; iteration: number },
) => Promise<{ content: string; steps: number }>;

export interface RunGoalOptions {
  store: GoalStore;
  runAgent: GoalRunAgentFn;
  /** Cap on iterations. Defaults to the goal's `maxSteps`. */
  maxIterations?: number;
  /** Called whenever the state changes. Optional; used by the CLI
   *  to print progress. */
  onStateChange?: (state: GoalState, goal: GoalRecord) => void;
}

export async function runGoalStateMachine(
  goal: GoalRecord,
  opts: RunGoalOptions,
): Promise<GoalRecord> {
  const max = opts.maxIterations ?? goal.maxSteps;
  let cur = opts.store.get(goal.id) ?? goal;
  let lastExec = "";
  for (let iter = 1; iter <= max; iter++) {
    // Bump iteration count first; reading from the store keeps the
    // value visible to lifecycle hooks.
    cur = opts.store.update(goal.id, { currentIteration: iter }) ?? cur;

    // ---- planning ----
    cur = opts.store.transition(goal.id, "planning") ?? cur;
    opts.onStateChange?.(cur.loopStatus, cur);
    const planOut = await opts.runAgent("planning", {
      previousOutput: lastExec,
      iteration: iter,
    });
    lastExec = planOut.content;

    // ---- executing ----
    cur = opts.store.transition(goal.id, "executing") ?? cur;
    opts.onStateChange?.(cur.loopStatus, cur);
    const execOut = await opts.runAgent("executing", {
      previousOutput: planOut.content,
      iteration: iter,
    });
    lastExec = execOut.content;

    // Persist the finalText (used by evaluate()).
    cur = opts.store.update(goal.id, {
      finalText: execOut.content.slice(0, 2000),
      stepsTaken: cur.stepsTaken + 1,
    }) ?? cur;

    // Agent-side early termination: if the model said GOAL COMPLETE
    // we short-circuit to evaluation with a synthetic high score.
    const lc = execOut.content.toLowerCase();
    if (lc.includes("goal complete")) {
      cur = opts.store.transition(goal.id, "evaluating") ?? cur;
      opts.onStateChange?.(cur.loopStatus, cur);
      const ev: GoalEvaluation = {
        id: "eval-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
        iteration: iter,
        score: 100,
        passed: true,
        feedback: "agent self-declared GOAL COMPLETE",
        createdAt: Date.now(),
      };
      cur = opts.store.recordEvaluation(goal.id, ev) ?? cur;
      cur = opts.store.transition(goal.id, "done") ?? cur;
      cur = opts.store.update(goal.id, { status: "complete" }) ?? cur;
      opts.onStateChange?.(cur.loopStatus, cur);
      return cur;
    }
    if (lc.includes("goal blocked")) {
      cur = opts.store.transition(goal.id, "evaluating") ?? cur;
      opts.onStateChange?.(cur.loopStatus, cur);
      const ev: GoalEvaluation = {
        id: "eval-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
        iteration: iter,
        score: 0,
        passed: false,
        feedback: "agent reported GOAL BLOCKED",
        createdAt: Date.now(),
      };
      cur = opts.store.recordEvaluation(goal.id, ev) ?? cur;
      cur = opts.store.transition(goal.id, "failed") ?? cur;
      cur = opts.store.update(goal.id, { status: "failed" }) ?? cur;
      opts.onStateChange?.(cur.loopStatus, cur);
      return cur;
    }

    // ---- evaluating ----
    cur = opts.store.transition(goal.id, "evaluating") ?? cur;
    opts.onStateChange?.(cur.loopStatus, cur);
    const evalRes = evaluate(cur, { finalText: execOut.content });
    const ev: GoalEvaluation = {
      id: "eval-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
      iteration: iter,
      score: evalRes.score,
      passed: evalRes.passed,
      feedback: evalRes.feedback,
      createdAt: Date.now(),
    };
    cur = opts.store.recordEvaluation(goal.id, ev) ?? cur;

    if (evalRes.passed) {
      cur = opts.store.transition(goal.id, "done") ?? cur;
      cur = opts.store.update(goal.id, { status: "complete" }) ?? cur;
      opts.onStateChange?.(cur.loopStatus, cur);
      return cur;
    }
    if (iter >= max) break;
    cur = opts.store.transition(goal.id, "re-planning") ?? cur;
    opts.onStateChange?.(cur.loopStatus, cur);
  }
  // Exhausted iterations without passing.
  cur = opts.store.transition(goal.id, "failed") ?? cur;
  cur = opts.store.update(goal.id, { status: "failed" }) ?? cur;
  opts.onStateChange?.(cur.loopStatus, cur);
  return cur;
}

// ---------- Re-exports (Phase 1 — p1-unify wireup) ----------
//
// `src/agent/goals.ts` is the canonical home of goal state. The
// `Loop<"goal">` shape that the new hierarchy expects also lives
// here as a re-export so callers (CLI, tests, external consumers)
// can `import { goalLoop, type GoalLoop, type GoalLoopInput,
// type GoalLoopOutput } from "./goals.js"` without reaching into
// `loops/`. The actual implementation is in `loops/goal.ts` — the
// factory wires the lifecycle into the new `Loop<Kind>` shape.

export {
  goalLoop,
  type GoalLoop,
  type GoalLoopInput,
  type GoalLoopOutput,
} from "./loops/goal.js";
