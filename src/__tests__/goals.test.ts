// Tests for the GoalStore persistence layer.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODINGHARNESS_HOME = mkdtempSync(join(tmpdir(), "ch-goals-test-"));
process.env.NO_COLOR = "1";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
  mkdirSync(join(process.env.CODINGHARNESS_HOME, sub), { recursive: true });
}

import {
  GoalStore,
  TERMINAL_GOAL_STATUSES,
  formatGoalLine,
  type GoalRecord,
  canTransition,
  checkTransition,
  GoalTransitionError,
  GOAL_STATES,
  TERMINAL_GOAL_STATES,
  evaluate,
  runGoalStateMachine,
  type GoalState,
  type GoalRunAgentFn,
} from "../agent/goals.js";

test("goals: add creates a pending record with id and timestamps", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals.json");
  const store = new GoalStore({ file });
  const rec = store.add({ objective: "wire up OAuth", maxSteps: 8 });
  assert.match(rec.id, /^goal-[a-z0-9-]+$/);
  assert.equal(rec.status, "pending");
  assert.equal(rec.stepsTaken, 0);
  assert.equal(rec.maxSteps, 8);
  assert.equal(rec.objective, "wire up OAuth");
  assert.ok(rec.createdAt > 0);
  assert.equal(rec.createdAt, rec.updatedAt);
});

test("goals: persists to disk and round-trips", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-r.json");
  const s1 = new GoalStore({ file });
  s1.add({ objective: "ship Phase 0", maxSteps: 12 });
  assert.ok(existsSync(file), "goals.json should be written");
  const s2 = new GoalStore({ file });
  const all = s2.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.objective, "ship Phase 0");
  assert.equal(all[0]!.maxSteps, 12);
});

test("goals: update changes status + stepsTaken", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-u.json");
  const s = new GoalStore({ file });
  const rec = s.add({ objective: "x", maxSteps: 5 });
  const updated = s.update(rec.id, { status: "in_progress", stepsTaken: 2 });
  assert.ok(updated);
  assert.equal(updated!.status, "in_progress");
  assert.equal(updated!.stepsTaken, 2);
  // Read it back from disk.
  const s2 = new GoalStore({ file });
  const got = s2.get(rec.id);
  assert.equal(got?.status, "in_progress");
  assert.equal(got?.stepsTaken, 2);
});

test("goals: update returns null for unknown id", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-unknown.json");
  const s = new GoalStore({ file });
  const r = s.update("goal-does-not-exist", { status: "complete" });
  assert.equal(r, null);
});

test("goals: remove deletes a single record", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-rm.json");
  const s = new GoalStore({ file });
  const a = s.add({ objective: "a", maxSteps: 1 });
  const b = s.add({ objective: "b", maxSteps: 1 });
  assert.equal(s.remove(a.id), true);
  assert.equal(s.list().length, 1);
  assert.equal(s.get(a.id), null);
  assert.equal(s.get(b.id)?.objective, "b");
});

test("goals: remove returns false for unknown id", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-rm2.json");
  const s = new GoalStore({ file });
  assert.equal(s.remove("goal-nope"), false);
});

test("goals: clear removes only terminal records", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-clear.json");
  const s = new GoalStore({ file });
  const a = s.add({ objective: "active", maxSteps: 5 });
  const b = s.add({ objective: "done", maxSteps: 5 });
  const c = s.add({ objective: "blocked", maxSteps: 5 });
  s.update(b.id, { status: "complete" });
  s.update(c.id, { status: "blocked" });
  const removed = s.clear();
  assert.equal(removed, 2);
  const remaining = s.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.id, a.id);
});

test("goals: clear returns 0 when nothing to clear", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-clear2.json");
  const s = new GoalStore({ file });
  s.add({ objective: "still active", maxSteps: 5 });
  assert.equal(s.clear(), 0);
});

test("goals: listActive returns only pending + in_progress", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-active.json");
  const s = new GoalStore({ file });
  const a = s.add({ objective: "active", maxSteps: 5 });
  const b = s.add({ objective: "done", maxSteps: 5 });
  s.update(b.id, { status: "complete" });
  s.markInProgress(a.id);
  const active = s.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0]!.id, a.id);
  assert.equal(active[0]!.status, "in_progress");
});

test("goals: tolerates missing file", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-missing.json");
  if (existsSync(file)) rmSync(file);
  const s = new GoalStore({ file });
  assert.deepEqual(s.list(), []);
  s.add({ objective: "from empty", maxSteps: 3 });
  assert.equal(s.list().length, 1);
});

test("goals: tolerates corrupt JSON", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-corrupt.json");
  // Write garbage.
  writeFileSync(file, "{ this is not valid json", "utf-8");
  const s = new GoalStore({ file });
  // Should start empty, not throw.
  assert.deepEqual(s.list(), []);
  // Should be able to write over it.
  s.add({ objective: "after corrupt", maxSteps: 1 });
  const s2 = new GoalStore({ file });
  assert.equal(s2.list().length, 1);
});

test("goals: atomic write does not leave .tmp files on success", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-atomic.json");
  const s = new GoalStore({ file });
  s.add({ objective: "atomic", maxSteps: 1 });
  s.add({ objective: "atomic 2", maxSteps: 1 });
  assert.ok(!existsSync(file + ".tmp"), "no .tmp should remain after successful write");
  // File should be a regular file with valid JSON.
  const stat = statSync(file);
  assert.equal(stat.isFile(), true);
  const parsed = JSON.parse(readFileSync(file, "utf-8"));
  assert.ok(Array.isArray(parsed.goals));
  assert.equal(parsed.goals.length, 2);
});

test("goals: formatGoalLine includes id, status, steps, objective", () => {
  const g: GoalRecord = {
    id: "goal-abc",
    objective: "ship the council feature",
    status: "in_progress",
    loopStatus: "executing",
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    maxSteps: 8,
    stepsTaken: 3,
  };
  const line = formatGoalLine(g);
  assert.match(line, /goal-abc/);
  assert.match(line, /in_progress/);
  assert.match(line, /3\/8/);
  assert.match(line, /ship the council feature/);
});

test("goals: formatGoalLine truncates long objective", () => {
  const g: GoalRecord = {
    id: "goal-xyz",
    objective: "x".repeat(200),
    status: "pending",
    loopStatus: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxSteps: 1,
    stepsTaken: 0,
  };
  const line = formatGoalLine(g);
  assert.ok(line.length < 200, "formatGoalLine should truncate long objectives");
  assert.match(line, /…$/);
});

test("goals: recordStep increments and persists", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-step.json");
  const s = new GoalStore({ file });
  const rec = s.add({ objective: "step test", maxSteps: 4 });
  s.recordStep(rec.id);
  s.recordStep(rec.id);
  s.recordStep(rec.id);
  const got = new GoalStore({ file }).get(rec.id);
  assert.equal(got?.stepsTaken, 3);
});

test("goals: TERMINAL_GOAL_STATUSES is the expected set", () => {
  assert.deepEqual([...TERMINAL_GOAL_STATUSES].sort(), ["blocked", "complete", "failed"]);
});

// ---------- Phase 1: state machine + lifecycle + spawn/pause/resume/revert + driver ----------

test("goals (v1 schema): existing goals.json on disk still loads unchanged", () => {
  // Simulate a v1 goals.json that predates the state machine.
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-v1.json");
  const v1 = {
    version: 1,
    goals: [
      {
        id: "goal-old-1",
        objective: "legacy v1 goal",
        status: "in_progress",
        createdAt: 1_000_000,
        updatedAt: 1_000_000,
        maxSteps: 6,
        stepsTaken: 2,
      },
    ],
  };
  writeFileSync(file, JSON.stringify(v1), "utf-8");
  const s = new GoalStore({ file });
  const all = s.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.id, "goal-old-1");
  // Upgraded in-memory: loopStatus is "pending" by default.
  assert.equal(all[0]!.loopStatus, "pending");
  // Existing top-level status is preserved.
  assert.equal(all[0]!.status, "in_progress");
});

test("goals: canTransition accepts every legal edge", () => {
  const legal: Array<[GoalState, GoalState]> = [
    ["pending", "planning"],
    ["planning", "executing"],
    ["executing", "evaluating"],
    ["evaluating", "re-planning"],
    ["evaluating", "done"],
    ["re-planning", "planning"],
    ["re-planning", "executing"],
    ["pending", "paused"],
    ["planning", "paused"],
    ["executing", "paused"],
    ["evaluating", "paused"],
    ["re-planning", "paused"],
    ["paused", "executing"],
    ["paused", "planning"],
    ["pending", "failed"],
    ["evaluating", "failed"],
  ];
  for (const [from, to] of legal) {
    assert.doesNotThrow(() => canTransition(from, to), `${from} → ${to} should be legal`);
    assert.equal(canTransition(from, to), true);
  }
});

test("goals: canTransition rejects illegal edges with GoalTransitionError", () => {
  // pending → evaluating: skip planning + executing
  assert.throws(() => canTransition("pending", "evaluating"), (e: Error) => {
    assert.ok(e instanceof GoalTransitionError);
    assert.equal((e as GoalTransitionError).from, "pending");
    assert.equal((e as GoalTransitionError).to, "evaluating");
    return true;
  });
  // done has no outgoing edges; can't go from done to executing
  assert.throws(() => canTransition("done", "executing"), GoalTransitionError);
  // paused can't go directly to done (must go through evaluating first)
  assert.throws(() => canTransition("paused", "done"), GoalTransitionError);
});

test("goals: checkTransition is the non-throwing variant", () => {
  const ok = checkTransition("pending", "planning");
  assert.deepEqual(ok, { ok: true });
  const bad = checkTransition("pending", "done");
  assert.equal(bad.ok, false);
  assert.match((bad as { ok: false; reason: string }).reason, /illegal transition/);
});

test("goals: same-state transition is a no-op (allowed)", () => {
  assert.doesNotThrow(() => canTransition("pending", "pending"));
  assert.equal(canTransition("executing", "executing"), true);
});

test("goals: GOAL_STATES enum matches the spike spec", () => {
  assert.deepEqual(
    [...GOAL_STATES].sort(),
    ["done", "evaluating", "executing", "failed", "paused", "pending", "planning", "re-planning"],
  );
  assert.equal(TERMINAL_GOAL_STATES.has("done"), true);
  assert.equal(TERMINAL_GOAL_STATES.has("failed"), true);
  assert.equal(TERMINAL_GOAL_STATES.has("paused"), false);
});

test("goals: lifecycle hooks fire on transition", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-hooks.json");
  const s = new GoalStore({ file });
  const entered: string[] = [];
  const exited: string[] = [];
  s.subscribe({
    onEnter: (state, g) => entered.push(state + ":" + g.id),
    onExit: (state, g) => exited.push(state + ":" + g.id),
  });
  const rec = s.add({ objective: "hooked", maxSteps: 3 });
  // add() fires onEnter for "pending"
  assert.deepEqual(entered, ["pending:" + rec.id]);
  // transition through the legal path
  s.transition(rec.id, "planning");
  s.transition(rec.id, "executing");
  s.transition(rec.id, "evaluating");
  s.transition(rec.id, "done");
  assert.deepEqual(exited, ["pending:" + rec.id, "planning:" + rec.id, "executing:" + rec.id, "evaluating:" + rec.id]);
  assert.deepEqual(entered, ["pending:" + rec.id, "planning:" + rec.id, "executing:" + rec.id, "evaluating:" + rec.id, "done:" + rec.id]);
});

test("goals: subscribe returns an unsubscribe function", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-unsub.json");
  const s = new GoalStore({ file });
  let count = 0;
  const off = s.subscribe({ onEnter: () => { count += 1; } });
  s.add({ objective: "a", maxSteps: 1 });
  off();
  s.add({ objective: "b", maxSteps: 1 });
  assert.equal(count, 1, "hook should fire only before unsubscribe");
});

test("goals: a buggy hook does not break the store", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-buggy-hook.json");
  const s = new GoalStore({ file });
  s.subscribe({ onEnter: () => { throw new Error("intentional"); } });
  // Should not throw — store logs and continues.
  const rec = s.add({ objective: "survives", maxSteps: 1 });
  s.transition(rec.id, "planning");
  // Confirm the transition was persisted.
  const got = new GoalStore({ file }).get(rec.id);
  assert.equal(got?.loopStatus, "planning");
});

test("goals: spawnSubgoal creates a child with parent linkage persisted", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-spawn.json");
  const s = new GoalStore({ file });
  const parent = s.add({ objective: "build auth", maxSteps: 4, model: "m", providerId: "p" });
  const child = s.spawnSubgoal(parent.id, { objective: "implement /login" });
  assert.ok(child, "spawnSubgoal should return the new record");
  assert.equal(child!.parentGoalId, parent.id);
  assert.equal(child!.status, "pending");
  // Children inherit model + provider + maxSteps.
  assert.equal(child!.model, "m");
  assert.equal(child!.providerId, "p");
  assert.equal(child!.maxSteps, 4);
  // listChildren surfaces the child.
  const children = s.listChildren(parent.id);
  assert.equal(children.length, 1);
  assert.equal(children[0]!.id, child!.id);
  // Persists across reload.
  const s2 = new GoalStore({ file });
  const reloadedChild = s2.get(child!.id);
  assert.equal(reloadedChild?.parentGoalId, parent.id);
});

test("goals: spawnSubgoal returns null when parent is unknown", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-spawn-orphan.json");
  const s = new GoalStore({ file });
  const child = s.spawnSubgoal("goal-doesnt-exist", { objective: "orphan" });
  assert.equal(child, null);
});

test("goals: pause records previousLoopStatus; resume returns to it", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-pause.json");
  const s = new GoalStore({ file });
  const rec = s.add({ objective: "p", maxSteps: 3 });
  s.transition(rec.id, "planning");
  s.transition(rec.id, "executing");
  // Pause from executing.
  const paused = s.pause(rec.id);
  assert.equal(paused?.loopStatus, "paused");
  assert.equal(paused?.previousLoopStatus, "executing");
  // Round-trip through disk.
  const s2 = new GoalStore({ file });
  assert.equal(s2.get(rec.id)?.loopStatus, "paused");
  // Resume.
  const resumed = s2.resume(rec.id);
  assert.equal(resumed?.loopStatus, "executing");
  assert.equal(resumed?.previousLoopStatus, undefined);
});

test("goals: pause from a terminal state throws GoalTransitionError", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-pause-terminal.json");
  const s = new GoalStore({ file });
  const rec = s.add({ objective: "p", maxSteps: 3 });
  s.transition(rec.id, "planning");
  s.transition(rec.id, "executing");
  s.transition(rec.id, "evaluating");
  s.transition(rec.id, "done");
  assert.throws(() => s.pause(rec.id), GoalTransitionError);
});

test("goals: revert rolls a terminal goal back to a non-terminal state", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-revert.json");
  const s = new GoalStore({ file });
  const rec = s.add({ objective: "r", maxSteps: 3 });
  s.transition(rec.id, "planning");
  s.transition(rec.id, "executing");
  s.transition(rec.id, "evaluating");
  s.transition(rec.id, "done");
  // Revert to executing.
  const reverted = s.revert(rec.id, "executing");
  assert.equal(reverted?.loopStatus, "executing");
  assert.equal(reverted?.currentIteration, 0);
  // Persists.
  const s2 = new GoalStore({ file });
  assert.equal(s2.get(rec.id)?.loopStatus, "executing");
});

test("goals: evaluate() is a pass when status is complete and there are no criteria", () => {
  const goal: GoalRecord = {
    id: "g1",
    objective: "x",
    status: "complete",
    loopStatus: "done",
    createdAt: 0,
    updatedAt: 0,
    maxSteps: 1,
    stepsTaken: 1,
  };
  const r = evaluate(goal);
  assert.equal(r.passed, true);
  assert.equal(r.score, 100);
});

test("goals: evaluate() scores against successCriteria keyword hits", () => {
  const goal: GoalRecord = {
    id: "g1",
    objective: "x",
    status: "complete",
    loopStatus: "done",
    createdAt: 0,
    updatedAt: 0,
    maxSteps: 1,
    stepsTaken: 1,
    finalText: "implemented the dashboard and added tests",
    successCriteria: { deliverables: ["dashboard", "tests", "deployment"] },
  };
  const r = evaluate(goal);
  assert.equal(r.score, 67); // 2 of 3 hits = 67
  assert.equal(r.passed, false); // below 70
  assert.equal(r.criteria.filter((c) => c.hit).length, 2);
});

test("goals: evaluate() passes when >= 70% of criteria hit", () => {
  const goal: GoalRecord = {
    id: "g1",
    objective: "x",
    status: "complete",
    loopStatus: "done",
    createdAt: 0,
    updatedAt: 0,
    maxSteps: 1,
    stepsTaken: 1,
    finalText: "dashboard tests deployment",
    successCriteria: { deliverables: ["dashboard", "tests", "deployment"] },
  };
  const r = evaluate(goal);
  assert.equal(r.passed, true);
  assert.equal(r.score, 100);
});

test("goals: runGoalStateMachine completes a full lifecycle with a stateful stub", async () => {
  // Stub runAgent: call 1 (planning) returns a plan, call 2 (executing)
  // returns a finalText that mentions all success criteria → eval
  // returns passed=true → state machine transitions to "done".
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-driver.json");
  const store = new GoalStore({ file });
  const goal = store.add({
    objective: "ship X",
    maxSteps: 3,
    successCriteria: { deliverables: ["alpha", "beta"] },
  });

  let calls = 0;
  const states: GoalState[] = [];
  const stub: GoalRunAgentFn = async (phase) => {
    calls += 1;
    if (phase === "planning") {
      return { content: "1. do alpha\n2. do beta", steps: 1 };
    }
    // executing
    return { content: "I did alpha and beta — both shipped", steps: 1 };
  };

  const final = await runGoalStateMachine(goal, {
    store,
    runAgent: stub,
    maxIterations: 3,
    onStateChange: (s) => states.push(s),
  });

  assert.equal(final.loopStatus, "done");
  assert.equal(final.status, "complete");
  assert.equal(calls, 2, "stub should be called once for planning, once for executing");
  // Verify the lifecycle: pending → planning → executing → evaluating → done.
  // (We filter to only the loop-machine states the driver actually sets.)
  assert.ok(states.includes("planning"));
  assert.ok(states.includes("executing"));
  assert.ok(states.includes("evaluating"));
  assert.ok(states.includes("done"));
  // An evaluation should be recorded.
  assert.ok(final.evaluations && final.evaluations.length >= 1);
  assert.equal(final.evaluations![0]!.passed, true);
  assert.equal(final.evaluations![0]!.score, 100);
});

test("goals: runGoalStateMachine fails after max iterations when criteria are never met", async () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-driver-fail.json");
  const store = new GoalStore({ file });
  const goal = store.add({
    objective: "no way to win",
    maxSteps: 2,
    successCriteria: { deliverables: ["never-going-to-find-this-keyword"] },
  });

  const stub: GoalRunAgentFn = async (phase) => {
    if (phase === "planning") return { content: "plan", steps: 1 };
    return { content: "no mention of the criterion", steps: 1 };
  };

  const final = await runGoalStateMachine(goal, {
    store,
    runAgent: stub,
    maxIterations: 2,
  });

  assert.equal(final.loopStatus, "failed");
  assert.equal(final.status, "failed");
  // 2 iterations × 2 calls (planning + executing) = 4.
  // Each iteration records one evaluation.
  assert.equal(final.evaluations?.length, 2);
  for (const e of final.evaluations!) {
    assert.equal(e.passed, false);
  }
});

test("goals: runGoalStateMachine short-circuits on GOAL COMPLETE", async () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-driver-complete.json");
  const store = new GoalStore({ file });
  const goal = store.add({ objective: "agent self-terminates", maxSteps: 3 });

  const stub: GoalRunAgentFn = async (phase) => {
    if (phase === "planning") return { content: "ok", steps: 1 };
    return { content: "all done — GOAL COMPLETE", steps: 1 };
  };

  const final = await runGoalStateMachine(goal, {
    store,
    runAgent: stub,
    maxIterations: 3,
  });

  assert.equal(final.loopStatus, "done");
  assert.equal(final.status, "complete");
});

test("goals: runGoalStateMachine handles GOAL BLOCKED → failed", async () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-driver-blocked.json");
  const store = new GoalStore({ file });
  const goal = store.add({ objective: "blocked", maxSteps: 3 });

  const stub: GoalRunAgentFn = async (phase) => {
    if (phase === "planning") return { content: "ok", steps: 1 };
    return { content: "I cannot — GOAL BLOCKED: missing dep", steps: 1 };
  };

  const final = await runGoalStateMachine(goal, {
    store,
    runAgent: stub,
    maxIterations: 3,
  });

  assert.equal(final.loopStatus, "failed");
  assert.equal(final.status, "failed");
});

test("goals: runGoalStateMachine reaches re-planning on failed evaluation", async () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "goals-driver-replan.json");
  const store = new GoalStore({ file });
  const goal = store.add({
    objective: "iterate until done",
    maxSteps: 3,
    successCriteria: { deliverables: ["magic-phrase-xyzzy"] },
  });

  let planningCalls = 0;
  let execCalls = 0;
  // The semantic identical-replan guard (see
  // `goals-semantic-replan.test.ts`) fires when two consecutive
  // plans normalize to the same form. To exercise the re-planning
  // path on a *failed evaluation* — the original intent of this
  // test — the stub must produce a different plan each iteration.
  const PLANS = ["initial plan", "revised plan with new angle"];
  const stub: GoalRunAgentFn = async (phase) => {
    if (phase === "planning") {
      planningCalls += 1;
      return { content: PLANS[planningCalls - 1]!, steps: 1 };
    }
    execCalls += 1;
    // First execution: no magic phrase. Second execution: has it.
    if (execCalls === 1) return { content: "first attempt — nothing here", steps: 1 };
    return { content: "second attempt — magic-phrase-xyzzy delivered", steps: 1 };
  };

  const states: GoalState[] = [];
  const final = await runGoalStateMachine(goal, {
    store,
    runAgent: stub,
    maxIterations: 3,
    onStateChange: (s) => states.push(s),
  });

  assert.equal(final.loopStatus, "done");
  assert.equal(planningCalls, 2, "should re-plan after first failed evaluation");
  assert.ok(states.includes("re-planning"), "should hit re-planning state");
  assert.equal(final.evaluations?.length, 2);
});
