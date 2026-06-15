// Tests for the 8 graph helpers in `workflow-graph.ts`.
// Pure functions, no I/O beyond the toolLibrary.json load
// (which is sync and reads the file we ship). Realistic
// fixtures — a 3-node "summarize email" workflow with
// conditions on one edge.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
    buildNodeReferenceMap,
    calculateAutoLayout,
    cleanupOrphanedEdges,
    diffWorkflows,
    findNodeByIdentifier,
    generateEdgeId,
    generateNodeId,
    loadToolLibrary,
    validateNodeConnections,
    validateNodeType,
} from "../agent/workflow-graph.js";
import type { WorkflowEdge, WorkflowNode, WorkflowRecord } from "../agent/workflow-types.js";

// ---------- Fixtures ----------

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
    return {
        id: "node_default",
        text: "Default",
        x: 0,
        y: 0,
        type: "execute-javascript",
        category: "utility",
        parameters: {},
        ...overrides,
    };
}

const receiveEmail = makeNode({
    id: "node_receive",
    text: "Receive Email",
    x: 0,
    y: 0,
    type: "webhook-listener",
    category: "trigger",
    parameters: { path: "/inbox" },
});

const summarizeEmail = makeNode({
    id: "node_summarize",
    text: "Summarize Email",
    x: 300,
    y: 0,
    type: "generate-with-ai-llm",
    category: "action",
    parameters: { provider: "Anthropic", model: "claude-3-haiku-20240307" },
});

const sendReply = makeNode({
    id: "node_send",
    text: "Send Reply",
    x: 600,
    y: 0,
    type: "mcp-client",
    category: "mcp",
    parameters: { serverId: "gmail", tool: "send" },
});

const nodes: WorkflowNode[] = [receiveEmail, summarizeEmail, sendReply];

function makeEdge(overrides: Partial<WorkflowEdge> = {}): WorkflowEdge {
    return {
        id: "edge_default",
        start: { id: "node_a", type: "output" },
        end: { id: "node_b", type: "input" },
        ...overrides,
    };
}

const edges: WorkflowEdge[] = [
    makeEdge({
        id: "edge_receive_summarize",
        start: { id: "node_receive", type: "output" },
        end: { id: "node_summarize", type: "input" },
    }),
    makeEdge({
        id: "edge_summarize_send",
        start: { id: "node_summarize", type: "output" },
        end: { id: "node_send", type: "input" },
    }),
];

// ---------- 1. calculateAutoLayout ----------

test("calculateAutoLayout: returns origin when no insert-after id", () => {
    const pos = calculateAutoLayout(nodes, null);
    assert.equal(pos.x, 0);
    assert.equal(pos.y, 0);
});

test("calculateAutoLayout: places to the right of the anchor (snapped to 300x150)", () => {
    const pos = calculateAutoLayout(nodes, "node_receive");
    assert.equal(pos.x, 300, "one cell to the right");
    assert.equal(pos.y, 0);
});

test("calculateAutoLayout: unknown anchor falls back to origin", () => {
    const pos = calculateAutoLayout(nodes, "node_does_not_exist");
    assert.equal(pos.x, 0);
    assert.equal(pos.y, 0);
});

test("calculateAutoLayout: snaps to nearest grid cell", () => {
    // 217 + 300 = 517 → snaps to 600. 89 snaps to 150.
    const off = makeNode({ id: "node_off", text: "Off", x: 217, y: 89 });
    const pos = calculateAutoLayout([off], "node_off");
    assert.equal(pos.x, 600, "217 + 300 = 517, snaps to 600");
    assert.equal(pos.y, 150, "89 snaps to 150");
});

// ---------- 2. validateNodeType ----------

test("validateNodeType: known type passes without warning", () => {
    const r = validateNodeType("generate-with-ai-llm");
    assert.equal(r.valid, true);
    assert.equal(r.warning, undefined);
});

test("validateNodeType: unknown type still returns true (graceful degradation) + warning", () => {
    const r = validateNodeType("agnt-gg-only-action");
    assert.equal(r.valid, true);
    assert.ok(r.warning !== undefined);
    assert.match(r.warning, /agnt-gg-only-action/);
});

test("loadToolLibrary: returns the v1 stub with at least 5 types", () => {
    const lib = loadToolLibrary();
    assert.ok(typeof lib === "object");
    const types = Object.keys(lib.types);
    assert.ok(types.length >= 5, `expected at least 5 types, got ${types.length}`);
    for (const t of ["generate-with-ai-llm", "mcp-client", "execute-javascript", "for-loop", "delay", "stop-workflow", "webhook-listener", "trigger-timer"]) {
        assert.ok(types.includes(t), `expected ${t} in tool library`);
    }
});

// ---------- 3. validateNodeConnections ----------

test("validateNodeConnections: ok when both endpoints exist and differ", () => {
    const r = validateNodeConnections("node_receive", "node_summarize", nodes);
    assert.equal(r.ok, true);
});

test("validateNodeConnections: rejects self-loops", () => {
    const r = validateNodeConnections("node_receive", "node_receive", nodes);
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.reason, "self_loop");
});

test("validateNodeConnections: rejects missing 'from'", () => {
    const r = validateNodeConnections("node_ghost", "node_summarize", nodes);
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.reason, "missing_from");
});

test("validateNodeConnections: rejects missing 'to'", () => {
    const r = validateNodeConnections("node_receive", "node_ghost", nodes);
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.reason, "missing_to");
});

// ---------- 4. cleanupOrphanedEdges ----------

test("cleanupOrphanedEdges: removes edges touching the deleted node", () => {
    const cleaned = cleanupOrphanedEdges("node_summarize", edges);
    assert.equal(cleaned.length, 0);
});

test("cleanupOrphanedEdges: keeps edges that do not touch the deleted node", () => {
    const extra = makeEdge({
        id: "edge_unrelated",
        start: { id: "node_other_a", type: "output" },
        end: { id: "node_other_b", type: "input" },
    });
    const cleaned = cleanupOrphanedEdges("node_summarize", [...edges, extra]);
    assert.equal(cleaned.length, 1);
    assert.equal(cleaned[0]?.id, "edge_unrelated");
});

test("cleanupOrphanedEdges: returns a new array (does not mutate input)", () => {
    const snapshot = edges.length;
    cleanupOrphanedEdges("node_summarize", edges);
    assert.equal(edges.length, snapshot);
});

// ---------- 5. generateNodeId / generateEdgeId ----------

test("generateNodeId: returns a unique id with the node_ prefix", () => {
    const a = generateNodeId();
    const b = generateNodeId();
    assert.match(a, /^node_[0-9a-f]{32}$/);
    assert.match(b, /^node_[0-9a-f]{32}$/);
    assert.notEqual(a, b);
});

test("generateEdgeId: includes source + target + handle for stability", () => {
    const id = generateEdgeId("node_a", "node_b", "output-0");
    assert.equal(id, "edge_node_a_node_b_output-0");
});

test("generateEdgeId: stable across re-saves (same inputs → same id)", () => {
    const a = generateEdgeId("node_x", "node_y", "out");
    const b = generateEdgeId("node_x", "node_y", "out");
    assert.equal(a, b);
});

// ---------- 6. diffWorkflows ----------

function makeRecord(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
    return {
        id: "wf_1",
        name: "Test Workflow",
        nodes,
        edges,
        ...overrides,
    };
}

test("diffWorkflows: identical records yield zero diff", () => {
    const r = makeRecord();
    const d = diffWorkflows(r, r);
    assert.equal(d.counts.nodesAdded, 0);
    assert.equal(d.counts.nodesRemoved, 0);
    assert.equal(d.counts.nodesModified, 0);
    assert.equal(d.counts.edgesAdded, 0);
    assert.equal(d.counts.edgesRemoved, 0);
});

test("diffWorkflows: detects added / removed / modified nodes", () => {
    const old = makeRecord();
    const newNode = makeNode({ id: "node_new", text: "New Step", x: 900, y: 0 });
    const modified = makeNode({ id: "node_summarize", text: "Summarize Email", x: 300, y: 0, parameters: { changed: true } });
    const removed = makeNode({ id: "node_send", text: "Send Reply", x: 600, y: 0 });
    const newRecord = makeRecord({
        nodes: [receiveEmail, modified, newNode],
        edges: [], // remove all edges too
    });
    const d = diffWorkflows(old, newRecord);
    assert.deepEqual(d.nodesAdded, ["node_new"]);
    assert.deepEqual(d.nodesRemoved, ["node_send"]);
    assert.deepEqual(d.nodesModified, ["node_summarize"]);
    assert.equal(d.counts.nodesAdded, 1);
    assert.equal(d.counts.nodesRemoved, 1);
    assert.equal(d.counts.nodesModified, 1);
});

test("diffWorkflows: detects added / removed edges", () => {
    const old = makeRecord();
    const newEdge = makeEdge({
        id: "edge_new",
        start: { id: "node_send", type: "output" },
        end: { id: "node_summarize", type: "input" },
    });
    const newRecord = makeRecord({ edges: [...edges, newEdge] });
    const d = diffWorkflows(old, newRecord);
    assert.deepEqual(d.edgesAdded, ["edge_new"]);
    assert.equal(d.counts.edgesAdded, 1);
    assert.equal(d.counts.edgesRemoved, 0);
});

// ---------- 7. findNodeByIdentifier ----------

test("findNodeByIdentifier: matches by id", () => {
    const n = findNodeByIdentifier(nodes, "node_summarize");
    assert.ok(n !== undefined);
    assert.equal(n.id, "node_summarize");
});

test("findNodeByIdentifier: matches by case-insensitive label", () => {
    const n = findNodeByIdentifier(nodes, "summarize email");
    assert.ok(n !== undefined);
    assert.equal(n.id, "node_summarize");
});

test("findNodeByIdentifier: returns undefined for unknown identifier", () => {
    const n = findNodeByIdentifier(nodes, "ghost");
    assert.equal(n, undefined);
});

test("findNodeByIdentifier: empty string returns undefined", () => {
    const n = findNodeByIdentifier(nodes, "");
    assert.equal(n, undefined);
});

// ---------- 8. buildNodeReferenceMap ----------

test("buildNodeReferenceMap: 1-indexed, formatted, all nodes", () => {
    const map = buildNodeReferenceMap(nodes);
    assert.equal(map.entries.length, 3);
    assert.equal(map.entries[0]?.index, 1);
    assert.equal(map.entries[2]?.index, 3);
    assert.equal(map.entries[0]?.label, "Receive Email");
    assert.match(map.formatted, /^\[1\] "Receive Email" \(id: node_receive, type: webhook-listener\)$/m);
    assert.match(map.formatted, /\[2\] "Summarize Email"/m);
    assert.match(map.formatted, /\[3\] "Send Reply"/m);
});

test("buildNodeReferenceMap: empty input yields empty map", () => {
    const map = buildNodeReferenceMap([]);
    assert.equal(map.entries.length, 0);
    assert.equal(map.formatted, "");
});
