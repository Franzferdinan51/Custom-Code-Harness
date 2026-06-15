// src/agent/workflow-eval.ts
//
// Edge condition evaluation + `{{template}}` parameter resolution.
// Direct port of `agnt-gg/backend/src/workflow/EdgeEvaluator.js` (79
// LOC) + `agnt-gg/backend/src/workflow/ParameterResolver.js` (278
// LOC) — combined into one pure-function module.
//
// See `docs/agnt-workflow-audit.md` §3.2 (I/O contract), §4.3 (the
// 10 condition operators), and §7 question #4 (the nodeId vs
// nodeName resolution policy).
//
// Design notes:
//
// - 10 operators from audit §4.3:
//   `is_empty`, `is_not_empty`, `equals`, `not_equals`,
//   `greater_than`, `less_than`, `greater_than_or_equal`,
//   `less_than_or_equal`, `contains`, `not_contains`.
//
// - Template resolution prefers `nodeId` over `nodeName`
//   (audit §7 #4 / phase4 T1 decision #4). Native workflows
//   should use `{{node_abc123.field}}`; the resolver falls back
//   to `{{nodeName.field}}` for agnt-gg-imported workflows. We
//   build both a `nodeIdToOutputs` map (primary) and a
//   `nodeTextToOutputs` map (fallback) and check primary first.
//
// - Special prefixes `trigger` and `input` resolve against
//   `currentTriggerData[prefix]`, matching audit §3.2. The
//   resolver is pure — the caller passes `currentTriggerData`
//   and `outputs` in; the engine instance is not used here.
//
// - Path syntax inside the template: `nodeId` is the first
//   segment; the rest is a dot/index path walked against the
//   node's `outputs` object. Examples:
//   `{{node_abc.field}}` → outputs["node_abc"]["field"]
//   `{{node_abc.list[0].name}}` → outputs["node_abc"]["list"][0]["name"]
//   `{{trigger.subject}}` → currentTriggerData["trigger"]["subject"]
//
// - `EdgeConditionEvaluationResult` is a small struct so the
//   caller (the workflow engine) can attribute failures to a
//   specific condition when logging.

import type { WorkflowCondition, WorkflowConditionOperator, WorkflowNode } from "./workflow-types.js";

// ---------- 1. Edge condition evaluation ----------

/** Result of evaluating a single condition. The `error` slot
 *  is set when the operator fails (e.g. `greater_than` on
 *  non-numeric input) — the engine should log it but the
 *  condition evaluates to `false` in that case. */
export interface EdgeConditionResult {
    operator: WorkflowConditionOperator;
    actual: boolean;
    /** Human-readable explanation. Useful for TUI debug output. */
    detail: string;
    /** Set when the operator threw (e.g. comparing non-numbers). */
    error?: string;
}

/** Result of evaluating a compound (multi-condition) edge. */
export interface EdgeEvaluationResult {
    /** True iff every (or every "or"-combined) condition passed. */
    fire: boolean;
    /** Per-condition results, in declaration order. */
    conditions: EdgeConditionResult[];
}

/** Evaluate a compound condition list. Mirrors
 *  `EdgeEvaluator.evaluateCompoundConditions` — the first
 *  condition's result is the seed; subsequent conditions
 *  combine with `and` (default) or `or` per their `logic`
 *  field. */
export function evaluateCompoundConditions(
    conditions: ReadonlyArray<WorkflowCondition>,
    /** Map of `nodeId` → outputs object. Resolved against
     *  `{{nodeId.field}}` references in `if` / `value`. */
    outputs: Readonly<Record<string, unknown>>,
    /** Trigger data, accessible as `{{trigger.field}}` /
     *  `{{input.field}}`. */
    currentTriggerData: Readonly<Record<string, unknown>>,
    /** Map of `nodeText` (lowercased) → outputs object. Used
     *  as a fallback for agnt-gg-imported workflows. */
    nodeTextToOutputs: Readonly<Record<string, unknown>>,
): EdgeEvaluationResult {
    if (conditions.length === 0) {
        return { fire: true, conditions: [] };
    }
    const results: EdgeConditionResult[] = [];
    let acc = false;
    for (let i = 0; i < conditions.length; i++) {
        const cond = conditions[i];
        if (cond === undefined) continue;
        const r = evaluateSingleCondition(cond, outputs, currentTriggerData, nodeTextToOutputs);
        results.push(r);
        if (i === 0) {
            acc = r.actual;
        } else {
            const logic = cond.logic ?? "and";
            acc = logic === "or" ? acc || r.actual : acc && r.actual;
        }
    }
    return { fire: acc, conditions: results };
}

/** Evaluate a single condition. Mirrors
 *  `EdgeEvaluator.evaluateSingleCondition` (audit §4.3). The
 *  `if` and `value` fields are passed through
 *  `resolveTemplate` first, so they can reference previous
 *  node outputs and trigger data. */
export function evaluateSingleCondition(
    cond: WorkflowCondition,
    outputs: Readonly<Record<string, unknown>>,
    currentTriggerData: Readonly<Record<string, unknown>>,
    nodeTextToOutputs: Readonly<Record<string, unknown>>,
): EdgeConditionResult {
    const lhs = resolveTemplate(cond.if, outputs, currentTriggerData, nodeTextToOutputs);
    // For unary operators, ignore `value`. For binary operators,
    // resolve `value` too (it can be a template).
    const op = cond.condition;
    try {
        const actual = applyOperator(op, lhs, cond.value, (v) =>
            resolveTemplate(v, outputs, currentTriggerData, nodeTextToOutputs),
        );
        return { operator: op, actual, detail: `${op}(${JSON.stringify(lhs)}${cond.value !== undefined ? `, ${JSON.stringify(cond.value)}` : ""}) = ${actual}` };
    } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        return {
            operator: op,
            actual: false,
            detail: `${op} failed: ${err}`,
            error: err,
        };
    }
}

/** Apply one of the 10 condition operators. Throws on
 *  type mismatches (caught by the caller). */
function applyOperator(
    op: WorkflowConditionOperator,
    lhs: unknown,
    rawValue: string | undefined,
    resolveValue: (v: string) => unknown,
): boolean {
    switch (op) {
    case "is_empty":
        return isEmpty(lhs);
    case "is_not_empty":
        return !isEmpty(lhs);
    case "equals":
        return deepEqual(lhs, resolveValueOrUndefined(rawValue, resolveValue));
    case "not_equals":
        return !deepEqual(lhs, resolveValueOrUndefined(rawValue, resolveValue));
    case "greater_than":
        return numericCompare(lhs, rawValue, resolveValue, (a, b) => a > b);
    case "less_than":
        return numericCompare(lhs, rawValue, resolveValue, (a, b) => a < b);
    case "greater_than_or_equal":
        return numericCompare(lhs, rawValue, resolveValue, (a, b) => a >= b);
    case "less_than_or_equal":
        return numericCompare(lhs, rawValue, resolveValue, (a, b) => a <= b);
    case "contains":
        return containsCheck(lhs, resolveValueOrUndefined(rawValue, resolveValue));
    case "not_contains":
        return !containsCheck(lhs, resolveValueOrUndefined(rawValue, resolveValue));
    }
}

/** Treat `undefined` / `null` / `""` / `[]` / `{}` as empty. */
function isEmpty(v: unknown): boolean {
    if (v === undefined || v === null) return true;
    if (typeof v === "string") return v.length === 0;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v as object).length === 0;
    return false;
}

/** Strict deep equality. Numbers compared by value (not by
 *  string), strings by value, arrays/objects recursively. */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
    }
    if (typeof a === "object" && typeof b === "object") {
        const ak = Object.keys(a as object).sort();
        const bk = Object.keys(b as object).sort();
        if (ak.length !== bk.length) return false;
        for (let i = 0; i < ak.length; i++) {
            if (ak[i] !== bk[i]) return false;
        }
        for (const k of ak) {
            if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
                return false;
            }
        }
        return true;
    }
    return false;
}

/** Convert a value to a number for comparison. Throws on
 *  non-numeric input. */
function toNumber(v: unknown): number {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
        const n = Number(v);
        if (Number.isNaN(n)) throw new Error(`expected number, got string "${v}"`);
        return n;
    }
    throw new Error(`expected number, got ${typeof v}`);
}

function resolveValueOrUndefined(
    raw: string | undefined,
    resolve: (v: string) => unknown,
): unknown {
    if (raw === undefined) return undefined;
    return resolve(raw);
}

function numericCompare(
    lhs: unknown,
    rawValue: string | undefined,
    resolveValue: (v: string) => unknown,
    cmp: (a: number, b: number) => boolean,
): boolean {
    if (rawValue === undefined) throw new Error("operator requires a value");
    const a = toNumber(lhs);
    const b = toNumber(resolveValue(rawValue));
    return cmp(a, b);
}

/** Substring for strings, element-membership for arrays. */
function containsCheck(lhs: unknown, rhs: unknown): boolean {
    if (typeof lhs === "string" && typeof rhs === "string") {
        return lhs.includes(rhs);
    }
    if (Array.isArray(lhs)) {
        return lhs.some((item) => deepEqual(item, rhs));
    }
    if (typeof lhs === "string" && Array.isArray(rhs)) {
        return rhs.some((item) => deepEqual(item, lhs));
    }
    return false;
}

// ---------- 2. {{template}} resolver ----------

/** Resolve a `{{...}}` template string. The whole string
 *  may be a single template (`{{x}}`) or a mixed literal
 *  with multiple templates (`Hello {{name}}!`). Unresolved
 *  templates become the literal string `"{{...}}"` so the
 *  caller can see the gap. Pure.
 *
 *  See audit §3.2 for the I/O contract and §7 #4 for the
 *  nodeId-first policy. */
export function resolveTemplate(
    template: string,
    outputs: Readonly<Record<string, unknown>>,
    currentTriggerData: Readonly<Record<string, unknown>>,
    nodeTextToOutputs: Readonly<Record<string, unknown>>,
): unknown {
    if (!template.includes("{{")) return template;
    // Capture every `{{...}}` block, non-greedy. The inner
    // expression cannot contain `}}` (we don't support nested
    // templates), so this is safe.
    return template.replace(/\{\{([^}]+)\}\}/g, (whole, expr: string) => {
        const trimmed = expr.trim();
        const resolved = resolveReference(trimmed, outputs, currentTriggerData, nodeTextToOutputs);
        return resolved !== undefined ? String(resolved) : whole;
    });
}

/** Resolve a single reference like `nodeId.field[0].sub`. */
function resolveReference(
    ref: string,
    outputs: Readonly<Record<string, unknown>>,
    currentTriggerData: Readonly<Record<string, unknown>>,
    nodeTextToOutputs: Readonly<Record<string, unknown>>,
): unknown {
    // Split into root and path. The root is the first segment
    // before the first `.` or `[`. The path is the rest.
    const rootMatch = /^([^.\[]+)(.*)$/.exec(ref);
    if (rootMatch === null) return undefined;
    const root = rootMatch[1] ?? "";
    const rest = rootMatch[2] ?? "";
    const rootValue = resolveRoot(root, outputs, currentTriggerData, nodeTextToOutputs);
    if (rootValue === undefined) return undefined;
    return walkPath(rootValue, rest);
}

/** Resolve the root of a reference: special prefix
 *  (`trigger`/`input`), `nodeId` (primary), or `nodeText`
 *  (fallback for agnt-gg imports). */
function resolveRoot(
    root: string,
    outputs: Readonly<Record<string, unknown>>,
    currentTriggerData: Readonly<Record<string, unknown>>,
    nodeTextToOutputs: Readonly<Record<string, unknown>>,
): unknown {
    if (root === "trigger" || root === "input") {
        const data = currentTriggerData[root];
        return data;
    }
    // Primary: nodeId match.
    if (Object.prototype.hasOwnProperty.call(outputs, root)) {
        return outputs[root];
    }
    // Fallback: nodeText match (case-insensitive, see
    // agnt-gg `ParameterResolver.js:45-55`). The caller
    // pre-builds `nodeTextToOutputs` keyed by lowercased
    // `node.text` to keep this lookup O(1).
    if (Object.prototype.hasOwnProperty.call(nodeTextToOutputs, root)) {
        return nodeTextToOutputs[root];
    }
    return undefined;
}

/** Walk a `.field` / `[index]` path against a value. */
function walkPath(value: unknown, path: string): unknown {
    if (path === "") return value;
    // Tokenize: alternation between `.name` and `[index]`.
    // We don't support quoted keys (`["name with spaces"]`).
    const tokenRegex = /\.([^.\[]+)|\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    let cur: unknown = value;
    while ((m = tokenRegex.exec(path)) !== null) {
        if (cur === undefined || cur === null) return undefined;
        if (m[1] !== undefined) {
            if (typeof cur !== "object") return undefined;
            cur = (cur as Record<string, unknown>)[m[1]];
        } else if (m[2] !== undefined) {
            if (!Array.isArray(cur)) return undefined;
            const idx = Number(m[2]);
            cur = cur[idx];
        }
    }
    return cur;
}

// ---------- 3. nodeTextToOutputs builder ----------

/** Build the `nodeTextToOutputs` map from a nodes array. Keys
 *  are `node.text.toLowerCase()`; values are the
 *  caller-supplied outputs (looked up by nodeId in the
 *  outputs map). Used as the fallback for agnt-gg-imported
 *  workflows.
 *
 *  Two nodes sharing a label resolve to the first match
 *  (agnt-gg accepts this as "user error"). The native
 *  workflow creator should warn on collisions, but the
 *  resolver itself does not enforce uniqueness. */
export function buildNodeTextMap(
    nodes: ReadonlyArray<WorkflowNode>,
    outputs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    for (const node of nodes) {
        const key = node.text.toLowerCase().replace(/\s+/g, "");
        if (key === "") continue;
        if (Object.prototype.hasOwnProperty.call(outputs, node.id)) {
            if (!Object.prototype.hasOwnProperty.call(map, key)) {
                map[key] = outputs[node.id];
            }
        }
    }
    return map;
}
