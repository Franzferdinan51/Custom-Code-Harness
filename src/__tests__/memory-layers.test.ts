// Tests for the 3-layer memory store (src/agent/memory-layers.ts)
// and the v1-compatible MemoryStore (src/agent/memory.ts).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test gets its own temp CH_HOME so they don't share state.
function makeTmp(): string {
  const t = mkdtempSync(join(tmpdir(), "ch-mem-"));
  process.env.CODINGHARNESS_HOME = t;
  process.env.NO_COLOR = "1";
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
    mkdirSync(join(t, sub), { recursive: true });
  }
  return t;
}

// IMPORTANT: import AFTER setting CODINGHARNESS_HOME so the
// `paths` getters resolve into the temp dir.
import { MemoryStore } from "../agent/memory.js";
import {
  MemoryLayerStore,
  LESSONS_HEADER,
  lessonFingerprint,
} from "../agent/memory-layers.js";

// ---- raw notes / round-trip ----

test("raw append + read round-trip preserves the appended text", async () => {
  const tmp = makeTmp();
  try {
    const mem = new MemoryStore();
    await mem.append("user prefers dark mode");
    await mem.append("project uses bun");
    const text = mem.read();
    assert.match(text, /dark mode/);
    assert.match(text, /project uses bun/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("raw append writes a timestamped bullet to MEMORY.md", async () => {
  const tmp = makeTmp();
  try {
    const mem = new MemoryStore();
    await mem.append("hello world");
    const file = join(tmp, "memory", "MEMORY.md");
    const body = readFileSync(file, "utf-8");
    assert.match(body, /^# Memory/m);
    // Matches `YYYY-MM-DD HH:MM:SS — hello world` (ISO slice(0,19) format).
    assert.match(body, /-\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+—\s+hello world/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- BM25 search ----

test("search returns ranked results with the 'note:' prefix", async () => {
  const tmp = makeTmp();
  try {
    const store = new MemoryLayerStore();
    // Bootstrap a lesson so the file is no longer in legacy mode.
    await store.appendLesson("seed lesson (just to flip into BM25 mode)");
    await store.append("rust borrow checker fights are common");
    await store.append("javascript async await is fine");
    await store.append("rust lifetimes confuse everyone");
    const found = await store.search("rust");
    assert.ok(found.length > 0, "expected BM25 hits for 'rust'");
    // Two of the three notes contain "rust" — both should appear.
    const matches = found.split("\n").filter((l) => l.includes("rust"));
    assert.ok(matches.length >= 2, `expected ≥2 rust hits, got ${matches.length}`);
    // The prefix should be present.
    assert.match(found, /note:/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("search uses BM25 ordering — doc with more matches ranks first", async () => {
  const tmp = makeTmp();
  try {
    const store = new MemoryLayerStore();
    // Bootstrap lessons mode.
    await store.appendLesson("seed lesson to flip into BM25 mode");
    await store.append("api error rate spiked");
    await store.append("api rate limit hit while calling the api");
    await store.append("database failover succeeded");
    const found = await store.search("api rate");
    const lines = found.split("\n");
    // First hit should be the one with the most "api" and "rate" terms.
    assert.ok(lines[0]!.includes("api rate limit"), `first hit should be the dense match, got: ${lines[0]}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- lessons ----

test("appendLesson writes to the LESSONS section with [iso] prefix", async () => {
  const tmp = makeTmp();
  try {
    const store = new MemoryLayerStore();
    const id = await store.appendLesson("always read the README before refactoring");
    assert.ok(id.startsWith("L"), "lesson id should be hashFingerprint-shaped");
    const file = join(tmp, "memory", "MEMORY.md");
    const body = readFileSync(file, "utf-8");
    assert.match(body, /## LESSONS/);
    assert.match(body, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(body, /always read the README before refactoring/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("appendLesson dedupes on case-folded, whitespace-collapsed fingerprint", async () => {
  const tmp = makeTmp();
  try {
    const store = new MemoryLayerStore();
    const a = await store.appendLesson("Always read the README before refactoring");
    const b = await store.appendLesson("  always   read   the   readme   before   refactoring  ");
    const c = await store.appendLesson("ALWAYS READ THE README BEFORE REFACTORING");
    assert.equal(a, b, "whitespace differences should still dedupe");
    assert.equal(b, c, "case differences should still dedupe");
    const file = join(tmp, "memory", "MEMORY.md");
    const body = readFileSync(file, "utf-8");
    // The lesson body should appear exactly once.
    const matches = body.match(/always read the readme before refactoring/gi);
    assert.ok(matches && matches.length === 1, `expected 1 lesson body, got ${matches?.length}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("appendLesson preserves existing entries when adding a new one", async () => {
  const tmp = makeTmp();
  try {
    const store = new MemoryLayerStore();
    await store.appendLesson("lesson one");
    await store.appendLesson("lesson two");
    await store.appendLesson("lesson three");
    const file = join(tmp, "memory", "MEMORY.md");
    const body = readFileSync(file, "utf-8");
    assert.match(body, /lesson one/);
    assert.match(body, /lesson two/);
    assert.match(body, /lesson three/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("search across layers labels lessons with 'lesson:' prefix", async () => {
  const tmp = makeTmp();
  try {
    const store = new MemoryLayerStore();
    await store.append("ran into a tokio mpsc send error");
    await store.appendLesson("tokio mpsc::Sender::send returns Err on closed channel");
    const found = await store.search("tokio mpsc");
    assert.match(found, /note: /);
    assert.match(found, /lesson: /);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- promotion ----

test("promoteToLesson moves matching raw notes into LESSONS", async () => {
  const tmp = makeTmp();
  try {
    const store = new MemoryLayerStore();
    await store.appendLesson("seed lesson so the section exists");
    await store.append("github cli workflow: gh pr create --fill");
    await store.append("deploying with kubectl apply -f manifest.yaml");
    await store.append("github actions cache speeds up ci runs");
    const moved = await store.promoteToLesson(/github/);
    assert.equal(moved, 2, `expected 2 promotions, got ${moved}`);
    const file = join(tmp, "memory", "MEMORY.md");
    const body = readFileSync(file, "utf-8");
    // The two github lines should no longer be in the raw block.
    const aboveLessons = body.split(LESSONS_HEADER)[0] ?? "";
    assert.ok(!aboveLessons.includes("github cli workflow"), "raw block should not still contain the first line");
    assert.ok(!aboveLessons.includes("github actions cache"), "raw block should not still contain the second line");
    // But the kubectl line should still be there.
    assert.match(aboveLessons, /kubectl/);
    // The lessons block should now contain the github bodies.
    const lessonsPart = body.split(LESSONS_HEADER)[1] ?? "";
    assert.match(lessonsPart, /github cli workflow/);
    assert.match(lessonsPart, /github actions cache/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("promoteToLesson dedupes — moving the same body twice creates one lesson", async () => {
  const tmp = makeTmp();
  try {
    const store = new MemoryLayerStore();
    // Seed lesson first so the section exists, with the same body the
    // raw line will be promoted to.
    await store.appendLesson("the quick brown fox jumps");
    // Add a raw note that, after stripping the timestamp, has the
    // same body. The fingerprint should match.
    await store.append("the quick brown fox jumps");
    const moved = await store.promoteToLesson(/quick brown fox/);
    assert.equal(moved, 1, "raw line should be removed");
    const file = join(tmp, "memory", "MEMORY.md");
    const body = readFileSync(file, "utf-8");
    const lessonsPart = body.split(LESSONS_HEADER)[1] ?? "";
    // The lesson body should appear exactly once.
    const matches = lessonsPart.match(/the quick brown fox jumps/g) ?? [];
    assert.equal(matches.length, 1, `expected 1 lesson body, got ${matches.length}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- legacy fallback ----

test("isLegacy returns true when MEMORY.md has no ## LESSONS section", () => {
  const tmp = makeTmp();
  try {
    // Bootstrap a v1-style file by hand.
    const file = join(tmp, "memory", "MEMORY.md");
    writeFileSync(file, "# Memory\n\nlegacy content here\n", "utf-8");
    const store = new MemoryLayerStore();
    assert.equal(store.isLegacy(), true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("legacy search falls back to substring match (no crash, no data loss)", async () => {
  const tmp = makeTmp();
  try {
    const file = join(tmp, "memory", "MEMORY.md");
    writeFileSync(file,
      "# Memory\n\nPersistent notes.\n\n- 2026-01-01 00:00 — dark mode preferred\n- 2026-01-02 00:00 — uses bun runtime\n",
      "utf-8");
    const store = new MemoryLayerStore();
    assert.equal(store.isLegacy(), true);
    const found = await store.search("dark");
    assert.match(found, /dark mode preferred/);
    // The line number prefix should be present (v1 shape).
    assert.match(found, /^\s*\d+\s+/m);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("legacy file's raw notes are preserved when lessons are bootstrapped", async () => {
  const tmp = makeTmp();
  try {
    const file = join(tmp, "memory", "MEMORY.md");
    const before = "# Memory\n\nPersistent notes.\n\n- 2026-01-01 00:00 — original note\n";
    writeFileSync(file, before, "utf-8");
    const store = new MemoryLayerStore();
    await store.appendLesson("first curated lesson");
    const after = readFileSync(file, "utf-8");
    assert.match(after, /original note/, "legacy notes must survive");
    assert.match(after, /## LESSONS/);
    assert.match(after, /first curated lesson/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- user file ----

test("readUser/appendUser leaves USER.md untouched by the layer refactor", async () => {
  const tmp = makeTmp();
  try {
    const mem = new MemoryStore();
    await mem.appendUser("name: Ryan");
    await mem.appendUser("role: heavy builder");
    const text = mem.readUser();
    assert.match(text, /name: Ryan/);
    assert.match(text, /role: heavy builder/);
    // USER.md must not contain a LESSONS section — it has its own schema.
    const file = join(tmp, "memory", "USER.md");
    const body = readFileSync(file, "utf-8");
    assert.ok(!body.includes(LESSONS_HEADER), "USER.md should not get a LESSONS section");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- fingerprint helper ----

test("lessonFingerprint is case- and whitespace-insensitive", () => {
  assert.equal(
    lessonFingerprint("Always Read the README"),
    lessonFingerprint("always   read  the readme")
  );
  assert.equal(
    lessonFingerprint("Hello, World!"),
    lessonFingerprint("  hello world  ")
  );
  // And stable for the same input.
  assert.equal(lessonFingerprint("x"), lessonFingerprint("x"));
});

// ---- v1 API compatibility ----

test("v1 MemoryStore.search still returns v1-shaped results in legacy mode", async () => {
  const tmp = makeTmp();
  try {
    const file = join(tmp, "memory", "MEMORY.md");
    writeFileSync(file, "# Memory\n\n- 2026-01-01 00:00 — bun is fast\n", "utf-8");
    const mem = new MemoryStore();
    const found = await mem.search("bun");
    // v1 shape: line-numbered, no `note:` prefix in legacy mode.
    assert.match(found, /\d+\s+-\s+\d{4}/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("ALL OK", () => {
  // No-op teardown; individual tests own their tmpdir.
});
