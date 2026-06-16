// src/agent/workflow-steps.ts
//
// Node executor + `WorkflowToolRegistry`. Direct port of
// `agnt-gg/backend/src/workflow/NodeExecutor.js` (audit §3.1).
// The executor is the dispatch layer that turns a
// `WorkflowNode` into a runtime call. The v1 surface is
// intentionally narrow — we ship the 4 most-used types from
// the audit's open question #1 table:
//
//   `generate-with-ai-llm`  → call the configured provider
//   `execute-javascript`    → run a JS snippet (sandboxed)
//   `mcp-client`            → call a registered MCP server tool
//   `stop-workflow`         → sets `engine.stopRequested = true`
//
// All other `action` / `utility` / `widget` / `control` types
// hard-fail with "type not implemented in v1: <node.type>" at
// execution time. The `toolLibrary.json` validator already
// warns on save (audit §6.3); the executor makes the failure
// explicit. T1.5 follow-ups can register more types in the
// `WorkflowToolRegistry` without touching the engine.
//
// The `run-workflow` case (sub-workflow invocation) is
// special-cased at the engine level — the executor is *not*
// involved. See `workflow.ts::_executeWorkflow` for the
// `isSubWorkflow=true` branch.
//
// The `WorkflowToolRegistry` is a narrow registry parallel to
// `McpRegistry` (audit §1 Q1 decision: "reuse `McpRegistry`
// for the `mcp` node type; new `WorkflowToolRegistry` for the
// built-in actions"). The split is deliberate: `McpRegistry`
// is the *external* MCP boundary; `WorkflowToolRegistry` is
// the *built-in* action boundary. They don't share an
// interface because their error semantics differ (MCP
// transports can be flaky; built-in actions should be
// deterministic).

import { runInNewContext, type Context } from "node:vm";

import { callCost } from "./cost.js";
import { resolveTemplate, buildNodeTextMap } from "./workflow-eval.js";
import type { McpCallResult, McpRegistry } from "./delegation.js";
import type { Provider, ProviderRequest, ProviderStreamEvent } from "../types.js";
import type { ChatMessage } from "../types.js";
import type {
    WorkflowNode,
    WorkflowRecord,
} from "./workflow-types.js";
import type { WorkflowEngine } from "./workflow.js";

// ---------- Errors ----------

/** Thrown by `NodeExecutor` when a step fails. The engine
 *  catches it, records it in `engine.errors[nodeId]`, and
 *  continues to the next eligible edge (or aborts the run
 *  if `engine.stopOnError` is true, per the audit's
 *  semantics). */
export class NodeExecutionError extends Error {
    constructor(message: string, public readonly nodeId: string) {
        super(message);
        this.name = "NodeExecutionError";
    }
}

// ---------- Tool registry ----------

/** The shape of a built-in workflow tool. Pure async — the
 *  engine awaits the return. Throwing inside a tool surfaces
 *  as a `NodeExecutionError` (caught by the engine). */
export type WorkflowToolFn = (input: {
    /** Post-template-resolution parameters from the node. */
    params: Record<string, unknown>;
    /** The previous step's output, or the trigger data for
     *  the first step. */
    inputData: unknown;
    /** The full workflow record. Read-only. */
    workflow: WorkflowRecord;
    /** The live engine — for `stop-workflow` and cost-cap
     *  checks. */
    engine: WorkflowEngine;
    /** Abort signal. */
    signal: AbortSignal;
}) => Promise<unknown>;

/** Narrow registry for built-in workflow actions. Mirrors
 *  `McpRegistry`'s shape — list + get — but `get` returns a
 *  tool *function*, not a transport call. */
export class WorkflowToolRegistry {
    private tools = new Map<string, { category: string; fn: WorkflowToolFn }>();

    /** Register a built-in action. `category` is the
     *  `node.category` the tool accepts (e.g. `"action"`,
     *  `"utility"`, `"custom"`). */
    register(type: string, category: string, fn: WorkflowToolFn): void {
        this.tools.set(type, { category, fn });
    }

    /** Get a tool by `node.type`. Returns `undefined` when
     *  the type is unknown. The caller decides whether to
     *  throw or fall back. */
    get(type: string): { category: string; fn: WorkflowToolFn } | undefined {
        return this.tools.get(type);
    }

    /** List all registered type names. Useful for the TUI /
     *  REPL node-palette. */
    list(): string[] {
        return [...this.tools.keys()];
    }
}

// ---------- Executor ----------

/** Dependencies the executor needs. The engine holds the
 *  singleton instance and threads it into every step. */
export interface NodeExecutorDeps {
    /** Provider registry, looked up by `params.provider`
     *  (default: the engine's active provider). */
    provider?: Provider;
    model?: string;
    /** MCP registry, for the `mcp-client` node type. */
    mcpRegistry?: McpRegistry;
    /** The runtime's `WorkflowToolRegistry`. The
     *  `defaultWorkflowToolRegistry()` factory wires the v1
     *  built-ins; tests can inject a stripped-down one. */
    tools: WorkflowToolRegistry;
    /** Optional callback to record a model call's cost
     *  (USD). When unset, the executor logs the call but
     *  doesn't update any accumulator. The engine wires
     *  this to its own `costAccumulator` so a `maxCostUsd`
     *  cap can fire. */
    recordCost?: (cost: number) => void;
}

/** The executor. One instance per engine. */
export class NodeExecutor {
    constructor(private readonly deps: NodeExecutorDeps) {}

    /** The executor's deps. Read-only public accessor used
     *  by the engine's `runSubWorkflow` to thread the
     *  parent's `provider` / `mcpRegistry` / `tools` into
     *  the child engine. Without this, the engine would
     *  have to do `this.nodeExecutor["deps"]` (private
     *  bracket-access), which compiles under `private`
     *  only because TypeScript's `private` is a compile-time
     *  hint. */
    getDep<K extends keyof NodeExecutorDeps>(key: K): NodeExecutorDeps[K] {
        return this.deps[key];
    }

    /** Execute a single node. Returns the step's output
     *  (shape per the `toolLibrary.json` entry's `outputs`
     *  schema). Throws `NodeExecutionError` on any failure.
     *  `engine` is a back-reference for `stop-workflow` and
     *  for the tool fns that need to inspect engine state
     *  (e.g. cost cap). */
    async executeNode(
        node: WorkflowNode,
        inputData: unknown,
        workflow: WorkflowRecord,
        engine: WorkflowEngine,
        signal: AbortSignal,
    ): Promise<unknown> {
        switch (node.category) {
            case "trigger":
                return executeTrigger(node, inputData);
            case "custom":
                return this.executeCustom(node, inputData, workflow, engine, signal);
            case "control":
                // The `stop-workflow` node type is a built-in
                // terminator in the `control` category. We
                // handle it inline (the alternative is a
                // registry lookup for a one-liner, and the
                // `stopRequested` mutation needs the engine
                // back-reference anyway). Any other control
                // type is unimplemented in v1 — the throw
                // here matches `executeCustom`'s error
                // message so the user sees the same shape
                // regardless of which arm matched.
                if (node.type === "stop-workflow") {
                    engine.stopRequested = true;
                    return { stopped: true, reason: typeof node.parameters["reason"] === "string" ? node.parameters["reason"] : "" };
                }
                throw new NodeExecutionError(
                    `type not implemented in v1: ${node.type} (category: ${node.category}). Add it to the WorkflowToolRegistry.`,
                    node.id,
                );
            case "action":
            case "utility":
            case "widget":
            case "mcp":
                return this.executeCustom(node, inputData, workflow, engine, signal);
            default:
                throw new NodeExecutionError(
                    `unknown node category: ${String((node as { category: unknown }).category)}`,
                    node.id,
                );
        }
    }

    /** Dispatch by `node.type` via the `WorkflowToolRegistry`
     *  or, for the `mcp-client` category, via the
     *  `McpRegistry`. */
    private async executeCustom(
        node: WorkflowNode,
        inputData: unknown,
        workflow: WorkflowRecord,
        engine: WorkflowEngine,
        signal: AbortSignal,
    ): Promise<unknown> {
        // MCP short-circuit. The `mcp-client` node type
        // resolves through the `McpRegistry` (not the
        // `WorkflowToolRegistry`) per audit §3.1.
        if (node.category === "mcp" || node.type === "mcp-client") {
            return executeMcpClient(node, inputData, this.deps.mcpRegistry, signal);
        }
        // The `execute-javascript` node type is a built-in
        // action (utility category) and resolves through
        // the `WorkflowToolRegistry` — but we also fall
        // back to the *inline* implementation if the
        // registry doesn't carry it, so the v1 stub
        // works out-of-the-box without the caller having
        // to register anything.
        if (node.type === "execute-javascript") {
            return executeJavaScriptTool(node, inputData);
        }
        // `stop-workflow` is handled by `executeNode` (the
        // switch above) before this method runs, but
        // some legacy workflows set `category: "action"`
        // on a `stop-workflow` node. We re-check here.
        if (node.type === "stop-workflow") {
            engine.stopRequested = true;
            return { stopped: true };
        }
        // `generate-with-ai-llm` is also a built-in; we
        // could register it in the default registry, but
        // the inline impl keeps the cost-tracking path
        // close to the executor's `recordCost` callback
        // without a registry indirection.
        if (node.type === "generate-with-ai-llm") {
            return executeGenerateWithAiLlm(node, inputData, this.deps, signal);
        }
        // Generic path: look up in the WorkflowToolRegistry.
        const entry = this.deps.tools.get(node.type);
        if (!entry) {
            throw new NodeExecutionError(
                `type not implemented in v1: ${node.type} (category: ${node.category}). Add it to the WorkflowToolRegistry.`,
                node.id,
            );
        }
        // Template resolution for the generic tool path.
        // The agnt-gg `NodeExecutor` runs every node's
        // `node.parameters` through
        // `parameterResolver.resolveParameters` before
        // dispatching (`NodeExecutor.js:145`). The v1 port
        // inlines that resolution for the two built-in
        // types that read params as strings
        // (`generate-with-ai-llm` for the `prompt`,
        // `execute-javascript` reads `code` raw — see
        // "Known fixture/engine mismatch" comment in
        // `workflow-e2e.test.ts`). For the
        // `WorkflowToolRegistry` path we walk the
        // `params` object and resolve every string value
        // through `resolveTemplate`, using the
        // already-executed nodes' outputs as the lookup
        // source. The `nodeTextToOutputs` fallback is
        // built lazily per call (audit §7 #4 — nodeId is
        // primary; nodeText is a fallback for agnt-gg
        // imports). Recursion is bounded — a
        // self-referencing `{{nodeA.x}}` in a param of
        // `nodeA` would not loop because `nodeA`'s
        // output is not yet in `engine.outputs` at the
        // time we resolve. For a node that depends on
        // its own prior output (e.g. a loop body's
        // first iteration), the prior execution's
        // output is in the map.
        const outputs = Object.fromEntries(engine.outputs);
        const nodeTextToOutputs = buildNodeTextMapForResolve(workflow.nodes, outputs);
        const resolvedParams = resolveParams(
            node.parameters,
            outputs,
            engine.currentTriggerData,
            nodeTextToOutputs,
        );
        return entry.fn({
            params: resolvedParams,
            inputData,
            workflow,
            engine,
            signal,
        });
    }
}

// ---------- Trigger ----------

/** Execute a `trigger` node. For v1, the trigger is a
 *  no-op whose output is the `inputData` (the engine has
 *  already validated the trigger and assembled the
 *  `currentTriggerData`). We only pass through and tag
 *  the result so downstream nodes can detect "this is the
 *  trigger's output". The `validate()` step is the
 *  engine's job (it builds start nodes from triggers that
 *  pass `validate()`; for the manual trigger that's
 *  always-true, the engine just emits the trigger
 *  data). */
function executeTrigger(node: WorkflowNode, inputData: unknown): unknown {
    return {
        ...(inputData !== undefined && typeof inputData === "object" ? inputData as Record<string, unknown> : {}),
        _triggerNodeId: node.id,
    };
}

// ---------- generate-with-ai-llm ----------

/** Run a single LLM call. Resolves the provider/model from
 *  the node params, sends a single user-turn request, and
 *  returns `{ generatedText, tokenCount, error }`. Cost is
 *  recorded via `deps.recordCost` (so the engine's
 *  `maxCostUsd` cap can fire). */
async function executeGenerateWithAiLlm(
    node: WorkflowNode,
    inputData: unknown,
    deps: NodeExecutorDeps,
    signal: AbortSignal,
): Promise<unknown> {
    const provider = deps.provider;
    if (!provider) {
        return { generatedText: "", tokenCount: 0, error: "no provider wired" };
    }
    const params = node.parameters;
    const model = (typeof params["model"] === "string" && params["model"]) || deps.model || "";
    const promptRaw = typeof params["prompt"] === "string" ? params["prompt"] : "";
    // Resolve `{{trigger.x}}` / `{{nodeId.x}}` references
    // in the prompt. The `inputData` for the LLM step is
    // passed via the `{{input.x}}` prefix.
    const prompt = resolveTemplate(promptRaw, {}, { input: inputData ?? {} }, {});
    const maxTokens = typeof params["maxTokens"] === "string" ? Number(params["maxTokens"]) :
        typeof params["maxTokens"] === "number" ? params["maxTokens"] : undefined;
    const temperature = typeof params["temperature"] === "string" ? Number(params["temperature"]) :
        typeof params["temperature"] === "number" ? params["temperature"] : undefined;
    const messages: ChatMessage[] = [{ role: "user", content: typeof prompt === "string" ? prompt : String(prompt ?? "") }];
    const req: ProviderRequest = {
        model,
        messages,
        ...(maxTokens !== undefined && Number.isFinite(maxTokens) ? { maxTokens } : {}),
        ...(temperature !== undefined && Number.isFinite(temperature) ? { temperature } : {}),
        signal,
    };
    let text = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    try {
        for await (const ev of provider.stream(req)) {
            if (ev.type === "text" && typeof ev.text === "string") {
                text += ev.text;
            } else if (ev.type === "usage" && ev.usage) {
                usage = ev.usage;
            } else if (ev.type === "error") {
                return { generatedText: "", tokenCount: 0, error: ev.error?.message ?? "provider error" };
            }
        }
    } catch (e) {
        return { generatedText: "", tokenCount: 0, error: (e as Error).message };
    }
    // Record cost if the executor was wired with a callback.
    if (deps.recordCost && model) {
        const cost = callCost(model, usage.inputTokens, usage.outputTokens);
        try { deps.recordCost(cost); } catch { /* never let cap-check throw inside a step */ }
    }
    return { generatedText: text, tokenCount: usage, error: "" };
}

// ---------- execute-javascript ----------

/** Run a JS snippet in a fresh VM context with the
 *  previous step's output bound to `input`. Returns
 *  `{ result, error }`. The VM context is created
 *  per-call (no shared state between calls) and the
 *  timeout is a hard cap on the call. The snippet's
 *  return value is JSON-serialized so it can be passed
 *  to the next step. */
async function executeJavaScriptTool(node: WorkflowNode, inputData: unknown): Promise<unknown> {
    const code = typeof node.parameters["code"] === "string" ? node.parameters["code"] : "";
    const timeoutMs = typeof node.parameters["timeoutMs"] === "number" ? node.parameters["timeoutMs"] : 5_000;
    if (!code) {
        return { result: null, error: "no code provided" };
    }
    const ctx: Context = {
        input: inputData,
        console: { log: () => { /* swallow */ }, error: () => { /* swallow */ } },
    };
    try {
        const result = await runInNewContext(`(async () => { return (${code}); })()`, ctx, { timeout: timeoutMs, displayErrors: false });
        return { result, error: "" };
    } catch (e) {
        return { result: null, error: (e as Error).message };
    }
}

// ---------- mcp-client ----------

/** Resolve the `mcp-client` node into a single MCP tool
 *  call. Mirrors `runMcpKind` in `src/agent/delegation.ts`
 *  but as a *plain async function* (no event emission, no
 *  AbortController plumbing beyond a signal). The shape
 *  `{ result, error }` is the engine's contract. */
async function executeMcpClient(
    node: WorkflowNode,
    _inputData: unknown,
    registry: McpRegistry | undefined,
    signal: AbortSignal,
): Promise<unknown> {
    if (!registry) {
        return { result: null, error: "no MCP registry wired" };
    }
    const params = node.parameters;
    const serverId = typeof params["serverId"] === "string" ? params["serverId"] : "";
    const tool = typeof params["tool"] === "string" ? params["tool"] : "";
    const args = (typeof params["args"] === "object" && params["args"] !== null && !Array.isArray(params["args"]))
        ? params["args"] as Record<string, unknown>
        : {};
    if (!serverId || !tool) {
        return { result: null, error: "mcp-client: serverId and tool are required" };
    }
    let r: McpCallResult;
    try {
        r = await registry.callTool(serverId, tool, args, { signal });
    } catch (e) {
        return { result: null, error: (e as Error).message };
    }
    if (!r.ok) {
        return { result: null, error: r.error ?? "MCP tool call failed" };
    }
    return { result: r.output, error: "" };
}

// ---------- default registry ----------

/** Build a `WorkflowToolRegistry` with the v1 built-in
 *  actions. Currently empty — all v1 types are inlined in
 *  `executeCustom`. The registry exists as the extension
 *  point for T1.5 to add more types without touching the
 *  engine. */
export function defaultWorkflowToolRegistry(): WorkflowToolRegistry {
    return new WorkflowToolRegistry();
}

// ---------- helpers (re-exported for the engine) ----------

/** Re-export the ProviderStreamEvent type so the engine
 *  can reference it without a second import path. We
 *  intentionally keep the alias narrow — anything more
 *  would couple the engine to provider internals. */
export type { ProviderStreamEvent };

// ---------- params template resolution (generic tool path) ----------

/** Wrapper around `buildNodeTextMap` so the executor's
 *  template-resolution pass uses the same nodeText map
 *  builder the engine's edge evaluator uses. Kept as a
 *  function for stack-trace clarity in error reports
 *  (the call site reads "we are resolving tool params"
 *  not "we are evaluating an edge condition"). */
function buildNodeTextMapForResolve(
    nodes: ReadonlyArray<WorkflowNode>,
    outputs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    return buildNodeTextMap(nodes, outputs);
}

/** Walk a `node.parameters` object and resolve every
 *  string value through `resolveTemplate`. Non-string
 *  values pass through unchanged. Objects and arrays
 *  are walked recursively so deeply-nested params
 *  (e.g. `args: { foo: "{{x}}" }` on an `mcp-client`
 *  node) are also resolved.
 *
 *  The resolution is bounded: a `{{self}}` reference
 *  inside a node's own params would not loop because
 *  the current node's output is not yet in
 *  `engine.outputs` at the time we resolve. Loops
 *  re-execute after the first pass writes back into
 *  `engine.outputs`, so subsequent iterations see the
 *  resolved values. */
function resolveParams(
    params: Record<string, unknown>,
    outputs: Readonly<Record<string, unknown>>,
    currentTriggerData: Readonly<Record<string, unknown>>,
    nodeTextToOutputs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
        out[k] = resolveValue(v, outputs, currentTriggerData, nodeTextToOutputs);
    }
    return out;
}

function resolveValue(
    v: unknown,
    outputs: Readonly<Record<string, unknown>>,
    currentTriggerData: Readonly<Record<string, unknown>>,
    nodeTextToOutputs: Readonly<Record<string, unknown>>,
): unknown {
    if (typeof v === "string") {
        // If the string has no `{{`, short-circuit to
        // avoid the regex pass.
        if (!v.includes("{{")) return v;
        return resolveTemplate(v, outputs, currentTriggerData, nodeTextToOutputs);
    }
    if (Array.isArray(v)) {
        return v.map((item) => resolveValue(item, outputs, currentTriggerData, nodeTextToOutputs));
    }
    if (v !== null && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
            out[k] = resolveValue(item, outputs, currentTriggerData, nodeTextToOutputs);
        }
        return out;
    }
    return v;
}
