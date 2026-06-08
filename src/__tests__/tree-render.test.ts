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

test("ALL OK", () => {});
