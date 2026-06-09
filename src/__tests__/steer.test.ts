// Tests for the SteerQueue (src/agent/steer.ts) — the in-memory FIFO
// the REPL uses to stash mid-run user input until the next turn
// boundary. See the agnt-port-plan note for the spec.
//
// We test:
//   1. push / peek / drain semantics
//   2. remove(id) and clear()
//   3. EventEmitter: "push" / "remove" / "clear" / "applied" fire
//      with the right payloads
//   4. applyToLastToolResult: appends to the last `role: "tool"`
//      message; drops the text when there is no tool message
//   5. Monotonic ids
//   6. List / size / isEmpty helpers

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SteerQueue } from "../agent/steer.js";
import type { ChatMessage } from "../types.js";

test("steer: push returns monotonically increasing ids", () => {
  const q = new SteerQueue();
  const a = q.push("first");
  const b = q.push("second");
  const c = q.push("third");
  assert.ok(a.id < b.id && b.id < c.id, "ids are monotonically increasing");
  assert.equal(a.text, "first");
  assert.equal(b.text, "second");
  assert.equal(c.text, "third");
  assert.ok(typeof a.queuedAt === "number" && a.queuedAt > 0);
});

test("steer: peek returns the head without removing it", () => {
  const q = new SteerQueue();
  assert.equal(q.peek(), null);
  const a = q.push("alpha");
  assert.equal(q.peek()?.id, a.id);
  assert.equal(q.size, 1, "peek must not change the size");
  q.push("beta");
  assert.equal(q.peek()?.id, a.id, "peek still returns the head (FIFO)");
});

test("steer: drain returns all entries in queue order and empties the queue", () => {
  const q = new SteerQueue();
  q.push("a");
  q.push("b");
  q.push("c");
  const drained = q.drain();
  assert.equal(drained.length, 3);
  assert.deepEqual(drained.map((e) => e.text), ["a", "b", "c"]);
  assert.equal(q.size, 0);
  assert.equal(q.peek(), null);
});

test("steer: drain on an empty queue returns [] and does not emit", () => {
  const q = new SteerQueue();
  let appliedCount = 0;
  q.on("applied", () => { appliedCount += 1; });
  const drained = q.drain();
  assert.deepEqual(drained, []);
  assert.equal(appliedCount, 0, "drain on an empty queue is a no-op (no event)");
});

test("steer: remove(id) drops a specific entry; remove(unknown) is a no-op", () => {
  const q = new SteerQueue();
  const a = q.push("a");
  const b = q.push("b");
  const c = q.push("c");
  const removed = q.remove(b.id);
  assert.equal(removed?.id, b.id);
  assert.equal(q.size, 2);
  assert.deepEqual(q.list().map((e) => e.id), [a.id, c.id]);
  // Unknown id: returns null, no mutation.
  const before = q.size;
  assert.equal(q.remove(99999), null);
  assert.equal(q.size, before);
});

test("steer: clear empties the queue", () => {
  const q = new SteerQueue();
  q.push("a"); q.push("b");
  q.clear();
  assert.equal(q.size, 0);
  assert.equal(q.isEmpty, true);
});

test("steer: EventEmitter fires push / remove / clear / applied", () => {
  const q = new SteerQueue();
  const events: string[] = [];
  q.on("push", (e) => { events.push("push:" + e.id); });
  q.on("remove", (e) => { events.push("remove:" + e.id); });
  q.on("clear", () => { events.push("clear"); });
  q.on("applied", (entries) => { events.push("applied:" + entries.map((e) => e.id).join(",")); });

  const a = q.push("a");
  const b = q.push("b");
  q.remove(a.id);
  const c = q.push("c");
  // Only `c` is left in the queue (a was removed, b was added but
  // then... wait, b is still there. So the queue is [b, c]. Drain
  // returns [b, c]. The applied event lists both ids.
  const drained = q.drain();
  q.clear();

  assert.deepEqual(events, [
    "push:" + a.id,
    "push:" + b.id,
    "remove:" + a.id,
    "push:" + c.id,
    "applied:" + drained.map((e) => e.id).join(","),  // [b.id, c.id]
    "clear",
  ]);
  // Sanity: drained has 2 entries (b and c).
  assert.equal(drained.length, 2);
  assert.equal(drained[0]?.text, "b");
  assert.equal(drained[1]?.text, "c");
});

test("steer: isEmpty is true for a fresh queue and false after push", () => {
  const q = new SteerQueue();
  assert.equal(q.isEmpty, true);
  q.push("x");
  assert.equal(q.isEmpty, false);
  q.clear();
  assert.equal(q.isEmpty, true);
});

// ---------- applyToLastToolResult ----------

test("steer: applyToLastToolResult appends the queued text to the last tool message", () => {
  const q = new SteerQueue();
  // Two text entries queued.
  q.push("also handle the 401 case");
  q.push("and log the retry count");
  const messages: ChatMessage[] = [
    { role: "user", content: "do the thing" },
    { role: "assistant", content: "calling the API" },
    { role: "tool", toolCallId: "t1", toolName: "bash", content: "32 tests passing" },
  ];
  const { messages: next, applied } = q.applyToLastToolResult(messages);
  assert.equal(applied.length, 2);
  // The tool message is the last one and had its content mutated.
  const last = next[next.length - 1]!;
  assert.equal(last.role, "tool");
  assert.match(last.content, /32 tests passing/);
  assert.match(last.content, /also handle the 401 case/);
  assert.match(last.content, /and log the retry count/);
  // Earlier messages are untouched.
  assert.equal(next[0], messages[0]);
  assert.equal(next[1], messages[1]);
  // Queue is drained.
  assert.equal(q.size, 0);
});

test("steer: applyToLastToolResult mutates a copy of the input array (no aliasing)", () => {
  const q = new SteerQueue();
  q.push("steer me");
  const original: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "tool", toolCallId: "t1", toolName: "bash", content: "result" },
  ];
  const before = JSON.stringify(original);
  const { messages: next } = q.applyToLastToolResult(original);
  // The returned array is a fresh wrapper, but the elements are the
  // same object references — that is the contract (cheaper than
  // deep-cloning every message). Mutating the array's SHAPE (push,
  // splice) does not affect the input array; mutating an element's
  // fields would, because we share references for non-target messages.
  next.push({ role: "assistant", content: "appended" });
  assert.equal(original.length, 2, "input array length is unchanged");
  // The tool message at the END was rebuilt (because it's the target),
  // so the input's last element is NOT the same reference as `next`'s
  // last element.
  assert.notEqual(next[1], original[1], "the target tool message is rebuilt (new reference)");
  assert.equal(JSON.stringify(original), before, "input array's tool message is untouched");
});

test("steer: applyToLastToolResult drops the steer text when there is no tool message", () => {
  const q = new SteerQueue();
  q.push("ignored because no tool result");
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "sure" },
  ];
  const { messages: next, applied } = q.applyToLastToolResult(messages);
  assert.equal(applied.length, 0, "applied is empty when no tool message exists");
  // The steer text is dropped (matches the spec: "append to last tool result").
  // The queue is still drained so the queue doesn't grow forever.
  assert.equal(q.size, 0);
  // The returned messages are a fresh array, unchanged.
  assert.deepEqual(next.map((m) => m.role), ["user", "assistant"]);
  assert.equal(next[1]?.content, "sure");
});

test("steer: applyToLastToolResult returns a fresh array even when the queue is empty", () => {
  const q = new SteerQueue();
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "tool", toolCallId: "t1", content: "result" },
  ];
  const { messages: next, applied } = q.applyToLastToolResult(messages);
  assert.equal(applied.length, 0);
  assert.equal(q.size, 0);
  assert.notEqual(next, messages, "returns a copy, not the same reference");
  assert.deepEqual(next, messages, "contents are identical when no steer was applied");
});

test("steer: applyToLastToolResult walks the messages in reverse to find the last tool message", () => {
  // Multiple tool messages: only the LAST one is mutated.
  const q = new SteerQueue();
  q.push("only affects the latest tool result");
  const messages: ChatMessage[] = [
    { role: "tool", toolCallId: "t1", toolName: "bash", content: "first tool result" },
    { role: "tool", toolCallId: "t2", toolName: "grep", content: "second tool result" },
    { role: "tool", toolCallId: "t3", toolName: "read", content: "third tool result" },
  ];
  const { messages: next } = q.applyToLastToolResult(messages);
  // The first two are untouched.
  assert.equal(next[0]!.content, "first tool result");
  assert.equal(next[1]!.content, "second tool result");
  // The last one has the steer text appended.
  const last = next[2]!;
  assert.match(last.content!, /third tool result/);
  assert.match(last.content!, /only affects the latest tool result/);
});

test("steer: applied event is emitted with the drained entries (in queue order)", () => {
  const q = new SteerQueue();
  q.push("a");
  q.push("b");
  let captured: number[] = [];
  q.on("applied", (entries) => { captured = entries.map((e) => e.id); });
  q.applyToLastToolResult([
    { role: "tool", toolCallId: "t1", content: "x" },
  ]);
  assert.equal(captured.length, 2);
  // Monotonic id order: first pushed < second pushed.
  assert.ok(captured[0]! < captured[1]!);
});

test("steer: list() is a snapshot (mutating it doesn't affect the queue)", () => {
  const q = new SteerQueue();
  q.push("a"); q.push("b");
  const snap = q.list();
  snap.pop();
  assert.equal(q.size, 2, "list() returns a copy");
});

test("steer: drain() during a push leaves the new entry for the next drain", () => {
  // The spec: "drain returns at most the entries that were queued
  // before the call; entries pushed during a drain are left for the
  // next drain."
  const q = new SteerQueue();
  q.push("a");
  // We don't actually call drain() while push() is running — JS is
  // single-threaded. The semantic check is just that drain() is
  // synchronous and returns the entries that were queued at call
  // time.
  const drained = q.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0]?.text, "a");
  // A subsequent push lands in a fresh queue.
  q.push("b");
  assert.equal(q.size, 1);
});
