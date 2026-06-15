// src/agent/workflow-types.ts
//
// Workflow DSL types, synthesized from `docs/agnt-workflow-audit.md` §2.2-2.4
// (the agnt-gg `backend/src/stream/example_workflows/*.json` shape). The
// types describe a single workflow: the top-level record, the graph
// vertices (nodes), the graph edges (with optional conditions and
// iteration caps), and the condition operator vocabulary.
//
// Design notes:
//
// - `WorkflowNode.outputs` is a *schema*, not a value (audit §2.3).
//   It describes the shape the node will produce, used by the canvas
//   UI to render edge condition editors. Real values live in
//   `WorkflowEngine.outputs[nodeId]` at runtime. We type it as
//   `Record<string, unknown>` because the schema shape is open
//   (per-node `outputs` keys are free-form).
//
// - Node `id` is the stable identifier (audit §7 #4 — we use IDs
//   over names for template references). `text` is the human label
//   and is NOT guaranteed unique; template resolver falls back to
//   `text` for agnt-gg-imported workflows.
//
// - `WorkflowEdge.start` / `end` are { id, type: "output" | "input" }
//   connection points. `type` distinguishes which input/output
//   handle on the node is being connected (multi-output and
//   multi-input nodes are common — e.g. `for-loop` has a `done` and
//   a `loop` output). For the v1 port we treat them as opaque
//   strings; the executor will resolve by `(targetNodeId, type)`.
//
// - `WorkflowCondition` covers all 10 operators from audit §4.3
//   (`is_empty`, `is_not_empty`, `equals`, `not_equals`,
//   `greater_than`, `less_than`, `greater_than_or_equal`,
//   `less_than_or_equal`, `contains`, `not_contains`). The
//   operator discriminator is `condition`; `value` is omitted for
//   the unary `is_empty` / `is_not_empty` operators.
//
// - Strict mode: `noUncheckedIndexedAccess` is on. All optional
//   fields are `?:`; all `Record<string, X>` values carry `| undefined`
//   semantics implicitly via index access. No `any`.

/** The closed vocabulary of node categories. The agnt-gg engine
 *  dispatches by `category` first, then resolves the concrete
 *  `type` via the tool library. See audit §3.1. */
export type WorkflowNodeCategory =
    | "trigger"
    | "action"
    | "utility"
    | "control"
    | "widget"
    | "custom"
    | "mcp";

/** The 10 edge condition operators. See audit §4.3. */
export type WorkflowConditionOperator =
    | "is_empty"
    | "is_not_empty"
    | "equals"
    | "not_equals"
    | "greater_than"
    | "less_than"
    | "greater_than_or_equal"
    | "less_than_or_equal"
    | "contains"
    | "not_contains";

/** A single condition on a workflow edge. The `if` and `value`
 *  fields go through `ParameterResolver.resolveTemplate` at
 *  evaluation time (audit §4.3). For unary operators (`is_empty`,
 *  `is_not_empty`) `value` is ignored. */
export interface WorkflowCondition {
    /** Template expression — typically `{{nodeX.field}}` or a
     *  literal. Resolved via the workflow outputs map. */
    if: string;
    /** The operator. */
    condition: WorkflowConditionOperator;
    /** Comparison value. Ignored for `is_empty` / `is_not_empty`.
     *  Can be a literal or a `{{template}}` reference. */
    value?: string;
    /** Combine with the previous condition. `"and"` is the
     *  default; the first condition's `logic` is ignored. */
    logic?: "and" | "or";
}

/** An edge in the workflow graph. Carries the connection points
 *  and optional conditions + iteration cap. */
export interface WorkflowEdge {
    id: string;
    start: { id: string; type: "output" };
    end: { id: string; type: "input" };
    /** Canvas-only coordinates. Persisted but ignored at
     *  execution time. */
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    /** Compound condition list. The edge fires only if all (or
     *  any, per `logic`) conditions evaluate true. */
    conditions?: WorkflowCondition[];
    /** Cap on how many times this edge can be traversed during
     *  one run. Used by `for-loop` to bound iterations. */
    maxIterations?: number;
}

/** A single node in the workflow graph. `outputs` is a *schema*
 *  (type description), not a runtime value. */
export interface WorkflowNode {
    id: string;
    /** Human label. NOT unique — multiple nodes may share a
     *  label. Template resolver falls back to this for
     *  agnt-gg-imported workflows. */
    text: string;
    x: number;
    y: number;
    /** Step type. Resolved against the tool library at
     *  execution time. Examples: `generate-with-ai-llm`,
     *  `mcp-client`, `execute-javascript`, `for-loop`, `delay`,
     *  `stop-workflow`, `webhook-listener`, `trigger-timer`. */
    type: string;
    icon?: string;
    category: WorkflowNodeCategory;
    parameters: Record<string, unknown>;
    /** Schema describing the shape the node will produce.
     *  Each key is a field name; the value is a sample /
     *  placeholder used by the canvas UI to render the edge
     *  condition editor. NOT a runtime value. */
    outputs?: Record<string, unknown>;
    description?: string;
    isSelected?: boolean;
}

/** A stored workflow record — the full graph plus canvas
 *  metadata. Persisted as one JSON file per workflow in v1 (see
 *  audit §8.2 `workflow-store.ts`). */
export interface WorkflowRecord {
    id: string;
    name: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    /** Canvas zoom level. UI-only. */
    zoomLevel?: number;
    /** Canvas pan offset. UI-only. */
    canvasOffsetX?: number;
    canvasOffsetY?: number;
    /** Canvas density flag. UI-only. */
    isTinyNodeMode?: boolean;
    /** Optional description / category for the workflows list. */
    description?: string;
    category?: string;
}

/** A node reference entry formatted for LLM context — see
 *  `buildNodeReferenceMap` in `workflow-graph.ts`. The fields
 *  are pre-formatted strings so the caller can drop them
 *  straight into a prompt. */
export interface NodeReferenceEntry {
    /** 1-indexed position in the reference list. */
    index: number;
    /** The human label. */
    label: string;
    /** The stable node id. */
    id: string;
    /** The step type. */
    type: string;
}

/** A pre-formatted reference map line for LLM context. The
 *  `format` field is e.g. `[1] "label" (id: x, type: y)`. */
export interface NodeReferenceMap {
    /** Ordered list of all nodes with their formatted lines. */
    entries: NodeReferenceEntry[];
    /** A single string with one entry per line, ready to drop
     *  into a prompt. */
    formatted: string;
}

/** A diff between two workflow records. Returned by
 *  `diffWorkflows` in `workflow-graph.ts`. Counts are kept
 *  alongside the ids for ergonomic UI display. */
export interface WorkflowDiff {
    nodesAdded: string[];
    nodesRemoved: string[];
    nodesModified: string[];
    edgesAdded: string[];
    edgesRemoved: string[];
    /** Convenience counts — same data as the arrays' lengths. */
    counts: {
        nodesAdded: number;
        nodesRemoved: number;
        nodesModified: number;
        edgesAdded: number;
        edgesRemoved: number;
    };
}

/** The result of validating a single node connection. Returned
 *  by `validateNodeConnections`. */
export type ConnectionValidation =
    | { ok: true }
    | { ok: false; reason: "missing_from" | "missing_to" | "self_loop" };
