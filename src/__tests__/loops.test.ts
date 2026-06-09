// Tests for the Loop<Kind> hierarchy.
//
// Per spec in `plans/plan_phase1/notes/agnt-port-plan.md` §3, the
// five tiers (mission, goal, agent, workflow, tool) are unified under
// a single discriminated union. Tests:
//
//   1. Union narrows on `kind` (compile-time — an exhaustive switch
//      on the `kind` field covers all five tiers without a default).
//   2. MissionLoop instantiates a GoalLoop (drives the same objective
//      and persists a goal in the same store).
//   3. GoalLoop uses the lifecycle state machine and exposes
//      evaluations (a stateful stub produces a passing run).
//   4. AgentLoop wraps `runAgent` — same stateful stub pattern as
//      `goals.test.ts`: call 1 yields a tool call, call 2 yields
//      done.
//   5. WorkflowLoop runs the 4-step reproduce→diagnose→patch→test
//      pattern, threading state between steps.
//   6. ToolLoop wraps a registry call (success + unknown tool).
//   7. Council is a GoalLoop — `councilAsGoalLoop()` returns a
//      `Loop<"goal">` (regression: existing `council.test.ts`
//      assertions on `runCouncil` still hold).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ch-loops-"));
process.env.CODINGHARNESS_HOME = tmp;
process.env.NO_COLOR = "1";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
  mkdirSync(join(tmp, sub), { recursive: true });
}

import {
  AnyLoop,
  LOOP_KINDS,
  isMission,
  isGoal,
  isAgent,
  isWorkflow,
  isTool,
  missionLoop,
  goalLoop,
  agentLoop,
  workflowLoop,
  bugFixWorkflow,
  toolLoopFromRegistry,
  toolCanHandle,
  toolSpecFor,
} from "../agent/loops/index.js";
import { ToolRegistry, type Tool, type ToolContext } from "../agent/tools/registry.js";
import { runAgent, DEFAULT_LIMITS } from "../agent/loop.js";
import { GoalStore, type GoalRunAgentFn } from "../agent/goals.js";
import { councilAsGoalLoop, BUILTIN_COUNCILORS, DEFAULT_COUNCIL_ROSTER, runCouncil, type CouncilDeps } from "../agent/council.js";
import type { Provider, ProviderRequest, ProviderStreamEvent, ToolCall } from "../types.js";

// ---------- 1. Union narrows on `kind` (compile-time) ----------

test("loops: union narrows on kind (compile-time exhaustive switch)", () => {
  // Build one of every kind. The switch below is exhaustive at the
  // type level — TSC will reject any kind that isn't handled. We
  // discriminate on the value's `kind` (not on a string literal) so
  // the switch exhausts against the full AnyLoop union.
  const allKinds: AnyLoop[] = [
    missionLoop(),
    goalLoop(),
    agentLoop(),
    workflowLoop(),
    toolLoopFromRegistry(new ToolRegistry(), "read"),
  ];
  assert.equal(allKinds.length, 5);
  const labels: string[] = allKinds.map((loop): string => {
    switch (loop.kind) {
      case "mission":  return "M:" + loop.description;
      case "goal":     return "G:" + loop.description;
      case "agent":    return "A:" + loop.description;
      case "workflow": return "W:" + loop.description;
      case "tool":     return "T:" + loop.description;
    }
  });
  assert.equal(labels.length, 5);
  assert.ok(labels.every((l) => l.length > 1));
});

test("loops: LOOP_KINDS lists the 5 tiers in spec order", () => {
  assert.deepEqual([...LOOP_KINDS], ["mission", "goal", "agent", "workflow", "tool"]);
});

test("loops: type guards discriminate correctly", () => {
  const m = missionLoop();
  const g = goalLoop();
  const a = agentLoop();
  const w = workflowLoop();
  const t = toolLoopFromRegistry(new ToolRegistry(), "read");
  assert.equal(isMission(m), true);
  assert.equal(isGoal(g), true);
  assert.equal(isAgent(a), true);
  assert.equal(isWorkflow(w), true);
  assert.equal(isTool(t), true);
  // Cross-guards return false.
  assert.equal(isMission(g), false);
  assert.equal(isTool(a), false);
});

// ---------- 2. MissionLoop instantiates a GoalLoop ----------

test("loops: MissionLoop instantiates a GoalLoop for a fresh objective", async () => {
  const store = new GoalStore({ file: join(tmp, "loops-mission.json") });
  const mission = missionLoop();
  const out = await mission.run(
    { objective: "ship loops module", store, maxIterations: 2, model: "x", providerId: "y" },
    { cwd: tmp, signal: new AbortController().signal },
  );
  // MissionLoop adds the goal and runs the inner goal loop. The
  // stub runAgent (default in GoalLoop) returns content; the
  // evaluator then fails because no success criteria, so the loop
  // ends in `failed` after `maxIterations`. The mission returns the
  // final record regardless.
  assert.equal(out.mode, "created");
  assert.ok(out.goal, "mission must produce a goal record");
  assert.equal(out.goal.objective, "ship loops module");
  assert.ok(out.goal.evaluations && out.goal.evaluations.length >= 1, "should record at least one evaluation");
});

test("loops: MissionLoop resumes an existing active goal", async () => {
  const store = new GoalStore({ file: join(tmp, "loops-mission-resume.json") });
  // Pre-seed an active goal.
  const pre = store.add({ objective: "resume me", maxSteps: 4 });
  store.markInProgress(pre.id);
  const mission = missionLoop();
  const out = await mission.run(
    { objective: "resume me", store },
    { cwd: tmp, signal: new AbortController().signal },
  );
  assert.equal(out.mode, "resumed");
  assert.equal(out.goal.id, pre.id);
});

// ---------- 3. GoalLoop uses the state machine + evaluations ----------

test("loops: GoalLoop drives the state machine to done with a stateful stub", async () => {
  const file = join(tmp, "loops-goal.json");
  if (existsSync(file)) rmSync(file);
  const store = new GoalStore({ file });
  const loop = goalLoop();
  // Stateful stub: call 1 (planning) returns a plan, call 2
  // (executing) returns finalText that hits both success criteria.
  let calls = 0;
  const stub: GoalRunAgentFn = async (phase) => {
    calls += 1;
    if (phase === "planning") return { content: "1. ship alpha 2. ship beta", steps: 1 };
    return { content: "alpha and beta shipped", steps: 1 };
  };
  const out = await loop.run(
    {
      objective: "ship alpha + beta",
      store,
      maxIterations: 3,
      runAgent: stub,
      successCriteria: { deliverables: ["alpha", "beta"] },
    },
    { cwd: tmp, signal: new AbortController().signal },
  );
  assert.equal(out.ok, true);
  assert.equal(out.loopStatus, "done");
  assert.equal(calls, 2, "stub should be called once for planning, once for executing");
  assert.ok(out.evaluations.length >= 1);
  assert.equal(out.evaluations[0]!.passed, true);
});

// ---------- 4. AgentLoop wraps runAgent (stateful stub) ----------

test("loops: AgentLoop matches runAgent behavior (stateful stub)", async () => {
  // Stateful stub pattern (matches goals.test.ts + AGENTS.md rule).
  // Call 1 yields a tool_call (read of /tmp/x); call 2 yields done.
  class StubProvider implements Provider {
    readonly id = "stub";
    readonly displayName = "Stub";
    private call = 0;
    async isConfigured() { return { ok: true }; }
    async *stream(_req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      this.call += 1;
      if (this.call === 1) {
        yield { type: "text", text: "let me read" };
        yield { type: "tool_call", toolCall: { id: "c1", name: "read", argsJson: JSON.stringify({ path: "/tmp/ch-loops-agent.txt" }) } satisfies ToolCall };
        yield { type: "done" };
        return;
      }
      // Call 2: done
      yield { type: "text", text: "I read it" };
      yield { type: "done" };
    }
  }
  // Set up the file the stub will read.
  const target = "/tmp/ch-loops-agent.txt";
  writeFileSync(target, "hello", "utf-8");
  const tools = new ToolRegistry();
  // Register a no-op "read" tool that returns a fixed result. We
  // don't want to depend on the default tool registry here so the
  // test is hermetic.
  const readTool: Tool = {
    spec: { name: "read", description: "stub", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
    validate: (a) => a as Record<string, unknown>,
    run: async () => ({ toolCallId: "c1", display: "read: hello", content: "hello", isError: false }),
  };
  tools.register(readTool);
  const provider = new StubProvider();
  const loop = agentLoop();
  const out = await loop.run(
    {
      provider,
      model: "x",
      messages: [{ role: "user", content: "go" }],
      tools,
      cwd: "/",
      signal: new AbortController().signal,
      limits: { ...DEFAULT_LIMITS, maxSteps: 4, requestTimeoutMs: 5_000 },
    },
    { cwd: "/", signal: new AbortController().signal },
  );
  // AgentLoop runs runAgent under the hood. After 1 step, the
  // tool result is fed back; on call 2 the model returns "done"
  // and the loop ends with that text.
  assert.match(out.finalText, /I read it/);
  assert.ok(out.result.steps >= 1);
});

// ---------- 5. WorkflowLoop runs the 4-step pattern ----------

test("loops: WorkflowLoop threads state through reproduce→diagnose→patch→test", async () => {
  // Stateful stub: each step gets a different text so we can
  // confirm the chain threads.
  let stepIdx = 0;
  const expected: string[] = ["REPRO", "DIAG", "PATCH", "TEST"];
  class StepStub implements Provider {
    readonly id = "step";
    readonly displayName = "StepStub";
    async isConfigured() { return { ok: true }; }
    async *stream(_req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      yield { type: "text", text: expected[stepIdx] ?? "extra" };
      yield { type: "done" };
    }
  }
  // The provider is shared; we bump the counter by replacing it
  // across calls. Simpler: build a counter provider that returns a
  // different text on each call. Stateful stub — see AGENTS.md.
  let calls = 0;
  const stepProvider: Provider = {
    id: "step",
    displayName: "Step",
    async isConfigured() { return { ok: true }; },
    async *stream(_req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      calls += 1;
      yield { type: "text", text: expected[calls - 1] ?? "extra" };
      yield { type: "done" };
    },
  };
  const wf = workflowLoop();
  const steps = bugFixWorkflow();
  const out = await wf.run(
    {
      task: "fix the bug",
      steps,
      provider: stepProvider,
      model: "x",
      cwd: "/",
      signal: new AbortController().signal,
    },
    { cwd: "/", signal: new AbortController().signal },
  );
  assert.equal(out.stepsRun, 4);
  assert.equal(out.state.steps.length, 4);
  assert.equal(out.state.steps[0]!.name, "reproduce");
  assert.equal(out.state.steps[0]!.output, "REPRO");
  assert.equal(out.state.steps[1]!.name, "diagnose");
  assert.equal(out.state.steps[1]!.output, "DIAG");
  assert.equal(out.state.steps[2]!.name, "patch");
  assert.equal(out.state.steps[2]!.output, "PATCH");
  assert.equal(out.state.steps[3]!.name, "test");
  assert.equal(out.state.steps[3]!.output, "TEST");
  assert.equal(out.finalText, "TEST");
  // (Quiet unused warnings: `stepIdx` is referenced by a stub class
  // defined above for documentation; the active stub is the
  // counter-based one.)
  void stepIdx;
  void StepStub;
});

// ---------- 6. ToolLoop wraps a registry call ----------

test("loops: ToolLoop wraps a registry call (success path)", async () => {
  const tools = new ToolRegistry();
  const echoTool: Tool = {
    spec: { name: "echo", description: "echoes", parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"], additionalProperties: false } },
    validate: (a) => {
      const args = a as Record<string, unknown>;
      if (typeof args.msg !== "string") throw new Error("msg must be string");
      return args;
    },
    run: async (args) => ({ toolCallId: "", display: "echo: " + args.msg, content: "echo: " + args.msg, isError: false }),
  };
  tools.register(echoTool);
  const loop = toolLoopFromRegistry(tools, "echo");
  const out = await loop.run(
    { args: { msg: "hi" } },
    { cwd: "/", signal: new AbortController().signal },
  );
  assert.equal(out.tool, "echo");
  assert.equal(out.dispatched, true);
  assert.equal(out.result.isError, false);
  assert.match(out.result.content, /echo: hi/);
  // Helpers.
  assert.equal(toolCanHandle(tools, "echo"), true);
  assert.equal(toolCanHandle(tools, "nope"), false);
  assert.ok(toolSpecFor(tools, "echo"));
  assert.equal(toolSpecFor(tools, "nope"), null);
});

test("loops: ToolLoop returns isError when the tool is unknown", async () => {
  const tools = new ToolRegistry();
  const loop = toolLoopFromRegistry(tools, "missing");
  const out = await loop.run(
    { args: {} },
    { cwd: "/", signal: new AbortController().signal },
  );
  assert.equal(out.dispatched, false);
  assert.equal(out.result.isError, true);
  assert.match(out.result.content, /unknown tool: missing/);
});

// ---------- 7. Council is a GoalLoop (regression) ----------

test("loops: councilAsGoalLoop returns a Loop<goal>", () => {
  const loop = councilAsGoalLoop();
  assert.equal(loop.kind, "goal");
  assert.match(loop.description, /council/i);
});

test("loops: councilAsGoalLoop.run drives a goal (delegates the runAgent bridge)", async () => {
  const store = new GoalStore({ file: join(tmp, "loops-council.json") });
  const loop = councilAsGoalLoop();
  const out = await loop.run(
    { objective: "council: should we ship?", store, maxIterations: 1 },
    { cwd: tmp, signal: new AbortController().signal },
  );
  assert.equal(out.goal.objective, "council: should we ship?");
  // The stub bridge from council.ts always returns "council:goal: executing ..."
  // so the loop ends with that text as finalText.
  assert.match(out.finalText ?? "", /council:goal/);
});

test("loops: existing council API still works (regression for council.test.ts)", async () => {
  // This is a thin re-run of council.test.ts's first scenario, just
  // to confirm the refactor didn't change the public surface.
  const callLog: string[] = [];
  const deps: CouncilDeps = {
    spawn: async (opts) => {
      if (opts.prompt.includes("Council transcript")) {
        callLog.push("synthesizer");
        return { text: "FINAL", usage: { inputTokens: 0, outputTokens: 0 } };
      }
      const role = opts.system.includes("SKEPTIC") ? "skeptic"
                 : opts.system.includes("BUILDER") ? "builder"
                 : "researcher";
      callLog.push(role);
      return { text: "reply-" + role, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const roster = DEFAULT_COUNCIL_ROSTER.map((r) => BUILTIN_COUNCILORS[r]);
  const r = await runCouncil("Q?", { mode: "consensus", councilors: roster, cwd: tmp }, deps);
  assert.equal(r.mode, "consensus");
  assert.equal(r.transcript.length, 4);
  assert.equal(r.final, "FINAL");
  assert.deepEqual(callLog.sort(), ["builder", "researcher", "skeptic", "synthesizer"].sort());
});
