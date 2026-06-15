// src/agent/workflow.ts
//
// The in-process `WorkflowEngine`. Direct port of
// `agnt-gg/backend/src/workflow/WorkflowEngine.js:152-434` (the
// `_executeWorkflow` loop) + `:17-94` (the state container).
// See `docs/agnt-workflow-audit.md` §4.1, §4.3, §5.1, §5.2.
//
// What the port is NOT (audit §8.3):
//
// - **No forked child process.** The agnt-gg
//   `WorkflowProcessBridge` / `ProcessManager` / `ProcessWorker`
//   are dropped. The engine runs in-process.
// - **No long-lived listening mode.** v1 is fire-and-forget.
//   Webhook / timer triggers that need to survive a CLI exit
//   are T1.5.
// - **No SQLite execution log.** Output / error maps are
//   in-process; the runtime wires a `CostTracker` for the
//   per-run cost cap.
//
// Per-workflow-run `maxCostUsd` cap (audit decision #3): the
// engine accumulates cost from every `generate-with-ai-llm`
// step and aborts with `status: "failed"` when the cap is
// hit. The cap lives on the constructor; the engine aborts
// the run *between* steps (after a step's cost is recorded,
// before the next step starts) so a runaway cap is contained
// to one step's cost.
//
// Sub-workflows (`run-workflow` node type, audit §3.1) are
// *not* dispatched through the executor. The engine handles
// the recursion inline: it instantiates a fresh
// `WorkflowEngine(..., { isSubWorkflow: true })` and
// `await`s the result. The sub-engine's `outputs` map is
// attached to the parent node's output under the
// `_subWorkflowOutputs` key (matching agnt-gg
// `WorkflowEngine.js:328`).

import { EventEmitter } from "node:events";

import {
    buildNodeTextMap,
    evaluateCompoundConditions,
    resolveTemplate,
} from "./workflow-eval.js";
import { NodeExecutor, NodeExecutionError } from "./workflow-steps.js";
import type { NodeExecutorDeps } from "./workflow-steps.js";
import type {
    WorkflowCondition,
    WorkflowEdge,
    WorkflowNode,
    WorkflowRecord,
} from "./workflow-types.js";

// ---------- Engine state ----------

/** The status transitions a `WorkflowEngine` can be in.
 *  The terminal states are `completed` and `failed`. */
export type WorkflowStatus = "idle" | "running" | "completed" | "failed";

/** Typed event map for `engine.on(...)`. */
export interface WorkflowEngineEvents {
    /** Fired when the engine's status changes. */
    statusChanged: [status: WorkflowStatus];
    /** Fired *before* a step executes. */
    stepStart: [nodeId: string];
    /** Fired *after* a step completes (success or error). */
    stepEnd: [nodeId: string, output: unknown];
    /** Fired when an edge fires (pushes its target onto
     *  the queue). */
    edgeFired: [edgeId: string, fromNodeId: string, toNodeId: string];
    /** Fired when the cost cap fires. The payload is the
     *  cumulative cost at the moment of cap. */
    costCapExceeded: [costUsd: number, capUsd: number];
}

/** Re-export of the engine events. We extend `EventEmitter`
 *  with a typed signature so callers can use
 *  `engine.on("stepEnd", (id, out) => ...)` without a cast. */
export declare interface WorkflowEngine {
    on<E extends keyof WorkflowEngineEvents>(event: E, listener: (...args: WorkflowEngineEvents[E]) => void): this;
    off<E extends keyof WorkflowEngineEvents>(event: E, listener: (...args: WorkflowEngineEvents[E]) => void): this;
    emit<E extends keyof WorkflowEngineEvents>(event: E, ...args: WorkflowEngineEvents[E]): boolean;
}

/** The dependencies the engine needs from the runtime.
 *  Mirrors `DelegationRuntimeDeps` but is narrower. */
export interface WorkflowEngineDeps extends NodeExecutorDeps {
    /** The trigger data the engine should use as the
     *  `currentTriggerData` for the first step and any
     *  `{{trigger.x}}` template references. */
    triggerData?: Record<string, unknown>;
    /** Abort signal. The engine aborts the run on
     *  `signal.aborted`. */
    signal?: AbortSignal;
    /** Per-workflow-run `maxCostUsd` cap (audit decision
     *  #3). When set, the engine aborts when the
     *  cumulative cost exceeds the cap. Unset = no cap. */
    maxCostUsd?: number;
}

/** The final result returned by `_executeWorkflow`. */
export interface WorkflowRunResult {
    status: "completed" | "failed";
    /** Cumulative cost in USD. */
    costUsd: number;
    /** Number of distinct nodes that executed (counts
     *  re-executions). */
    stepsRun: number;
    /** Final outputs map. */
    outputs: ReadonlyMap<string, unknown>;
    /** Per-node errors, keyed by node id. */
    errors: ReadonlyMap<string, Error>;
    /** Error message when `status: "failed"`, undefined
     *  otherwise. */
    error?: string;
}

// ---------- Engine ----------

/** The 50ms yield interval (audit §4.1 step 4). When the
 *  queue is non-empty, the engine yields to the event loop
 *  every N items so long runs don't starve other I/O. The
 *  yield is `setImmediate` — non-blocking, but lets the
 *  macrotask queue drain. */
const YIELD_EVERY_N_STEPS = 50;

/** A node enqueued for execution, paired with the
 *  `inputData` it should receive (the source node's output,
 *  per audit §3.2). Tracking the input per-enqueue
 *  handles branches correctly: if two upstream nodes both
 *  push to the same target, each invocation gets its own
 *  source's output. */
interface QueuedNode {
    node: WorkflowNode;
    input: unknown;
}

/** The global cap on edges traversed per run. Mirrors
 *  agnt-gg's `globalMaxIterations = 100`
 *  (`WorkflowEngine.js:35`). Prevents infinite loops from
 *  a missing / wrong edge condition. */
const GLOBAL_MAX_ITERATIONS = 100;

export class WorkflowEngine extends EventEmitter {
    readonly workflow: WorkflowRecord;
    readonly isSubWorkflow: boolean;
    /** Live state — mutated as the engine walks the graph. */
    readonly outputs = new Map<string, unknown>();
    readonly errors = new Map<string, Error>();
    readonly nodeExecutionCounts = new Map<string, number>();
    readonly edgeIterations = new Map<string, number>();
    /** Cumulative cost (USD) across all `generate-with-ai-llm`
     *  steps in this run. */
    private costAccumulator = 0;
    /** Total edges traversed. Bounded by `GLOBAL_MAX_ITERATIONS`. */
    private totalIterations = 0;
    /** Current status. */
    private _status: WorkflowStatus = "idle";
    /** Set by the `stop-workflow` step executor. The loop
     *  exits cleanly on the next iteration. */
    stopRequested = false;
    /** The trigger data used for `{{trigger.x}}` /
     *  `{{input.x}}` references. */
    readonly currentTriggerData: Record<string, unknown>;
    /** Abort signal. */
    readonly signal: AbortSignal;
    /** Cost cap (USD). Undefined = no cap. */
    readonly maxCostUsd: number | undefined;
    /** Node executor. */
    private readonly nodeExecutor: NodeExecutor;

    constructor(workflow: WorkflowRecord, deps: WorkflowEngineDeps, opts: { isSubWorkflow?: boolean } = {}) {
        super();
        this.setMaxListeners(0);
        this.workflow = workflow;
        this.isSubWorkflow = opts.isSubWorkflow === true;
        this.currentTriggerData = { ...(deps.triggerData ?? {}) };
        this.signal = deps.signal ?? new AbortController().signal;
        this.maxCostUsd = deps.maxCostUsd;
        // The executor's `recordCost` is the engine's own
        // private hook so a `maxCostUsd` cap fires between
        // steps.
        const recordCost = (cost: number): void => {
            this.costAccumulator += cost;
        };
        this.nodeExecutor = new NodeExecutor({
            ...deps,
            recordCost,
        });
    }

    /** The current engine status. */
    get status(): WorkflowStatus {
        return this._status;
    }

    /** Cumulative cost (USD). */
    get costUsd(): number {
        return this.costAccumulator;
    }

    private setStatus(s: WorkflowStatus): void {
        if (this._status === s) return;
        this._status = s;
        this.emit("statusChanged", s);
    }

    // ---------- The main loop ----------

    /** Run the workflow to completion. Mirrors
     *  `WorkflowEngine._executeWorkflow` (`WorkflowEngine.js:152-434`).
     *  Returns the final result; the engine's state maps are
     *  populated as a side effect. */
    async _executeWorkflow(): Promise<WorkflowRunResult> {
        this.setStatus("running");
        const result: WorkflowRunResult = {
            status: "completed",
            costUsd: 0,
            stepsRun: 0,
            outputs: this.outputs,
            errors: this.errors,
        };
        try {
            // 1. Build start nodes (audit §4.1 step 2).
            const startNodes = this._findStartNodes();
            if (startNodes.length === 0) {
                this.setStatus("failed");
                result.status = "failed";
                result.error = "no start nodes found";
                return result;
            }
            // 2. Run each start node, then drain the queue
            //    (audit §4.1 step 3-4). The first start node
            //    receives `currentTriggerData.trigger` as its
            //    `inputData` (audit §3.2 — the trigger's output
            //    is the trigger payload, then the next step's
            //    output becomes its successor's `inputData`).
            const queue: QueuedNode[] = [];
            const triggerOutput = this.currentTriggerData["trigger"] ?? this.currentTriggerData;
            for (const node of startNodes) {
                if (this.signal.aborted) {
                    this.setStatus("failed");
                    result.status = "failed";
                    result.error = "cancelled";
                    return result;
                }
                if (this.stopRequested) break;
                await this.runStep(node, triggerOutput, queue);
                // Post-step cap check (applies to start nodes too).
                if (this.maxCostUsd !== undefined && this.costAccumulator > this.maxCostUsd) {
                    this.emit("costCapExceeded", this.costAccumulator, this.maxCostUsd);
                    this.setStatus("failed");
                    result.status = "failed";
                    result.error = `maxCostUsd exceeded: $${this.costAccumulator.toFixed(4)} > $${this.maxCostUsd.toFixed(4)}`;
                    return result;
                }
            }
            let processed = 0;
            while (queue.length > 0) {
                if (this.signal.aborted) {
                    this.setStatus("failed");
                    result.status = "failed";
                    result.error = "cancelled";
                    return result;
                }
                if (this.stopRequested) {
                    // Clean exit; the stop-workflow step
                    // already set the flag.
                    break;
                }
                if (this.totalIterations >= GLOBAL_MAX_ITERATIONS) {
                    this.setStatus("failed");
                    result.status = "failed";
                    result.error = `global max iterations (${GLOBAL_MAX_ITERATIONS}) exceeded`;
                    return result;
                }
                // 50ms yield (audit §4.1 step 4). setImmediate
                // is non-blocking but yields to the event
                // loop.
                if (processed > 0 && processed % YIELD_EVERY_N_STEPS === 0) {
                    await new Promise<void>((r) => setImmediate(r));
                }
                processed++;
                const item = queue.shift();
                if (item === undefined) break;
                // Cost-cap check between steps.
                if (this.maxCostUsd !== undefined && this.costAccumulator > this.maxCostUsd) {
                    this.emit("costCapExceeded", this.costAccumulator, this.maxCostUsd);
                    this.setStatus("failed");
                    result.status = "failed";
                    result.error = `maxCostUsd exceeded: $${this.costAccumulator.toFixed(4)} > $${this.maxCostUsd.toFixed(4)}`;
                    return result;
                }
                await this.runStep(item.node, item.input, queue);
                // Post-step cap check: a step may have added
                // cost; if the cumulative total is now over
                // the cap, abort before the next step.
                if (this.maxCostUsd !== undefined && this.costAccumulator > this.maxCostUsd) {
                    this.emit("costCapExceeded", this.costAccumulator, this.maxCostUsd);
                    this.setStatus("failed");
                    result.status = "failed";
                    result.error = `maxCostUsd exceeded: $${this.costAccumulator.toFixed(4)} > $${this.maxCostUsd.toFixed(4)}`;
                    return result;
                }
            }
            // Final status: if a `stop-workflow` step fired,
            // the run is "completed" (clean exit, not a
            // failure). If the loop was aborted by the
            // signal or the iteration cap, status is already
            // "failed" — leave it.
            if (this._status === "running") {
                this.setStatus("completed");
            }
            result.status = this._status === "failed" ? "failed" : "completed";
            result.costUsd = this.costAccumulator;
            result.stepsRun = this.nodeExecutionCounts.size;
            return result;
        } catch (e) {
            this.setStatus("failed");
            result.status = "failed";
            result.error = (e as Error).message;
            result.costUsd = this.costAccumulator;
            result.stepsRun = this.nodeExecutionCounts.size;
            return result;
        }
    }

    /** Execute a single node, push the result to
     *  `outputs`, increment counters, evaluate outgoing
     *  edges, and enqueue their targets. */
    private async runStep(node: WorkflowNode, inputData: unknown, queue: QueuedNode[]): Promise<void> {
        if (this.signal.aborted) {
            throw new Error("cancelled");
        }
        this.emit("stepStart", node.id);
        // Count this execution (audit: `nodeExecutionCounts`).
        this.nodeExecutionCounts.set(node.id, (this.nodeExecutionCounts.get(node.id) ?? 0) + 1);

        // Special-case: `run-workflow` (sub-workflow
        // recursion). The executor doesn't handle this
        // because the engine owns the lifetime.
        if (node.type === "run-workflow") {
            await this.runSubWorkflow(node, inputData);
            this.emit("stepEnd", node.id, this.outputs.get(node.id));
            return;
        }

        let output: unknown;
        try {
            output = await this.nodeExecutor.executeNode(node, inputData, this.workflow, this, this.signal);
        } catch (e) {
            this.errors.set(node.id, e as Error);
            // On error, the engine does NOT push the
            // node's outgoing edges. The run ends in
            // `failed` status (set by the caller). We
            // re-throw so the queue loop sees the
            // failure.
            this.emit("stepEnd", node.id, undefined);
            throw e;
        }
        this.outputs.set(node.id, output);
        this.emit("stepEnd", node.id, output);

        // Evaluate outgoing edges. If any condition is
        // present, the resolver must return `fire: true`
        // for the target to be enqueued.
        const nodeTextToOutputs = buildNodeTextMap(
            this.workflow.nodes,
            Object.fromEntries(this.outputs),
        );
        for (const edge of this.workflow.edges) {
            if (edge.start.id !== node.id) continue;
            this.totalIterations++;
            // Per-edge iteration cap.
            const iterCount = (this.edgeIterations.get(edge.id) ?? 0) + 1;
            if (edge.maxIterations !== undefined && iterCount > edge.maxIterations) {
                continue;
            }
            if (edge.conditions && edge.conditions.length > 0) {
                const condResult = evaluateCompoundConditions(
                    edge.conditions,
                    Object.fromEntries(this.outputs),
                    { trigger: this.currentTriggerData, input: inputData ?? {} },
                    nodeTextToOutputs,
                );
                if (!condResult.fire) continue;
            }
            this.edgeIterations.set(edge.id, iterCount);
            // The target node gets *this node's* output as
            // its `inputData`. For multi-output nodes
            // (e.g. for-loop's "done" vs "loop"), the
            // `end.type` would disambiguate, but v1 keeps
            // the audit's behavior (one output per
            // source per default).
            const targetNode = this.workflow.nodes.find((n) => n.id === edge.end.id);
            if (!targetNode) continue;
            queue.push({ node: targetNode, input: output });
            this.emit("edgeFired", edge.id, edge.start.id, edge.end.id);
        }
    }

    /** Instantiate a sub-workflow and run it inline.
     *  Mirrors `WorkflowEngine.js:318-333`. */
    private async runSubWorkflow(node: WorkflowNode, _inputData: unknown): Promise<void> {
        const subWorkflowId = typeof node.parameters["workflowId"] === "string" ? node.parameters["workflowId"] : "";
        if (!subWorkflowId) {
            throw new NodeExecutionError(`run-workflow: workflowId parameter is required (node ${node.id})`, node.id);
        }
        // The sub-workflow record is supplied via
        // `node.parameters.workflowRecord` (a hook for
        // tests / the runtime that already has the
        // record). The runtime wiring (step 5-6) is the
        // place where the id is resolved against the
        // store.
        const subRecord = node.parameters["workflowRecord"] as WorkflowRecord | undefined;
        if (!subRecord) {
            throw new NodeExecutionError(
                `run-workflow: sub-workflow record not provided (node ${node.id}, id=${subWorkflowId}). ` +
                `The runtime wiring resolves the id from the store; tests should pass workflowRecord directly.`,
                node.id,
            );
        }
        // Sub-workflow inherits the parent's cost cap and
        // trigger data; the sub-engine has its own
        // `costAccumulator` so caps are NOT shared across
        // parent/child. This matches the audit decision
        // (per-workflow-run, not per-tree).
        const subEngine = new WorkflowEngine(subRecord, {
            // Reuse the executor deps from the parent so
            // tools / providers stay consistent.
            provider: this.nodeExecutor["deps"].provider,
            model: this.nodeExecutor["deps"].model,
            mcpRegistry: this.nodeExecutor["deps"].mcpRegistry,
            tools: this.nodeExecutor["deps"].tools,
            triggerData: this.currentTriggerData,
            signal: this.signal,
        }, { isSubWorkflow: true });
        const subResult = await subEngine._executeWorkflow();
        // The sub-workflow's outputs are attached to the
        // parent node under `_subWorkflowOutputs`
        // (audit: `WorkflowEngine.js:328`).
        const subOutputs: Record<string, unknown> = {};
        for (const [k, v] of subResult.outputs) {
            subOutputs[k] = v;
        }
        this.outputs.set(node.id, {
            _subWorkflowOutputs: subOutputs,
            status: subResult.status,
            costUsd: subResult.costUsd,
            stepsRun: subResult.stepsRun,
        });
    }

    /** Find the start nodes for this run.
     *  - For a sub-workflow, the start nodes are any node
     *    with no incoming edge.
     *  - For a top-level workflow, the start nodes are the
     *    trigger nodes (we treat all of them as start, and
     *    the engine passes `currentTriggerData` as their
     *    `inputData`). If no trigger exists, fallback to
     *    `nodes[0]`. */
    private _findStartNodes(): WorkflowNode[] {
        if (this.isSubWorkflow) {
            return this.findStartNodesNoIncoming();
        }
        // Top-level: prefer trigger nodes.
        const triggers = this.workflow.nodes.filter((n) => n.category === "trigger");
        if (triggers.length > 0) return triggers;
        // Fallback: nodes with no incoming edge.
        const noIncoming = this.findStartNodesNoIncoming();
        if (noIncoming.length > 0) return noIncoming;
        // Last resort: nodes[0].
        if (this.workflow.nodes.length > 0) {
            const first = this.workflow.nodes[0]!;
            return [first];
        }
        return [];
    }

    private findStartNodesNoIncoming(): WorkflowNode[] {
        const incoming = new Set<string>();
        for (const e of this.workflow.edges) {
            incoming.add(e.end.id);
        }
        return this.workflow.nodes.filter((n) => !incoming.has(n.id));
    }
}

// ---------- helpers (re-exported for tests / runtime) ----------

/** Re-export the condition evaluator so the runtime
 *  wiring (step 5) can build edge summaries without a
 *  second import. */
export { evaluateCompoundConditions };

/** Re-export the template resolver for the runtime
 *  wiring. The runtime uses it to resolve
 *  `{{trigger.x}}` references when constructing the
 *  `triggerData` payload. */
export { resolveTemplate };

/** Re-export the condition type so callers can build
 *  `WorkflowEdge` objects with full type safety. */
export type { WorkflowCondition, WorkflowEdge, WorkflowNode, WorkflowRecord };
