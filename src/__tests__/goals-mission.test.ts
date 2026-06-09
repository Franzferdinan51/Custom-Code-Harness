// Tests for the multi-mission + goals/ directory split
// (src/agent/goals.ts). The headline scenarios:
//
//   1. Multi-mission: two stores for two missions see two
//      different files and don't share records.
//   2. New records stamped with the active mission.
//   3. The mission field round-trips through disk.
//   4. Legacy v1/v2 single-file migration: a $CH_HOME/goals.json
//      gets auto-moved to $CH_HOME/goals/legacy/state.json on
//      first access via a default-mission GoalStore.
//   5. The default mission starts empty (no records leak from
//      the migration).
//   6. The `<direct>` test escape hatch (`{ file: ... }`) bypasses
//      per-mission resolution AND the migration.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODINGHARNESS_HOME = mkdtempSync(join(tmpdir(), "ch-goals-mission-test-"));
process.env.NO_COLOR = "1";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "goals"]) {
  mkdirSync(join(process.env.CODINGHARNESS_HOME, sub), { recursive: true });
}

import {
  GoalStore,
  DEFAULT_MISSION,
  LEGACY_MISSION,
  type GoalRecord,
} from "../agent/goals.js";
import { paths } from "../config/paths.js";

// ---------- 1. Multi-mission isolation ----------

test("mission: two stores for two missions see two different files", () => {
  const a = new GoalStore({ mission: "alpha" });
  const b = new GoalStore({ mission: "beta" });
  assert.equal(a.mission, "alpha");
  assert.equal(b.mission, "beta");
  assert.notEqual(a.file, b.file);
  assert.equal(a.file, paths.goalsMissionFile("alpha"));
  assert.equal(b.file, paths.goalsMissionFile("beta"));
});

test("mission: goals in mission A are hidden from mission B and vice versa", () => {
  const a = new GoalStore({ mission: "A" });
  const b = new GoalStore({ mission: "B" });
  a.add({ objective: "alpha-1", maxSteps: 4 });
  a.add({ objective: "alpha-2", maxSteps: 4 });
  b.add({ objective: "beta-1", maxSteps: 4 });
  // Cross-read: a fresh store for each mission sees only its own.
  const a2 = new GoalStore({ mission: "A" });
  const b2 = new GoalStore({ mission: "B" });
  assert.equal(a2.list().length, 2);
  assert.equal(b2.list().length, 1);
  assert.ok(a2.list().every((g) => g.mission === "A"));
  assert.ok(b2.list().every((g) => g.mission === "B"));
});

test("mission: switching to mission B starts fresh (no A records leak)", () => {
  // Fresh home so this test isn't affected by records in other tests'
  // missions on the shared $CH_HOME.
  const home = mkdtempSync(join(tmpdir(), "ch-mission-fresh-"));
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "goals"]) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  const prevHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    new GoalStore({ mission: "A" }).add({ objective: "ghost", maxSteps: 2 });
    const b = new GoalStore({ mission: "B" });
    assert.equal(b.list().length, 0, "mission B starts empty even after A had goals");
  } finally {
    process.env.CODINGHARNESS_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- 2. New records stamped with the active mission ----------

test("mission: new records carry the active mission field", () => {
  const s = new GoalStore({ mission: "stamped" });
  const rec = s.add({ objective: "x", maxSteps: 1 });
  assert.equal(rec.mission, "stamped");
  // Reload from disk and confirm the stamp survives.
  const s2 = new GoalStore({ mission: "stamped" });
  const got = s2.get(rec.id);
  assert.ok(got, "record persisted");
  assert.equal(got!.mission, "stamped");
});

// ---------- 3. The default mission is `default` ----------

test("mission: default constructor uses DEFAULT_MISSION (\"default\")", () => {
  const s = new GoalStore();
  assert.equal(s.mission, DEFAULT_MISSION);
  assert.equal(s.mission, "default");
  assert.equal(s.file, paths.goalsMissionFile("default"));
});

test("mission: <direct> sentinel is set when constructed with explicit `file`", () => {
  const file = join(process.env.CODINGHARNESS_HOME!, "direct.json");
  const s = new GoalStore({ file });
  assert.equal(s.mission, "<direct>");
  assert.equal(s.file, file);
  // A new record has no `mission` stamp (test escape hatch).
  const rec = s.add({ objective: "test", maxSteps: 1 });
  assert.equal(rec.mission, undefined);
});

// ---------- 4. Legacy v1/v2 single-file migration ----------

test("legacy migration: $CH_HOME/goals.json moves to goals/legacy/state.json on first default-mission access", () => {
  // Set up a fresh home with a legacy single-file.
  const home = mkdtempSync(join(tmpdir(), "ch-legacy-"));
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "goals"]) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  const prevHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    // Pre-populate the legacy file with a v2 envelope holding one
    // record.
    const legacyFile = join(home, "goals.json");
    const legacyRec: GoalRecord = {
      id: "goal-legacy-1",
      objective: "ship v1",
      status: "complete",
      loopStatus: "done",
      createdAt: 1_000_000,
      updatedAt: 1_000_000,
      maxSteps: 8,
      stepsTaken: 8,
    };
    writeFileSync(legacyFile, JSON.stringify({ version: 2, goals: [legacyRec] }, null, 2), "utf-8");
    assert.ok(existsSync(legacyFile), "precondition: legacy file exists");

    // Construct a default-mission store — this triggers the migration.
    const s = new GoalStore();
    assert.equal(s.mission, "default");

    // After migration, the legacy file is gone.
    assert.ok(!existsSync(legacyFile), "legacy single file unlinked");
    // And the legacy mission's state file exists.
    const legacyMissionFile = paths.goalsMissionFile(LEGACY_MISSION);
    assert.ok(existsSync(legacyMissionFile), "legacy mission state file created");

    // The default mission starts empty.
    assert.equal(s.list().length, 0, "default mission starts empty after migration");

    // The legacy mission has the migrated record.
    const legacy = new GoalStore({ mission: LEGACY_MISSION });
    const list = legacy.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, "goal-legacy-1");
    assert.equal(list[0]!.mission, LEGACY_MISSION, "migrated record stamped with legacy mission");
  } finally {
    process.env.CODINGHARNESS_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy migration: does not fire for non-default missions", () => {
  // Set up a fresh home with a legacy file, but only construct a
  // non-default-mission store. The legacy file should remain
  // untouched so the user can still access it.
  const home = mkdtempSync(join(tmpdir(), "ch-legacy-no-mig-"));
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "goals"]) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  const prevHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const legacyFile = join(home, "goals.json");
    writeFileSync(legacyFile, JSON.stringify({ version: 2, goals: [] }, null, 2), "utf-8");

    // Construct a "side" mission — migration should NOT fire.
    const s = new GoalStore({ mission: "side" });
    assert.equal(s.mission, "side");
    assert.ok(existsSync(legacyFile), "legacy file preserved (migration only fires for default mission)");

    // Now construct a default-mission store — THIS fires the migration.
    const def = new GoalStore();
    assert.equal(def.mission, "default");
    assert.ok(!existsSync(legacyFile), "legacy file removed by the default-mission access");
  } finally {
    process.env.CODINGHARNESS_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy migration: does not clobber an existing legacy mission state file", () => {
  // If the user already has a "legacy" mission (manually created
  // or from a prior migration), the next default-mission access
  // should unlink the old single-file and NOT overwrite the
  // existing legacy mission data.
  const home = mkdtempSync(join(tmpdir(), "ch-legacy-existing-"));
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "goals"]) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  const prevHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    // Pre-populate the legacy mission's state file with one record.
    const legacyMissionFile = paths.goalsMissionFile(LEGACY_MISSION);
    mkdirSync(join(home, "goals", LEGACY_MISSION), { recursive: true });
    writeFileSync(legacyMissionFile, JSON.stringify({
      version: 2,
      goals: [{ id: "pre-existing", objective: "keep me", status: "complete", loopStatus: "done", createdAt: 1, updatedAt: 1, maxSteps: 1, stepsTaken: 1 }],
    }, null, 2), "utf-8");

    // Also drop a stale single-file legacy record (different from
    // the one in the legacy mission).
    const legacyFile = join(home, "goals.json");
    writeFileSync(legacyFile, JSON.stringify({
      version: 2,
      goals: [{ id: "stale", objective: "should not overwrite", status: "complete", loopStatus: "done", createdAt: 1, updatedAt: 1, maxSteps: 1, stepsTaken: 1 }],
    }, null, 2), "utf-8");

    new GoalStore(); // triggers migration
    assert.ok(!existsSync(legacyFile), "legacy file unlinked");

    // The pre-existing legacy record is preserved.
    const legacy = new GoalStore({ mission: LEGACY_MISSION });
    const list = legacy.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, "pre-existing", "existing legacy mission data preserved");
  } finally {
    process.env.CODINGHARNESS_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy migration: v1 records get backfilled loopStatus=pending and mission=legacy", () => {
  const home = mkdtempSync(join(tmpdir(), "ch-legacy-v1-"));
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "goals"]) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  const prevHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    // v1 envelope (no `version` field, no `loopStatus` on records).
    const legacyFile = join(home, "goals.json");
    writeFileSync(legacyFile, JSON.stringify({
      version: 1,
      goals: [{ id: "v1-1", objective: "old", status: "in_progress", createdAt: 1, updatedAt: 1, maxSteps: 4, stepsTaken: 1 }],
    }, null, 2), "utf-8");

    new GoalStore();
    const legacy = new GoalStore({ mission: LEGACY_MISSION });
    const list = legacy.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.loopStatus, "pending", "v1 record loopStatus backfilled");
    assert.equal(list[0]!.mission, LEGACY_MISSION, "v1 record stamped with legacy mission");
  } finally {
    process.env.CODINGHARNESS_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy migration: missing legacy file is a no-op (no error, no spurious files)", () => {
  // Just construct a default-mission store on a clean home — no
  // legacy file exists, so the migration helper short-circuits.
  const home = mkdtempSync(join(tmpdir(), "ch-legacy-clean-"));
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "goals"]) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  const prevHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const s = new GoalStore();
    assert.equal(s.list().length, 0);
    // The legacy mission's state file should NOT be created.
    assert.ok(!existsSync(paths.goalsMissionFile(LEGACY_MISSION)),
      "no legacy mission file created when there was no data to migrate");
  } finally {
    process.env.CODINGHARNESS_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- 5. <direct> test escape hatch ----------

test("<direct>: file-based store does NOT trigger migration", () => {
  const home = mkdtempSync(join(tmpdir(), "ch-direct-no-mig-"));
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "goals"]) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  const prevHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const legacyFile = join(home, "goals.json");
    writeFileSync(legacyFile, JSON.stringify({ version: 2, goals: [] }, null, 2), "utf-8");
    // The <direct> constructor should NOT unlink the legacy file.
    const file = join(home, "my-test.json");
    const s = new GoalStore({ file });
    s.add({ objective: "test", maxSteps: 1 });
    assert.ok(existsSync(legacyFile), "<direct> constructor skipped migration");
    assert.ok(existsSync(file));
  } finally {
    process.env.CODINGHARNESS_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- 6. Per-mission file structure is exactly goals/<mission>/state.json ----------

test("mission: file path is $CH_HOME/goals/<mission>/state.json", () => {
  const home = mkdtempSync(join(tmpdir(), "ch-mission-path-"));
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "goals"]) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  const prevHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const s = new GoalStore({ mission: "feature-x" });
    s.add({ objective: "x", maxSteps: 1 });
    const expected = join(home, "goals", "feature-x", "state.json");
    assert.equal(s.file, expected);
    assert.ok(existsSync(expected), "state file written to the right path");
    // Parent directory was created.
    assert.ok(existsSync(join(home, "goals", "feature-x")));
  } finally {
    process.env.CODINGHARNESS_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
