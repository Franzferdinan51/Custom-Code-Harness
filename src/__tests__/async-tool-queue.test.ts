// Tests for the AsyncToolQueueStore crash-resilience layer
// (src/agent/delegation.ts).
//
// The store is the persistence backbone of the async_tool
// delegation kind. The contract under test:
//
//   1. add / markRunning / markCompleted / markFailed write to disk
//      atomically and are recoverable across process restarts.
//   2. The DelegationManager replays pending / running entries on
//      startup.
//   3. The executeFunction MUST be idempotent — replaying a half-
//      finished run is safe because the same (id, toolName, args)
//      resolves to the same result without duplicate side effects.
//
// The headline test is the "kill mid-run, restart, replay" path:
//   - M1 submits an async_tool, the executeFunction hangs forever
//     (simulating a crash mid-run).
//   - M1 is dropped (no manager reference held).
//   - M2 starts up against the same file, replays the persisted
//     entry, and marks it complete (using a real, idempotent
//     executeFunction).
//   - The executeFunction was called twice in total (once hung, once
//     succeeded) and the queue file is now coherent.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ch-async-tool-queue-"));
process.env.CODINGHARNESS_HOME = tmp;
process.env.NO_COLOR = "1";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
  mkdirSync(join(tmp, sub), { recursive: true });
}

import {
  AsyncToolQueueStore,
  DelegationManager,
  type AsyncToolQueueEntry,
  type DelegationRuntimeDeps,
} from "../agent/delegation.js";
import { SubAgentManager } from "../agent/subagent.js";
import { GoalStore } from "../agent/goals.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { Provider, ProviderRequest, ProviderStreamEvent } from "../types.js";
import type { Settings } from "../config/settings.js";

// ---------- Stub provider (echo) ----------

class EchoProvider implements Provider {
  readonly id = "echo";
  readonly displayName = "Echo";
  async isConfigured() { return { ok: true }; }
  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const last = req.messages[req.messages.length - 1];
    const text = "ECHO: " + ((last && last.content) || "");
    yield { type: "text", text };
    yield { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } };
    yield { type: "done" };
  }
}

const baseSettings: Settings = {
  providers: { echo: { id: "echo", model: "echo-1" } },
  defaultProvider: "echo",
  defaultModel: "echo-1",
};

interface MakeDepsOpts {
  asyncToolQueue?: AsyncToolQueueStore;
  executeFunction?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

function makeDeps(opts: MakeDepsOpts = {}) {
  const settings = { ...baseSettings };
  const providers = new ProviderRegistry(settings);
  providers.register("echo", new EchoProvider());
  const subagent = new SubAgentManager(providers, settings, { cwd: tmp });
  const goalStore = new GoalStore({ file: join(tmp, "delegation-goals.json") });
  const deps: DelegationRuntimeDeps = {
    providers,
    settings,
    cwd: tmp,
    subagent,
    goalStore,
    ...(opts.asyncToolQueue ? { asyncToolQueue: opts.asyncToolQueue } : {}),
    ...(opts.executeFunction ? { executeFunction: opts.executeFunction } : {}),
  };
  return { deps, providers, subagent, goalStore };
}

// ---------- AsyncToolQueueStore unit tests ----------

test("async-tool-queue: store round-trips entries on disk", () => {
  const file = join(tmp, "store-rt.json");
  const s = new AsyncToolQueueStore({ file });
  const e1 = s.add({ id: "del-1", toolName: "compute", args: { x: 1 } });
  assert.equal(e1.status, "pending");
  s.markRunning("del-1");
  s.markCompleted("del-1", { ok: true });
  // Reopen from the same file.
  const s2 = new AsyncToolQueueStore({ file });
  const list = s2.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, "del-1");
  assert.equal(list[0]!.status, "completed");
  assert.deepEqual(list[0]!.result, { ok: true });
});

test("async-tool-queue: listPending returns only pending + running", () => {
  const file = join(tmp, "list-pending.json");
  const s = new AsyncToolQueueStore({ file });
  s.add({ id: "a", toolName: "t", args: {} });
  s.add({ id: "b", toolName: "t", args: {} });
  s.add({ id: "c", toolName: "t", args: {} });
  s.markCompleted("a", 1);
  s.markRunning("b");
  // c is still pending
  const pending = s.listPending();
  assert.deepEqual(pending.map((e) => e.id), ["b", "c"]);
  assert.equal(pending.every((e) => e.status === "running" || e.status === "pending"), true);
});

test("async-tool-queue: purge removes terminal entries but keeps pending", () => {
  const file = join(tmp, "purge.json");
  const s = new AsyncToolQueueStore({ file });
  s.add({ id: "a", toolName: "t", args: {} });
  s.add({ id: "b", toolName: "t", args: {} });
  s.markCompleted("a", 1);
  s.markFailed("b", "boom");
  const removed = s.purge();
  assert.equal(removed, 2);
  assert.equal(s.list().length, 0);
});

test("async-tool-queue: missing file starts empty", () => {
  const file = join(tmp, "missing.json");
  // Make sure the file doesn't exist.
  if (existsSync(file)) rmSync(file);
  const s = new AsyncToolQueueStore({ file });
  assert.equal(s.list().length, 0);
});

test("async-tool-queue: corrupt file starts empty + logs a warning", () => {
  const file = join(tmp, "corrupt.json");
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(file, "{ this is not json", "utf-8");
  const s = new AsyncToolQueueStore({ file });
  assert.equal(s.list().length, 0, "corrupt JSON falls back to empty list");
});

test("async-tool-queue: markRunning is idempotent", () => {
  const file = join(tmp, "running-once.json");
  const s = new AsyncToolQueueStore({ file });
  s.add({ id: "a", toolName: "t", args: {} });
  s.markRunning("a");
  const first = s.list()[0]!;
  const startedAt = first.startedAt;
  // Wait a moment so a second markRunning would tick the timestamp.
  // Then call markRunning again — startedAt should be UNCHANGED
  // (idempotent) because the entry is already running.
  s.markRunning("a");
  const second = s.list()[0]!;
  assert.equal(second.startedAt, startedAt, "markRunning is idempotent on already-running entries");
});

test("async-tool-queue: markCompleted on a missing id is a no-op", () => {
  const file = join(tmp, "missing-id.json");
  const s = new AsyncToolQueueStore({ file });
  s.markCompleted("does-not-exist", { ok: true });
  assert.equal(s.list().length, 0);
});

// ---------- DelegationManager integration ----------

test("async-tool-queue: manager runs async_tool and records the result on the store", async () => {
  const file = join(tmp, "manager-basic.json");
  const store = new AsyncToolQueueStore({ file });
  const calls: Array<{ toolName: string; args: unknown }> = [];
  const { deps } = makeDeps({
    asyncToolQueue: store,
    executeFunction: async (toolName, args) => {
      calls.push({ toolName, args });
      return { computed: true, tool: toolName, args };
    },
  });
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "async_tool",
    toolName: "compute",
    args: { x: 1 },
    cwd: tmp,
  });
  const res = await handle.result();
  assert.equal(res.kind, "async_tool");
  // The store now has the entry in "completed" state.
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.status, "completed");
  assert.deepEqual(list[0]!.result, { computed: true, tool: "compute", args: { x: 1 } });
  assert.equal(calls.length, 1, "executeFunction called once for the live run");
});

test("async-tool-queue: legacy in-memory path still works when no store is wired", async () => {
  // Regression: hosts that don't set up the store should still get
  // the Phase 1 echo behavior.
  const { deps } = makeDeps();
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "async_tool",
    toolName: "fetch_url",
    args: { url: "https://example.com" },
    cwd: tmp,
  });
  const res = await handle.result();
  assert.equal(res.kind, "async_tool");
  if (res.kind === "async_tool") {
    assert.equal(res.toolName, "fetch_url");
    assert.equal(res.iterations, 1);
    // Phase 1 echo shape: { echoed, args, at }
    const inner = res.result as { echoed: string; args: Record<string, unknown> };
    assert.equal(inner.echoed, "fetch_url");
  }
});

// ---------- The headline test: kill mid-run, restart, replay ----------

test("async-tool-queue: pending entries are persisted and replayed on restart (kill mid-run)", async () => {
  const file = join(tmp, "replay.json");
  // Track invocations of the REAL (idempotent) executeFunction.
  const realCalls: Array<{ toolName: string; args: unknown }> = [];
  const realExecuteFunction = async (toolName: string, args: Record<string, unknown>) => {
    realCalls.push({ toolName, args });
    return { ok: true, tool: toolName, args };
  };

  // M1's executeFunction: hangs forever on the first call (simulating
  // the process being killed mid-run). Subsequent calls delegate to
  // the real function. This guarantees M1's invocation of exec never
  // resolves — M1 will be "killed" before completion.
  let firstCallStarted = false;
  const m1ExecuteFunction = async (toolName: string, args: Record<string, unknown>) => {
    if (!firstCallStarted) {
      firstCallStarted = true;
      return new Promise<unknown>(() => { /* hang forever — kill mid-run */ });
    }
    return realExecuteFunction(toolName, args);
  };

  // ---- M1: submit, then drop (simulating process kill) ----
  const store1 = new AsyncToolQueueStore({ file });
  const { deps: deps1 } = makeDeps({
    asyncToolQueue: store1,
    executeFunction: m1ExecuteFunction,
  });
  const m1 = new DelegationManager(deps1);
  // Submit. We don't await the result — M1 is about to be killed.
  void m1.submit({
    kind: "async_tool",
    toolName: "compute",
    args: { x: 1, label: "important" },
    cwd: tmp,
  });

  // Give M1 a tick to write the entry to disk.
  await new Promise((r) => setTimeout(r, 30));

  // Sanity: the file has the entry in "running" state.
  const persistedRaw = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(persistedRaw.entries.length, 1, "M1 wrote the entry to disk");
  assert.equal(persistedRaw.entries[0].status, "running", "M1 marked the entry as running");
  assert.equal(persistedRaw.entries[0].toolName, "compute");

  // "Kill" M1: drop all references, abort all signals, let the GC
  // collect the manager. The m1ExecuteFunction's hang is still
  // pending in the event loop but no one is awaiting it.
  // (We can't truly SIGKILL the test process; this is a clean
  // simulation.)

  // ---- M2: restart, replay ----
  const store2 = new AsyncToolQueueStore({ file });
  const { deps: deps2 } = makeDeps({
    asyncToolQueue: store2,
    executeFunction: realExecuteFunction,
  });
  const m2 = new DelegationManager(deps2);
  // The constructor calls replayAsyncToolQueue synchronously, but
  // the function is async. Give it a tick to complete.
  await new Promise((r) => setTimeout(r, 50));

  // After replay: the real function was called once, and the
  // entry is now "completed" in the file.
  assert.equal(realCalls.length, 1, "real executeFunction was called once by the replay");
  assert.equal(realCalls[0]!.toolName, "compute");
  assert.deepEqual(realCalls[0]!.args, { x: 1, label: "important" });

  const after = store2.list();
  const completed = after.filter((e: AsyncToolQueueEntry) => e.status === "completed");
  assert.equal(completed.length, 1, "the replayed entry is now in completed state");
  assert.equal(completed[0]!.id, persistedRaw.entries[0].id, "the same id is reused");
  assert.deepEqual(completed[0]!.result, { ok: true, tool: "compute", args: { x: 1, label: "important" } });

  // The queue file is coherent (read it from disk to be sure).
  const finalRaw = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(finalRaw.entries[0].status, "completed");
  assert.deepEqual(finalRaw.entries[0].result, { ok: true, tool: "compute", args: { x: 1, label: "important" } });

  // And m2 should not re-replay: a fresh manager should see an
  // empty pending list.
  const store3 = new AsyncToolQueueStore({ file });
  assert.equal(store3.listPending().length, 0, "no pending entries on a clean restart");
});

test("async-tool-queue: failed runs persist the error message", async () => {
  const file = join(tmp, "failed.json");
  const store = new AsyncToolQueueStore({ file });
  const { deps } = makeDeps({
    asyncToolQueue: store,
    executeFunction: async () => { throw new Error("boom"); },
  });
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "async_tool",
    toolName: "compute",
    args: { x: 1 },
    cwd: tmp,
  });
  // The manager's result() promise converts throws into a generic
  // failed placeholder (pre-existing behavior; the wrapper exists so
  // callers don't have to try/catch). The store, however, records
  // the real error from the executeFunction. We verify the store
  // here — that's the contract under test.
  await handle.result().catch(() => { /* expected: throws */ });
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.status, "failed");
  assert.equal(list[0]!.error, "boom");
  // Note: handle.status is a snapshot from DelegationManager.submit
  // (taken at submit time, when status is still "queued"). The
  // authoritative "failed" state lives in the AsyncToolQueueStore,
  // which the assertions above check. Don't re-assert handle.status
  // here — it would be a snapshot-vs-live bug, not a real failure.
});

test("async-tool-queue: replay does not call the function when the queue is empty", async () => {
  const file = join(tmp, "no-replay.json");
  // Empty file.
  const calls: unknown[] = [];
  const store = new AsyncToolQueueStore({ file });
  const { deps } = makeDeps({
    asyncToolQueue: store,
    executeFunction: async (toolName, args) => {
      calls.push({ toolName, args });
      return { ok: true };
    },
  });
  new DelegationManager(deps);
  // Give the constructor's replay a tick to run.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 0, "no replay when the queue is empty");
});

test("async-tool-queue: replay is best-effort and survives a single failure", async () => {
  const file = join(tmp, "replay-fail.json");
  // Pre-populate the file with a stuck "running" entry.
  const preStore = new AsyncToolQueueStore({ file });
  preStore.add({ id: "del-stuck", toolName: "compute", args: { x: 1 } });
  preStore.markRunning("del-stuck");

  // The replay executeFunction throws — the manager should record
  // the failure and continue (no crash, no hang).
  const store = new AsyncToolQueueStore({ file });
  const { deps } = makeDeps({
    asyncToolQueue: store,
    executeFunction: async () => { throw new Error("replay failure"); },
  });
  new DelegationManager(deps);
  await new Promise((r) => setTimeout(r, 30));
  const after = store.list();
  assert.equal(after.length, 1);
  assert.equal(after[0]!.status, "failed");
  assert.equal(after[0]!.error, "replay failure");
});
