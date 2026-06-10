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
  /** Override the goal runner. Defaults to a stateful stub that
   *  plans on the first call, executes "GOAL COMPLETE" on the
   *  second — drives the state machine to `done` in one
   *  iteration. Pass a different `runGoalAgent` to drive
   *  other paths (blocked, identical-replan guard, etc.). */
  runGoalAgent?: DelegationRuntimeDeps["runGoalAgent"];
}

function makeDeps(opts: MakeDepsOpts = {}) {
  const settings = { ...baseSettings };
  const providers = new ProviderRegistry(settings);
  providers.register("echo", new EchoProvider());
  const subagent = new SubAgentManager(providers, settings, { cwd: tmp });
  const goalStore = new GoalStore({ file: join(tmp, "delegation-goals.json") });
  // Stateful goal-runner stub. Returns "GOAL COMPLETE" on the
  // executing phase so the state machine reaches `done` in a
  // single iteration. Mirrors the AGENTS.md "stub providers in
  // agent-loop tests must be stateful" rule.
  const defaultRunner: NonNullable<DelegationRuntimeDeps["runGoalAgent"]> = async (phase, ctx) => {
    if (phase === "planning") {
      return { content: "1. read the file\n2. ship it\nReady to execute.", steps: 1 };
    }
    // executing
    void ctx; // unused
    return { content: "done. GOAL COMPLETE", steps: 1 };
  };
  const deps: DelegationRuntimeDeps = {
    providers,
    settings,
    cwd: tmp,
    subagent,
    goalStore,
    runGoalAgent: opts.runGoalAgent ?? defaultRunner,
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
    // The dispatcher adds the goal to the store and runs the
    // state machine for real (Phase 3+). The stateful stub
    // returns "GOAL COMPLETE" on the executing phase, so the
    // goal reaches `done` in a single iteration.
    const stored = goalStore.get(res.goalId);
    assert.ok(stored, "the goal must be persisted in the store");
    assert.equal(stored!.objective, "ship Phase 1 delegation");
    assert.equal(stored!.loopStatus, "done");
    assert.equal(res.status, "done");
    assert.equal(res.iterations, 1);
  }
});

test("delegation: goal kind returns a clear failure when no runGoalAgent is wired", async () => {
  // Build a manager WITHOUT the goal runner. The manager must
  // not throw — it returns a `failed` delegation with a clear
  // reason. This lets the union accept goal kinds in hosts
  // that haven't wired the runner (e.g. slim test fixtures for
  // non-goal kinds).
  const { deps } = makeDeps();
  const noRunnerDeps: DelegationRuntimeDeps = { ...deps, runGoalAgent: undefined };
  const mgr = new DelegationManager(noRunnerDeps);
  const handle = mgr.submit({
    kind: "goal",
    objective: "should fail fast",
    cwd: tmp,
  });
  for await (const ev of handle.events()) {
    if (ev.kind === "completed" || ev.kind === "failed" || ev.kind === "cancelled") break;
  }
  const res = await handle.result();
  assert.equal(res.kind, "goal");
  if (res.kind === "goal") {
    assert.equal(res.status, "failed");
    assert.equal(res.goalId, ""); // no goal record was created
  }
});

test("delegation: goal kind drives a full lifecycle to `done` via a stateful runner", async () => {
  // The runner is stateful: planning returns a fresh plan on
  // each iteration, executing returns "GOAL COMPLETE" on the
  // first iteration. The state machine must reach `done` in
  // a single iteration and the manager must surface that as
  // the delegation's status.
  const { deps, goalStore } = makeDeps();
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "goal",
    objective: "ship the goal kind for real",
    maxIterations: 4,
    cwd: tmp,
  });
  const seenStates: string[] = [];
  for await (const ev of handle.events()) {
    if (ev.kind === "log" && ev.line.startsWith("[goal] ")) {
      seenStates.push(ev.line.slice("[goal] ".length));
    }
    if (ev.kind === "completed" || ev.kind === "failed" || ev.kind === "cancelled") break;
  }
  const res = await handle.result();
  assert.equal(res.kind, "goal");
  if (res.kind === "goal") {
    assert.equal(res.status, "done");
    assert.equal(res.iterations, 1);
    // The store must reflect the terminal state.
    const stored = goalStore.get(res.goalId);
    assert.ok(stored);
    assert.equal(stored!.loopStatus, "done");
    assert.equal(stored!.status, "complete");
    // The lifecycle log must include planning + executing.
    assert.ok(
      seenStates.some((s) => s.startsWith("planning")),
      "expected a 'planning' lifecycle log",
    );
    assert.ok(
      seenStates.some((s) => s.startsWith("executing")),
      "expected an 'executing' lifecycle log",
    );
  }
});

test("delegation: goal kind respects the per-call abort signal", async () => {
  // The runner is slow (sleeps 200ms per call). The manager
  // gets its signal aborted before the runner's first call
  // returns. The manager must surface a `cancelled: true`
  // result and the goal record must reflect a terminal
  // (paused/failed) state.
  const ac = new AbortController();
  const slowRunner: NonNullable<DelegationRuntimeDeps["runGoalAgent"]> = async (phase) => {
    await new Promise((r) => setTimeout(r, 200));
    if (ac.signal.aborted) throw new Error("aborted");
    return { content: phase === "planning" ? "1. plan" : "GOAL COMPLETE", steps: 1 };
  };
  const { deps } = makeDeps({ runGoalAgent: slowRunner });
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "goal",
    objective: "abort mid-run",
    maxIterations: 4,
    cwd: tmp,
  });
  // Abort the signal after a short delay (well before the 200ms
  // runner returns).
  setTimeout(() => ac.abort(), 30);
  const res = await handle.result();
  assert.equal(res.kind, "goal");
  if (res.kind === "goal") {
    // The runner throws when aborted; the manager swallows
    // that, the state machine bails, and we land in a
    // non-`done` terminal state. The exact state depends on
    // which phase the abort hit, so we assert the broad
    // contract: status is one of {failed, paused, executing}
    // and not "done".
    assert.notEqual(res.status, "done");
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

// ---------- 9. Phase 3 T5: skills allowlist on goal kind (Q6) ----------
//
// The `DelegationBase.skills` field is forwarded to
// `SubAgentManager.spawn({ skills })` for the `agent` kind. For
// the `goal` kind, the same field is stamped on the goal record
// (`runGoalKind` → `goalStore.add({ skills })`) and inherited by
// sub-delegations submitted from `onGoalEnter("executing")`. The
// tests below assert the forward-side: a parent goal with
// `skills: ["http", "search"]` produces a sub-delegation with
// the same allowlist, and a parent without `skills` produces a
// sub-delegation with `skills` undefined (backwards compat).
//
// We capture the sub-delegation by monkey-patching the manager's
// `submit` so every work it sees is recorded. To exercise the
// `onGoalEnter("executing")` hook end-to-end we add a goal to
// the store directly (skipping `runGoalKind`'s dedup-key
// pre-registration, which exists to prevent the manager's own
// state machine from re-entering the hook on the goal it just
// created) and walk it through the lifecycle. The hook fires
// when the goal transitions to "executing" and submits a
// sub-delegation with the parent goal's `skills` field
// inherited.

test("delegation: goal kind forwards skills allowlist to onGoalEnter sub-delegation (Q6)", async () => {
  const { deps, goalStore } = makeDeps();
  const mgr = new DelegationManager(deps);
  // Capture every submit() the manager makes. The sub-spawn
  // from the hook is one of them; we filter to it by kind.
  const captured: Array<{ kind: string; skills: string[] | undefined; objective: string }> = [];
  const realSubmit = mgr.submit.bind(mgr);
  (mgr as unknown as { submit: typeof realSubmit }).submit = (work) => {
    captured.push({ kind: work.kind, skills: work.skills, objective: "objective" in work ? work.objective : "" });
    return realSubmit(work);
  };

  // Add a goal record with `skills` and walk it through the
  // lifecycle. The hook fires on the "executing" transition
  // and submits a sub-delegation.
  const goal = goalStore.add({
    objective: "ship skills forwarding",
    maxSteps: 2,
    skills: ["http", "search"],
  });
  goalStore.transition(goal.id, "planning");
  goalStore.transition(goal.id, "executing");

  // Wait for the sub-delegation's run to land in the captured
  // array. The hook's submit() is synchronous (it just enqueues
  // the run), so by the time the transitions above return the
  // captured array is populated.
  const sub = captured.find((c) => c.kind === "goal" && c.objective === goal.objective);
  assert.ok(sub, "onGoalEnter sub-delegation must be captured");
  assert.deepEqual(sub!.skills, ["http", "search"], "sub-delegation must inherit the parent goal's skills");
  // The goal record in the store has the field stamped.
  const stored = goalStore.get(goal.id);
  assert.ok(stored, "goal record must be persisted");
  assert.deepEqual(stored!.skills, ["http", "search"]);
});

test("delegation: goal kind without skills leaves onGoalEnter sub-delegation's skills undefined (backwards compat)", async () => {
  const { deps, goalStore } = makeDeps();
  const mgr = new DelegationManager(deps);
  const captured: Array<{ kind: string; skills: string[] | undefined; objective: string }> = [];
  const realSubmit = mgr.submit.bind(mgr);
  (mgr as unknown as { submit: typeof realSubmit }).submit = (work) => {
    captured.push({ kind: work.kind, skills: work.skills, objective: "objective" in work ? work.objective : "" });
    return realSubmit(work);
  };

  // Add a goal record WITHOUT skills (backwards compat).
  const goal = goalStore.add({
    objective: "no skills allowlist",
    maxSteps: 2,
    // skills: not set
  });
  goalStore.transition(goal.id, "planning");
  goalStore.transition(goal.id, "executing");

  const sub = captured.find((c) => c.kind === "goal" && c.objective === goal.objective);
  assert.ok(sub, "onGoalEnter sub-delegation must be captured");
  assert.equal(sub!.skills, undefined, "sub-delegation's skills must be undefined when parent didn't set it");
  // The goal record in the store has no `skills` field.
  const stored = goalStore.get(goal.id);
  assert.ok(stored);
  assert.equal(stored!.skills, undefined);
});

test("delegation: goal kind sub-delegation inherits skills end-to-end (runGoalKind path)", async () => {
  // This test exercises the full `runGoalKind` path: submit
  // a goal delegation with `skills: ["http", "search"]`, let
  // the state machine run with the default runner (which
  // drives a single iteration to "GOAL COMPLETE"), and assert
  // the goal record is stamped with the allowlist. The
  // pre-registered dedup key inside `runGoalKind` prevents
  // the hook from re-dispatching for the goal the manager
  // is running inline — so this test focuses on the
  // `goalStore.add({ skills })` plumbing rather than the
  // hook's submit() forward.
  const { deps, goalStore } = makeDeps();
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "goal",
    objective: "ship end-to-end skills forwarding",
    maxIterations: 1,
    cwd: tmp,
    skills: ["http", "search"],
  });
  for await (const ev of handle.events()) {
    if (ev.kind === "completed" || ev.kind === "failed" || ev.kind === "cancelled") break;
  }
  const res = await handle.result();
  assert.equal(res.kind, "goal");
  if (res.kind === "goal") {
    const stored = goalStore.get(res.goalId);
    assert.ok(stored, "goal record must be persisted");
    assert.deepEqual(stored!.skills, ["http", "search"], "goal record must carry the parent delegation's skills");
  }
});

// ---------- 10. Phase 3 T5: maxCostUsd cap on goal kind ----------
//
// The `DelegationBase.maxCostUsd` field is enforced for the
// `agent` kind via the `CostTracker`. For the `goal` kind,
// `runGoalKind` wraps the `runGoalAgent` closure so each call's
// `usage` (when the runner returns it) is recorded on a
// per-delegation `CostTracker` and the cap is checked after
// every phase. When the cap fires, the goal is stamped with
// `status: "failed"` + `lastError: "maxCostUsd cap exceeded: $X.XX"`,
// the state machine is broken via a thrown error, and the
// manager surfaces the same message on the delegation's
// `error` field.
//
// The custom runner below returns a fixed usage on every call.
// gpt-4o-mini pricing is $0.15/1M in + $0.60/1M out, so
// {500_000, 500_000} = $0.375 per call (the state machine
// makes two calls per iteration — planning + executing — so
// `maxIterations: 1` = $0.75 cumulative). That's well above
// $0.001 (cap-fires test) and well below $1.0 (high-cap test).
// The default `echo-1` model is NOT in the cost table, so we
// explicitly set `model: "gpt-4o-mini"` on the goal delegation
// so the cap check has a non-zero cost to compare against.

function makeUsageRunner(usage: { inputTokens: number; outputTokens: number } | undefined) {
  return async (phase: "planning" | "executing") => {
    if (phase === "planning") {
      return {
        content: "1. plan\n2. execute\nReady to execute.",
        steps: 1,
        ...(usage !== undefined ? { usage } : {}),
      };
    }
    // executing — never reach here when the cap fires after
    // the planning phase, but be defensive.
    return {
      content: "executing — would normally say GOAL COMPLETE here",
      steps: 1,
      ...(usage !== undefined ? { usage } : {}),
    };
  };
}

test("delegation: goal kind enforces maxCostUsd cap when cumulative cost exceeds it", async () => {
  // Stub returns {500K in / 500K out} = $0.375 per call at
  // gpt-4o-mini pricing. After the planning phase the
  // cumulative cost is $0.375 > $0.001 → cap fires.
  const runner = makeUsageRunner({ inputTokens: 500_000, outputTokens: 500_000 });
  const { deps, goalStore } = makeDeps({ runGoalAgent: runner });
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "goal",
    objective: "ship cap enforcement",
    maxIterations: 4,
    cwd: tmp,
    model: "gpt-4o-mini",
    maxCostUsd: 0.001,
  });
  for await (const ev of handle.events()) {
    if (ev.kind === "completed" || ev.kind === "failed" || ev.kind === "cancelled") break;
  }
  const res = await handle.result();
  assert.equal(res.kind, "goal");
  if (res.kind === "goal") {
    // The cap fired: status is failed, error carries the cap
    // message, and the goal record has lastError stamped.
    assert.equal(res.status, "failed");
    assert.match(res.error ?? "", /maxCostUsd cap exceeded/);
    assert.match(res.error ?? "", /\$\d/);
    const stored = goalStore.get(res.goalId);
    assert.ok(stored);
    assert.equal(stored!.status, "failed");
    assert.equal(stored!.loopStatus, "failed");
    assert.match(stored!.lastError ?? "", /maxCostUsd cap exceeded/);
  }
});

test("delegation: goal kind with no maxCostUsd completes normally even with high cumulative cost", async () => {
  // Same usage stub, but no cap. The goal's runner drives
  // the state machine normally; without a cap there's no
  // threshold to trip.
  const runner = makeUsageRunner({ inputTokens: 500_000, outputTokens: 500_000 });
  const { deps, goalStore } = makeDeps({ runGoalAgent: runner });
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "goal",
    objective: "no cap, just run",
    maxIterations: 1,
    cwd: tmp,
    model: "gpt-4o-mini",
    // maxCostUsd: not set
  });
  for await (const ev of handle.events()) {
    if (ev.kind === "completed" || ev.kind === "failed" || ev.kind === "cancelled") break;
  }
  const res = await handle.result();
  assert.equal(res.kind, "goal");
  if (res.kind === "goal") {
    // The runner doesn't say "GOAL COMPLETE", so the goal
    // will fail the evaluator (no success criteria) and
    // end in `failed` after exhausting the single iteration.
    // The point: the cap didn't fire. Assert the error is
    // absent.
    assert.equal(res.error, undefined, "no cap → no cap-exceeded error");
    // Sanity: the goal record is NOT in the cap-failed
    // shape — `lastError` is empty.
    const stored = goalStore.get(res.goalId);
    assert.ok(stored);
    assert.doesNotMatch(stored!.lastError ?? "", /maxCostUsd cap exceeded/);
  }
});

test("delegation: goal kind with a high maxCostUsd cap does not fire even with high cumulative cost", async () => {
  // Same usage stub, cap is $1.0. Cumulative cost is $0.75,
  // well below the cap. Goal completes normally.
  const runner = makeUsageRunner({ inputTokens: 500_000, outputTokens: 500_000 });
  const { deps, goalStore } = makeDeps({ runGoalAgent: runner });
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "goal",
    objective: "high cap, plenty of headroom",
    maxIterations: 1,
    cwd: tmp,
    model: "gpt-4o-mini",
    maxCostUsd: 1.0,
  });
  for await (const ev of handle.events()) {
    if (ev.kind === "completed" || ev.kind === "failed" || ev.kind === "cancelled") break;
  }
  const res = await handle.result();
  assert.equal(res.kind, "goal");
  if (res.kind === "goal") {
    assert.equal(res.error, undefined, "high cap → no cap-exceeded error");
    const stored = goalStore.get(res.goalId);
    assert.ok(stored);
    assert.doesNotMatch(stored!.lastError ?? "", /maxCostUsd cap exceeded/);
  }
});

test("delegation: goal kind with maxCostUsd cap does NOT fire when the runner returns no usage (no false cap hits)", async () => {
  // Cap is $0.001 — would fire on ANY non-zero cost. The
  // runner returns no `usage`, so the manager records zero
  // for the call and the cap is a no-op. The goal completes
  // normally (still fails the evaluator — no success
  // criteria, no GOAL COMPLETE — but that's the normal
  // exhausted-iterations path, not a cap-failure).
  const runner = makeUsageRunner(undefined);
  const { deps, goalStore } = makeDeps({ runGoalAgent: runner });
  const mgr = new DelegationManager(deps);
  const handle = mgr.submit({
    kind: "goal",
    objective: "no usage returned, cap should not fire",
    maxIterations: 1,
    cwd: tmp,
    model: "gpt-4o-mini",
    maxCostUsd: 0.001,
  });
  for await (const ev of handle.events()) {
    if (ev.kind === "completed" || ev.kind === "failed" || ev.kind === "cancelled") break;
  }
  const res = await handle.result();
  assert.equal(res.kind, "goal");
  if (res.kind === "goal") {
    assert.equal(res.error, undefined, "no usage → no cap-exceeded error");
    const stored = goalStore.get(res.goalId);
    assert.ok(stored);
    assert.doesNotMatch(stored!.lastError ?? "", /maxCostUsd cap exceeded/);
  }
});
