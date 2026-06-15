// Tests for the `ch workflow *` CLI subcommand and the
// `/workflow` slash command (Phase 4 T1 step 7).
//
// The spec asks for 3 smoke tests:
//   1. `ch workflow list` on an empty store returns empty.
//   2. `ch workflow export <id>` + `ch workflow import <file>`
//      round-trips a workflow.
//   3. `ch workflow run <id>` with a stub workflow returns
//      the expected result shape.
//
// We exercise the public runtime surface (the CLI is a
// thin adapter over `runtime.workflowStore` and
// `runtime.runWorkflow`). Testing the runtime surface
// instead of `spawn("bun", "src/cli.ts", "workflow", ...)`
// keeps tests deterministic and fast — per the
// t1-endpoints memory note, spawning `ch serve` per
// test is ~2s each. The delegation kind is tested
// separately in `delegation.test.ts`.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkflowEngine } from "../agent/workflow.js";
import { defaultWorkflowToolRegistry } from "../agent/workflow-steps.js";
import type { Provider, ProviderRequest, ProviderStreamEvent } from "../types.js";
import type { WorkflowRecord } from "../agent/workflow-types.js";

// Per AGENTS.md "test setup rules": set CH_HOME
// and mkdir the subdirs BEFORE importing modules
// that read `paths.*`. The HarnessRuntime's
// constructor reads `paths.workflows` from
// `paths.home` which is set from $CODINGHARNESS_HOME
// at import time.
const tmp = mkdtempSync(join(tmpdir(), "ch-workflow-cli-"));
process.env.CODINGHARNESS_HOME = tmp;
process.env.NO_COLOR = "1";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "workflows"]) {
    mkdirSync(join(tmp, sub), { recursive: true });
}

import { HarnessRuntime } from "../runtime.js";

test.after(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** A stub provider that yields a single canned text
 *  reply per call. The "stateful" pattern from
 *  AGENTS.md: a static "done" stub loops forever, so
 *  we yield distinct outputs across calls. For the
 *  3-node linear test the engine makes 1 LLM call, so
 *  one reply is enough. */
class StubProvider implements Provider {
    readonly id = "stub";
    readonly displayName = "Stub";
    private replies: string[];
    constructor(replies: string[]) { this.replies = [...replies]; }
    async isConfigured() { return { ok: true }; }
    async *stream(_req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
        const next = this.replies.shift() ?? "FALLBACK";
        yield { type: "text", text: next };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: "done" };
    }
}

/** Build a 3-node linear workflow: trigger → LLM → stop. */
function makeLinearWorkflow(): WorkflowRecord {
    return {
        id: "",
        name: "Linear Test",
        nodes: [
            { id: "t", text: "Trigger", x: 0, y: 0, type: "webhook-listener", category: "trigger", parameters: { path: "/x" } },
            { id: "l", text: "LLM", x: 200, y: 0, type: "generate-with-ai-llm", category: "action", parameters: { model: "gpt-4o-mini", prompt: "hi" } },
            { id: "s", text: "Stop", x: 400, y: 0, type: "stop-workflow", category: "control", parameters: { reason: "done" } },
        ],
        edges: [
            { id: "e1", start: { id: "t", type: "output" }, end: { id: "l", type: "input" } },
            { id: "e2", start: { id: "l", type: "output" }, end: { id: "s", type: "input" } },
        ],
    };
}

// ---------- 1. workflow list on empty store returns empty ----------

test("workflow-cli: list on an empty store returns 0 entries", async () => {
    // Each test gets its own runtime so the per-test
    // write state doesn't leak between sibling tests.
    // The `WorkflowStore` itself is per-runtime
    // (constructed in the runtime's constructor).
    const dir = mkdtempSync(join(tmpdir(), "ch-wf-cli-list-"));
    for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "workflows"]) {
        mkdirSync(join(dir, sub), { recursive: true });
    }
    const oldHome = process.env.CODINGHARNESS_HOME;
    process.env.CODINGHARNESS_HOME = dir;
    try {
        const runtime = new HarnessRuntime({ cwd: dir, ephemeral: true });
        const all = await runtime.workflowStore.list();
        assert.equal(all.length, 0, "list on an empty store returns 0 entries");
    } finally {
        if (oldHome === undefined) delete process.env.CODINGHARNESS_HOME;
        else process.env.CODINGHARNESS_HOME = oldHome;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

test("workflow-cli: list returns 1 entry after createOrUpdate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ch-wf-cli-list1-"));
    for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "workflows"]) {
        mkdirSync(join(dir, sub), { recursive: true });
    }
    const oldHome = process.env.CODINGHARNESS_HOME;
    process.env.CODINGHARNESS_HOME = dir;
    try {
        const runtime = new HarnessRuntime({ cwd: dir, ephemeral: true });
        await runtime.workflowStore.createOrUpdate({
            name: "Hello Workflow",
            nodes: [
                { id: "n1", text: "Trigger", x: 0, y: 0, type: "webhook-listener", category: "trigger", parameters: {} },
            ],
            edges: [],
        });
        const all = await runtime.workflowStore.list();
        assert.equal(all.length, 1);
        assert.equal(all[0]!.name, "Hello Workflow");
    } finally {
        if (oldHome === undefined) delete process.env.CODINGHARNESS_HOME;
        else process.env.CODINGHARNESS_HOME = oldHome;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

// ---------- 2. export + import round-trips a workflow ----------

test("workflow-cli: export + import round-trips a workflow with a fresh id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ch-wf-cli-rt-"));
    for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "workflows"]) {
        mkdirSync(join(dir, sub), { recursive: true });
    }
    const oldHome = process.env.CODINGHARNESS_HOME;
    process.env.CODINGHARNESS_HOME = dir;
    try {
        const runtime = new HarnessRuntime({ cwd: dir, ephemeral: true });
        const created = await runtime.workflowStore.createOrUpdate({
            name: "Round-trip test",
            nodes: [
                { id: "n1", text: "Trigger", x: 0, y: 0, type: "webhook-listener", category: "trigger", parameters: {} },
                { id: "n2", text: "LLM", x: 200, y: 0, type: "generate-with-ai-llm", category: "action", parameters: { prompt: "x" } },
            ],
            edges: [{ id: "e1", start: { id: "n1", type: "output" }, end: { id: "n2", type: "input" } }],
        });
        const env = await runtime.workflowStore.exportWorkflow(created.id);
        assert.equal(env.format, "share");
        assert.equal(env.version, 1);
        assert.equal(env.workflow.name, "Round-trip test");
        assert.equal(env.workflow.nodes.length, 2);
        // Round-trip through a file.
        const file = join(dir, "envelope.json");
        writeFileSync(file, JSON.stringify(env, null, 2), "utf-8");
        assert.ok(existsSync(file));
        const { readFileSync } = await import("node:fs");
        const parsed = JSON.parse(readFileSync(file, "utf-8"));
        const imported = await runtime.workflowStore.importWorkflow(parsed);
        assert.ok(imported.id.length > 0);
        assert.notEqual(imported.id, created.id, "import always assigns a fresh id");
        assert.equal(imported.name, "Round-trip test");
        assert.equal(imported.nodes.length, 2);
        // Verify the new record is queryable.
        const reread = await runtime.workflowStore.get(imported.id);
        assert.equal(reread.id, imported.id);
        assert.equal(reread.name, "Round-trip test");
    } finally {
        if (oldHome === undefined) delete process.env.CODINGHARNESS_HOME;
        else process.env.CODINGHARNESS_HOME = oldHome;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

// ---------- 3. run a workflow returns the expected shape ----------

test("workflow-cli: run a 3-node linear workflow returns completed with steps=3 and cost>0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ch-wf-cli-run-"));
    for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "workflows"]) {
        mkdirSync(join(dir, sub), { recursive: true });
    }
    const oldHome = process.env.CODINGHARNESS_HOME;
    process.env.CODINGHARNESS_HOME = dir;
    try {
        const runtime = new HarnessRuntime({ cwd: dir, ephemeral: true });
        const rec = await runtime.workflowStore.createOrUpdate(makeLinearWorkflow());
        // Direct engine construction mirrors the
        // runtime's wiring but with an injected
        // provider. The runtime's `runWorkflow` would
        // need a configured provider on
        // `providerRegistry.default()`; we exercise
        // the engine path because it's the one the
        // `workflow` delegation kind uses internally
        // too (and is what the runtime's helper
        // delegates to).
        const linear = await runtime.workflowStore.get(rec.id);
        const provider = new StubProvider(["summary text"]);
        const engine = new WorkflowEngine(linear, {
            provider,
            model: "gpt-4o-mini",
            tools: defaultWorkflowToolRegistry(),
            triggerData: { trigger: { body: "hello" } },
        });
        const result = await engine._executeWorkflow();
        assert.equal(result.status, "completed");
        assert.equal(result.stepsRun, 3, "trigger + llm + stop = 3 distinct nodes");
        assert.ok(result.costUsd > 0, "cost should be recorded for the LLM call (got " + result.costUsd + ")");
        // `runWorkflow` runtime helper exists.
        assert.equal(typeof runtime.runWorkflow, "function");

        // Regression: a 0-node workflow should fail
        // fast with "no start nodes found".
        const empty = await runtime.workflowStore.createOrUpdate({
            name: "Empty",
            nodes: [],
            edges: [],
        });
        const emptyEngine = new WorkflowEngine(
            await runtime.workflowStore.get(empty.id),
            { tools: defaultWorkflowToolRegistry(), triggerData: {} },
        );
        const emptyResult = await emptyEngine._executeWorkflow();
        assert.equal(emptyResult.status, "failed");
        assert.match(emptyResult.error ?? "", /no start nodes/);
    } finally {
        if (oldHome === undefined) delete process.env.CODINGHARNESS_HOME;
        else process.env.CODINGHARNESS_HOME = oldHome;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

test("workflow-cli: runtime.runWorkflow with a missing id throws not_found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ch-wf-cli-missing-"));
    for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "workflows"]) {
        mkdirSync(join(dir, sub), { recursive: true });
    }
    const oldHome = process.env.CODINGHARNESS_HOME;
    process.env.CODINGHARNESS_HOME = dir;
    try {
        const runtime = new HarnessRuntime({ cwd: dir, ephemeral: true });
        let caught: Error | null = null;
        try {
            await runtime.runWorkflow("wf-does-not-exist");
        } catch (e) {
            caught = e as Error;
        }
        assert.ok(caught, "missing id should throw");
        assert.match(caught!.message, /workflow not found/);
    } finally {
        if (oldHome === undefined) delete process.env.CODINGHARNESS_HOME;
        else process.env.CODINGHARNESS_HOME = oldHome;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

// ---------- 4. /workflow slash command exercises the registry ----------

test("slash: /workflow is registered in BUILTIN_REGISTRY", async () => {
    const { BUILTIN_REGISTRY } = await import("../slash/builtin.js");
    const cmd = BUILTIN_REGISTRY.get("workflow");
    assert.ok(cmd, "/workflow should be registered");
    assert.equal(cmd!.name, "workflow");
    assert.match(cmd!.usage ?? "", /\/workflow/);
    // The command belongs to the "workflow" group so
    // the help / welcome output surfaces it next to
    // /goal and /loop.
    assert.equal(cmd!.group, "workflow");
});
