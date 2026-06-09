// Tests for the `ch goals revert <id> --to <n>` CLI command.
//
// Layered testing:
//   1. Direct unit tests of `GoalStore.revert(id, to, opts)` with a
//      stubbed goal record (the "stubbed GoalStore" the task
//      describes). Covers the new `targetIteration` option, the
//      default behavior, and the round-trip through disk.
//   2. End-to-end CLI test that spawns `ch goals revert` in a
//      subprocess against a pre-populated goals.json. Verifies the
//      argument parser, the default --to=1 behavior, and the
//      help-text update.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Set up an isolated CODINGHARNESS_HOME for direct unit tests.
const unitTmp = mkdtempSync(join(tmpdir(), "ch-goals-cli-unit-"));
process.env.CODINGHARNESS_HOME = unitTmp;
process.env.NO_COLOR = "1";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
  mkdirSync(join(unitTmp, sub), { recursive: true });
}

import { GoalStore, type GoalRecord } from "../agent/goals.js";

test.after(() => {
  try { rmSync(unitTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------- 1. Direct unit tests of GoalStore.revert() with stubbed records ----------

/** Build a GoalRecord in a known "done" terminal state for tests. */
function makeTerminalGoal(id: string, currentIteration: number): GoalRecord {
  return {
    id,
    objective: "ship the council feature",
    status: "complete",
    loopStatus: "done",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    maxSteps: 8,
    stepsTaken: currentIteration,
    currentIteration,
  };
}

test("goals-cli: revert(id, 'planning', { targetIteration: N }) resets the iteration to N", () => {
  // Stub: a single goal in a terminal "done" state with a known
  // currentIteration. The store's revert should move it to
  // "planning" and set currentIteration to the target.
  const file = join(unitTmp, "revert-iter.json");
  const s = new GoalStore({ file });
  const rec = s.add({ objective: "ship the council feature", maxSteps: 8 });
  // Walk the legal state path to reach a terminal "done" state.
  s.transition(rec.id, "planning");
  s.transition(rec.id, "executing");
  s.transition(rec.id, "evaluating");
  s.transition(rec.id, "done");
  s.update(rec.id, { currentIteration: 5 });

  // Act: revert to planning with targetIteration=2.
  const reverted = s.revert(rec.id, "planning", { targetIteration: 2 });
  assert.ok(reverted, "revert should return the updated record");
  assert.equal(reverted!.loopStatus, "planning");
  assert.equal(reverted!.currentIteration, 2, "currentIteration should be set to the target");
  assert.equal(reverted!.status, "in_progress", "status should reset to in_progress on a non-terminal revert");

  // Round-trip through disk.
  const s2 = new GoalStore({ file });
  const reloaded = s2.get(rec.id);
  assert.equal(reloaded?.loopStatus, "planning");
  assert.equal(reloaded?.currentIteration, 2);
});

test("goals-cli: revert() without targetIteration still defaults currentIteration to 0", () => {
  // Backward-compat regression: the new option must be OPTIONAL.
  // Existing callers that pass no opts should see the same
  // currentIteration=0 reset as before.
  const file = join(unitTmp, "revert-default.json");
  const s = new GoalStore({ file });
  const rec = s.add({ objective: "x", maxSteps: 4 });
  s.transition(rec.id, "planning");
  s.transition(rec.id, "executing");
  s.transition(rec.id, "evaluating");
  s.transition(rec.id, "done");
  s.update(rec.id, { currentIteration: 3 });

  const reverted = s.revert(rec.id, "planning");
  assert.equal(reverted?.currentIteration, 0);
});

test("goals-cli: revert(id, to) returns null for unknown id", () => {
  const file = join(unitTmp, "revert-unknown.json");
  const s = new GoalStore({ file });
  assert.equal(s.revert("goal-does-not-exist", "planning", { targetIteration: 2 }), null);
});

test("goals-cli: revert() with the same state and a target iteration is NOT a no-op", () => {
  // Edge case: caller is already at "planning" and reverts to
  // "planning" with a new targetIteration. The implementation
  // must NOT short-circuit (only short-circuits when both state
  // and targetIteration match). Otherwise the target iteration
  // would silently stay at its old value.
  const file = join(unitTmp, "revert-same-state.json");
  const s = new GoalStore({ file });
  const rec = s.add({ objective: "x", maxSteps: 4 });
  s.transition(rec.id, "planning");
  s.update(rec.id, { currentIteration: 7 });

  const reverted = s.revert(rec.id, "planning", { targetIteration: 2 });
  assert.ok(reverted);
  assert.equal(reverted!.loopStatus, "planning");
  assert.equal(reverted!.currentIteration, 2, "targetIteration must override even on same-state reverts");
});

// ---------- 2. End-to-end CLI tests (subprocess against an isolated goals.json) ----------

/** Run a `ch goals ...` subprocess with a fresh, isolated
 *  CODINGHARNESS_HOME. The CLI is invoked with `--mission legacy`
 *  so it reads from the per-mission state file that
 *  `seedGoalsJson` writes. Returns { stdout, stderr, status }. */
function runChGoals(home: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("bun", ["src/cli.ts", "goals", "--mission", "legacy", ...args], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: { ...process.env, CODINGHARNESS_HOME: home, NO_COLOR: "1" },
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? -1,
  };
}

/** Pre-seed an isolated `$CH_HOME/goals/legacy/state.json` with a
 *  known terminal goal. The path matches the per-mission layout
 *  from Q10 (post-migration) — `seedGoalsJson` writes the v2
 *  envelope directly to the file the CLI will read, so no
 *  migration is needed. The legacy mission's normalization pass
 *  in the GoalStore constructor stamps the goal with
 *  `mission: "legacy"`. */
function seedGoalsJson(home: string, goal: GoalRecord): string {
  const dir = join(home, "goals", "legacy");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "state.json");
  writeFileSync(file, JSON.stringify({ version: 2, goals: [goal] }, null, 2), "utf-8");
  return file;
}

test("goals-cli: `ch goals revert <id> --to 2` reverts a terminal goal to planning at iteration 2", () => {
  const home = mkdtempSync(join(tmpdir(), "ch-goals-cli-e2e-"));
  try {
    // Stub: a terminal "done" goal with currentIteration=5.
    const goal: GoalRecord = makeTerminalGoal("goal-cli-test-1", 5);
    const file = seedGoalsJson(home, goal);

    // Act: revert to iteration 2.
    const r = runChGoals(home, ["revert", "goal-cli-test-1", "--to", "2"]);
    assert.equal(r.status, 0, `revert should exit 0 — stderr was: ${r.stderr}`);
    assert.match(r.stdout, /reverted goal-cli-test-1 to iteration 2/);
    assert.match(r.stdout, /loopStatus=planning/);

    // The on-disk goal was actually updated: loopStatus="planning",
    // currentIteration=2, status="in_progress". The CLI's first
    // default-mission access migrated the seeded legacy file to
    // $CH_HOME/goals/legacy/state.json — read from there.
    const after = JSON.parse(readFileSync(join(home, "goals", "legacy", "state.json"), "utf-8")) as { goals: GoalRecord[] };
    assert.equal(after.goals.length, 1);
    assert.equal(after.goals[0]!.loopStatus, "planning");
    assert.equal(after.goals[0]!.currentIteration, 2);
    assert.equal(after.goals[0]!.status, "in_progress");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("goals-cli: `ch goals revert <id> --to=2` parses the equals form", () => {
  // The arg parser supports both `--to 2` and `--to=2`. This
  // test guards the equals form because it's the shape the user
  // often reaches for when scripting.
  const home = mkdtempSync(join(tmpdir(), "ch-goals-cli-equals-"));
  try {
    const goal: GoalRecord = makeTerminalGoal("goal-cli-equals", 4);
    const file = seedGoalsJson(home, goal);

    const r = runChGoals(home, ["revert", "goal-cli-equals", "--to=3"]);
    assert.equal(r.status, 0, `revert --to=3 should exit 0 — stderr: ${r.stderr}`);
    assert.match(r.stdout, /to iteration 3/);

    const after = JSON.parse(readFileSync(join(home, "goals", "legacy", "state.json"), "utf-8")) as { goals: GoalRecord[] };
    assert.equal(after.goals[0]!.currentIteration, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("goals-cli: `ch goals revert <id>` (no --to) defaults to iteration 1", () => {
  // Q4 default: "revert the last step" = --to 1.
  const home = mkdtempSync(join(tmpdir(), "ch-goals-cli-default-"));
  try {
    const goal: GoalRecord = makeTerminalGoal("goal-cli-default", 7);
    const file = seedGoalsJson(home, goal);

    const r = runChGoals(home, ["revert", "goal-cli-default"]);
    assert.equal(r.status, 0, `revert (no --to) should exit 0 — stderr: ${r.stderr}`);
    assert.match(r.stdout, /to iteration 1/);

    const after = JSON.parse(readFileSync(join(home, "goals", "legacy", "state.json"), "utf-8")) as { goals: GoalRecord[] };
    assert.equal(after.goals[0]!.currentIteration, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("goals-cli: `ch goals revert <id> --to 0` is rejected as a usage error", () => {
  // --to must be a positive integer. 0 is invalid.
  const home = mkdtempSync(join(tmpdir(), "ch-goals-cli-zero-"));
  try {
    seedGoalsJson(home, makeTerminalGoal("goal-cli-zero", 2));
    const r = runChGoals(home, ["revert", "goal-cli-zero", "--to", "0"]);
    assert.equal(r.status, 2, "--to 0 should be a usage error (exit 2)");
    assert.match(r.stderr, /--to must be a positive integer/);
    // File should be unchanged — no revert happened. After the
    // migration triggered by the CLI, the goal lives in the
    // "legacy" mission's state file, not the original single-file.
    const after = JSON.parse(readFileSync(join(home, "goals", "legacy", "state.json"), "utf-8")) as { goals: GoalRecord[] };
    assert.equal(after.goals[0]!.loopStatus, "done", "loopStatus should still be 'done' after a rejected revert");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("goals-cli: `ch goals revert <unknown-id>` is a runtime error (exit 1)", () => {
  const home = mkdtempSync(join(tmpdir(), "ch-goals-cli-unknown-"));
  try {
    // Seed a different goal so the store isn't empty.
    seedGoalsJson(home, makeTerminalGoal("goal-exists", 1));
    const r = runChGoals(home, ["revert", "goal-does-not-exist", "--to", "1"]);
    assert.equal(r.status, 1, "unknown id should be a runtime error (exit 1)");
    assert.match(r.stderr, /no such goal/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("goals-cli: `ch goals revert` without an id is a usage error (exit 2)", () => {
  const home = mkdtempSync(join(tmpdir(), "ch-goals-cli-no-id-"));
  try {
    const r = runChGoals(home, ["revert"]);
    assert.equal(r.status, 2, "missing id should be a usage error (exit 2)");
    assert.match(r.stderr, /usage: ch goals revert <id>/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("goals-cli: `ch goals revert <id> --json` emits the reverted record as JSON", () => {
  // The --json flag should make the command emit the full
  // reverted record so scripts can pipe the new state into
  // other tooling.
  const home = mkdtempSync(join(tmpdir(), "ch-goals-cli-json-"));
  try {
    seedGoalsJson(home, makeTerminalGoal("goal-cli-json", 3));
    const r = runChGoals(home, ["revert", "goal-cli-json", "--to", "2", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout) as GoalRecord;
    assert.equal(parsed.id, "goal-cli-json");
    assert.equal(parsed.loopStatus, "planning");
    assert.equal(parsed.currentIteration, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("goals-cli: help text mentions the revert subcommand", () => {
  // The goals subcommand's usage line and description should
  // surface `revert` so users discover it from `ch help goals`.
  const r = spawnSync("bun", ["src/cli.ts", "help", "goals"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /revert/);
  assert.match(r.stdout, /--to/);
  // And the high-level `ch help` should still mention "goals" as
  // a subcommand (regression — we didn't accidentally remove it
  // from the registry).
  const help = spawnSync("bun", ["src/cli.ts", "help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\bgoals\b/);
});

test("goals-cli: ensure baseline setup actually seeded the file (test isolation sanity)", () => {
  // Cheap invariant: the seedGoalsJson helper above writes a
  // v2 envelope. This test guards against a regression where
  // the seed helper changes shape in a way that breaks the
  // other tests' parsing.
  const home = mkdtempSync(join(tmpdir(), "ch-goals-cli-sanity-"));
  try {
    const file = seedGoalsJson(home, makeTerminalGoal("goal-sanity", 1));
    assert.ok(existsSync(file));
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { version: number; goals: GoalRecord[] };
    assert.equal(parsed.version, 2);
    assert.equal(parsed.goals.length, 1);
    assert.equal(parsed.goals[0]!.id, "goal-sanity");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
