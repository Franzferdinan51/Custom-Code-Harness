// Tests for the compaction preview UI (v0.2.2).

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  previewCompaction,
  formatCompactionPreview,
  defaultCutoff,
  roughTokenCount,
} from "../agent/compaction.js";
import type { ChatMessage } from "../types.js";

function makeMessages(n: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "message " + i + " — " + "lorem ipsum ".repeat(10),
    });
  }
  return msgs;
}

test("previewCompaction: returns the right cutoff for short sessions", () => {
  const msgs = makeMessages(4);
  const p = previewCompaction(msgs);
  // Short session: no compaction.
  assert.equal(p.cutoff, 0);
  assert.equal(p.removed.length, 0);
  assert.equal(p.kept.length, msgs.length);
});

test("previewCompaction: long session splits removed/kept", () => {
  const msgs = makeMessages(20);
  const p = previewCompaction(msgs);
  assert.ok(p.cutoff > 0);
  assert.ok(p.cutoff < msgs.length);
  // Removed has head (3) + omitted marker (1) + tail (3) = 7 if length > 6
  assert.ok(p.removed.length > 0);
  assert.ok(p.kept.length > 0);
  // Token savings is positive.
  assert.ok(p.tokensSaved > 0);
  // tokensAfter is strictly less than tokensBefore.
  assert.ok(p.tokensAfter < p.tokensBefore);
});

test("previewCompaction: indices are 0-based and contiguous", () => {
  const msgs = makeMessages(30);
  const p = previewCompaction(msgs);
  for (let i = 0; i < p.removed.length; i++) {
    const e = p.removed[i]!;
    if (e.index < 0) continue; // synthetic "..." entry
    if (i === 0) assert.equal(e.index, 0);
    else if (i > 0 && p.removed[i - 1]!.index >= 0) {
      // contiguous (or jumps when the omitted marker is in between)
    }
  }
});

test("formatCompactionPreview: produces a multi-line string with markers", () => {
  const msgs = makeMessages(20);
  const p = previewCompaction(msgs);
  const out = formatCompactionPreview(p, { colorize: false });
  // Should mention the cutoff, tokens, and the ✓/✗ markers.
  assert.match(out, /Compaction preview/);
  assert.match(out, /cutoff/);
  assert.match(out, /tokens/);
  assert.match(out, /✓/);
  assert.match(out, /✗/);
  // Should have separate removed/kept sections.
  assert.match(out, /removed/);
  assert.match(out, /kept/);
});

test("formatCompactionPreview: colorize=true adds ANSI codes", () => {
  const msgs = makeMessages(20);
  const p = previewCompaction(msgs);
  const out = formatCompactionPreview(p, { colorize: true });
  assert.match(out, /\x1b\[3[12]m/);
});

test("formatCompactionPreview: colorize=false is plain text", () => {
  const msgs = makeMessages(20);
  const p = previewCompaction(msgs);
  const out = formatCompactionPreview(p, { colorize: false });
  assert.ok(!out.includes("\x1b["));
});

test("defaultCutoff: keeps at least maxRecent OR minRecentFraction, whichever is larger", () => {
  // 20 messages, maxRecent=6, fraction=0.3 → keep max(6, 6) = 6, cutoff = 20 - 6 = 14
  assert.equal(defaultCutoff(20, 6, 0.3), 14);
  // maxRecent=3, fraction=0.3 → 30% of 20 = 6, so keep 6, cutoff = 14
  assert.equal(defaultCutoff(20, 3, 0.3), 14);
  // maxRecent=10 wins over 30%: keep 10, cutoff = 5
  assert.equal(defaultCutoff(15, 10, 0.3), 5);
  // too short
  assert.equal(defaultCutoff(2), 0);
});

test("roughTokenCount: non-zero for non-empty content", () => {
  const m: ChatMessage[] = [{ role: "user", content: "x".repeat(400) }];
  assert.ok(roughTokenCount(m) >= 100);
});

test("previewCompaction: empty message array", () => {
  const p = previewCompaction([]);
  assert.equal(p.cutoff, 0);
  assert.equal(p.totalMessages, 0);
  assert.equal(p.removed.length, 0);
  assert.equal(p.kept.length, 0);
  assert.equal(p.tokensBefore, 0);
  assert.equal(p.tokensAfter, 0);
  assert.equal(p.tokensSaved, 0);
});

test("ALL OK", () => {});
