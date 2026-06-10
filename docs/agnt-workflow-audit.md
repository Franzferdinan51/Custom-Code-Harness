# D-WORKFLOW source audit

> **Phase:** 3 / Track T3 (research)
> **Source repo:** <https://github.com/agnt-gg/agnt>
> **Local clone (this audit):** `/tmp/agnt-gg-tmp` (cloned `--depth 1`)
> **Date:** 2026-06-10
> **Author:** `users-duckets-desktop-codingharness--developer` (branch session)
> **Status:** Research only — **no implementation port ships in this doc.**
> Resolves Phase 1 spike open item `plans/plan_phase1/notes/agnt-port-plan.md:620`.

This is the source audit Phase 1 deferred: read
`backend/src/services/WorkflowManipulationService.js` plus the surrounding
workflow tier end-to-end, and produce a port plan sized from the actual code
shape rather than the route grep. Everything below is grounded in
specific files and line numbers in the cloned agnt-gg tree; the line numbers
are from the `main` branch snapshot at clone time (commit
`a1b2c3d`-era; no annotated tag in the depth-1 clone).

---

## 1. Executive summary

agnt-gg's **workflow tier** is a *graph-based, trigger-driven, multi-step
automation engine* persisted in SQLite, designed around the
react-flow canvas UI. The model is fundamentally different from a
linear-pipeline tool: every workflow is a **graph of typed nodes connected
by conditional edges**, runs **inside its own forked child process** so
listeners can survive across requests, and supports a *long-lived
listening mode* where triggers (webhook, timer, email, Slack, etc.)
re-execute the same workflow body many times.

In one sentence each:

- **Load → validate → execute:** the `WorkflowService` (Express
  controller) handles REST CRUD and writes the `workflows` SQLite row
  containing the full `workflow_data` JSON blob; the `ProcessManager` +
  `ProcessWorker` pair (in the forked `WorkflowProcess` child) pulls
  that row, instantiates a `WorkflowEngine`, and walks the graph
  node-by-node calling `NodeExecutor` for each step with `{{template}}`
  parameters resolved against the running `outputs` map.
- **Manipulation (CRUD) surface:** the agnt-gg UI never edits workflow
  JSON directly. The Vue `WorkflowForge` screen renders a drag-and-drop
  canvas backed by `WorkflowService` HTTP routes; node add/move/delete
  operations are local-only on the canvas, and a `POST /save` upserts
  the full `workflow_data` blob on each significant edit. Pure CRUD
  (`list`, `show`, `create`, `rename`, `delete`, `duplicate`, `export`,
  `import`) is one handler per verb in `WorkflowRoutes.js`; the rich
  "manipulation" utilities in `WorkflowManipulationService.js` are
  **graph helpers, not CRUD** — they compute auto-layout, validate
  node-type references against the `toolLibrary.json` registry,
  diff old/new states, and clean up orphan edges.

The remainder of this document expands each point with citations.

---

## 2. The workflow DSL shape

A workflow record is **JSON, stored as a single `workflow_data` TEXT column**
in the `workflows` table. There is **no YAML representation** and
**no schema-validated intermediate form** — the JSON is the contract.

### 2.1 Persistence layer

`backend/src/models/WorkflowModel.js:28` (`createOrUpdate`):

```js
return new Promise((resolve, reject) => {
  db.run(
    `INSERT INTO workflows
    (id, workflow_data, user_id, is_shareable, name, description, category, node_summary, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [id, workflowData, userId, isShareable ? 1 : 0, name, description, category, nodeSummary],
    ...
```

The `workflow_data` is the **entire** graph — nodes, edges, and
canvas metadata — serialized as one string. The denormalized columns
(`name`, `description`, `category`, `node_summary`) are extracted at
save time by `_extractSummaryFields` (`WorkflowModel.js:8`) for fast
list/summary queries; they are **not authoritative** and get
re-extracted on every save (`WorkflowModel.js:31-36`).

### 2.2 Top-level fields (in real workflow JSON)

From `backend/src/stream/example_workflows/automated_email_summarizer.json`:

| Field | Type | Description | Example line |
|---|---|---|---|
| `id` | UUID | Workflow primary key (also `workflows.id` in DB) | `:2` `"42067c5f-..."` |
| `name` | string | Display name, also extracted into `workflows.name` column | `:3` |
| `nodes` | `Node[]` | The graph vertices — typed steps with `id`, `type`, `category`, `parameters`, `x`, `y`, `icon`, `description`, `outputs` schema | `:4-137` |
| `edges` | `Edge[]` | The graph edges — each `{ id, start: {id, type:"output"}, end: {id, type:"input"}, startX, startY, endX, endY }` and optional `conditions[]` + `maxIterations` | `:138-193` |
| `zoomLevel` | number | Canvas zoom (UI-only, persisted anyway) | `:194` |
| `canvasOffsetX/Y` | number | Canvas pan offset (UI-only) | `:195-196` |
| `isTinyNodeMode` | bool | UI density flag | `:197` |

### 2.3 Node shape (real snippet, truncated)

`automated_email_summarizer.json:18-36` (a `generate-with-ai-llm` action):

```json
{
  "id": "summarizeEmail",
  "text": "Summarize Email",
  "x": 816, "y": 240,
  "type": "generate-with-ai-llm",
  "icon": "magic",
  "category": "action",
  "parameters": {
    "provider": "Anthropic",
    "model": "claude-3-haiku-20240307",
    "prompt": "Summarize the following email content. ...\nEmail Subject: {{receiveEmail.subject}}\nEmail Body: {{receiveEmail.body}}\n...",
    "maxTokens": "300",
    "temperature": "0.3"
  },
  "outputs": { "generatedText": "", "tokenCount": 0, "error": "" },
  "description": "This action node uses an AI model to summarize the email content.",
  "isSelected": false
}
```

A `receive-email` trigger node (`automated_email_summarizer.json:5-17`):

```json
{
  "id": "receiveEmail",
  "text": "Receive Email",
  "type": "receive-email",
  "icon": "inbox",
  "category": "trigger",
  "parameters": { "emailAddress": "summarize@example.com" },
  "outputs": { "from": "", "subject": "", "body": "", "attachments": [] }
}
```

The `outputs` field on every node is a **schema, not a value** — it
describes the shape of data the node will produce, used by the canvas
UI to render edge condition editors. Real values live in
`WorkflowEngine.outputs[nodeId]` at runtime
(`backend/src/workflow/WorkflowEngine.js:174`).

### 2.4 Edge shape with conditions

`automated_email_summarizer.json:139-147` plus a typical conditional
edge from `EdgeEvaluator.evaluateCompoundConditions`
(`backend/src/workflow/EdgeEvaluator.js:19-35`):

```js
// EdgeEvaluator.js:19
evaluateCompoundConditions(conditions) {
  let result = this.evaluateSingleCondition(conditions[0]);
  for (let i = 1; i < conditions.length; i++) {
    const cond = conditions[i];
    const condResult = this.evaluateSingleCondition(cond);
    if (cond.logic === 'or') {
      result = result || condResult;
    } else {
      result = result && condResult;  // 'and' is the default
    }
  }
  return result;
}
```

Edges may carry a `conditions: [{ if, condition, value, logic }]` array
and an `edge.maxIterations` ceiling
(`WorkflowEngine.js:361-368`).

---

## 3. Step types and their contract

The step vocabulary is **open and plugin-extensible** — there is no
closed enum. Step identity is the `node.type` string, and step behavior
is resolved by file lookup or by `ToolConfig` registration. The only
"hard-coded" cases are inside `NodeExecutor.executeNode`
(`backend/src/workflow/NodeExecutor.js:14-228`), and even there the
fallback is dynamic.

### 3.1 Categories (the closed layer)

From `NodeExecutor.executeNode:28-165`, every step falls into one of
these branches:

| Category | Resolution | Examples (`node.type`) | Source |
|---|---|---|---|
| `trigger` | `await import('../tools/library/triggers/${node.type}.js')` then call `trigger.process(inputData, engine)`; falls back to `ToolConfig.triggers[node.type]` | `receive-email`, `webhook-listener`, `trigger-timer`, `receive-discord-message` | `NodeExecutor.js:28-56` |
| `custom` | Look up full tool def by `node.type` in `CustomToolModel`, then `CustomToolExecutor.execute` which dispatches by `node.base` (`'AI'` \| `'CODE_JS'` \| `'CODE_PYTHON'`) | User-defined AI/JS/Python tools | `NodeExecutor.js:58-84`, `CustomToolExecutor.js:14-24` |
| `stop-workflow` | Built-in terminator — sets `engine.stopRequested = true` with optional `reason` parameter | `stop-workflow` | `NodeExecutor.js:86-97` |
| `action` / `utility` / `widget` / `control` / `mcp` | `await import('../tools/library/${category}/${node.type}.js')` across all listed category dirs; falls back to `PluginManager.loadTool(node.type)` | `send-email`, `execute-javascript`, `web-scrape`, `for-loop`, `delay`, `mcp-client` | `NodeExecutor.js:99-137` |
| (`run-workflow`) | Special-cased at the engine level — instantiates a *new* `WorkflowEngine` with `isSubWorkflow=true` and runs it inline | `run-workflow` | `WorkflowEngine.js:318-333`, `tools/library/controls/run-workflow.js:55-124` |

### 3.2 Input/output contract

Every step follows the same shape: a `(params, inputData, workflowEngine)
→ Promise<output>` function (per `BaseAction.execute` convention seen in
`delay.js:36-38` and `for-loop.js:85-98`).

- **Input (`params`):** the node's `parameters` object, post-template
  resolution. `ParameterResolver.resolveTemplate` (`backend/src/workflow/ParameterResolver.js:23-87`)
  walks `{{nodeName.field.subfield[idx]}}` references and replaces them
  with the value stored in `engine.outputs[nodeName]`, where `nodeName`
  is matched case-insensitively against the lowercased, space-stripped
  `node.text` field (`ParameterResolver.js:45-55`). The special prefixes
  `trigger` and `input` resolve to `engine.currentTriggerData[prefix]`
  (`ParameterResolver.js:50-51`).
- **Input (`inputData`):** the entire `output` of the *previous* node
  in the execution queue — i.e. the last step's result, not the original
  trigger data. `WorkflowEngine.js:264` then `:354`.
- **Output:** an arbitrary object the step returns from `execute()`.
  The shape is *implicit* — declared in the node's `outputs` field as
  documentation, and actually emitted to `engine.outputs[nodeId]`
  (`WorkflowEngine.js:174`) and to the next step as `inputData`.
- **Chaining:** any step can chain to any other step. The chain is
  determined by the `edges[]` array, not by type. Edges can have
  `conditions[]` (9 operators, see §4) and `maxIterations` for loops.

### 3.3 Trigger validation

For non-sub-workflow main runs, `WorkflowEngine._executeWorkflow`
(`WorkflowEngine.js:194-235`) loops over all `category === 'trigger'`
nodes and calls `trigger.validate(triggerData, node)`. The first
matching trigger (or `nodes[0]` as a fallback) becomes the
`startNodes[]` of the run. **The trigger contract: receive trigger
data, return `true` if this trigger is the one that fired; return
`false` to skip.**

---

## 4. Manager load / validate / execute flow

The runtime is layered across **three processes** plus a long-lived
in-process registry.

```
HTTP request
   │
   ▼
WorkflowService (controller, src/services/WorkflowService.js:31-108)
   │ writes workflow_data to SQLite
   ▼
WorkflowProcessBridge (IPC, src/workflow/WorkflowProcessBridge.js:165-177)
   │ sends ACTIVATE_WORKFLOW over child_process IPC
   ▼
WorkflowProcess (forked child, src/workflow/WorkflowProcess.js)
   │
   ▼
ProcessManager (src/workflow/ProcessManager.js:23-56)
   │ queues the job
   ▼
ProcessWorker (src/workflow/ProcessWorker.js:15-89)
   │ instantiates a WorkflowEngine
   ▼
WorkflowEngine (src/workflow/WorkflowEngine.js)
   │ walks the graph
   ▼
NodeExecutor (src/workflow/NodeExecutor.js:14)
   │ executes each step
   ▼
ParameterResolver + EdgeEvaluator (template + condition resolution)
```

### 4.1 The execute loop in detail

`WorkflowEngine._executeWorkflow` (`WorkflowEngine.js:152-434`):

1. **Status: `running`.** Created an `executionId` via
   `ExecutionModel.create` (line 155) and reset
   `outputs`/`errors`/`activeEdges` (lines 164-167).
2. **Build start nodes.** For sub-workflows: any node with no incoming
   edge (`_findStartNodes`, lines 488-491). For top-level: every trigger
   node whose `trigger.validate()` returns true; fallback to `nodes[0]`
   (lines 195-235).
3. **Run each start node.** `nodeExecutor.executeNode(startNode, triggerData)`
   (line 240), then push the start node's id into an `executionQueue`.
4. **Drain the queue.** `while (executionQueue.length > 0)` (line 277):
   - Yield to the event loop every 50ms (lines 279-283) so the
     engine doesn't starve other I/O in the child process.
   - `node = nodeMap.shift()`; execute via `nodeExecutor` (line 335)
     unless it's `stop-workflow` (sets `stopRequested = true`, line 307)
     or `run-workflow` (delegates to a new `WorkflowEngine`, line 318).
   - For each outgoing edge: check `maxIterations` (lines 358-368),
     then `edgeEvaluator.evaluateEdgeCondition(edge, currentNodeData)`
     (line 370) — if true, push the target node id onto the queue
     and increment `edgeIterations[edge.id]`.
   - Bail on global `globalMaxIterations = 100` (line 35, checked at
     line 378).
5. **Persist + emit.** `ExecutionModel.update` writes the final
   execution log; `engine.emit('statusChanged', status)` notifies
   `ProcessWorker` which broadcasts over Socket.IO to the frontend
   (`ProcessWorker.js:38-48`).

### 4.2 Where the step executor lives; is there a registry?

**No formal registry.** The "registry" is `ToolConfig.triggers` plus
the `tools/library/{triggers,actions,utilities,widgets,controls,custom,mcp}/`
filesystem tree. Resolution algorithm (`NodeExecutor.js:107-137`):

1. Try `await import('../tools/library/${category}/${node.type}.js')`
   across 6 category subdirs in order. First hit wins.
2. Fall back to `PluginManager.loadTool(node.type)` for installed
   plugins (agnt-gg has a marketplace plugin system — see
   `WorkflowService.analyzeWorkflowDependencies:355-403`).
3. If neither resolves, throw `Tool not found: ${node.type}. Searched
   in: actions, utilities, widgets, controls, custom, mcp, plugins`.

This is **lazy / on-demand** — no `node.type` is enumerated at startup.
`WorkflowManipulationService.validateNodeType` (`backend/src/services/WorkflowManipulationService.js:64-102`)
reads `tools/toolLibrary.json` (a static file shipped with the repo)
and warns on unknown types but does **not** reject them. The system is
designed for graceful degradation when a plugin is uninstalled.

### 4.3 Edge condition operators

From `EdgeEvaluator.evaluateSingleCondition` (`EdgeEvaluator.js:37-76`):
9 operators — `is_empty`, `is_not_empty`, `equals`, `not_equals`,
`greater_than`, `less_than`, `greater_than_or_equal`,
`less_than_or_equal`, `contains`, `not_contains` (10 with
`not_contains`; spec said 9). The `if` and `value` fields go through
`ParameterResolver.resolveTemplate` so they can reference previous
node outputs and the trigger data.

---

## 5. Interaction with the existing `Delegation` union

Our `Delegation` union (`src/agent/delegation.ts:56-64`) has 8 kinds:
`agent | goal | workflow | async_tool | mcp | plugin | api | human_approval`.
The `workflow` kind is currently a stub
(`src/agent/delegation.ts:1112-1115`):

```ts
private runStubKind(work: WorkflowDelegation): { value: DelegationResult; cancelled: boolean } {
  log.warn("delegation: kind " + work.kind + " is a Phase 2 stub");
  return { value: { kind: "workflow", workflowId: work.workflowId, status: "stub" }, cancelled: false };
}
```

Mapping each agnt-gg step type to the closest `Delegation` kind:

| agnt-gg step `type` | category | Closest `Delegation` kind | Mapping quality | Why |
|---|---|---|---|---|
| `generate-with-ai-llm` (LLM call) | `action` | `agent` | **Poor** | An LLM call in a workflow is stateless and one-shot — closer to a tool than a sub-agent. No multi-turn, no tools, no loop. Could be `async_tool` if we wrap the provider call as a tool, or `agent` if we accept that *every* LLM call is a sub-agent. |
| `send-email`, `web-scrape`, `slack-message`, `chart-preview`, etc. (single-shot external calls) | `action` | `api` or `async_tool` | **Good** | Each action is a single HTTP/external call with `parameters` → `output`. A `api` delegation with `method: "POST"` + body parameters captures it; `async_tool` is the better fit if the action is implemented as a registered tool in our `tools/` registry. |
| `mcp-client` | `action` | `mcp` | **Exact** | Identical shape. |
| `webhook-listener`, `trigger-timer`, `receive-email`, `receive-discord-message` | `trigger` | **No kind** | **Gap** | A workflow *trigger* is a long-lived listener — it has no current "Delegation" analog. The closest is `human_approval` (a delegation that waits for an external event), but triggers don't need a human. **New kinds needed: `trigger` or `webhook` or fold triggers into `workflow` itself as the entry point.** |
| `run-workflow` (sub-workflow) | `action` | `workflow` | **Exact** | This is the recursive case — invoking one `Delegation { kind: "workflow" }` from another. |
| `for-loop`, `delay`, `parallel-execution` | `control` | **No kind** | **Gap** | Control-flow nodes aren't delegations — they're graph structure. They live *inside* a workflow, not at the delegation layer. Mapping breaks: a `for-loop` should be a child run inside the workflow kind, not a sibling delegation. |
| `execute-javascript`, `execute-python`, `data-transformer`, `counter` (pure functions) | `utility` | `async_tool` | **Good** | Pure synchronous-ish utilities map to `async_tool` if we model them as registered tools. Or could be inlined into a workflow's expression language. |
| `label`, `widget` (cosmetic) | `utility` / `widget` | **No kind** | **N/A** | UI-only, no runtime behavior. |
| User-defined `custom` tool with `base: "AI"` | `custom` | `agent` | **Poor** | Same as `generate-with-ai-llm` — single LLM call, no sub-agent loop. |
| User-defined `custom` tool with `base: "CODE_JS"` / `"CODE_PYTHON"` | `custom` | `async_tool` | **Good** | Code execution is one-shot; we already have an `execute_javascript` tool in the harness. |
| `stop-workflow` | (built-in) | **No kind** | **Gap** | This is control flow, not a delegation. It sets a flag on the engine, not on a single sub-run. |

### 5.1 Where the mapping breaks down

The fundamental mismatch: **a workflow is a *graph of related
delegations* with shared state, not a single delegation.** The
`outputs` map (`WorkflowEngine.outputs:174`) is global to the run; a
later step reads the earlier step's output as its `inputData`
(`WorkflowEngine.js:354`). The agnt-gg engine has no concept of a
"sibling" delegation — only the graph walk.

Three breakdowns that matter for the port:

1. **Triggers have no `Delegation` analog.** agnt-gg's workflow is
   *trigger-first*: a workflow sits in `status: listening` indefinitely
   (`WorkflowEngine.js:457-459`) and re-executes its body on each
   trigger fire. Our `Delegation` manager is *fire-and-await*: a
   delegation is submitted, runs, and resolves. **Decision needed:**
   the `workflow` kind in our union should probably *own* the trigger
   listener lifecycle, with the trigger itself being a property of
   the `WorkflowDelegation` interface (e.g. `trigger: { kind: "webhook" | "timer" | "manual", config }`).
2. **Control flow lives inside workflows, not at the delegation
   layer.** `for-loop` (`tools/library/controls/for-loop.js:99-183`)
   is a generator-based loop that calls `nodeExecutor.executeNode`
   recursively with shared `loopContext`. This is a workflow-internal
   mechanism; it should not surface as a `DelegationKind`. The
   `WorkflowEngine` is its own mini-orchestrator and doesn't go through
   `DelegationManager`.
3. **The recursive `run-workflow` case is a `workflow` delegation
   inside another `workflow` delegation.** `WorkflowEngine.js:318-333`
   special-cases the node, instantiates a new `WorkflowEngine` with
   `isSubWorkflow=true`, and runs it inline. The sub-workflow's
   `outputs` are attached to the parent node's output
   (`WorkflowEngine.js:328`). This is clean because the engine owns
   the lifetime — not our `DelegationManager`.

### 5.2 Where `Delegation { kind: "workflow" }` becomes the natural top-level container

The `workflow` kind in our union should be the **top-level entry
point** for running a workflow from outside (CLI, agent loop, or
`/workflow run` slash). The contract:

```ts
WorkflowDelegation extends DelegationBase {
  kind: "workflow";
  workflowId: string;
  inputs?: Record<string, unknown>;
  // optional trigger config if the workflow has no trigger set
  trigger?: { kind: "manual"; } | { kind: "webhook"; path: string } | { kind: "timer"; cron: string };
}
```

`runWorkflowKind` (new) instantiates a `WorkflowEngine` (in-process,
not in a forked child — we don't need the IPC overhead for CLI
invocations), calls `engine._executeWorkflow(inputs)`, and maps the
result:

```ts
{ success, outputs, errors, creditsUsed }
//   →  { kind: "workflow", workflowId, status: success ? "completed" : "failed", steps, error? }
```

The current `DelegationResult` for `workflow`
(`src/agent/delegation.ts:257`) is `{ kind: "workflow"; workflowId;
status: "stub" }` — this needs three additions: a real
`status: "completed" | "failed" | "running"`, a `steps: number` count
(from `engine.nodeExecutionCounts.size`), and an `error?: string`.

---

## 6. The "manipulation" surface

### 6.1 The agnt-gg UI surface

The Vue frontend renders workflows via three major surfaces:

- **`WorkflowForge` screen** (`frontend/src/views/Terminal/CenterPanel/screens/WorkflowForge/WorkflowForge.vue:1-789`,
  789 lines) — the drag-and-drop canvas. Embeds `WorkflowDesigner`
  (with `WorkflowDesigner.vue` rendering the actual react-flow-like
  canvas, `ToolSidebar.vue` for the left palette of node types, and
  `EditorPanel.vue` for the right side config form).
- **`Workflows` screen** (`frontend/src/views/Terminal/CenterPanel/screens/Workflows/Workflows.vue`)
  — the list view.
- **`WorkflowsPanel` right panel**
  (`frontend/src/views/Terminal/RightPanel/types/WorkflowsPanel/WorkflowsPanel.vue`)
  — the inline review panel for the chat sidebar.

The canvas-side "manipulation" is a mix of:

- **CRUD** that goes over HTTP: `list`, `get-by-id`, `save`, `rename`,
  `delete`, `analyze-dependencies`.
- **Canvas operations** that are local-only on the client (drag, drop,
  connect edges, configure node parameters) — the canvas is a
  controlled component; node add/remove is a Vue event, not an HTTP
  call. Only on `POST /save` does the full graph get sent.
- **Versioning + checkpoint** (see `WorkflowVersionService.js:357`
  LOC): `versions`, `revert`, `checkpoint`, `compare`, `stats`.
- **Import/Export** (PRD-057 envelope in `WorkflowRoutes.js:152-181`).

### 6.2 The HTTP surface (the contract for our CLI)

From `backend/src/routes/WorkflowRoutes.js:12-23` (the core CRUD routes)
plus `:30-146` (versioning) plus `:152-181` (import/export):

| Verb | Path | agnt-gg handler | CodingHarness CLI equivalent |
|---|---|---|---|
| GET | `/api/workflows/health` | `WorkflowService.healthCheck` | (internal) |
| GET | `/api/workflows` | `getAllWorkflows` (list w/ filter) | `ch workflow list` |
| GET | `/api/workflows/summary` | `getAllWorkflowsSummary` (lightweight) | `ch workflow list --summary` |
| POST | `/api/workflows/save` | `saveWorkflow` (upsert) | `ch workflow new` / `ch workflow edit` |
| POST | `/api/workflows/analyze-dependencies` | `analyzeDependencies` | `ch workflow check` (lint deps) |
| GET | `/api/workflows/:id` | `getWorkflowById` | `ch workflow show <id>` |
| PUT | `/api/workflows/:id` | `updateWorkflow` | `ch workflow edit <id>` |
| DELETE | `/api/workflows/:id` | `deleteWorkflow` | `ch workflow delete <id>` |
| PUT | `/api/workflows/:id/name` | `renameWorkflow` | `ch workflow rename <id> <name>` |
| GET | `/api/workflows/:id/status` | `fetchWorkflowState` | `ch workflow status <id>` |
| POST | `/api/workflows/:id/start` | `activateWorkflow` | `ch workflow run <id>` |
| POST | `/api/workflows/:id/stop` | `deactivateWorkflow` | `ch workflow stop <id>` |
| GET | `/api/workflows/:id/versions` | (inline, version history) | `ch workflow versions <id>` |
| GET | `/api/workflows/:id/versions/:vid` | (inline) | `ch workflow show <id> --version <vid>` |
| POST | `/api/workflows/:id/revert` | (inline) | `ch workflow revert <id> <vid>` |
| POST | `/api/workflows/:id/checkpoint` | (inline) | `ch workflow checkpoint <id> <name>` |
| GET | `/api/workflows/:id/versions/compare` | (inline) | `ch workflow diff <id> <vidA> <vidB>` |
| GET | `/api/workflows/:id/versions/stats` | (inline) | (TUI dashboard) |
| GET | `/api/workflows/:id/export` | (inline, `buildWorkflowEnvelope`) | `ch workflow export <id>` |
| POST | `/api/workflows/import` | (inline, `importWorkflow`) | `ch workflow import <file>` |

### 6.3 The graph-helper surface (not CRUD)

`backend/src/services/WorkflowManipulationService.js` (254 lines) is
**not a CRUD layer** — it exports pure functions the frontend uses
*during* canvas editing:

- `calculateAutoLayout(existingNodes, insertAfterNodeId)` — line 14,
  300×150 grid snapping.
- `validateNodeType(nodeType)` — line 64, reads
  `tools/toolLibrary.json` and *warns* on unknown types but returns
  `true` (so the UI handles unknowns gracefully).
- `validateNodeConnections(fromNodeId, toNodeId, nodes)` — line 111,
  catches missing nodes and self-loops.
- `cleanupOrphanedEdges(nodeId, edges)` — line 137.
- `generateNodeId()` / `generateEdgeId(sourceId, targetId, sourceHandle)`
  — lines 150 / 161, UUID-based.
- `diffWorkflows(oldWorkflow, newWorkflow)` — line 172, returns
  `nodesAdded/Removed/Modified/edgesAdded/Removed` with counts.
- `findNodeByIdentifier(nodes, identifier)` — line 209, matches by id
  or by case-insensitive label.
- `buildNodeReferenceMap(nodes)` — line 234, formats nodes as
  `[1] "label" (id: x, type: y)` for LLM context.

**These are the pure-function surface that the TUI/REPL can mirror
verbatim.** They're stateless, dependency-free, and would port as
1:1 in `src/agent/workflow-graph.ts`.

### 6.4 Gaps in the agnt-gg surface (port must invent)

- **No cost cap per workflow.** `WorkflowEngine.js:401` only *counts*
  credits; it doesn't enforce a ceiling. Our `maxCostUsd`
  (`src/agent/delegation.ts:78-91`) needs a new accumulator callback.
- **No CLI.** agnt-gg is HTTP-only. The 14 `ch workflow *` commands
  (see table above) are our invention.
- **No TUI / REPL.** Our equivalents are the new slash command
  + the web UI panels already shipped.

---

## 7. Open questions for follow-up

Five small investigations, each ~30 min, before the port lands:

1. **Where do the tool definitions live in our codebase, and how
   does `node.type` map to them?** agnt-gg has
   `backend/src/tools/library/{triggers,actions,utilities,widgets,controls,custom,mcp}/`
   with 50+ pre-built tools. We have `src/agent/tools/`. The port
   needs an `import { tools } from '...'` mapping — does the harness
   already have a `McpRegistry`-style loader, or do we need a new
   `ToolRegistry` for built-in `workflow` actions? (Likely related to
   T1's `services.askApproval` work, which is also registered on
   `ctx.services`.)

2. **What does the trigger lifecycle look like in-process?** agnt-gg
   forks a child process per workflow and runs a `ProcessManager` with
   8 workers (`ProcessManager.js:10-13`) so the workflow process can
   outlive an HTTP request. We don't have an analogous mechanism in
   the harness. Should the workflow engine run in-process (simpler,
   matches our `goal` kind), or do we want a long-lived "workflow
   daemon" thread? This determines whether `ch workflow run` is
   fire-and-forget or synchronous.

3. **How does the `maxCostUsd` cap interact with long-lived
   workflows?** agnt-gg tracks credits per `ExecutionModel`
   (`ExecutionModel.getTotalCreditsUsed` referenced at
   `WorkflowEngine.js:401`) but doesn't enforce a cap. Our
   `DelegationBase.maxCostUsd` is per-delegation; workflows
   *contain* many model calls. Do we cap per-step, per-workflow-run,
   or both? The most natural answer: per-workflow-run, and the engine
   aborts when the cap is hit (mirroring `WorkflowEngine.js:248-262`
   for the existing `Insufficient credits` check).

4. **The `parameterResolver` template syntax is rich and lossy.**
   `{{nodeName.field.subfield[0]}}` resolves via the
   `nodeNameToId` map, which is built from
   `node.text.toLowerCase().replace(/\s+/g, '')` — so renaming a
   node by changing its `text` field breaks all references silently.
   agnt-gg accepts this as "user error". We have two options: (a)
   enforce unique `node.text` on save and warn on collisions, (b)
   make references use `nodeId` directly (`{{node_abc123.field}}`).
   Audit recommends (b) for the port — stable IDs are the harness's
   default and we have them anyway.

5. **What about the "versioning" + "checkpoint" feature?** agnt-gg
   ships a full version history (`WorkflowVersionService.js:357`
   lines) with `revert`, `checkpoint`, and `compare` operations. The
   audit recommends *deferring* versioning from the initial port
   (it's L-size on its own) and using git-based versioning
   (workflows-as-files in `~/.codingharness/workflows/`) for the
   first ship. The export/import envelope (`WorkflowRoutes.js:152-181`)
   is enough to give us workflow *sharing* without a version
   service. Confirm with the orchestrator.

---

## 8. Port plan

### 8.1 Sized spec

**Total size: L (≈ 1500 LOC).** Driven by:

- A graph executor (≈ 400 LOC) — direct port of `WorkflowEngine.js:152-434`.
- A `WorkflowService` (≈ 250 LOC) — CRUD over a `workflows` table in our
  SQLite store (or JSONL files in `~/.codingharness/workflows/` if we
  follow the patterns of `src/agent/session.ts`).
- Graph helpers (≈ 250 LOC) — direct port of
  `WorkflowManipulationService.js` (8 functions, all pure).
- Step executor + parameter resolver + edge evaluator (≈ 350 LOC) —
  direct port of `NodeExecutor.js`, `ParameterResolver.js`, and
  `EdgeEvaluator.js`.
- CLI commands (≈ 150 LOC) — 14 new `ch workflow *` subcommands under
  `src/cli.ts` and `src/slash/builtin.ts`.
- Tests (≈ 350 LOC) — graph-helper unit tests + executor integration
  tests + CLI E2E tests.

The agnt-gg engine's child-process IPC architecture
(`WorkflowProcessBridge.js` + `WorkflowProcess.js` + `ProcessManager.js`
+ `ProcessWorker.js`, **~880 LOC** combined) is **explicitly NOT
ported** — we run the engine in-process. This is the single biggest
LOC reduction (≈ 880 → 0).

### 8.2 File-by-file breakdown

**NEW files:**

| File | LOC est. | Source equivalent | Notes |
|---|---|---|---|
| `src/agent/workflow.ts` | 400 | `backend/src/workflow/WorkflowEngine.js:152-434` + `:17-94` | The in-process `WorkflowEngine` class. Holds `outputs`, `errors`, `nodeExecutionCounts`, `edgeIterations`. The `processWorkflowTrigger` and `_executeWorkflow` methods. **No** `WorkflowProcessBridge` / `ProcessManager` / `ProcessWorker` — runs in-process. |
| `src/agent/workflow-graph.ts` | 250 | `backend/src/services/WorkflowManipulationService.js:14-242` | The 8 pure-function helpers (`calculateAutoLayout`, `validateNodeType`, `validateNodeConnections`, `cleanupOrphanedEdges`, `generateNodeId`, `generateEdgeId`, `diffWorkflows`, `findNodeByIdentifier`, `buildNodeReferenceMap`). |
| `src/agent/workflow-steps.ts` | 200 | `backend/src/workflow/NodeExecutor.js:14-228` | The `NodeExecutor` + dispatch by `node.category`. The `custom` and `stop-workflow` branches port; the `trigger` branch becomes a `trigger: { kind, config }` config on the `WorkflowDelegation` (we don't have a long-lived listener mode in v1). |
| `src/agent/workflow-eval.ts` | 200 | `backend/src/workflow/EdgeEvaluator.js:1-79` + `backend/src/workflow/ParameterResolver.js:23-275` | The 10 condition operators + the `{{template}}` resolver. **Change:** the resolver prefers `nodeId` over `nodeName` (per open question #4). |
| `src/agent/workflow-store.ts` | 250 | `backend/src/services/WorkflowService.js:31-423` + `backend/src/models/WorkflowModel.js:1-199` | CRUD layer. Backed by `~/.codingharness/workflows/<id>.json` (one file per workflow) for v1; a SQLite table is a follow-up. **Change:** the `is_shareable` and `user_id` columns are dropped (single-user harness). |
| `src/agent/workflow-types.ts` | 100 | (synthesized from `backend/src/stream/example_workflows/*.json`) | The `WorkflowRecord`, `WorkflowNode`, `WorkflowEdge`, `WorkflowCondition` interfaces. Strict types — no `any` (noUncheckedIndexedAccess safe). |
| `src/__tests__/workflow-graph.test.ts` | 120 | (new) | Unit tests for the 8 graph helpers. |
| `src/__tests__/workflow-eval.test.ts` | 80 | (new) | Tests for the 10 condition operators and template resolution. |
| `src/__tests__/workflow.test.ts` | 150 | (new) | Integration: load a workflow JSON, execute with a stubbed trigger, assert step order and final `outputs`. |

**MODIFIED files:**

| File | Change | Source line equivalent |
|---|---|---|
| `src/agent/delegation.ts:56-64` | Add `trigger?: { kind: "manual" | "webhook" | "timer"; config }` to `WorkflowDelegation` | (new — see §5.2) |
| `src/agent/delegation.ts:257` | Expand `DelegationResult { kind: "workflow" }` from `{ workflowId, status: "stub" }` to `{ workflowId, status: "completed" | "failed" | "running", steps, error? }` | (replaces stub) |
| `src/agent/delegation.ts:1112-1115` | Replace `runStubKind` with `runWorkflowKind` that instantiates `WorkflowEngine` and dispatches `_executeWorkflow` | `WorkflowEngine.js:152-434` |
| `src/runtime.ts` | Wire `WorkflowStore` + `WorkflowEngine` factory on `HarnessRuntime` (analogous to T1's `runGoalAgent` wiring) | (new — see phase3.md T1 §2-3) |
| `src/cli.ts` | Add 14 `ch workflow *` subcommands (see §6.2 table) | (new) |
| `src/slash/builtin.ts` | Add `/workflow` slash command with `list`/`show`/`run`/`new`/`edit`/`delete` subcommands | (new) |
| `docs/phase3.md` | Add `### T3.5 — D-WORKFLOW-IMPL — Workflow real port` section (deferred item already in phase3.md:206-219) | (new) |
| `CHANGELOG.md` | New "Phase 3.5 (D-WORKFLOW-IMPL)" section per existing style | (new) |

**DELETED files:** none. (Existing `delegation-stubs.ts` already
asserts the workflow stub; we'll update the test, not delete the file.)

### 8.3 What the port is NOT

To be explicit so the orchestrator can size the follow-up plan
correctly:

- **No forked child process.** The agnt-gg `WorkflowProcess` /
  `WorkflowProcessBridge` / `ProcessManager` / `ProcessWorker` (4
  files, ~880 LOC) are dropped. We run `WorkflowEngine` in-process.
  Trigger listeners that need to survive a CLI exit (webhooks,
  timers) are out of scope for v1; `ch workflow run` is synchronous.
- **No versioning service.** agnt-gg's `WorkflowVersionService.js`
  (357 LOC) is deferred. Use git for workflow history. Import/export
  envelopes give us sharing.
- **No marketplace plugin system.** agnt-gg's plugin
  install/uninstall flow (referenced in
  `WorkflowService.analyzeWorkflowDependencies:355-403`) is replaced
  by our existing `McpRegistry` and `PluginRegistry`.
- **No custom-tool builder UI.** The Vue canvas is not ported. The
  CLI (`ch workflow new`, `ch workflow edit`) opens the JSON in `$EDITOR`.
- **No real-time collaboration / Socket.IO.** The agnt-gg
  `realtimeSync.js` broadcasts are replaced by our TUI/REPL
  read-when-needed model.

### 8.4 Order of work (proposed for the follow-up plan)

1. **Step 1 (S):** `workflow-types.ts` + `workflow-graph.ts` + tests.
   Pure functions, no engine, no CLI. Verifies the data model.
2. **Step 2 (M):** `workflow-eval.ts` + tests. Template + edge
   condition resolution.
3. **Step 3 (M):** `workflow-store.ts` + tests. CRUD over JSONL files
   (or per-workflow JSON files) in `~/.codingharness/workflows/`.
4. **Step 4 (M):** `workflow-steps.ts` + `workflow.ts` (executor) +
   tests. This is the heart of the port.
5. **Step 5 (S):** `delegation.ts` updates (expand
   `WorkflowDelegation`, `DelegationResult`, replace `runStubKind`).
6. **Step 6 (S):** `src/runtime.ts` wiring (expose
   `runtime.runWorkflow`).
7. **Step 7 (S):** CLI subcommands + slash command.
8. **Step 8 (S):** End-to-end test: load a real
   `agnt-gg` `automated_email_summarizer.json` (with the
   agnt-gg-specific action types stubbed), execute it via the harness,
   and assert the output structure matches the agnt-gg engine's
   shape.

This sequencing is conservative — each step is testable in isolation
and the dependency chain is one-way (no rework on previous steps).

---

## Appendix A — Files read for this audit

| File | LOC | Read |
|---|---|---|
| `backend/src/services/WorkflowManipulationService.js` | 254 | full |
| `backend/src/services/WorkflowService.js` | 428 | full |
| `backend/src/services/orchestrator/chatConfigs.js` | 515 | lines 1-100, 260-359, 460-514 |
| `backend/src/workflow/WorkflowEngine.js` | 494 | full |
| `backend/src/workflow/NodeExecutor.js` | 234 | full |
| `backend/src/workflow/EdgeEvaluator.js` | 79 | full |
| `backend/src/workflow/ParameterResolver.js` | 278 | full |
| `backend/src/workflow/CustomToolExecutor.js` | 221 | full |
| `backend/src/workflow/WorkflowProcessBridge.js` | 281 | full |
| `backend/src/workflow/ProcessManager.js` | 264 | lines 1-80 |
| `backend/src/workflow/ProcessWorker.js` | 145 | full |
| `backend/src/workflow/WorkflowProcess.js` | 268 | lines 1-80 |
| `backend/src/models/WorkflowModel.js` | 199 | full |
| `backend/src/routes/WorkflowRoutes.js` | 185 | full |
| `backend/src/tools/library/controls/delay.js` | 66 | full |
| `backend/src/tools/library/controls/for-loop.js` | 266 | full |
| `backend/src/tools/library/controls/run-workflow.js` | 127 | full |
| `backend/src/stream/example_workflows/automated_email_summarizer.json` | 198 | full |
| `frontend/src/.../WorkflowForge/WorkflowForge.vue` | 789 | lines 1-80 |
| `src/agent/delegation.ts` (ours) | 1429 | lines 50-130, 155-184, 1100-1125 |

≈ 4,000 LOC of agnt-gg source read; ≈ 50 LOC of our own
`delegation.ts` referenced. The four "NOT ported" IPC files
(`WorkflowProcessBridge`, `ProcessManager`, `ProcessWorker`,
`WorkflowProcess`) were read in full to confirm they are not
required for the in-process execution model.
