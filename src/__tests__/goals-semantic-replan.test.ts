// Tests for the semantic identical-replan guard in
// `runGoalStateMachine` (src/agent/goals.ts).
//
// The guard catches the common LLM failure mode where the planner
// re-generates the same plan in a different surface form (e.g.
// "Run tests" vs "run  tests" vs "tests run"). The surface-text
// check would have missed this; the new check normalizes both
// plans (lowercase, whitespace-strip, token-sort) before comparing.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ch-goals-semantic-replan-"));
process.env.CODINGHARNESS_HOME = tmp;
process.env.NO_COLOR = "1";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
  mkdirSync(join(tmp, sub), { recursive: true });
}

import {
  GoalStore,
  isSemanticallyIdentical,
  normalizeForSemanticCompare,
  runGoalStateMachine,
  SEMANTIC_IDENTICAL_REPLAN_REASON,
  type GoalRunAgentFn,
} from "../agent/goals.js";

test.after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------- Pure helpers ----------

test("semantic-replan: normalizeForSemanticCompare lowercases and token-sorts", () => {
  const a = "Run tests";
  const b = "run  tests";
  assert.equal(normalizeForSemanticCompare(a), normalizeForSemanticCompare(b));
  // Different token order also normalizes the same.
  const c = "tests run";
  assert.equal(normalizeForSemanticCompare(a), normalizeForSemanticCompare(c));
  // Punctuation splits into its own tokens; matches the simple
  // whitespace split. We do NOT strip punctuation — that's a
  // Phase 3 refinement. The user's example ("Run tests" vs "run
  // tests") is the canonical case the guard must catch.
  const d = "  RUN   tests  ";
  assert.equal(normalizeForSemanticCompare(a), normalizeForSemanticCompare(d));
});

test("semantic-replan: isSemanticallyIdentical returns true for the canonical example", () => {
  // The exact case from the task description: "Run tests" vs
  // "run  tests" (extra spaces, different case).
  assert.equal(isSemanticallyIdentical("Run tests", "run  tests"), true);
});

test("semantic-replan: isSemanticallyIdentical returns false for genuinely different plans", () => {
  // Different token → not identical.
  assert.equal(isSemanticallyIdentical("Run tests", "Run build"), false);
  // Empty vs non-empty → not identical.
  assert.equal(isSemanticallyIdentical("", "Run tests"), false);
  assert.equal(isSemanticallyIdentical("Run tests", ""), false);
  // Same set, different one of the tokens.
  assert.equal(isSemanticallyIdentical("Run tests now", "Run tests later"), false);
});

// ---------- State machine integration ----------

test("semantic-replan: runGoalStateMachine aborts on a semantically identical replan", async () => {
  // Stub: planning yields "Run tests" both times (same content,
  // different surface form on the second call). Executing yields
  // output that does NOT mention the success criterion, so the
  // evaluator fails and the runner enters re-planning. On the
  // second re-plan, the new plan content is semantically identical
  // to the first → the guard aborts with the reason.
  const file = join(tmp, "semantic-replan.json");
  const store = new GoalStore({ file });
  const goal = store.add({
    objective: "ship feature X",
    maxSteps: 4,
    successCriteria: { deliverables: ["magic-phrase-xyzzy"] },
  });

  let planningCall = 0;
  const stub: GoalRunAgentFn = async (phase) => {
    if (phase === "planning") {
      planningCall += 1;
      // First call: "Run tests" (canonical).
      // Second call: "run  tests" (lowercase + double space) —
      // semantically identical to the first.
      return { content: planningCall === 1 ? "Run tests" : "run  tests", steps: 1 };
    }
    // executing: never satisfies the criterion.
    return { content: "executing — no magic phrase here", steps: 1 };
  };

  const final = await runGoalStateMachine(goal, {
    store,
    runAgent: stub,
    maxIterations: 4,
  });

  // The guard fired: status="failed", loopStatus="failed",
  // lastError carries the canonical reason.
  assert.equal(final.status, "failed", "goal status should be 'failed' after semantic identical replan");
  assert.equal(final.loopStatus, "failed");
  assert.equal(final.lastError, SEMANTIC_IDENTICAL_REPLAN_REASON);
  // The planner was called exactly twice (initial + one re-plan)
  // before the guard aborted. A naive byte-equal guard would have
  // missed this case.
  assert.equal(planningCall, 2, "planner should have run exactly twice before the guard aborted");
  // The goal should be persisted to disk with the failure reason.
  const reloaded = new GoalStore({ file }).get(goal.id);
  assert.equal(reloaded?.lastError, SEMANTIC_IDENTICAL_REPLAN_REASON);
  assert.equal(reloaded?.status, "failed");
});

test("semantic-replan: runGoalStateMachine does NOT abort on a genuinely different replan", async () => {
  // Same setup as above, but every re-plan introduces a brand new
  // token so the plans are pairwise non-identical. The guard must
  // NOT fire. The evaluator still fails (no magic phrase) and the
  // goal eventually exhausts maxIterations — at which point the
  // normal "failed" path (without lastError) takes over.
  const file = join(tmp, "semantic-replan-no-trigger.json");
  const store = new GoalStore({ file });
  const goal = store.add({
    objective: "ship feature Y",
    maxSteps: 3,
    successCriteria: { deliverables: ["magic-phrase-xyzzy"] },
  });

  let planningCall = 0;
  // Three distinct plans, each adds a fresh token so the
  // normalized form is unique on every call.
  const PLANS = [
    "Run tests",
    "Run tests, additionally lint",
    "Run tests, additionally lint, finally build",
  ];
  const stub: GoalRunAgentFn = async (phase) => {
    if (phase === "planning") {
      planningCall += 1;
      return { content: PLANS[planningCall - 1]!, steps: 1 };
    }
    return { content: "still no magic phrase", steps: 1 };
  };

  const final = await runGoalStateMachine(goal, {
    store,
    runAgent: stub,
    maxIterations: 3,
  });

  assert.equal(final.status, "failed", "goal should still end as failed (evaluator never passed)");
  assert.equal(final.loopStatus, "failed");
  // The guard did NOT fire — this is a normal "evaluator never
  // passed" failure, not a semantic identical-replan. The
  // lastError must not carry the guard's reason.
  assert.notEqual(final.lastError, SEMANTIC_IDENTICAL_REPLAN_REASON);
  assert.equal(planningCall, 3, "planner should run maxIterations times when no guard fires");
});

test("semantic-replan: runGoalStateMachine does not fire guard on the first iteration", async () => {
  // Single-iteration goal: the planner is called once and the
  // guard has no previous plan to compare against. The guard
  // must NOT fire. The goal fails normally because the
  // criterion is never met.
  const file = join(tmp, "semantic-replan-first-iter.json");
  const store = new GoalStore({ file });
  const goal = store.add({
    objective: "ship feature Z",
    maxSteps: 1,
    successCriteria: { deliverables: ["never-found-keyword"] },
  });

  const stub: GoalRunAgentFn = async (phase) => {
    if (phase === "planning") return { content: "Some plan", steps: 1 };
    return { content: "no keyword here", steps: 1 };
  };

  const final = await runGoalStateMachine(goal, {
    store,
    runAgent: stub,
    maxIterations: 1,
  });

  assert.equal(final.status, "failed");
  assert.notEqual(final.lastError, SEMANTIC_IDENTICAL_REPLAN_REASON);
});
