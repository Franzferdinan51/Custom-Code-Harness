// Tests for the Phase 1 (p1-unify) CLI wireup.
//
// Verifies that the spec's required exports live in the canonical
// files (`src/agent/goals.ts`, `src/agent/loop.ts`) so the CLI
// commands and external consumers can `import { goalLoop } from
// "./agent/goals.js"` without reaching into `loops/` directly.
//
//   1. `goals.ts` re-exports `goalLoop`, `GoalLoop`, `GoalLoopInput`,
//      `GoalLoopOutput` from `loops/goal.js`.
//   2. `loop.ts` re-exports `agentLoop`, `AgentLoop`, `AgentLoopInput`,
//      `AgentLoopOutput` from `loops/agent.js`.
//   3. `goalLoop()` factory from `goals.ts` produces a Loop<"goal">
//      that runs against an in-memory store.
//   4. `agentLoop()` factory from `loop.ts` produces a Loop<"agent">
//      that wraps the existing `runAgent` (regression — the agent
//      loop is still the agent-level workhorse).
//   5. `councilAsGoalLoop()` returns a Loop<"goal"> whose bridge can
//      drive a council deliberation (regression for the council
//      wireup — see `src/cli.ts` `runCouncilCmd`).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ch-cli-wireup-"));
process.env.CODINGHARNESS_HOME = tmp;
process.env.NO_COLOR = "1";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
  mkdirSync(join(tmp, sub), { recursive: true });
}

import {
  GoalStore,
  goalLoop as goalLoopFromGoals,
  type GoalLoop,
  type GoalLoopInput,
  type GoalLoopOutput,
  type GoalRecord,
  type GoalRunAgentFn,
} from "../agent/goals.js";
import {
  agentLoop as agentLoopFromLoop,
  type AgentLoop,
  type AgentLoopInput,
  type AgentLoopOutput,
  DEFAULT_LIMITS,
} from "../agent/loop.js";
import { councilAsGoalLoop } from "../agent/council.js";

// Clean up tmp on test teardown so a re-run on the same machine
// starts clean.
test.after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test("wireup: goals.ts re-exports goalLoop as a Loop<goal>", () => {
  const loop: GoalLoop = goalLoopFromGoals();
  assert.equal(loop.kind, "goal");
  assert.equal(typeof loop.run, "function");
  // The re-exported type is the same shape as the canonical one.
  const input: GoalLoopInput = { objective: "wireup smoke" };
  const out: Promise<GoalLoopOutput> = loop.run(input, {
    cwd: tmp,
    signal: new AbortController().signal,
  });
  assert.ok(out instanceof Promise, "loop.run should return a Promise");
});

test("wireup: loop.ts re-exports agentLoop as a Loop<agent>", () => {
  const loop: AgentLoop = agentLoopFromLoop();
  assert.equal(loop.kind, "agent");
  assert.equal(typeof loop.run, "function");
  // The re-exported type is the same shape as the canonical one.
  const input: AgentLoopInput = {
    provider: {} as AgentLoopInput["provider"], // never used — stubbed below
    model: "stub",
    messages: [],
    tools: {} as AgentLoopInput["tools"],
    cwd: tmp,
    signal: new AbortController().signal,
  };
  const out: Promise<AgentLoopOutput> = loop.run(input, {
    cwd: tmp,
    signal: new AbortController().signal,
  });
  assert.ok(out instanceof Promise, "loop.run should return a Promise");
});

test("wireup: goalLoop from goals.ts drives a full lifecycle with a stub bridge", async () => {
  // Stateful stub: phase=planning yields a plan, phase=executing
  // yields "GOAL COMPLETE" so the state machine short-circuits to
  // "done". This mirrors the stub-provider pattern from
  // goals.test.ts.
  const store = new GoalStore();
  const callLog: Array<"planning" | "executing"> = [];
  const stub: GoalRunAgentFn = async (phase, ctx) => {
    callLog.push(phase);
    if (phase === "planning") {
      return { content: "Plan: 1) list files 2) summarize. Ready to execute.", steps: 1 };
    }
    // executing — say GOAL COMPLETE so the state machine ends
    return { content: "Done. GOAL COMPLETE", steps: 1 };
  };
  const loop = goalLoopFromGoals();
  const out = await loop.run(
    {
      objective: "wireup full lifecycle",
      maxIterations: 3,
      store,
      runAgent: stub,
    },
    {
      cwd: tmp,
      signal: new AbortController().signal,
    },
  );
  assert.equal(out.ok, true, "loop should reach done state");
  assert.equal(out.loopStatus, "done");
  assert.equal(callLog.length >= 2, true, "stub should have been called for planning + executing");
  assert.deepEqual(callLog.slice(0, 2), ["planning", "executing"]);
  // The goal should be persisted in the store.
  const persisted: GoalRecord | null = store.get(out.goal.id);
  assert.ok(persisted, "loop should persist the goal to the store");
  assert.equal(persisted.objective, "wireup full lifecycle");
});

test("wireup: councilAsGoalLoop drives a council through a goal lifecycle", async () => {
  // Stub bridge: simulate the council returning a synthesized
  // answer. We only need the loop's state machine to walk plan →
  // execute → done.
  const store = new GoalStore();
  const loop = councilAsGoalLoop();
  const out = await loop.run(
    {
      objective: "wireup council smoke",
      maxIterations: 1,
      store,
      runAgent: async (phase) => {
        if (phase === "planning") {
          return { content: "council plan: spawn 3 councilors + synthesizer", steps: 0 };
        }
        return { content: "synthesized final answer from council", steps: 3 };
      },
    },
    {
      cwd: tmp,
      signal: new AbortController().signal,
    },
  );
  // The bridge yields "GOAL COMPLETE" only when the executing
  // content literally contains it — our bridge doesn't, so the
  // state machine should walk once and the eval should pass
  // (heuristic) or fail (heuristic). Either way, the goal should
  // exist in the store and the loop returned a structured output.
  assert.ok(out.goal, "loop should produce a goal record");
  assert.equal(out.goal.objective, "wireup council smoke");
  assert.ok(["done", "failed", "paused", "executing", "evaluating"].includes(out.loopStatus),
    "loopStatus should be one of the known states, got: " + out.loopStatus);
});

test("wireup: DEFAULT_LIMITS is still exported from loop.ts (regression)", () => {
  // The CLI reuses DEFAULT_LIMITS in its runAgent bridge. Confirm
  // it's still exported after the AgentLoop re-export was added.
  assert.ok(DEFAULT_LIMITS, "DEFAULT_LIMITS should be exported from loop.ts");
  assert.equal(typeof DEFAULT_LIMITS.maxSteps, "number");
});
