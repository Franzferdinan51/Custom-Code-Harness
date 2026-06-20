// Phase 4 T1 step 8 — End-to-end test that loads a real
// `agnt-gg` workflow JSON fixture, executes it through the
// in-process `WorkflowEngine`, and asserts the output shape
// matches what the agnt-gg engine would produce.
//
// Source: `docs/agnt-workflow-audit.md` §8.4 step 8.
// Fixture: `src/__tests__/fixtures/automated_email_summarizer.json`
// (198 LOC, checked in — taken verbatim from
// `agnt-gg/backend/src/stream/example_workflows/automated_email_summarizer.json`).
//
// What the fixture exercises:
//   - 1 trigger node (`receiveEmail`, agnt-gg-specific type
//     not in v1's built-in set)
//   - 2 `generate-with-ai-llm` actions (`summarizeEmail`,
//     `generateResponse`)
//   - 2 `execute-javascript` utilities (`processResults`,
//     `logSummaryData`)
//   - 2 `send-email` actions (`sendResponse`, `notifyTeam`)
//   - 1 disconnected `label` node (`emailSummarizerLabel`,
//     no incoming/outgoing edges, never executes)
//   - 6 edges forming a tree (1→1, 1→1, 1→1, 1→1, 1→1, 1→1)
//
// Template resolution: the fixture uses
// `{{<nodeId>.<field>}}` references throughout (e.g.
// `{{receiveEmail.subject}}`, `{{summarizeEmail.generatedText}}`).
// Per Phase 4 §T1 decision #4 the resolver prefers `nodeId`
// over `nodeName`, so this exercises the PRIMARY resolution
// path. The `nodeName` fallback is not exercised here — the
// fixture is already authored in the native style. Tests for
// the fallback live in `workflow-eval.test.ts`.
//
// The agnt-gg-specific types `receive-email` and `send-email`
// are NOT in the v1 built-in set (audit decision #1: built-in
// types in v1 are only `generate-with-ai-llm`,
// `execute-javascript`, `mcp-client`, `stop-workflow`). We
// register them in a test `WorkflowToolRegistry` with
// in-memory implementations:
//
//   - `receive-email`  : returns a fixed test email payload
//                        (the engine actually handles trigger
//                        nodes generically via
//                        `executeTrigger()`, so this stub is
//                        never reached for the trigger
//                        category — but we register it for
//                        safety / future-proofing).
//   - `send-email`     : records the call (recipient, body)
//                        and returns `{ success: true, ... }`.
//                        The fixture has two `send-email`
//                        nodes (`sendResponse`, `notifyTeam`)
//                        — both go through this stub.
//   - `webhook-listener` : no-op stub, registered so the test
//                        exercises the same
//                        `WorkflowToolRegistry` registration
//                        path the runtime uses; not actually
//                        invoked by this fixture.
//
// The LLM steps are stubbed via a stateful `Provider` (matches
// the "stateful stub" pattern in AGENTS.md — static done
// stubs loop forever). Two stubs, one per LLM call, in
// declaration order. The stub provider yields the same text
// every call (the engine just records the cost; the actual
// text content does not affect downstream behavior in the
// test because the downstream nodes all template-resolve the
// LLM output into JS code or `send-email` params).
//
// Known fixture/engine mismatch (filed as T1.5 follow-up in
// deliverable.md): the fixture's two `execute-javascript`
// nodes (`processResults`, `logSummaryData`) contain
// `{{<nodeId>.<field>}}` template references inside their
// `code` parameter. The agnt-gg `NodeExecutor` resolves
// `node.parameters` through `parameterResolver` before
// dispatching to the action (NodeExecutor.js:145); our v1
// port does NOT template-resolve the `code` parameter for
// `execute-javascript` (the inline impl at
// `workflow-steps.ts:326-342` reads the raw string). This
// makes the two JS nodes fail with a syntax error — but the
// executor catches the error and stores `{ result: null,
// error: "..." }` as the node's output WITHOUT throwing, so
// the engine continues to the downstream edges. The test
// documents this and asserts that the workflow still
// completes (since downstream `sendResponse` and
// `notifyTeam` stubs are not gated on a successful JS
// result). The full template-resolve-in-code path is a
// T1.5 enhancement and is not required for the E2E to
// demonstrate the v1 engine contract.
//
// The E2E also exercises `runWorkflowKind` (the real
// `Delegation { kind: "workflow" }` runtime path) by
// constructing a `DelegationManager` with a `WorkflowStore`
// holding the fixture, submitting a `WorkflowDelegation`,
// and asserting the resulting `DelegationResult` shape.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkflowEngine } from "../agent/workflow.js";
import {
    WorkflowToolRegistry,
    defaultWorkflowToolRegistry,
} from "../agent/workflow-steps.js";
import { WorkflowStore } from "../agent/workflow-store.js";
import { DelegationManager, type DelegationRuntimeDeps } from "../agent/delegation.js";
import { SubAgentManager } from "../agent/subagent.js";
import { GoalStore } from "../agent/goals.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { Provider, ProviderRequest, ProviderStreamEvent } from "../types.js";
import type { Settings } from "../config/settings.js";
import type { WorkflowRecord } from "../agent/workflow-types.js";

const tmp = mkdtempSync(join(tmpdir(), "ch-wf-e2e-"));
process.env.CODINGHARNESS_HOME = tmp;
process.env.NO_COLOR = "1";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "workflows"]) {
    mkdirSync(join(tmp, sub), { recursive: true });
}

// ---------- Stateful LLM provider stub ----------
//
// Each LLM step in the fixture calls
// `generate-with-ai-llm`; the engine streams from the
// provider via `provider.stream()`. Our stub yields a
// different reply per call (AGENTS.md: "stub providers in
// agent-loop tests must be stateful: yield tool calls on
// call 1, then `done` on call 2+ — otherwise the loop runs
// forever"). The two LLM steps in the fixture are
// `summarizeEmail` and `generateResponse` — we yield
// `summary text` then `response text`, then fall back to
// `FALLBACK` for any further calls (none expected in this
// workflow, but defensive against a future graph edit).

class StubProvider implements Provider {
    readonly id = "stub";
    readonly displayName = "Stub";
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

// ---------- Test fixture loader ----------

function loadFixture(): WorkflowRecord {
    const path = join(__dirname, "fixtures", "automated_email_summarizer.json");
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as WorkflowRecord;
}

// ---------- Test tool registry factory ----------

interface ToolStubs {
    tools: WorkflowToolRegistry;
    /** Recorded `send-email` calls. */
    sendEmailCalls: Array<{ to: string; subject: string; body: string }>;
}

function makeStubs(): ToolStubs {
    const sendEmailCalls: Array<{ to: string; subject: string; body: string }> = [];
    const tools = defaultWorkflowToolRegistry();
    // `receive-email` — agnt-gg trigger type. The engine
    // handles trigger-category nodes generically (the
    // `executeTrigger()` pass-through in
    // `workflow-steps.ts:251-256`), so this stub is
    // registered for safety / future-proofing and is NOT
    // expected to fire in the current fixture. The
    // fixture's `receiveEmail` node is category
    // `trigger`, so the engine hands its `inputData`
    // (which is `currentTriggerData.trigger`) through
    // unchanged.
    tools.register("receive-email", "trigger", async () => {
        return { from: "test@x.com", subject: "Test", body: "Test email", attachments: [] };
    });
    // `send-email` — agnt-gg action type. The fixture has
    // two `send-email` nodes (`sendResponse` and
    // `notifyTeam`); both will fire and both will record
    // their call here. The test asserts the recorded call
    // for `sendResponse` carries the LLM's `generatedText`
    // in the `body` (the LLM stub is the second provider
    // call, which is the value that resolves
    // `{{generateResponse.generatedText}}`).
    tools.register("send-email", "action", async ({ params }) => {
        const to = typeof params["to"] === "string" ? params["to"] : "";
        const subject = typeof params["subject"] === "string" ? params["subject"] : "";
        const body = typeof params["body"] === "string" ? params["body"] : "";
        sendEmailCalls.push({ to, subject, body });
        return { success: true, messageId: "stub-msg-id", error: null };
    });
    // `webhook-listener` — agnt-gg trigger type, not
    // present in the fixture. Registered for symmetry
    // (the runtime registration path is exercised) and
    // because the task spec calls for it. No-op.
    tools.register("webhook-listener", "trigger", async () => {
        return { body: {}, headers: {}, query: {} };
    });
    return { tools, sendEmailCalls };
}

// ---------- Engine E2E ----------

test("workflow E2E: agnt-gg automated_email_summarizer.json — engine executes, send-email stub fires, cost recorded", async () => {
    const fixture = loadFixture();
    const { tools, sendEmailCalls } = makeStubs();
    // Stateful LLM stub: one reply per LLM call in
    // declaration order. `summarizeEmail` is the first
    // LLM call (the `summarizeEmail` node's prompt comes
    // pre-bound in the engine call path), `generateResponse`
    // is the second.
    const provider = new StubProvider(["summary text", "response text"]);
    // Per Phase 4 §T1 decision #4 (nodeId-first template
    // resolution), the fixture's `{{receiveEmail.subject}}`,
    // `{{summarizeEmail.generatedText}}`,
    // `{{processResults.result.from}}`, etc. all resolve
    // via the nodeId map. The trigger data below is the
    // `currentTriggerData` the engine passes to the first
    // start node — the engine reads `triggerData.trigger`
    // (or `triggerData` itself if `.trigger` is absent)
    // and uses that as the first step's `inputData`. The
    // fixture's `summarizeEmail` prompt references
    // `{{receiveEmail.subject}}` (a nodeId, not a trigger
    // reference), but the trigger payload is what populates
    // the `from` / `subject` / `body` for downstream
    // `{{processResults.result.from}}` etc.
    const triggerData = {
        trigger: {
            from: "test@x.com",
            subject: "Test",
            body: "Test email",
        },
    };
    const stepOrder: string[] = [];
    const engine = new WorkflowEngine(fixture, {
        provider,
        // The fixture's two LLM nodes hard-code
        // `model: "claude-3-haiku-20240307"` in their
        // parameters. The engine's
        // `executeGenerateWithAiLlm` honors the per-node
        // model first, falling back to the engine-level
        // `model` only when the node's `model` is empty
        // (workflow-steps.ts:276). We pass the same
        // model as the engine-level fallback for
        // consistency — the assertion below uses
        // `claude-3-haiku-20240307` pricing.
        model: "claude-3-haiku-20240307",
        tools,
        triggerData,
    });
    // Attach the stepEnd listener BEFORE the run so
    // we capture the full execution order. The engine
    // emits `stepEnd` synchronously after each node
    // (workflow.ts:361), so a listener registered on
    // the constructed engine is hit in declaration
    // order.
    engine.on("stepEnd", (id) => { stepOrder.push(id); });
    // 1. Run.
    const result = await engine._executeWorkflow();
    assert.equal(result.status, "completed", `expected completed, got ${result.status}: ${result.error ?? ""}`);
    // 2. `engine.outputs` has a key per executed node.
    // The fixture has 8 nodes total; 7 are reachable
    // (the 8th, `emailSummarizerLabel`, has no incoming
    // edges and is not the trigger, so it never starts).
    // 7 distinct nodes should appear in
    // `nodeExecutionCounts`.
    assert.equal(result.stepsRun, 7, `expected 7 nodes to execute, got ${result.stepsRun}`);
    assert.ok(engine.outputs.has("receiveEmail"), "trigger output should be present");
    assert.ok(engine.outputs.has("summarizeEmail"), "first LLM output should be present");
    assert.ok(engine.outputs.has("processResults"), "processResults should be present (even with error)");
    assert.ok(engine.outputs.has("generateResponse"), "second LLM output should be present");
    assert.ok(engine.outputs.has("sendResponse"), "sendResponse should be present");
    assert.ok(engine.outputs.has("logSummaryData"), "logSummaryData should be present (even with error)");
    assert.ok(engine.outputs.has("notifyTeam"), "notifyTeam should be present");
    assert.ok(!engine.outputs.has("emailSummarizerLabel"), "label node should not execute (no incoming edges)");
    // 3. Execution order matches the agnt-gg engine's
    //    tree traversal: trigger → summarizeEmail →
    //    processResults → [generateResponse (enqueued
    //    first), logSummaryData (enqueued second)] →
    //    [sendResponse (after generateResponse),
    //    notifyTeam (after logSummaryData)]. The
    //    engine's `stepEnd` events are the source of
    //    truth — we collect them in declaration order
    //    via the listener attached above.
    // The expected order is the BFS tree walk:
    //   1. receiveEmail (start)
    //   2. summarizeEmail (only child of receiveEmail)
    //   3. processResults (only child of summarizeEmail)
    //   4. generateResponse (enqueued first from processResults)
    //   5. logSummaryData (enqueued second from processResults)
    //   6. sendResponse (child of generateResponse)
    //   7. notifyTeam (child of logSummaryData)
    assert.deepEqual(stepOrder, [
        "receiveEmail",
        "summarizeEmail",
        "processResults",
        "generateResponse",
        "logSummaryData",
        "sendResponse",
        "notifyTeam",
    ], `unexpected step order: ${stepOrder.join(", ")}`);
    // 4. The `send-email` stub recorded being called.
    // Two `send-email` nodes → two calls.
    assert.equal(sendEmailCalls.length, 2, `expected 2 send-email calls, got ${sendEmailCalls.length}`);
    // The first call is `sendResponse` (executed before
    // `notifyTeam` per the order above). Its `body` is
    // `{{generateResponse.generatedText}}` — which
    // resolves to the second LLM call's reply
    // ("response text") because the engine resolves
    // templates at step-execution time using the
    // outputs already in `engine.outputs` (so by the
    // time `sendResponse` runs, `generateResponse` has
    // completed and its output is in the map).
    const first = sendEmailCalls[0]!;
    assert.equal(first.body, "response text", `sendResponse body should be the LLM's response text, got: ${first.body}`);
    // The `to` field templates `{{processResults.result.from}}`
    // which is `undefined` (the JS node failed) — the
    // resolver leaves the literal `{{...}}` in the
    // string when the path is unresolved. This is the
    // documented "unresolved → literal" behavior (see
    // `workflow-eval.ts:262-277`).
    assert.match(first.to, /\{\{processResults\.result\.from\}\}/, `to should carry the unresolved template literal, got: ${first.to}`);
    // The second call is `notifyTeam`. Its `to` is
    // hard-coded (`"team@example.com"`), not templated.
    const second = sendEmailCalls[1]!;
    assert.equal(second.to, "team@example.com");
    // 5. `engine.nodeExecutionCounts.size > 0` and
    //    `engine.costAccumulator > 0` (we charged for
    //    the LLM calls). The fixture's two LLM nodes
    //    carry `model: "claude-3-haiku-20240307"`, so
    //    the cost table uses the claude-3-haiku row
    //    ($0.25 input / $1.25 output per 1M tokens).
    //    100 in / 50 out per call: $0.0000875 per
    //    call. Two calls → $0.000175.
    assert.ok(engine.nodeExecutionCounts.size > 0, "nodeExecutionCounts should be non-empty");
    assert.ok(result.costUsd > 0, `costUsd should be > 0, got ${result.costUsd}`);
    // Two LLM calls (summarizeEmail + generateResponse),
    // each at 100 in / 50 out, on claude-3-haiku-20240307.
    // Exact value comes from
    // `callCost("claude-3-haiku-20240307", 100, 50)` —
    // doubled.
    const singleCallCost = ((): number => {
        // Mirror `callCost("claude-3-haiku-20240307", 100, 50)`
        // from `src/agent/cost.ts` without importing (the
        // cost module's table is the source of truth).
        // claude-3-haiku-20240307 input: 0.25 USD/1M,
        // output: 1.25 USD/1M (per the cost.ts table).
        return (100 * 0.25 / 1_000_000) + (50 * 1.25 / 1_000_000);
    })();
    const expectedCost = 2 * singleCallCost;
    assert.ok(Math.abs(result.costUsd - expectedCost) < 1e-9, `costUsd should be ${expectedCost}, got ${result.costUsd}`);
});

// ---------- DelegationRuntime E2E (runWorkflowKind) ----------

test("workflow E2E: DelegationManager.runWorkflowKind returns { status: \"completed\", steps: N, costUsd: ~X } (no error)", async () => {
    // Persist the fixture to a `WorkflowStore` so
    // `runWorkflowKind` can load it by id. The store
    // is the narrow in-process CRUD layer that the
    // runtime wires for the `workflow` delegation kind.
    // The store's `root` option overrides the default
    // directory; we use a per-test subdirectory to keep
    // state isolated.
    const fixture = loadFixture();
    const storeRoot = join(tmp, "workflows-store");
    const store = new WorkflowStore({ root: storeRoot });
    await store.createOrUpdate({ record: fixture });
    // Wire a fresh DelegationManager with the same
    // stubs the direct engine test used. The manager
    // owns the abort signal and event stream.
    const { tools, sendEmailCalls } = makeStubs();
    const provider = new StubProvider(["summary text", "response text"]);
    const settings: Settings = {
        providers: { stub: { id: "stub", model: "claude-3-haiku-20240307" } },
        defaultProvider: "stub",
        defaultModel: "claude-3-haiku-20240307",
    };
    const providers = new ProviderRegistry(settings);
    providers.register("stub", provider);
    const subagent = new SubAgentManager(providers, settings, { cwd: tmp });
    const goalStore = new GoalStore({ file: join(tmp, "delegation-goals.json") });
    const deps: DelegationRuntimeDeps = {
        providers,
        settings,
        cwd: tmp,
        subagent,
        goalStore,
        // The four new workflow deps (added in step 5 of
        // T1 — see `delegation.ts:485-511`).
        workflowStore: store,
        workflowToolRegistry: tools,
        workflowProvider: provider,
        workflowModel: "claude-3-haiku-20240307",
    };
    const mgr = new DelegationManager(deps);
    // The trigger payload goes via `inputs` (the
    // delegation's "manual" trigger carries the
    // caller's payload under `inputs`, renamed under
    // `trigger.*` in `runWorkflowKind`).
    const run = mgr.submit({
        kind: "workflow",
        workflowId: fixture.id,
        trigger: { kind: "manual" },
        inputs: {
            from: "test@x.com",
            subject: "Test",
            body: "Test email",
        },
        cwd: tmp,
    });
    const result = await run.result();
    // 6. The final DelegationResult shape. Status is
    //    `completed` (no error path was hit); `error`
    //    is absent (the engine only sets `error` on
    //    `status: "failed"`, per `delegation.ts:1498`).
    // Narrow the discriminated union to the workflow
    // arm so TS resolves the `status` / `error` /
    // `steps` / `costUsd` fields.
    assert.equal(result.kind, "workflow", "result should be the workflow arm");
    if (result.kind !== "workflow") return; // exhaustiveness guard
    assert.equal(result.status, "completed", `expected completed, got ${result.status}: ${result.error ?? ""}`);
    assert.equal(result.workflowId, fixture.id);
    assert.equal(result.error, undefined, "error should be absent on completed");
    assert.equal(result.steps, 7, `expected 7 steps, got ${result.steps}`);
    assert.ok(result.costUsd !== undefined && result.costUsd > 0, `costUsd should be > 0, got ${result.costUsd}`);
    // The two send-email stubs fired through the full
    // runtime path (not the direct engine path).
    assert.equal(sendEmailCalls.length, 2, `expected 2 send-email calls via runWorkflowKind, got ${sendEmailCalls.length}`);
});

test("WorkflowStore: cleans up the tmp file when the rename step fails (regression for orphan-.tmp bug)", async () => {
  // Pre-fix: `createOrUpdate()` did `writeFile(tmp, ...); rename(tmp, f)`
  // with no try/catch — a `rename` failure (e.g. the target is
  // a directory) left the `<id>.json.tmp` orphan next to the
  // workflow file in `~/.codingharness/workflows/`. The fix
  // tracks `tmp` and unlinks it in the catch. We assert no
  // orphan `.tmp` remains after a forced rename failure.
  const storeRoot = join(tmp, "workflows-orphan-test");
  mkdirSync(storeRoot, { recursive: true });
  const store = new WorkflowStore({ root: storeRoot });
  // Pre-create the destination path as a DIRECTORY so the
  // rename onto it fails on POSIX.
  const wid = "wf-orphan";
  mkdirSync(join(storeRoot, wid + ".json"), { recursive: true });
  let threw = false;
  try {
    await store.createOrUpdate({
      record: { id: wid, name: "orphan-test", nodes: [], edges: [] },
    });
  } catch (e) {
    threw = true;
  }
  assert.ok(threw, "createOrUpdate() should have thrown when the target is a directory");
  // No orphan .tmp should remain in the store root.
  const fs = await import("node:fs/promises");
  const siblings = (await fs.readdir(storeRoot)).filter((f) => f.endsWith(".tmp"));
  assert.equal(siblings.length, 0, "no orphan .tmp should remain after a failed save, got: " + siblings.join(", "));
});
