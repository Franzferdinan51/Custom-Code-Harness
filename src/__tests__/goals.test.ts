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

import { GoalStore, TERMINAL_GOAL_STATUSES, formatGoalLine, type GoalRecord } from "../agent/goals.js";

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
