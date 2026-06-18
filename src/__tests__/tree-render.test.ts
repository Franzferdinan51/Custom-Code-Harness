// Tests for the session-tree renderer (v0.2.2).
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ch-tree-"));
process.env.CODINGHARNESS_HOME = tmp;
process.env.NO_COLOR = "1";

import { mkdirSync as _mkdirSync } from "node:fs";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
  _mkdirSync(join(tmp, sub), { recursive: true });
}

import { Session } from "../agent/session.js";
import { renderSessionTree } from "../slash/tree-render.js";

function fresh(): string { return mkdtempSync(join(tmpdir(), "ch-tree-")); }

test("tree: empty session renders as '(empty)'", async () => {
  const cwd = fresh();
  try {
    const s = await Session.create({ cwd, name: "empty" });
    const out = renderSessionTree(s.allEntries(), "");
    assert.equal(out, "(empty)");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("tree: linear session renders as └─ with markers", async () => {
  const cwd = fresh();
  try {
    const s = await Session.create({ cwd, name: "linear" });
    const u1 = await s.append({ kind: "message", message: { role: "user", content: "first prompt" } });
    const a1 = await s.append({ kind: "message", message: { role: "assistant", content: "first reply" } });
    const u2 = await s.append({ kind: "message", message: { role: "user", content: "second prompt" } });
    await s.append({ kind: "message", message: { role: "assistant", content: "second reply" } });
    // We need a head — set it to the last entry.
    s.meta.head = u2.id;
    const out = renderSessionTree(s.allEntries(), u2.id);
    // Should contain a "●" marker on the head.
    assert.match(out, /● /);
    // Should mention each user prompt.
    assert.match(out, /first prompt/);
    assert.match(out, /second prompt/);
    // Tree chars.
    assert.match(out, /[├└]─/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("tree: forked session shows the active branch with → and inactive with whitespace", async () => {
  const cwd = fresh();
  try {
    const s = await Session.create({ cwd, name: "forked" });
    const u1 = await s.append({ kind: "message", message: { role: "user", content: "shared" } });
    const a1 = await s.append({ kind: "message", message: { role: "assistant", content: "shared-reply" } });
    // Fork from a1.
    const child = await s.fork(a1.id);
    // Append a divergent message in the child.
    const div = await child.append({ kind: "message", message: { role: "user", content: "divergent path" } });
    const entries = child.allEntries();
    const out = renderSessionTree(entries, div.id);
    // The head should be marked with ●.
    assert.match(out, /● /);
    // The active linear path should have → for ancestors.
    assert.match(out, /→ /);
    // The divergent path should appear.
    assert.match(out, /divergent path/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("tree: tool results show as ✓/✗ with display", async () => {
  const cwd = fresh();
  try {
    const s = await Session.create({ cwd, name: "tools" });
    await s.append({ kind: "message", message: { role: "user", content: "run something" } });
    const tc = await s.append({ kind: "tool_result", toolCallId: "tc1", toolName: "bash", result: { toolCallId: "tc1", display: "exit 0", content: "ok", isError: false } });
    s.meta.head = tc.id;
    const out = renderSessionTree(s.allEntries(), tc.id);
    assert.match(out, /✓/);
    assert.match(out, /exit 0/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("tree: --depth=0 caps walk at the root and reports the omitted descendants", async () => {
  // Build a 3-level linear tree (root + 2 children). With
  // depth=0 we should see ONLY the root line + a "(… N more below)"
  // leaf, never the descendants themselves.
  const cwd = fresh();
  try {
    const s = await Session.create({ cwd, name: "deep" });
    const r = await s.append({ kind: "message", message: { role: "user", content: "root" } });
    const a1 = await s.append({ kind: "message", message: { role: "assistant", content: "child-1" } });
    await s.append({ kind: "message", message: { role: "user", content: "child-2" } });
    s.meta.head = a1.id;
    const out = renderSessionTree(s.allEntries(), a1.id, { depth: 0 });
    // The root label must be present…
    assert.match(out, /root/);
    // …but the descendant labels MUST NOT.
    assert.doesNotMatch(out, /child-1/);
    assert.doesNotMatch(out, /child-2/);
    // The "(… N more below)" hint must mention the omitted count
    // and tell the user how to expand.
    assert.match(out, /2 more below/);
    assert.match(out, /--depth=1/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("tree: --limit truncates the output and appends a footer", async () => {
  // 6-entry linear session. With limit=3 we expect exactly 3
  // tree lines + a 1-line footer pointing at --depth / --limit.
  const cwd = fresh();
  try {
    const s = await Session.create({ cwd, name: "limit" });
    for (let i = 0; i < 6; i++) {
      await s.append({ kind: "message", message: { role: i % 2 === 0 ? "user" : "assistant", content: "msg-" + i } });
    }
    const out = renderSessionTree(s.allEntries(), "", { limit: 3 });
    const lines = out.split("\n");
    // 3 tree lines + 1 footer.
    assert.equal(lines.length, 4);
    assert.match(out, /\(truncated at 3 lines/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("tree: --limit larger than the tree is a no-op", async () => {
  // 3-entry session, limit=100. Output should be the full tree
  // with NO footer.
  const cwd = fresh();
  try {
    const s = await Session.create({ cwd, name: "small" });
    await s.append({ kind: "message", message: { role: "user", content: "a" } });
    await s.append({ kind: "message", message: { role: "assistant", content: "b" } });
    await s.append({ kind: "message", message: { role: "user", content: "c" } });
    const out = renderSessionTree(s.allEntries(), "", { limit: 100 });
    assert.doesNotMatch(out, /truncated/);
    // Every entry's label should be present (labels are part of a
    // longer tree line, so use `contains` not `^label$`).
    assert.match(out, /a/);
    assert.match(out, /b/);
    assert.match(out, /c/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("tree: --depth and --limit compose (limit hit before depth)", async () => {
  // A 10-level deep tree. depth=5 + limit=3 means the cap is the
  // limit (we stop after 3 lines + the footer). The "(… N more)"
  // leaf is never emitted because we hit the limit first.
  const cwd = fresh();
  try {
    const s = await Session.create({ cwd, name: "combo" });
    let prev = await s.append({ kind: "message", message: { role: "user", content: "L0" } });
    for (let i = 1; i <= 9; i++) {
      prev = await s.append({ kind: "message", message: { role: i % 2 === 0 ? "user" : "assistant", content: "L" + i } });
    }
    s.meta.head = prev.id;
    const out = renderSessionTree(s.allEntries(), prev.id, { depth: 5, limit: 3 });
    const lines = out.split("\n");
    assert.equal(lines.length, 4, "3 tree lines + 1 truncation footer");
    assert.match(out, /truncated at 3 lines/);
    // We never recursed deep enough to hit the depth cap, so no
    // "(… N more below)" leaf.
    assert.doesNotMatch(out, /more below/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("ALL OK", () => {});
