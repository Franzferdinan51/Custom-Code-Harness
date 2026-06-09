// MissionLoop — perpetual driver. Owns the long-running GoalLoop.
//
// Tier 1 in the loop hierarchy. A mission is a long-lived user goal
// spanning hours/days; it survives an app restart (via the GoalStore
// persistence in `$CH_HOME/goals.json`) and may have sub-goals.
//
// A MissionLoop is the top of the stack. When you `run()` it, it:
//   1. Reads the active goal from the GoalStore (or creates one
//      from the input's `objective`).
//   2. Wraps the goal in a GoalLoop.
//   3. Runs the GoalLoop.
//   4. On `done`/`failed`, returns the final result. On `paused`,
//      it stays parked awaiting the next launch (the goal state is
//      persisted; the next `ch` invocation will resume from there
//      if the user re-runs the mission).
//
// A mission is a *GoalLoop* wrapped in a perpetual shell — the
// mission loop's only job is to instantiate the goal and decide
// whether to run, resume, or stop.

import type { Loop, LoopContext } from "./loop.js";
import { GoalStore, type GoalRecord, type GoalState } from "../goals.js";
import { goalLoop, type GoalLoop, type GoalLoopInput, type GoalLoopOutput } from "./goal.js";

export interface MissionInput {
  /** The mission's objective. If the store has a matching active
   *  goal, this is ignored (we resume). */
  objective?: string;
  /** If set, resume the goal with this id (regardless of status). */
  resumeId?: string;
  /** Model/provider overrides — applied to a fresh goal only. */
  model?: string;
  providerId?: string;
  /** Max iterations for the inner goal loop. Forwarded to a fresh
   *  goal only; resumed goals keep their original cap. */
  maxIterations?: number;
  /** Optional store. Defaults to a fresh GoalStore. */
  store?: GoalStore;
  /** Optional: forwarded to the GoalLoop. */
  runAgent?: GoalLoopInput["runAgent"];
}

export interface MissionOutput {
  /** The final goal record. */
  goal: GoalRecord;
  ok: boolean;
  loopStatus: GoalState;
  /** "created" if a new goal was added; "resumed" if we picked up
   *  an existing one. */
  mode: "created" | "resumed" | "noop";
  finalText?: string;
}

/** A Loop<"mission">. */
export interface MissionLoop extends Loop<"mission", MissionInput, MissionOutput> {}

/** Build a MissionLoop. */
export function missionLoop(): MissionLoop {
  return {
    kind: "mission",
    description: "perpetual driver — owns the long-running GoalLoop and survives restarts",
    async run(input: MissionInput, ctx: LoopContext): Promise<MissionOutput> {
      const store = input.store ?? new GoalStore();
      let mode: "created" | "resumed" | "noop" = "noop";
      let goal: GoalRecord | null = null;
      if (input.resumeId) {
        goal = store.get(input.resumeId);
        if (goal) {
          // Best-effort resume from a paused state.
          try { store.resume(goal.id); } catch { /* may already be non-paused */ }
          mode = "resumed";
        }
      }
      if (!goal) {
        // Find an active goal matching the objective, or create one.
        const active = store.listActive();
        const match = input.objective
          ? active.find((g) => g.objective === input.objective)
          : active[0];
        if (match) {
          try { store.resume(match.id); } catch { /* ignore */ }
          goal = match;
          mode = "resumed";
        } else if (input.objective) {
          goal = store.add({
            objective: input.objective,
            maxSteps: input.maxIterations ?? 8,
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
          });
          store.markInProgress(goal.id);
          mode = "created";
        }
      }
      if (!goal) {
        // No goal to drive. Return a noop — the mission had nothing
        // to do. This is the "no active goals" path.
        ctx.hooks?.onInfo?.("[mission] no active goal — nothing to do");
        return { goal: null as unknown as GoalRecord, ok: true, loopStatus: "pending", mode: "noop" };
      }
      // Drive the goal through a GoalLoop. Pass the existing goal in
      // (via `goal` field) so the inner loop drives THIS goal rather
      // than creating a new one in the same store.
      const inner: GoalLoop = goalLoop();
      const innerInput: GoalLoopInput = {
        objective: goal.objective,
        maxIterations: goal.maxSteps,
        ...(goal.model !== undefined ? { model: goal.model } : {}),
        ...(goal.providerId !== undefined ? { providerId: goal.providerId } : {}),
        ...(goal.successCriteria !== undefined ? { successCriteria: goal.successCriteria } : {}),
        store,
        goal,
        ...(input.runAgent !== undefined ? { runAgent: input.runAgent } : {}),
      };
      const out: GoalLoopOutput = await inner.run(innerInput, ctx);
      return {
        goal: out.goal,
        ok: out.ok,
        loopStatus: out.loopStatus,
        mode,
        ...(out.finalText !== undefined ? { finalText: out.finalText } : {}),
      };
    },
  };
}
