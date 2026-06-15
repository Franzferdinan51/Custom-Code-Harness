// Tests for `WorkflowEngine` + `NodeExecutor` integration.
// Covers the 5 scenarios from the task spec:
//   1. 3-node linear: trigger → llm → stop
//   2. 4-node branched: edge conditions, one branch taken
//   3. 2-node loop with `maxIterations: 3`
//   4. Workflow with `maxCostUsd: 0.0001` (cap fires)
//   5. Sub-workflow via `run-workflow`
//
// We stub the provider and McpRegistry at the test
// boundary so the engine runs deterministically and
// doesn't touch the network. The integration shape mirrors
// `delegation-stubs.test.ts` (stateful provider stub +
// narrow McpRegistry stub).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkflowEngine } from "../agent/workflow.js";
import { defaultWorkflowToolRegistry } from "../agent/workflow-steps.js";
import { callCost } from "../agent/cost.js";
import type { McpCallResult, McpRegistry } from "../agent/delegation.js";
import type { Provider, ProviderRequest, ProviderStreamEvent } from "../types.js";
import type {
    WorkflowEdge,
    WorkflowNode,
    WorkflowRecord,
} from "../agent/workflow-types.js";

process.env.CODINGHARNESS_HOME = mkdtempSync(join(tmpdir(), "ch-wf-test-"));
process.env.NO_COLOR = "1";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "workflows"]) {
    mkdirSync(join(process.env.CODINGHARNESS_HOME, sub), { recursive: true });
}

// ---------- Stub provider (stateful) ----------

class StubProvider implements Provider {
    readonly id = "stub";
    readonly displayName = "Stub";
    /** A queue of text replies; the provider pops one per
     *  call. Matches the "stateful stub" pattern called
     *  out in AGENTS.md: a static "done" stub loops
     *  forever, so we yield different outputs per call. */
    private replies: string[];
    constructor(replies: string[]) {
        this.replies = [...replies];
    }
    async isConfigured() { return { ok: true }; }
    async *stream(_req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const next = this.replies.shift() ?? "FALLBACK";
    yield { type: "text", text: next };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50 } };
    yield { type: "done" };
  }
}

// ---------- McpRegistry stub ----------

function makeMcpRegistry(): { registry: McpRegistry; calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> } {
    const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
    const registry: McpRegistry = {
        id: "test",
        listServers: () => [{ id: "fs", name: "Filesystem" }],
        callTool: async (server, tool, args) => {
            calls.push({ server, tool, args });
            return { ok: true, output: { files: ["a.txt"] } } satisfies McpCallResult;
        },
    };
    return { registry, calls };
}

// ---------- Workflow fixture helpers ----------

function makeNode(id: string, text: string, type: string, category: WorkflowNode["category"], parameters: Record<string, unknown> = {}, overrides: Partial<WorkflowNode> = {}): WorkflowNode {
    return { id, text, x: 0, y: 0, type, category, parameters, ...overrides };
}

function makeEdge(id: string, from: string, to: string, overrides: Partial<WorkflowEdge> = {}): WorkflowEdge {
    return {
        id,
        start: { id: from, type: "output" },
        end: { id: to, type: "input" },
        ...overrides,
    };
}

function baseDeps(overrides: Partial<ConstructorParameters<typeof WorkflowEngine>[1]> = {}): ConstructorParameters<typeof WorkflowEngine>[1] {
    return {
        tools: defaultWorkflowToolRegistry(),
        ...overrides,
    };
}

// ---------- 1. Linear workflow ----------

test("workflow: 3-node linear trigger → llm → stop", async () => {
    const trigger = makeNode("t", "Trigger", "webhook-listener", "trigger", { path: "/x" });
    const llm = makeNode("l", "Summarize", "generate-with-ai-llm", "action", { provider: "stub", model: "gpt-4o-mini", prompt: "summarize {{trigger.body}}" });
    const stop = makeNode("s", "Stop", "stop-workflow", "control", { reason: "done" });
    const wf: WorkflowRecord = {
        id: "wf-linear",
        name: "Linear",
        nodes: [trigger, llm, stop],
        edges: [
            makeEdge("e1", "t", "l"),
            makeEdge("e2", "l", "s"),
        ],
    };
    const provider = new StubProvider(["summary text"]);
    const engine = new WorkflowEngine(wf, baseDeps({ provider, model: "gpt-4o-mini", triggerData: { trigger: { body: "hello" } } }));
    const result = await engine._executeWorkflow();
    assert.equal(result.status, "completed");
    assert.equal(engine.stopRequested, true, "stop-workflow should set the flag");
    // LLM step output is at outputs["l"]
    const llmOut = engine.outputs.get("l") as { generatedText: string; tokenCount: { inputTokens: number; outputTokens: number }; error: string };
    assert.ok(llmOut, "LLM output should be in outputs");
    assert.equal(llmOut.generatedText, "summary text");
    assert.equal(llmOut.error, "");
    assert.equal(llmOut.tokenCount.inputTokens, 100);
    // Cost should be recorded (gpt-4o-mini, 100 in / 50 out)
    const expected = callCost("gpt-4o-mini", 100, 50);
    assert.ok(Math.abs(result.costUsd - expected) < 1e-9, `cost should be ${expected}, got ${result.costUsd}`);
    // Both llm and stop nodes were executed
    assert.ok(engine.nodeExecutionCounts.has("l"));
    assert.ok(engine.nodeExecutionCounts.has("s"));
    // Steps: trigger, llm, stop (3 distinct nodes ran at least once)
    assert.equal(result.stepsRun, 3);
});

// ---------- 2. Branched workflow with conditions ----------

test("workflow: 4-node branched — one branch taken, one not", async () => {
    const t = makeNode("t", "Trigger", "webhook-listener", "trigger", {});
    const classify = makeNode("c", "Classify", "execute-javascript", "utility", { code: "({ category: 'urgent' })" });
    const urgent = makeNode("u", "Urgent Handler", "execute-javascript", "utility", { code: "({ handled: 'urgent' })" });
    const normal = makeNode("n", "Normal Handler", "execute-javascript", "utility", { code: "({ handled: 'normal' })" });
    const wf: WorkflowRecord = {
        id: "wf-branch",
        name: "Branch",
        nodes: [t, classify, urgent, normal],
        edges: [
            makeEdge("e1", "t", "c"),
            // Branch on the JS node's `result.category`
            // (the JS tool wraps the snippet's return in
            // `{ result, error }`).
            makeEdge("eU", "c", "u", {
                conditions: [{ if: "{{c.result.category}}", condition: "equals", value: "urgent" }],
            }),
            makeEdge("eN", "c", "n", {
                conditions: [{ if: "{{c.result.category}}", condition: "equals", value: "normal" }],
            }),
        ],
    };
    const engine = new WorkflowEngine(wf, baseDeps({ triggerData: {} }));
    const result = await engine._executeWorkflow();
    assert.equal(result.status, "completed");
    // Urgent branch fired, normal branch did not.
    const urgentOut = engine.outputs.get("u") as { result: { handled: string }; error: string };
    const normalOut = engine.outputs.get("n");
    assert.ok(urgentOut, "urgent handler should have output");
    assert.equal(urgentOut.result.handled, "urgent");
    assert.equal(normalOut, undefined, "normal handler should not have run");
    assert.equal(engine.edgeIterations.get("eU"), 1, "urgent edge fired once");
    assert.equal(engine.edgeIterations.get("eN"), undefined, "normal edge did not fire");
});

// ---------- 3. Loop with maxIterations ----------

test("workflow: 2-node loop with maxIterations=3 iterates 3 times then stops", async () => {
    // Trigger → counter (execute-javascript that increments a stateful closure) → back to counter
    // We use `maxIterations: 3` on the loop-back edge to bound the run.
    const t = makeNode("t", "Trigger", "webhook-listener", "trigger", {});
    let counter = 0;
    const counterTool = (code: string): WorkflowNode => makeNode("c", "Counter", "execute-javascript", "utility", { code });
    // We need a way to make `execute-javascript` stateful across invocations. The
    // current executor implementation runs each invocation in a fresh VM context.
    // So the state must live OUTSIDE the VM. We register a custom tool in the
    // WorkflowToolRegistry that uses a closure over the counter.
    const tools = defaultWorkflowToolRegistry();
    tools.register("custom-counter", "custom", async ({ inputData: _input, engine }) => {
        // Incrementing is observed through `engine.outputs` after this returns.
        counter += 1;
        return { iteration: counter, prev: engine.outputs.get("c") ?? null };
    });
    const c = makeNode("c", "Counter", "custom-counter", "custom", {});
    const wf: WorkflowRecord = {
        id: "wf-loop",
        name: "Loop",
        nodes: [t, c],
        edges: [
            makeEdge("eStart", "t", "c"),
            // Loop back: c → c, with maxIterations=3
            makeEdge("eLoop", "c", "c", { maxIterations: 3 }),
        ],
    };
    const engine = new WorkflowEngine(wf, baseDeps({ tools }));
    const result = await engine._executeWorkflow();
    assert.equal(result.status, "completed");
    // The counter should have been called 4 times: once from the start edge,
    // and then 3 more from the loop-back edge (c→c with maxIterations=3).
    assert.equal(counter, 4, `counter should be 4 (1 start + 3 loop), got ${counter}`);
    assert.equal(engine.edgeIterations.get("eLoop"), 3, "loop edge hit maxIterations=3");
});

// ---------- 4. maxCostUsd cap ----------

test("workflow: maxCostUsd cap aborts the run when exceeded", async () => {
    const t = makeNode("t", "Trigger", "webhook-listener", "trigger", {});
    const expensive = makeNode("x", "Expensive", "generate-with-ai-llm", "action", { provider: "stub", model: "gpt-4o", prompt: "x" });
    const wf: WorkflowRecord = {
        id: "wf-cap",
        name: "Cap",
        nodes: [t, expensive],
        edges: [makeEdge("e1", "t", "x")],
    };
    const provider = new StubProvider(["expensive reply"]);
    // gpt-4o at 100 in / 50 out: $2.50/1M * 100 + $10/1M * 50 = $2.5e-4 + $5e-4 = $7.5e-4.
    // Set the cap far below that.
    const engine = new WorkflowEngine(wf, baseDeps({ provider, model: "gpt-4o", maxCostUsd: 0.0001 }));
    let capEvent: [number, number] | undefined;
    engine.on("costCapExceeded", (cost, cap) => { capEvent = [cost, cap]; });
    const result = await engine._executeWorkflow();
    assert.equal(result.status, "failed", "cap should abort the run");
    assert.match(result.error ?? "", /maxCostUsd/);
    assert.ok(capEvent, "costCapExceeded event should fire");
    assert.ok(capEvent![0] > capEvent![1], "cost should be over cap");
});

test("workflow: maxCostUsd cap does NOT fire when the run stays under it", async () => {
    const t = makeNode("t", "Trigger", "webhook-listener", "trigger", {});
    const cheap = makeNode("x", "Cheap", "generate-with-ai-llm", "action", { provider: "stub", model: "gpt-4o-mini", prompt: "x" });
    const wf: WorkflowRecord = {
        id: "wf-nocap",
        name: "No Cap",
        nodes: [t, cheap],
        edges: [makeEdge("e1", "t", "x")],
    };
    const provider = new StubProvider(["cheap reply"]);
    const engine = new WorkflowEngine(wf, baseDeps({ provider, model: "gpt-4o-mini", maxCostUsd: 1.0 }));
    const result = await engine._executeWorkflow();
    assert.equal(result.status, "completed");
    assert.equal(result.error, undefined);
});

// ---------- 5. Sub-workflow via run-workflow ----------

test("workflow: run-workflow instantiates a sub-engine inline", async () => {
    const t = makeNode("t", "Trigger", "webhook-listener", "trigger", {});
    // Sub-workflow record: trigger → llm
    const subTrigger = makeNode("st", "Sub Trigger", "webhook-listener", "trigger", {});
    const subLlm = makeNode("sl", "Sub LLM", "generate-with-ai-llm", "action", { provider: "stub", model: "gpt-4o-mini", prompt: "sub" });
    const subRecord: WorkflowRecord = {
        id: "sub",
        name: "Sub",
        nodes: [subTrigger, subLlm],
        edges: [makeEdge("se1", "st", "sl")],
    };
    // Parent: trigger → run-workflow
    const rw = makeNode("rw", "Run Sub", "run-workflow", "action", { workflowId: "sub", workflowRecord: subRecord });
    const wf: WorkflowRecord = {
        id: "wf-parent",
        name: "Parent",
        nodes: [t, rw],
        edges: [makeEdge("e1", "t", "rw")],
    };
    const provider = new StubProvider(["sub output"]);
    const engine = new WorkflowEngine(wf, baseDeps({ provider, model: "gpt-4o-mini" }));
    const result = await engine._executeWorkflow();
    assert.equal(result.status, "completed");
    const out = engine.outputs.get("rw") as { _subWorkflowOutputs: Record<string, unknown>; status: string; costUsd: number; stepsRun: number };
    assert.ok(out, "sub-workflow node should have output");
    assert.equal(out.status, "completed");
    assert.ok(out._subWorkflowOutputs, "sub-workflow outputs should be attached");
    // The sub-engine's outputs should include the sub-LLM's output.
    const subLlmOut = out._subWorkflowOutputs["sl"] as { generatedText: string };
    assert.equal(subLlmOut.generatedText, "sub output");
    // Sub-workflow ran 2 steps (trigger + llm)
    assert.equal(out.stepsRun, 2);
});

// ---------- 6. MCP client step ----------

test("workflow: mcp-client step calls the McpRegistry with the right args", async () => {
    const { registry, calls } = makeMcpRegistry();
    const t = makeNode("t", "Trigger", "webhook-listener", "trigger", {});
    const mcp = makeNode("m", "MCP", "mcp-client", "mcp", { serverId: "fs", tool: "list", args: { path: "/tmp" } });
    const wf: WorkflowRecord = {
        id: "wf-mcp",
        name: "MCP",
        nodes: [t, mcp],
        edges: [makeEdge("e1", "t", "m")],
    };
    const engine = new WorkflowEngine(wf, baseDeps({ mcpRegistry: registry, triggerData: {} }));
    const result = await engine._executeWorkflow();
    assert.equal(result.status, "completed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.server, "fs");
    assert.equal(calls[0]!.tool, "list");
    assert.deepEqual(calls[0]!.args, { path: "/tmp" });
    const out = engine.outputs.get("m") as { result: unknown; error: string };
    assert.equal(out.error, "");
    assert.deepEqual(out.result, { files: ["a.txt"] });
});

// ---------- 7. execute-javascript step ----------

test("workflow: execute-javascript runs the snippet and returns result", async () => {
    const t = makeNode("t", "Trigger", "webhook-listener", "trigger", {});
    const js = makeNode("j", "JS", "execute-javascript", "utility", { code: "({ doubled: input.value * 2 })" });
    const wf: WorkflowRecord = {
        id: "wf-js",
        name: "JS",
        nodes: [t, js],
        edges: [makeEdge("e1", "t", "j")],
    };
    // The first step's `inputData` is the trigger payload
    // (audit §3.2). The JS snippet reads `input.value`,
    // so we put `value: 21` in the trigger output. The
    // engine passes `currentTriggerData.trigger` to the
    // first start node.
    const engine = new WorkflowEngine(wf, baseDeps({ triggerData: { trigger: { value: 21 } } }));
    const result = await engine._executeWorkflow();
    assert.equal(result.status, "completed");
    const out = engine.outputs.get("j") as { result: { doubled: number }; error: string };
    assert.equal(out.error, "");
    assert.equal(out.result.doubled, 42);
});

// ---------- 8. Unknown node type fails the run ----------

test("workflow: unknown node type surfaces as a NodeExecutionError", async () => {
    const t = makeNode("t", "Trigger", "webhook-listener", "trigger", {});
    const bad = makeNode("b", "Bad", "send-email", "action", { to: "x@y.z" });
    const wf: WorkflowRecord = {
        id: "wf-bad",
        name: "Bad",
        nodes: [t, bad],
        edges: [makeEdge("e1", "t", "b")],
    };
    const engine = new WorkflowEngine(wf, baseDeps({ triggerData: {} }));
    const result = await engine._executeWorkflow();
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /type not implemented in v1: send-email/);
    // The error is recorded per-node.
    assert.ok(engine.errors.has("b"));
});

// ---------- 9. Abort signal cancels the run ----------

test("workflow: abort signal cancels the run", async () => {
    const t = makeNode("t", "Trigger", "webhook-listener", "trigger", {});
    const llm = makeNode("l", "LLM", "generate-with-ai-llm", "action", { provider: "stub", model: "gpt-4o-mini", prompt: "x" });
    const wf: WorkflowRecord = {
        id: "wf-abort",
        name: "Abort",
        nodes: [t, llm],
        edges: [makeEdge("e1", "t", "l")],
    };
    const provider = new StubProvider(["x"]);
    const controller = new AbortController();
    const engine = new WorkflowEngine(wf, baseDeps({ provider, model: "gpt-4o-mini", signal: controller.signal }));
    // Abort before run.
    controller.abort();
    const result = await engine._executeWorkflow();
    assert.equal(result.status, "failed");
    assert.equal(result.error, "cancelled");
});

// ---------- 10. status events fire in order ----------

test("workflow: statusChanged event fires with running then completed", async () => {
    const t = makeNode("t", "Trigger", "webhook-listener", "trigger", {});
    const stop = makeNode("s", "Stop", "stop-workflow", "control", {});
    const wf: WorkflowRecord = {
        id: "wf-events",
        name: "Events",
        nodes: [t, stop],
        edges: [makeEdge("e1", "t", "s")],
    };
    const engine = new WorkflowEngine(wf, baseDeps({ triggerData: {} }));
    const seen: string[] = [];
    engine.on("statusChanged", (s) => { seen.push(s); });
    await engine._executeWorkflow();
    assert.equal(seen[0], "running");
    // Last is either "completed" (if no stop) or "completed" too
    // (the stop-workflow sets the flag but the engine still
    // finalizes as completed when the queue drains).
    assert.equal(seen[seen.length - 1], "completed");
});
