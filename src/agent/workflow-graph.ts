// src/agent/workflow-graph.ts
//
// Pure-function graph helpers for workflow editing. Direct port of
// `agnt-gg/backend/src/services/WorkflowManipulationService.js` (254 LOC)
// — the 8 helpers used by the canvas UI. They are stateless, have
// no I/O, and are reusable by both the TUI/REPL and the eventual
// web UI panel.
//
// See `docs/agnt-workflow-audit.md` §6.3 for the original behavior.
//
// All exports are synchronous and side-effect free. The one I/O is
// the load of `src/agent/workflow/toolLibrary.json` (sync JSON parse
// at module init) — see `loadToolLibrary`.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type {
    ConnectionValidation,
    NodeReferenceMap,
    WorkflowDiff,
    WorkflowEdge,
    WorkflowNode,
    WorkflowRecord,
} from "./workflow-types.js";

// ---------- Tool library (stub) ----------

/** The shape of one entry in `toolLibrary.json`. Matches the
 *  per-type object in `src/agent/workflow/toolLibrary.json`. */
interface ToolLibraryEntry {
    category: string;
    icon?: string;
    description?: string;
    inputs: string[];
    outputs: string[];
}

interface ToolLibrary {
    version: number;
    description?: string;
    types: Record<string, ToolLibraryEntry>;
}

let _toolLibrary: ToolLibrary | null = null;

/** Load the stub tool library. Reads once and caches. */
export function loadToolLibrary(): ToolLibrary {
    if (_toolLibrary) return _toolLibrary;
    // Resolve relative to this file: dist/agent/workflow-graph.js
    // → ../../src/agent/workflow/toolLibrary.json in source, but
    // tsc copies the source layout into dist/, so it's just one
    // directory up. We use fileURLToPath to be ESM-correct under
    // both tsc and tsx.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = join(here, "workflow", "toolLibrary.json");
    const raw = readFileSync(candidate, "utf-8");
    _toolLibrary = JSON.parse(raw) as ToolLibrary;
    return _toolLibrary;
}

// ---------- 1. calculateAutoLayout ----------

/** Grid cell dimensions in pixels. Matches agnt-gg (audit §6.3). */
const GRID_W = 300;
const GRID_H = 150;

/** Snap a coordinate to the 300x150 grid. */
function snap(value: number, cell: number): number {
    return Math.round(value / cell) * cell;
}

/** Calculate an auto-layout position for a newly inserted node.
 *  If `insertAfterNodeId` is given, place the new node directly
 *  to the right of that node (one grid cell over). Otherwise,
 *  place at the origin. Pure: no I/O, no side effects.
 *
 *  The 300x150 grid matches agnt-gg's react-flow-like canvas
 *  cell size, so nodes placed by auto-layout line up with nodes
 *  the user has dragged manually. */
export function calculateAutoLayout(
    existingNodes: ReadonlyArray<WorkflowNode>,
    insertAfterNodeId: string | null,
): { x: number; y: number } {
    if (insertAfterNodeId === null) {
        return { x: snap(0, GRID_W), y: snap(0, GRID_H) };
    }
    const found = findNodeByIdentifier(existingNodes, insertAfterNodeId);
    if (!found) {
        return { x: snap(0, GRID_W), y: snap(0, GRID_H) };
    }
    return { x: snap(found.x + GRID_W, GRID_W), y: snap(found.y, GRID_H) };
}

// ---------- 2. validateNodeType ----------

/** Check whether a `node.type` is in the tool library. Per
 *  audit §6.3 the agnt-gg behavior is "warn on unknown, return
 *  true" — graceful degradation. The TUI surfaces the warning
 *  via the second tuple slot. */
export function validateNodeType(nodeType: string): { valid: boolean; warning?: string } {
    const lib = loadToolLibrary();
    if (lib.types[nodeType] !== undefined) return { valid: true };
    return {
        valid: true,
        warning: `Unknown workflow node type "${nodeType}". The engine will attempt to resolve it at execution time, but the type is not in the built-in tool library.`,
    };
}

// ---------- 3. validateNodeConnections ----------

/** Validate that a proposed edge (from→to) is well-formed.
 *  Catches missing nodes and self-loops. Mirrors
 *  `WorkflowManipulationService.js:111`. */
export function validateNodeConnections(
    fromNodeId: string,
    toNodeId: string,
    nodes: ReadonlyArray<WorkflowNode>,
): ConnectionValidation {
    if (fromNodeId === toNodeId) return { ok: false, reason: "self_loop" };
    const fromExists = nodes.some((n) => n.id === fromNodeId);
    if (!fromExists) return { ok: false, reason: "missing_from" };
    const toExists = nodes.some((n) => n.id === toNodeId);
    if (!toExists) return { ok: false, reason: "missing_to" };
    return { ok: true };
}

// ---------- 4. cleanupOrphanedEdges ----------

/** Remove edges that reference a deleted node. Returns a new
 *  edge array; the input is not mutated. Pure. */
export function cleanupOrphanedEdges(
    nodeId: string,
    edges: ReadonlyArray<WorkflowEdge>,
): WorkflowEdge[] {
    return edges.filter((e) => e.start.id !== nodeId && e.end.id !== nodeId);
}

// ---------- 5. generateNodeId / generateEdgeId ----------

/** Generate a stable node id. UUID v4. */
export function generateNodeId(): string {
    return `node_${randomUUID().replace(/-/g, "")}`;
}

/** Generate a stable edge id. Includes the source/target ids and
 *  the source handle so the id is human-readable in logs and
 *  stable across re-saves (same connection → same id). */
export function generateEdgeId(
    sourceId: string,
    targetId: string,
    sourceHandle: string,
): string {
    return `edge_${sourceId}_${targetId}_${sourceHandle}`;
}

// ---------- 6. diffWorkflows ----------

/** Diff two workflow records. Identifies added / removed /
 *  modified nodes and added / removed edges. "Modified" means
 *  the node id exists in both but the object is not deep-equal.
 *  Returns a structured `WorkflowDiff` with id lists and a
 *  counts summary. */
export function diffWorkflows(
    oldWorkflow: WorkflowRecord,
    newWorkflow: WorkflowRecord,
): WorkflowDiff {
    const oldNodesById = new Map<string, WorkflowNode>();
    for (const n of oldWorkflow.nodes) oldNodesById.set(n.id, n);
    const newNodesById = new Map<string, WorkflowNode>();
    for (const n of newWorkflow.nodes) newNodesById.set(n.id, n);

    const nodesAdded: string[] = [];
    const nodesRemoved: string[] = [];
    const nodesModified: string[] = [];
    for (const [id, node] of newNodesById) {
        const prev = oldNodesById.get(id);
        if (prev === undefined) {
            nodesAdded.push(id);
        } else if (!nodeEqual(prev, node)) {
            nodesModified.push(id);
        }
    }
    for (const [id] of oldNodesById) {
        if (!newNodesById.has(id)) nodesRemoved.push(id);
    }

    const oldEdgesById = new Map<string, WorkflowEdge>();
    for (const e of oldWorkflow.edges) oldEdgesById.set(e.id, e);
    const newEdgesById = new Map<string, WorkflowEdge>();
    for (const e of newWorkflow.edges) newEdgesById.set(e.id, e);

    const edgesAdded: string[] = [];
    const edgesRemoved: string[] = [];
    for (const [id] of newEdgesById) {
        if (!oldEdgesById.has(id)) edgesAdded.push(id);
    }
    for (const [id] of oldEdgesById) {
        if (!newEdgesById.has(id)) edgesRemoved.push(id);
    }

    return {
        nodesAdded,
        nodesRemoved,
        nodesModified,
        edgesAdded,
        edgesRemoved,
        counts: {
            nodesAdded: nodesAdded.length,
            nodesRemoved: nodesRemoved.length,
            nodesModified: nodesModified.length,
            edgesAdded: edgesAdded.length,
            edgesRemoved: edgesRemoved.length,
        },
    };
}

/** Structural equality for two workflow nodes. Compares the
 *  fields that affect execution: type, parameters, outputs
 *  schema, and position. Ignores UI-only fields (`isSelected`,
 *  canvas coordinates handled separately). */
function nodeEqual(a: WorkflowNode, b: WorkflowNode): boolean {
    if (a.type !== b.type) return false;
    if (a.text !== b.text) return false;
    if (a.category !== b.category) return false;
    if (!jsonEqual(a.parameters, b.parameters)) return false;
    if (!jsonEqual(a.outputs ?? {}, b.outputs ?? {})) return false;
    return true;
}

/** Stable JSON-stringify-based deep equality. Keys are sorted
 *  so `{"a":1,"b":2}` and `{"b":2,"a":1}` compare equal. */
function jsonEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a, Object.keys(a as object).sort()) ===
        JSON.stringify(b, Object.keys(b as object).sort());
}

// ---------- 7. findNodeByIdentifier ----------

/** Find a node by either its id (exact) or its label
 *  (case-insensitive). Mirrors `WorkflowManipulationService.js:209`.
 *  Returns `undefined` if no match. */
export function findNodeByIdentifier(
    nodes: ReadonlyArray<WorkflowNode>,
    identifier: string,
): WorkflowNode | undefined {
    if (identifier === "") return undefined;
    const byId = nodes.find((n) => n.id === identifier);
    if (byId !== undefined) return byId;
    const needle = identifier.toLowerCase();
    return nodes.find((n) => n.text.toLowerCase() === needle);
}

// ---------- 8. buildNodeReferenceMap ----------

/** Build a node reference map for LLM context. Each node is
 *  formatted as `[1] "label" (id: x, type: y)`. The 1-indexed
 *  list is more readable for the model than a 0-indexed one,
 *  and matches the agnt-gg output. */
export function buildNodeReferenceMap(nodes: ReadonlyArray<WorkflowNode>): NodeReferenceMap {
    const entries = nodes.map((n, i) => ({
        index: i + 1,
        label: n.text,
        id: n.id,
        type: n.type,
    }));
    const formatted = entries
        .map((e) => `[${e.index}] "${e.label}" (id: ${e.id}, type: ${e.type})`)
        .join("\n");
    return { entries, formatted };
}
