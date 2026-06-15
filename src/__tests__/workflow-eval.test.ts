// Tests for `workflow-eval.ts` — the 10 condition operators
// + the `{{template}}` resolver with nodeId-first resolution.
// Pure functions, no I/O, no engine instance.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
    buildNodeTextMap,
    evaluateCompoundConditions,
    evaluateSingleCondition,
    resolveTemplate,
} from "../agent/workflow-eval.js";
import type { WorkflowCondition } from "../agent/workflow-types.js";

// ---------- Fixtures ----------

// `nodeId` → outputs (audit §3.2: real values live in
// `WorkflowEngine.outputs[nodeId]` at runtime).
const outputs = {
    node_summarize: {
        summary: "Meeting at 3pm",
        score: 0.87,
        tags: ["meeting", "calendar"],
    },
    node_classify: {
        category: "calendar",
    },
};

// `nodeText` (lowercased) → outputs. Built once via
// `buildNodeTextMap`; used as fallback for agnt-gg imports.
const nodesForTextMap = [
    { id: "node_summarize", text: "Summarize Email" },
    { id: "node_classify", text: "Classify Email" },
];
const nodeTextToOutputs = buildNodeTextMap(
    nodesForTextMap as never,
    outputs,
);

const triggerData = {
    trigger: { subject: "Re: meeting", body: "Let's meet at 3pm" },
    input: { foo: "bar" },
};

function cond(overrides: Partial<WorkflowCondition>): WorkflowCondition {
    return { if: "", condition: "equals", ...overrides };
}

// ---------- 10 condition operators ----------

test("op: is_empty (string)", () => {
    const r = evaluateSingleCondition(
        cond({ if: "{{node_summarize.summary}}", condition: "is_empty" }),
        outputs, triggerData, nodeTextToOutputs,
    );
    assert.equal(r.actual, false);
});

test("op: is_not_empty (string)", () => {
    const r = evaluateSingleCondition(
        cond({ if: "{{node_summarize.summary}}", condition: "is_not_empty" }),
        outputs, triggerData, nodeTextToOutputs,
    );
    assert.equal(r.actual, true);
});

test("op: equals (number)", () => {
    const r = evaluateSingleCondition(
        cond({ if: "{{node_summarize.score}}", condition: "equals", value: "0.87" }),
        outputs, triggerData, nodeTextToOutputs,
    );
    assert.equal(r.actual, true);
});

test("op: not_equals (string)", () => {
    const r = evaluateSingleCondition(
        cond({ if: "{{node_summarize.summary}}", condition: "not_equals", value: "other" }),
        outputs, triggerData, nodeTextToOutputs,
    );
    assert.equal(r.actual, true);
});

test("op: greater_than (number)", () => {
    const r = evaluateSingleCondition(
        cond({ if: "{{node_summarize.score}}", condition: "greater_than", value: "0.5" }),
        outputs, triggerData, nodeTextToOutputs,
    );
    assert.equal(r.actual, true);
});

test("op: less_than (number)", () => {
    const r = evaluateSingleCondition(
        cond({ if: "{{node_summarize.score}}", condition: "less_than", value: "1.0" }),
        outputs, triggerData, nodeTextToOutputs,
    );
    assert.equal(r.actual, true);
});

test("op: greater_than_or_equal (boundary)", () => {
    const r = evaluateSingleCondition(
        cond({ if: "{{node_summarize.score}}", condition: "greater_than_or_equal", value: "0.87" }),
        outputs, triggerData, nodeTextToOutputs,
    );
    assert.equal(r.actual, true);
});

test("op: less_than_or_equal (boundary)", () => {
    const r = evaluateSingleCondition(
        cond({ if: "{{node_summarize.score}}", condition: "less_than_or_equal", value: "0.87" }),
        outputs, triggerData, nodeTextToOutputs,
    );
    assert.equal(r.actual, true);
});

test("op: contains (string substring)", () => {
    const r = evaluateSingleCondition(
        cond({ if: "{{node_summarize.summary}}", condition: "contains", value: "Meeting" }),
        outputs, triggerData, nodeTextToOutputs,
    );
    assert.equal(r.actual, true);
});

test("op: contains (array membership)", () => {
    const r = evaluateSingleCondition(
        cond({ if: "{{node_summarize.tags}}", condition: "contains", value: "calendar" }),
        outputs, triggerData, nodeTextToOutputs,
    );
    assert.equal(r.actual, true);
});

test("op: not_contains (string)", () => {
    const r = evaluateSingleCondition(
        cond({ if: "{{node_summarize.summary}}", condition: "not_contains", value: "Lunch" }),
        outputs, triggerData, nodeTextToOutputs,
    );
    assert.equal(r.actual, true);
});

// ---------- Compound conditions (and/or) ----------

test("compound: all-and (default) — all pass → fire", () => {
    const conds: WorkflowCondition[] = [
        cond({ if: "{{node_summarize.summary}}", condition: "is_not_empty" }),
        cond({ if: "{{node_summarize.score}}", condition: "greater_than", value: "0.5" }),
    ];
    const r = evaluateCompoundConditions(conds, outputs, triggerData, nodeTextToOutputs);
    assert.equal(r.fire, true);
});

test("compound: all-and — one fails → no fire", () => {
    const conds: WorkflowCondition[] = [
        cond({ if: "{{node_summarize.summary}}", condition: "is_not_empty" }),
        cond({ if: "{{node_summarize.score}}", condition: "less_than", value: "0.5" }),
    ];
    const r = evaluateCompoundConditions(conds, outputs, triggerData, nodeTextToOutputs);
    assert.equal(r.fire, false);
});

test("compound: one-or — one passes → fire", () => {
    const conds: WorkflowCondition[] = [
        cond({ if: "{{node_summarize.score}}", condition: "less_than", value: "0.5" }),
        cond({ if: "{{node_summarize.score}}", condition: "greater_than", value: "0.5", logic: "or" }),
    ];
    const r = evaluateCompoundConditions(conds, outputs, triggerData, nodeTextToOutputs);
    assert.equal(r.fire, true);
});

test("compound: empty list → fire (no conditions = no gate)", () => {
    const r = evaluateCompoundConditions([], outputs, triggerData, nodeTextToOutputs);
    assert.equal(r.fire, true);
});

// ---------- {{template}} resolver ----------

test("resolveTemplate: single nodeId reference", () => {
    const out = resolveTemplate("{{node_summarize.summary}}", outputs, triggerData, nodeTextToOutputs);
    assert.equal(out, "Meeting at 3pm");
});

test("resolveTemplate: mixed literal + template", () => {
    const out = resolveTemplate("Subject: {{node_summarize.summary}}", outputs, triggerData, nodeTextToOutputs);
    assert.equal(out, "Subject: Meeting at 3pm");
});

test("resolveTemplate: trigger prefix resolves against currentTriggerData", () => {
    const out = resolveTemplate("{{trigger.subject}}", outputs, triggerData, nodeTextToOutputs);
    assert.equal(out, "Re: meeting");
});

test("resolveTemplate: input prefix resolves against currentTriggerData", () => {
    const out = resolveTemplate("{{input.foo}}", outputs, triggerData, nodeTextToOutputs);
    assert.equal(out, "bar");
});

test("resolveTemplate: nodeName fallback works for agnt-gg imports", () => {
    // nodeId is preferred, but nodeText "summarize email" is a
    // fallback. Here we strip nodeId so only the fallback works.
    const outputsNoIds: Record<string, unknown> = {};
    const out = resolveTemplate("{{summarizeemail.summary}}", outputsNoIds, triggerData, nodeTextToOutputs);
    assert.equal(out, "Meeting at 3pm");
});

test("resolveTemplate: nodeId takes priority over nodeName fallback", () => {
    // If both keys are present, the nodeId one wins.
    const conflicting = {
        summarizeemail: { summary: "FALLBACK" },
        node_summarize: { summary: "PRIMARY" },
    };
    const out = resolveTemplate("{{node_summarize.summary}}", conflicting, triggerData, conflicting);
    assert.equal(out, "PRIMARY");
});

test("resolveTemplate: array index path", () => {
    const out = resolveTemplate("{{node_summarize.tags[0]}}", outputs, triggerData, nodeTextToOutputs);
    assert.equal(out, "meeting");
});

test("resolveTemplate: nested dot path", () => {
    const nested = { node_a: { x: { y: { z: "deep" } } } };
    const out = resolveTemplate("{{node_a.x.y.z}}", nested, triggerData, nodeTextToOutputs);
    assert.equal(out, "deep");
});

test("resolveTemplate: unresolved reference stays as the literal '{{...}}'", () => {
    const out = resolveTemplate("Hi {{node_ghost}}!", outputs, triggerData, nodeTextToOutputs);
    assert.equal(out, "Hi {{node_ghost}}!");
});

test("resolveTemplate: plain text without templates passes through", () => {
    const out = resolveTemplate("no templates here", outputs, triggerData, nodeTextToOutputs);
    assert.equal(out, "no templates here");
});

test("resolveTemplate: numeric output coerces to string", () => {
    const out = resolveTemplate("score={{node_summarize.score}}", outputs, triggerData, nodeTextToOutputs);
    assert.equal(out, "score=0.87");
});
