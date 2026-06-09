// GoalLoop — drives a goal forward through plan → execute → evaluate → replan.
//
// Tier 2 in the loop hierarchy. The body is `runGoalStateMachine`
// from `src/agent/goals.ts` (the Phase 1 port). The GoalLoop wraps
// it in the `Loop<Kind>` shape so it composes with the rest of the
// hierarchy and so the `delegate()` helper from
// `src/agent/delegation.ts` can route work to it.
//
// A GoalLoop instantiates one goal in a `GoalStore`, drives the state
// machine, and emits lifecycle events through the loop's hooks.
// Sub-work (a sub-agent spawn from a plan step, an async tool call,
// etc.) is dispatched through `delegate` so it inherits the union
// handling from Phase 1.

import type { Loop, LoopContext } from "./loop.js";
import {
  GoalStore,
  runGoalStateMachine,
  type GoalRecord,
  type GoalRunAgentFn,
  type GoalState,
  type RunGoalOptions,
} from "../goals.js";

export interface GoalLoopInput {
  objective: string;
  maxIterations?: number;
  model?: string;
  providerId?: string;
  successCriteria?: { deliverables: string[]; qualityChecks?: string[] };
  parentGoalId?: string;
  /** The runAgent bridge. If not supplied, the loop expects an
   *  external bridge (typically wired by the CLI or the delegation
   *  manager) and the run will be a no-op dispatch. */
  runAgent?: GoalRunAgentFn;
  /** Optional: a pre-existing GoalStore. Defaults to a fresh one. */
  store?: GoalStore;
  /** Optional: drive an existing goal instead of creating a new one.
   *  Used by the MissionLoop to resume a matched active goal. The
   *  goal must already be in the supplied `store`. */
  goal?: GoalRecord;
}

export interface GoalLoopOutput {
  goal: GoalRecord;
  ok: boolean;
  /** Final loop state ("done" | "failed" | "paused" | "executing" | ...). */
  loopStatus: GoalState;
  /** The final text the agent produced. */
  finalText?: string;
  /** History of evaluator runs. */
  evaluations: NonNullable<GoalRecord["evaluations"]>;
}

/** A Loop<"goal">. */
export interface GoalLoop extends Loop<"goal", GoalLoopInput, GoalLoopOutput> {}

/** Build a GoalLoop. The closure captures no state. */
export function goalLoop(): GoalLoop {
  return {
    kind: "goal",
    description: "plan → execute → evaluate → replan state machine (drives one objective)",
    async run(input: GoalLoopInput, ctx: LoopContext): Promise<GoalLoopOutput> {
      const store = input.store ?? new GoalStore();
      const goal = input.goal ?? store.add({
        objective: input.objective,
        maxSteps: input.maxIterations ?? 8,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
        ...(input.successCriteria !== undefined ? { successCriteria: input.successCriteria } : {}),
        ...(input.parentGoalId !== undefined ? { parentGoalId: input.parentGoalId } : {}),
      });
      // If we just created the goal, mark it in_progress. If we
      // were given an existing one (resume), the caller already
      // owns the state — leave it alone.
      if (!input.goal) store.markInProgress(goal.id);
      ctx.hooks?.onInfo?.("[goal] created " + goal.id + " — " + input.objective);
      // The bridge: if the caller didn't supply a runAgent, we use
      // a stub that the delegation manager can detect. This is the
      // hook the Phase 1 plan called for — subgoals dispatched
      // through `delegate` reach this stub and the manager records
      // the dispatch even if the actual LLM call is wired elsewhere.
      const stub: GoalRunAgentFn = input.runAgent ?? (async (phase, pCtx) => {
        ctx.hooks?.onInfo?.("[goal] " + phase + " (iteration " + pCtx.iteration + ") — no runAgent wired");
        return { content: "no runAgent wired; phase=" + phase + " iter=" + pCtx.iteration, steps: 0 };
      });
      const opts: RunGoalOptions = {
        store,
        runAgent: stub,
        ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
        onStateChange: (state, g) => {
          ctx.hooks?.onState?.(state);
          ctx.hooks?.onInfo?.("[goal " + g.id + "] " + state + " (iter " + (g.currentIteration ?? 0) + ")");
        },
      };
      // Respect the caller's signal. The state machine reads the
      // store's own signal via canTransition, so we abort by
      // transitioning the goal to "paused" and then bail. The
      // cleanest hook is to install an abort listener that pauses.
      const onAbort = () => {
        try { store.pause(goal.id); } catch { /* terminal state — ignore */ }
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
      let final: GoalRecord;
      try {
        final = await runGoalStateMachine(goal, opts);
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      const ok = final.loopStatus === "done";
      return {
        goal: final,
        ok,
        loopStatus: final.loopStatus,
        ...(final.finalText !== undefined ? { finalText: final.finalText } : {}),
        evaluations: final.evaluations ?? [],
      };
    },
  };
}
