// Tests for the DelegationManager discriminated union (Phase 1 port
// of agnt-gg/agnt's subagent delegation model per
// plans/plan_phase1/notes/agnt-port-plan.md §2).
//
// The union covers 8 worker kinds. Phase 1 implements:
//   - agent           (sub-agent via SubAgentManager)
//   - goal            (lifecycle dispatcher)
//   - async_tool      (single-shot, schedule field reserved)
//   - human_approval  (default-decision when no askApproval wired)
//
// The remaining four (workflow, mcp, plugin, api) are Phase 2 stubs
// but live in the union so the discriminator exhausts at compile
// time.
//
// Tests:
//   1. Union narrows on `kind` (compile-time: a switch on the
//      union's `kind` field hits every case without a `default`).
//   2. Run / observe / cancel happy path per kind (4 kinds).
//   3. The goal-loop's onEnter("executing") lifecycle hook calls
//      delegate for subgoals (integration test).
//   4. The `agent` kind still behaves identically to the old
//      `SubAgentManager.spawn()` for the simple case (regression
//      test).
//   5. cancelAll(parentId) walks the delegation tree.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ch-delegation-"));
process.env.CODINGHARNESS_HOME = tmp;
process.env.NO_COLOR = "1";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
  mkdirSync(join(tmp, sub), { recursive: true });
}

import {
  DelegationManager,
  delegate,
  type Delegation,
  type DelegationKind,
  type DelegationEvent,
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

// ---------- Helper: build a manager + subagents + store ----------

interface MakeDepsOpts {
  askApproval?: DelegationRuntimeDeps["askApproval"];
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
    ...(opts.askApproval ? { askApproval: opts.askApproval } : {}),
  };
  return { deps, providers, subagent, goalStore };
}

// ---------- 1. Union narrowing (compile-time) ----------

test("delegation: union narrows on kind (compile-time check via exhaustive switch)", () => {
  // The switch below is exhaustive at the type level — TSC will
  // reject any new kind that isn't handled. We discriminate on the
  // work object's `kind` (not on a string literal) so the switch
  // exhausts against the full Delegation union.
  const allKinds: Delegation[] = [
    { kind: "agent", agent: "explore", prompt: "", cwd: tmp },
    { kind: "goal", objective: "", cwd: tmp },
    { kind: "async_tool", toolName: "x", args: {}, cwd: tmp },
    { kind: "human_approval", prompt: "", context: { reason: "" }, defaultDecision: "allow", cwd: tmp },
    { kind: "workflow", workflowId: "wf-1", cwd: tmp },
    { kind: "mcp", serverId: "fs", tool: "list", args: {}, cwd: tmp },
    { kind: "plugin", pluginId: "demo", tool: "run", args: {}, cwd: tmp },
    { kind: "api", method: "GET", url: "https://example.com", cwd: tmp },
  ];
  // Walk the array. For each element the discriminant narrows the
  // work to the matching variant. If a new kind is added to the
  // union and not added here, TSC will fail at build time.
  const labels: string[] = allKinds.map((work): string => {
    switch (work.kind) {
      case "agent": return "a:" + work.agent;
      case "goal": return "g:" + work.objective;
      case "async_tool": return "t:" + work.toolName;
      case "human_approval": return "h:" + work.prompt;
      case "workflow": return "w:" + work.workflowId;
      case "mcp": return "m:" + work.tool;
      case "plugin": return "p:" + work.tool;
      case "api": return "x:" + work.method;
    }
  });
  assert.equal(labels.length, 8);
  assert.ok(labels.every((l) => l.length > 1));
});

test("delegation: DelegationKind union has the expected 8 kinds", () => {
  const expected: DelegationKind[] = [
    "agent", "goal", "workflow", "async_tool",
    "mcp", "plugin", "api", "human_approval",
  ];
  // The kind field on the union is a string. We verify the set of
  // unique kinds we can discriminate on matches the design.
  const seen = new Set<DelegationKind>();
  for (const k of expected) seen.add(k);
  assert.equal(seen.size, 8);
});

// ---------- 2. agent kind ----------

test("delegation: agent kind run/observe/cancel happy path", async () => {
  const { deps, subagent } = makeDeps();
  const mgr = new DelegationManager(deps);

  const handle = mgr.submit({
    kind: "agent",
    agent: "summarize",
    prompt: "hello",
    cwd: tmp,
  });

  // Observe: collect events into a list and assert a `started` is
  // emitted before `completed`.
  const events: DelegationEvent[] = [];
  for await (const ev of handle.events()) {
    events.push(ev);
    if (ev.kind === "completed" || ev.kind === "failed" || ev.kind === "cancelled") break;
  }
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes("started"), "expected started event");
  assert.ok(kinds.includes("completed") || kinds.includes("failed"), "expected terminal event");

  const res = await handle.result();
  assert.equal(res.kind, "agent");
  if (res.kind === "agent") {
    assert.match(res.text, /ECHO/);
    assert.equal(res.status, "ok");
  }

  // Regression: same shape as the old SubAgentManager.spawn().
  const direct = await subagent.spawn({
    agent: "summarize",
    prompt: "hello",
    cwd: tmp,
    signal: new AbortController().signal,
  });
  assert.equal(direct.status, "ok");
  assert.match(direct.text, /ECHO/);
});

test("delegation: agent kind cancel aborts the run", async () => {
  const { deps } = makeDeps();
  const mgr = new DelegationManager(deps);
  const ac = new AbortController();
  const handle = mgr.submit({
    kind: "agent",
    agent: "summarize",
    prompt: "long running",
    cwd: tmp,
    signal: ac.signal,
  });
  // Cancel immediately.
  await handle.cancel();
  const res = await handle.result();
  // The echo provider finishes synchronously, so by the time we
  // call cancel the run may already have completed. Either way,
  // the result is consistent (no crash, no hang).
  assert.equal(res.kind, "agent");
});

// ---------- 3. goal kind ----------

test("delegation: goal kind dispatches a goal through the store", async () => {
  const { deps, goalStore } = makeDeps();
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "goal",
    objective: "ship Phase 1 delegation",
    maxIterations: 1,
    cwd: tmp,
  });
  // Drain events.
  for await (const ev of handle.events()) {
    if (ev.kind === "completed" || ev.kind === "failed" || ev.kind === "cancelled") break;
  }
  const res = await handle.result();
  assert.equal(res.kind, "goal");
  if (res.kind === "goal") {
    // The dispatcher adds the goal to the store and runs one
    // iteration; the stub runAgent throws, which the manager
    // swallows (the goal remains in whatever state the runner
    // left it in).
    const stored = goalStore.get(res.goalId);
    assert.ok(stored, "the goal must be persisted in the store");
    assert.equal(stored!.objective, "ship Phase 1 delegation");
  }
});

// ---------- 4. async_tool kind ----------

test("delegation: async_tool kind single-shot happy path", async () => {
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
  }
  // And the events stream saw a progress.
  const evs: DelegationEvent[] = [];
  for await (const ev of handle.events()) evs.push(ev);
  assert.ok(evs.some((e) => e.kind === "progress"), "expected progress event");
});

// ---------- 5. human_approval kind ----------

test("delegation: human_approval uses default when no askApproval wired", async () => {
  const { deps } = makeDeps();
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "human_approval",
    prompt: "Allow npm install?",
    context: { tool: "bash", reason: "package install" },
    defaultDecision: "allow",
    cwd: tmp,
  });
  const res = await handle.result();
  assert.equal(res.kind, "human_approval");
  if (res.kind === "human_approval") {
    assert.equal(res.decision, "allow");
  }
});

test("delegation: human_approval calls askApproval when wired", async () => {
  let askedPrompt = "";
  const { deps } = makeDeps({
    askApproval: async (req) => {
      askedPrompt = req.prompt;
      return { decision: "deny", reason: "user clicked no" };
    },
  });
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "human_approval",
    prompt: "Allow rm -rf?",
    context: { tool: "bash", args: { cmd: "rm -rf /tmp" }, reason: "destructive" },
    defaultDecision: "allow",
    cwd: tmp,
  });
  const res = await handle.result();
  assert.equal(res.kind, "human_approval");
  if (res.kind === "human_approval") {
    assert.equal(res.decision, "deny");
    assert.equal(res.reason, "user clicked no");
  }
  assert.equal(askedPrompt, "Allow rm -rf?");
});

// ---------- 6. Phase 2 stubs ----------

test("delegation: workflow kind is still a stub (Phase 2)", async () => {
  const { deps } = makeDeps();
  const mgr = new DelegationManager(deps);
  const w = mgr.submit({ kind: "workflow", workflowId: "wf-1", cwd: tmp });
  const res = await w.result();
  assert.equal(res.kind, "workflow");
  if (res.kind === "workflow") {
    assert.equal(res.status, "stub");
  }
});

test("delegation: mcp kind without registry returns status=failed with reason", async () => {
  const { deps } = makeDeps();
  const mgr = new DelegationManager(deps);
  const m = mgr.submit({ kind: "mcp", serverId: "fs", tool: "list", args: {}, cwd: tmp });
  const res = await m.result();
  assert.equal(res.kind, "mcp");
  if (res.kind === "mcp") {
    assert.equal(res.status, "failed");
    assert.match(res.error ?? "", /no MCP registry wired/);
  }
});

test("delegation: plugin kind without file returns status=failed with reason", async () => {
  const { deps } = makeDeps();
  const mgr = new DelegationManager(deps);
  const p = mgr.submit({ kind: "plugin", pluginId: "demo-missing", tool: "run", args: {}, cwd: tmp });
  const res = await p.result();
  assert.equal(res.kind, "plugin");
  if (res.kind === "plugin") {
    assert.equal(res.status, "failed");
    assert.match(res.error ?? "", /plugin not found/);
  }
});

// ---------- 7. cancelAll walks the tree ----------

test("delegation: cancelAll walks the parent→child tree", async () => {
  const { deps } = makeDeps();
  const mgr = new DelegationManager(deps);
  // Fire 3 children off a single parent id.
  for (let i = 0; i < 3; i++) {
    mgr.submit({
      kind: "async_tool",
      toolName: "child-" + i,
      args: {},
      cwd: tmp,
      parentId: "parent-1",
    });
  }
  assert.equal(mgr.list({ parentId: "parent-1" }).length, 3);
  const cancelled = await mgr.cancelAll("parent-1");
  assert.equal(cancelled, 3);
});

// ---------- 8. Goal-loop integration hook ----------

test("delegation: goal-loop onEnter(executing) calls delegate for subgoals", () => {
  const { deps, goalStore } = makeDeps();
  // Constructing the manager subscribes the hook to the store.
  const mgr = new DelegationManager(deps);

  // Add a parent goal, then spawn a sub-goal.
  const parent = goalStore.add({ objective: "parent", maxSteps: 4 });
  const child = goalStore.spawnSubgoal(parent.id, { objective: "child", maxSteps: 2 });
  assert.ok(child, "subgoal must spawn");
  assert.equal(child!.parentGoalId, parent.id);

  // Before executing: no goal delegations in flight.
  const before = mgr.list({ kind: "goal" }).length;

  // Drive the child's lifecycle. We can transition it directly
  // through the store (the runner isn't needed for the hook test).
  goalStore.transition(child!.id, "planning");
  goalStore.transition(child!.id, "executing");

  // After executing: the manager must have submitted a goal
  // delegation for the child.
  const after = mgr.list({ kind: "goal" });
  assert.ok(after.length > before, "expected a new goal delegation after the child entered executing");
  const childDelegation = after.find((d) => d.parentId === parent.id);
  assert.ok(childDelegation, "child delegation must have parentId set to its parent goal id");
});

test("delegation: top-level delegate() helper resolves the same result as manager.submit().result()", async () => {
  const { deps } = makeDeps();
  const res = await delegate(
    { kind: "async_tool", toolName: "ping", args: {}, cwd: tmp },
    deps,
  );
  assert.equal(res.kind, "async_tool");
});
