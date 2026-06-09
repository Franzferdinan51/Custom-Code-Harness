# agnt-gg → CodingHarness Port Plan (Phase 1)

**Status:** SPIKE — design-only deliverable. No production code.
**Branch:** `phase1/spike`
**Author:** Developer @ CodingHarness
**Date:** 2026-06-09
**Sources audited:**

- `https://github.com/agnt-gg/agnt` (cloned to `/tmp/agnt-gg`)
  - `CLAUDE.md` (project overview, architecture, plugin system)
  - `CODEX.md` (duplicate of CLAUDE.md — used here for completeness)
  - `DESIGN.md` (UI/UX design tokens — pink `#e53d8f` primary, cyan `#12e0ff` secondary, dark-navy surfaces)
  - `backend/src/services/OrchestratorService.js` (3077 LOC) — universal chat handler, mid-run `/steer`, AGI re-plan loop
  - `backend/src/services/goal/GoalProcessor.js` (402 LOC) — plan phase (LLM breaks goal → tasks)
  - `backend/src/services/goal/GoalEvaluator.js` (470 LOC) — evaluate phase (LLM scores tasks against success criteria)
  - `backend/src/services/goal/TaskOrchestrator.js` (1307 LOC) — execute phase (parallel task groups, replan-on-fail)
  - `backend/src/services/goal/AgentTaskMatcher.js`, `TraceAnalyzer.js`, `SkillEvolver.js`, `SkillForgeOrchestrator.js` — supporting goal subsystems
  - `backend/src/services/AsyncToolQueue.js` (549 LOC) — long-running tool queue with periodic execution
  - `backend/src/models/GoalModel.js` (203 LOC) — DB schema with `status`, `loop_status`, `current_iteration`, `max_iterations`, `world_state`
  - `backend/src/routes/AsyncToolRoutes.js` — REST surface for queue

- CodingHarness current state
  - `src/agent/loop.ts` (342 LOC) — single-turn agent loop
  - `src/agent/subagent.ts` (300 LOC) — `SubAgentManager` (name-keyed, ephemeral or persistent)
  - `src/agent/council.ts` (275 LOC) — multi-agent council (consensus / adversarial)
  - `src/agent/goals.ts` (182 LOC) — `GoalStore` JSON persistence (one-shot)
  - `src/ui/repl.ts` (122 LOC) — minimal line-based REPL
  - `src/ui/tui.ts` (665 LOC) + `tui-app.ts` (293 LOC) + `approval-modal.ts` (96 LOC) — OpenTUI TUI
  - `src/agent/agents.ts` — built-in agent allowlists (explore/plan/review/summarize/implement/test)

---

## 1. Goal Lifecycle Port

### 1.1 Current state in CodingHarness

`src/agent/goals.ts` (182 LOC) exposes:

- `GoalStatus = "pending" | "in_progress" | "complete" | "blocked" | "failed"`
- `GoalRecord { id, objective, status, createdAt, updatedAt, maxSteps, stepsTaken, finalText?, model?, providerId? }`
- `GoalStore` — JSON file at `$CH_HOME/goals.json` with `add / list / get / update / remove / clear / markInProgress / recordStep`
- One-shot runner in `src/cli.ts` (`ch goal <objective>`) — runs `runAgent` to `maxSteps`, persists final text, no re-plan, no eval.

The runner is **non-resumable**: on abort or crash, the goal record stays in `in_progress` and there is no way to resume, replan, or evaluate.

### 1.2 agnt-gg's state machine (target)

Across `GoalModel.js`, `GoalProcessor.js`, `GoalEvaluator.js`, `TaskOrchestrator.js`, and `OrchestratorService.js:927-987`, agnt-gg uses **two parallel status fields**:

| Field | Type | Values | Where |
|---|---|---|---|
| `goals.status` | top-level lifecycle | `pending → executing → completed` / `needs_review` / `validated` / `stuck` / `failed` | `GoalModel.updateStatus` (L106-115) |
| `goals.loop_status` | AGI loop phase | `planning → executing → evaluating → replanning → completed` / `stuck` | `GoalModel.updateLoopStatus` (L152-163) |

`OrchestratorService.js:927-987` is the canonical AGI loop:

```
needs_improvement (score < 70) → loop_status = 'replanning'
                              → _replanFailedTasks (LLM call, L1035-1144)
                              → guard identical-replan × 3 → 'stuck'
                              → else loop again
```

### 1.3 Target state diagram

```
   ┌─────────┐
   │ pending │   (GoalStore.add)
   └────┬────┘
        │ /goal <objective> or auto-detect
        ▼
   ┌──────────┐
   │ planning │   ← plan phase: LLM breaks objective into tasks,
   └────┬─────┘     writes goal_plan (subgoals + dependencies).
        │
        ▼
   ┌──────────┐
   │ executing│   ← task-by-task execution. Each task is its own
   └──┬───┬───┘     subagent (subagent.ts) — parallel where deps allow.
      │   │
      │   └────► (replan entry) ──► replanning ──► executing (loop)
      │                                                        ▲
      ▼                                                        │
   ┌────────────┐                                             │
   │ evaluating │   ← GoalEvaluator: score tasks against      │
   └──┬─────┬───┘     success_criteria (golden standards).     │
      │     │                                                  │
      │     ├── score ≥ 70% ──► complete (validated)          │
      │     │                                                  │
      │     ├── score < 70% ──► replanning ───────────────────-┘
      │     │
      │     ├── no output / crash ──► failed
      │     │
      │     └── 3× identical replan ──► stuck
      ▼
   [terminal] complete | failed | blocked | stuck | reverted
```

Pause / resume / revert are orthogonal to this machine:

- `paused` — user typed `/pause` (or signal received); current `subagent` AbortSignal is fired; record remains, `loop_status = 'paused'`. Resume re-runs the next step with the persisted history.
- `reverted` — user typed `/revert <id> <step>`; `goals/world_state` snapshot from before that step is restored, `loop_status` rolls back to `planning` or earlier `executing`. (agnt-gg does not implement this today; it's a Phase 1 *new* behavior we add because our goals are JSON-snapshot-friendly.)

### 1.4 State → file/line → target mapping

| agnt-gg source | Line range | Behavior | CodingHarness target |
|---|---|---|---|
| `GoalProcessor.js:_analyzeGoal` | L149-277 | LLM breaks goal into tasks (title, description, requiredTools, dependencies, orderIndex) | **NEW** `src/agent/goal-planner.ts` — `planGoal(objective, ctx): Promise<GoalPlan>`; uses `runAgent` with a JSON-only system prompt and `capToolResult` to stay crash-safe |
| `GoalProcessor.js:processGoal` | L21-66 | Orchestrates the plan phase | **NEW** `src/agent/goal-runner.ts` — `runGoal(goal, deps): AsyncIterable<GoalEvent>`; emits `plan → executing → evaluating → replanning` events |
| `GoalProcessor.js:validateGoalCompletion` | L73-89 | Checks all tasks complete | Folded into runner's `evaluating` step |
| `GoalEvaluator.js:evaluateGoal` | L27-158 | LLM-scored per-task evaluation against success criteria | **NEW** `src/agent/goal-evaluator.ts` — `evaluateGoal(goal, ctx): Promise<EvaluationReport>` |
| `GoalEvaluator.js:aiEvaluateTaskOutput` | L209-313 | Per-task scoring JSON-shape | Inside `goal-evaluator.ts` |
| `GoalEvaluator.js:calculateOverallScores` | L321-350 | weighted `completeness*0.3 + quality*0.7` | Inside `goal-evaluator.ts` |
| `TaskOrchestrator.js:executeGoal` | L26-68 | Marks goal executing, kicks off tasks | Inside `goal-runner.ts` |
| `TaskOrchestrator.js:executeGoalTasks` | L69+ | Parallel task groups, ordered by `orderIndex` | Inside `goal-runner.ts` — uses `SubAgentManager.spawnMany` with the per-task tool allowlist |
| `OrchestratorService.js:927-987` | AGI re-plan loop | score < 70 → replan → identical-replan guard | Inside `goal-runner.ts` (the loop) |
| `TaskOrchestrator.js:_replanFailedTasks` | L1035-1144 | LLM regenerates failed tasks | **NEW** `src/agent/goal-replanner.ts` — `replan(goal, eval, ctx): Promise<GoalPlan>` |
| `OrchestratorService.js:40-85` (`/steer`) | mid-run user steer | stash + apply to last tool result | **NEW** `src/agent/steer.ts` — `SteerQueue`; integrated into `loop.ts` post-tool result message append |
| `GoalModel.js:updateLoopStatus` | L152-163 | `loop_status` column | Extend `GoalRecord.loopStatus: GoalLoopStatus` (see 1.5) |
| `GoalModel.js:updateWorldState` | L124-135 | JSON snapshot per iteration | Extend `GoalRecord.worldState?: Record<string, unknown>` |
| (no agnt-gg equivalent) | — | `/pause` `/resume` `/revert` | **NEW** `src/agent/goal-control.ts` — `pause(goalId) / resume(goalId) / revert(goalId, stepId)`; goal-runner subscribes to a per-goal control channel |

### 1.5 Schema changes (Phase 1)

`GoalRecord` becomes (additions marked **+**):

```ts
type GoalStatus = "pending" | "in_progress" | "complete" | "blocked" | "failed";
type GoalLoopStatus =
  | "planning" | "executing" | "evaluating"
  | "replanning" | "paused" | "stuck"
  | "complete" | "needs_review" | "validated";

interface GoalRecord {
  id: string;
  objective: string;
  status: GoalStatus;            // (existing)
  + loopStatus: GoalLoopStatus;  // (new) — the AGI state machine
  createdAt: number;
  updatedAt: number;
  maxSteps: number;              // renamed to maxIterations (but keep alias)
  + currentIteration: number;    // (new)
  stepsTaken: number;
  finalText?: string;
  model?: string;
  providerId?: string;
  + successCriteria?: {          // (new) — golden standards
      deliverables: string[];
      qualityChecks: string[];
    };
  + plan?: {                     // (new) — output of the plan phase
      tasks: GoalTask[];
      estimatedDurationMin?: number;
    };
  + evaluations?: GoalEvaluation[]; // (new) — history of evaluator runs
  + worldState?: Record<string, unknown>; // (new) — revert snapshots
  + parentGoalId?: string;       // (new) — for sub-goals
}

interface GoalTask {
  id: string;             // task-<ts>-<rand>
  title: string;
  description: string;
  requiredTools: string[];
  dependencies: string[]; // task ids this one waits on
  orderIndex: number;
  status: "pending" | "in_progress" | "complete" | "failed" | "skipped";
  output?: unknown;
  startedAt?: number;
  completedAt?: number;
  agentName?: string;     // which subagent ran it
  sessionId?: string;
}

interface GoalEvaluation {
  id: string;
  iteration: number;
  scores: { overall: number; completeness: number; quality: number; taskAverage: number };
  passed: boolean;        // overall >= 70
  feedback: string;
  taskEvaluations: Array<{ taskId: string; score: number; feedback: string }>;
  createdAt: number;
}
```

Persistence: bump the JSON envelope `version: 1` → `version: 2`; on read, v1 records are upgraded in-memory only (write a sibling `.v1-backup.json` once, never migrate on the fly).

### 1.6 What's new vs. already exists

| Behavior | agnt-gg | CodingHarness now | Status |
|---|---|---|---|
| Persisted goal record | ✓ | ✓ (`GoalStore`) | port schema, keep store |
| One-shot runner | ✓ | ✓ (`ch goal`) | keep, add `loopStatus` plumbing |
| Plan phase (LLM → tasks) | ✓ | ✗ | **NEW** `goal-planner.ts` |
| Execute phase (task groups) | ✓ | ✗ (just runs the agent once) | **NEW** `goal-runner.ts` |
| Evaluator with golden standards | ✓ | ✗ | **NEW** `goal-evaluator.ts` |
| Re-plan on low score | ✓ | ✗ | **NEW** `goal-replanner.ts` |
| Identical-replan × 3 → `stuck` | ✓ | ✗ | **NEW** in `goal-runner.ts` |
| Sub-goal spawn (parent → child) | partial | ✗ | **NEW** `GoalStore.add({ parentGoalId })` |
| `/pause` `/resume` | ✗ | ✗ | **NEW** `goal-control.ts` |
| `/revert` | ✗ | ✗ | **NEW** `goal-control.ts` |
| Mid-run `/steer` | ✓ (`OrchestratorService.js:40-85`) | ✗ | **NEW** `steer.ts` |
| Snapshot per iteration (for revert) | partial (`world_state` JSON) | ✗ | **NEW** snapshot writer in `goal-runner.ts` |

---

## 2. Subagent Delegation Union

### 2.1 agnt-gg's worker kinds

From `OrchestratorService.js:821` (`universalChatHandler`), `TaskOrchestrator.js`, `AsyncToolQueue.js`, `backend/src/services/orchestrator/agentTools.js`, `codeTools.js`, `chatConfigs.js`, and `PluginManager.js`, agnt-gg dispatches to:

| Kind | Lives in | Lifecycle | Cancellation | Source line refs |
|---|---|---|---|---|
| `agent` (in-process subagent via the orchestrator's main loop) | `OrchestratorService.universalChatHandler` | sync (one chat turn) | per-stream `AbortController` | `OrchestratorService.js:823-860, 970-1005` |
| `goal` (long-running goal loop) | `TaskOrchestrator` | async (background) | `runningGoals` map + per-goal `AbortController` | `TaskOrchestrator.js:24, 40-48` |
| `workflow` (multi-step workflow run) | `WorkflowService` | async (background) | per-workflow `AbortController` | inferred from `WorkflowRoutes.js` and `chatConfigs.js` |
| `async tool` (long-running single tool or periodic) | `AsyncToolQueue` | async, periodic-capable | per-execution `AbortController` + `setInterval` cleanup | `AsyncToolQueue.js:101-141, 273-373, 449-482` |
| `MCP` (Model Context Protocol) | `MCPService` / `MCPToolService` | sync from caller's POV | inherits orchestrator's signal | `services/MCPService.js` |
| `plugin` (.agnt package) | `PluginManager` / `PluginBundler` | sync from caller's POV | inherits orchestrator's signal | `services/plugins/PluginManager.js` |
| `api` (HTTP) | `orchestrator/apiReference.js` | sync | n/a (HTTP) | `services/orchestrator/apiReference.js` |
| `human approval` (request user via modal) | `routes/Middleware.js` + frontend `ApprovalModal.vue` | blocks until user responds | timeout = abort | inferred from CLAUDE.md "approval flow" |

### 2.2 Current CodingHarness subagent (300 LOC, name-keyed)

`src/agent/subagent.ts` already supports a sub-agent kind — keyed by `agent: string` (one of `explore|plan|review|summarize|implement|test|...`). It is **not** a discriminated union yet; it is a single class `SubAgentManager` with a `spawn`/`spawnMany` API and a `spawn_subagent` tool spec.

It is sequential or parallel; persistent session or ephemeral. It does NOT cover goal / workflow / async tool / MCP / plugin / human-approval kinds.

### 2.3 Target: extend vs. new file?

**Recommendation: extend `src/agent/subagent.ts` and add a thin discriminated-union layer `src/agent/delegation.ts`.**

Rationale: ~80% of the existing `SubAgentManager` code (registry lookup, session creation, hooks, vision-routing) is reusable for `agent` and `goal` kinds. Adding a new file would duplicate it. `delegation.ts` becomes the *typed union + dispatcher* and reuses `SubAgentManager` for `agent` and `goal`.

### 2.4 Target discriminated union

```ts
// src/agent/delegation.ts — Phase 1 NEW

export type DelegationKind =
  | "agent"        // one-shot subagent (the current SubAgentManager)
  | "goal"         // long-running goal with plan/execute/eval/replan loop
  | "workflow"     // pre-authored multi-step workflow (Phase 2)
  | "async_tool"   // long-running tool with periodic/timeout support
  | "mcp"          // MCP server tool call (Phase 2)
  | "plugin"       // .agnt package tool call (Phase 2)
  | "api"          // raw HTTP call (Phase 2)
  | "human_approval"; // blocks until user clicks yes/no (Phase 1 — already partly there in approval.ts)

export type DelegationId = string; // "del-<ts>-<rand>"

export interface DelegationBase {
  id: DelegationId;
  kind: DelegationKind;
  /** Parent goal/agent id (for cancel propagation). */
  parentId?: string;
  /** Working directory. */
  cwd: string;
  /** Abort signal — the runner propagates cancel up the tree. */
  signal: AbortSignal;
  /** Created at (ms). */
  createdAt: number;
}

export interface AgentDelegation extends DelegationBase {
  kind: "agent";
  agent: string;            // AgentDefinition name
  prompt: string;
  model?: string;
  providerId?: string;
  parentSessionId?: string;
  ephemeral?: boolean;
}

export interface GoalDelegation extends DelegationBase {
  kind: "goal";
  objective: string;
  successCriteria?: { deliverables: string[]; qualityChecks: string[] };
  maxIterations: number;        // renamed from maxSteps
  model?: string;
  providerId?: string;
  parentGoalId?: string;        // for sub-goal spawn
}

export interface AsyncToolDelegation extends DelegationBase {
  kind: "async_tool";
  toolName: string;
  args: Record<string, unknown>;
  /** Optional periodic control (matches agnt-gg _interval / _stopAfter / _duration / _delayFirst). */
  schedule?: {
    intervalSeconds?: number;
    stopAfter?: number;
    durationMinutes?: number;
    delayFirst?: boolean;
  };
}

export interface HumanApprovalDelegation extends DelegationBase {
  kind: "human_approval";
  prompt: string;
  /** Shown in the modal. */
  context: { tool?: string; args?: unknown; reason: string };
  /** Default decision on timeout. */
  defaultDecision: "allow" | "deny";
  /** Timeout in seconds (default 120). */
  timeoutSeconds?: number;
}

// workflow / mcp / plugin / api — Phase 2; declared as `never`-typed stubs now
// so the union is exhaustive at compile time.

export type Delegation =
  | AgentDelegation
  | GoalDelegation
  | AsyncToolDelegation
  | HumanApprovalDelegation;
```

### 2.5 Signatures

```ts
export interface DelegationRun {
  id: DelegationId;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: number;
  completedAt?: number;
  /** Streaming events the caller can subscribe to. */
  events: AsyncIterable<DelegationEvent>;
  /** Final result (resolves when status is terminal). */
  result(): Promise<DelegationResult>;
  /** Best-effort cancel. */
  cancel(): Promise<void>;
}

export type DelegationEvent =
  | { kind: "started"; at: number }
  | { kind: "log"; line: string }
  | { kind: "progress"; at: number; ratio: number; note?: string }
  | { kind: "subevent"; delegationId: DelegationId; event: DelegationEvent }
  | { kind: "completed"; at: number; result: DelegationResult }
  | { kind: "failed"; at: number; error: string }
  | { kind: "cancelled"; at: number };

export type DelegationResult =
  | { kind: "agent"; text: string; usage: { inputTokens: number; outputTokens: number }; steps: number; sessionId?: string }
  | { kind: "goal"; goalId: string; status: GoalLoopStatus; finalText?: string; evaluations: GoalEvaluation[] }
  | { kind: "async_tool"; toolName: string; iterations: number; result: unknown }
  | { kind: "human_approval"; decision: "allow" | "deny" };

export interface DelegationDeps {
  subagent: SubAgentManager;       // existing
  goalStore: GoalStore;             // extended
  goalRunner: GoalRunner;           // NEW
  goalEvaluator: GoalEvaluator;     // NEW
  asyncQueue: AsyncToolQueue;       // NEW
  approval: ApprovalService;        // NEW — wraps approval-modal for CLI/REPL
}

export class DelegationManager {
  constructor(deps: DelegationDeps);
  /** Submit a delegation; returns a handle immediately. */
  submit(d: Delegation): DelegationRun;
  /** List currently running delegations (for /status and the REPL sidebar). */
  list(filter?: { kind?: DelegationKind; parentId?: string }): DelegationRun[];
  /** Cancel one or all (for /cancel and the global stop). */
  cancel(id: DelegationId): Promise<boolean>;
  cancelAll(parentId?: string): Promise<number>;
}
```

### 2.6 Persistence

- `agent` — already persists via `Session` (existing). No change.
- `goal` — persists via `GoalStore` JSON. Add `parentGoalId` field.
- `async_tool` — **NEW** `src/util/async-queue-store.ts` (mirrors agnt-gg's `AsyncToolQueue` but with JSON persistence: `$CH_HOME/async-queue.json`). Periodic ticks are restored on app start.
- `human_approval` — no persistence; if a turn is aborted, the next turn re-prompts.
- `workflow` / `mcp` / `plugin` / `api` — Phase 2.

### 2.7 Cancellation tree

`DelegationManager.submit` records `parentId`. When the parent goal/agent is cancelled, the manager calls `cancelAll(parentId)`. The runner fires each child's `signal.abort()`, which in turn calls its `cancelAll(parentId)`. This matches agnt-gg's `cancelAllForConversation` pattern (`AsyncToolQueue.js:487-495`) but generalized to delegation trees.

---

## 3. Loop Hierarchy (5 tiers)

This collapses what agnt-gg splits across `OrchestratorService`, `TaskOrchestrator`, `goal-runner`, and the per-task `executeTool` into a single stack. The big idea: **make council a kind of goal loop, not a parallel system.**

| Tier | What it is | agnt-gg equivalent | Our file (current) | Our file (target) | Diff in one sentence |
|---|---|---|---|---|---|
| **1. Mission** | Long-lived user goal spanning hours/days; survives app restart; possibly with sub-goals. | `Mission` concept is implicit across `goals` + `experiments` (`backend/src/services/ExperimentService.js`) | does not exist | **NEW** `src/agent/mission.ts` — owns the `GoalStore` and the long-running `GoalRunner`; one process = one mission; persists across restarts. |
| **2. Goal** | One objective, one plan, one eval. State machine from §1. | `goals` row + `goal_evaluations` + `goal_iterations` + `tasks` | `src/agent/goals.ts` (one-shot, no eval) | `src/agent/goals.ts` (extended schema) + **NEW** `src/agent/goal-runner.ts` (the AGI loop) | Re-shape the existing `GoalStore` to hold plan/eval/worldState, and add a runner that emits lifecycle events. |
| **3. Agent** | A focused LLM turn with a tool allowlist. Reusable for both main and sub-agent invocations. | The orchestrator's `universalChatHandler` (`OrchestratorService.js:823`) | `src/agent/loop.ts` (342 LOC) + `src/agent/subagent.ts` (300 LOC) | `src/agent/loop.ts` (extend hooks for `/steer`, mid-run cancel) + `src/agent/subagent.ts` (delegate to `DelegationManager`) | Same loop body, plus a `steerQueue` field in `AgentRunInput` so the agent can read mid-run steers between tool rounds. |
| **4. Workflow** | A pre-authored multi-step sequence (think: DAG of agents/tools). Optional in Phase 1. | `WorkflowService` + `WorkflowManipulationService` + `chatConfigs.js:workflow` | does not exist | **NEW** `src/agent/workflow.ts` (Phase 2) — defined as a thin `Delegation { kind: "workflow" }` driver; Phase 1 ships a stub that errors with "workflows: not yet ported". | Defer to Phase 2; document the slot. |
| **5. Tool** | A single tool call: `read`, `bash`, `web_search`, `spawn_subagent`, etc. | `services/orchestrator/tools.js` + `ToolService.js` | `src/agent/tools/*.ts` (registry, bash, read, edit, etc.) | unchanged | No port needed. |

### 3.1 Council becomes a Goal flavor

Today `src/agent/council.ts` is a separate `runCouncil` orchestrator that calls `SubAgentManager.spawn` directly via a `CouncilDeps` interface. In Phase 1, the target is:

```ts
// Conceptual — in council.ts, or factored into a new council-goal.ts
async function runCouncilAsGoal(input: string, mode: "consensus"|"adversarial", deps: DelegationDeps) {
  const plan: GoalPlan = await goalPlanner.plan({
    objective: `Run a ${mode} council on: ${input}`,
    kind: "council",
  });
  // plan.tasks = one subagent per councilor + a synthesizer task
  // each task is a Delegation { kind: "agent", agent: councilor.name }
  // the goal-runner executes them with the right maxIterations
}
```

The council's "transcript" is then just the goal's `evaluations` history, and the synthesized final answer is `goal.finalText`. The CLI subcommand `ch council` becomes a thin wrapper that submits a `GoalDelegation { kind: "goal", objective: "...council..." }` and waits on `delegation.result()`. This deletes `council.ts` as a separate code path — the file shrinks to a system-prompt bundle + a CLI adapter, and the loop logic moves into `goal-runner.ts`.

The motivation: today `ch council` and `ch goal` have separate failure modes, separate sessions, separate recovery paths. After the merge, all multi-step coordination goes through one machine.

---

## 4. REPL Simplification Spec

### 4.1 Reference target

- **Codex CLI** (`codex-rs/tui`): single-column, scrolling, no sidebar. Tool calls render as inline `▌ name(args)` boxes that collapse on enter. Status line at the very bottom: model · tokens · cwd. The prompt is a one-liner.
- **Claude Code** (`@anthropic-ai/claude-code`): two-region — left scrollable message list, right fixed status / hint / model. Prompt is multi-line. Slash commands are autocomplete'd.
- **DuckHive** (Ryan's own fork): readline + colors, no TUI library.

### 4.2 User-facing layout (target default `ch`)

```
┌─ ch · session 7f2a · opus-4.5 · codingharness ─────────────────────────────┐
│                                                                             │
│  user  ▸ wire up OAuth for the dashboard                                   │
│                                                                             │
│  ─── thinking ───────────────────────────────────────────────────────────  │
│  The user wants OAuth. I should plan: inspect current state, then…         │
│  ─────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  ─── plan ───────────────────────────────────────────────────────────────  │
│  1. read src/server.ts to find the auth hooks                              │
│  2. read src/config/providers.ts to find the provider registry             │
│  3. spawn_subagent implement "add /auth/login and /auth/callback"          │
│  4. run npm test                                                           │
│  ─────────────────────────────────────────────────────────────────────────│
│                                                                             │
│  ▌ spawn_subagent  agent=implement  prompt="add /auth/login…"              │
│    ✓ [sub:implement status=ok steps=4 tokens=2100in/850out]                 │
│    Wrote src/server/auth.ts, registered /auth/login + /auth/callback.      │
│                                                                             │
│  ▌ bash  cmd="npm test 2>&1 | tail -30"                                    │
│    ✓ 32 tests passing                                                       │
│                                                                             │
│  assistant ▸ done. Files: src/server/auth.ts (new), src/server.ts (+12).  │
│  type /help for slash commands                                             │
│                                                                             │
├────────────────────────────────────────────────────────────────────────────┤
│ ch › add a /healthcheck slash command_                                     │
└─ opus-4.5 · 2.1k in / 0.9k out · 4 steps · 8.2s ── session 7f2a · /help ──┘
```

### 4.3 Layout zones

| Zone | Position | Content |
|---|---|---|
| Header | top, 1 line | `ch · session <id> · <model> · <project>` |
| Body | middle, fills | scrolling message list — user / assistant / thinking / plan / tool callout / info / error |
| Input | bottom, 3-5 lines | multi-line textarea; `Enter` sends, `\` + `Enter` for newline, `Up`/`Down` for history |
| Footer | very bottom, 1 line | `model · tokens in/out · steps · wallclock · session id · /help hint` |

### 4.4 Input affordances

- **Slash commands** — `/` triggers completion popup; built-ins in `src/slash/builtin.ts` (already 22+).
- **Multi-line** — `\` + `Enter` inserts a newline; `Enter` sends; `Esc` cancels current turn.
- **History** — `Up`/`Down` walk; persisted at `$CH_HOME/history.txt` (plain text, last 2000 lines).
- **Input prefixes** — `@<path>` attaches a file (OpenCode pattern); `!shell` runs a one-shot bash and pastes the output as a user message.
- **Mid-run steer** — when the agent is busy, the input is still editable; `Enter` stashes the text via `SteerQueue` and the agent picks it up between tool rounds (matches agnt-gg's `OrchestratorService.js:40-85`).
- **Approval modal** — when a tool needs approval, a centered box replaces the input (not a separate top-level screen); `y`/`n`/`!` (always-allow this tool) responds.

### 4.5 Tool-call rendering

Inline callout shape (always collapsed by default; `Enter` on the line expands):

```
▌ <tool-name>  <key1>=<short value>  <key2>=<short value>
  ✓ <one-line display>
  ▾ (3 lines, click or Enter to expand)
```

Failure:

```
▌ <tool-name>  <key1>=<short value>
  ✗ <one-line display>     ← red, bold
  ▾ <full error message>
```

Sub-agent (delegation):

```
▸ delegation  kind=goal  id=del-7f2a
   planning → executing (3/7 tasks) → evaluating
   4.2k in / 1.8k out · 12s
```

### 4.6 Status line fields

- `model` — current resolved model (e.g. `opus-4.5`).
- `tokens in/out` — this session totals.
- `steps` — last assistant turn's step count.
- `wallclock` — last turn wall time, e.g. `8.2s`.
- `session id` — short, e.g. `7f2a`.
- `/help` hint — always present so users discover slash commands.

### 4.7 Default `ch` vs. `ch tui --legacy`

| Command | Effect |
|---|---|
| `ch` (no args) | new REPL (Phase 1) — the look above. No OpenTUI dependency in the main path. |
| `ch tui --legacy` | the existing OpenTUI app from `src/ui/tui.ts` (header / sidebar / body / input / footer split). Kept for users who prefer the four-pane layout and for the tests that depend on it. |
| `ch tui` (default) | alias for the new REPL. |
| `ch web` | unchanged — vanilla-JS web UI in `src/web/`. |
| `ch serve` | unchanged — `src/server.ts` for the SSE server. |
| `ch electron` | unchanged — Electron shell. |

The new REPL is implemented in **`src/ui/repl-v2.ts`** (new file). It reuses `startRepl` from `repl.ts` for the readline plumbing and adds the new render layer (message list, tool callout renderer, status line). The old `repl.ts` is left as the non-TTY fallback that `bin/ch` falls back to when stdin is a pipe.

### 4.8 Test matrix for the new REPL

- `ch` in TTY: shows new REPL.
- `ch` with piped stdin: shows the old line-based REPL.
- `ch tui`: same as `ch`.
- `ch tui --legacy`: shows OpenTUI.
- `CH_FORCE_TUI=1`: forces OpenTUI regardless of TTY (for CI).
- `CH_FORCE_REPL=1`: forces the new REPL regardless of TTY.

---

## 5. Backwards Compatibility

### 5.1 What to keep

- `ch tui --legacy` — keeps OpenTUI on disk. Files `src/ui/tui.ts` (665 LOC), `src/ui/tui-app.ts` (293 LOC), `src/ui/approval-modal.ts` (96 LOC) are unchanged. Their `@opentui/core` imports stay.
- `npm test` — `src/__tests__/tui.test.ts` (uses `createTestRenderer` from `@opentui/core/testing`) stays. The 103+ tests still pass.
- `npm run electron` — `electron/` is independent of the REPL choice; no change.
- `ch serve`, `ch web`, `ch doctor`, `ch memory`, `ch cron`, `ch sessions`, `ch init`, `ch update`, `ch export`, `ch compact` — no change.
- `ch run / ch agent / ch code / ch goal / ch loop / ch council / ch goals` — keep their subcommand surface; internally they may be re-wired to `DelegationManager` but the CLI stays green-compatible.
- All slash commands in `src/slash/builtin.ts` — unchanged.
- Session JSONL format (`src/agent/session.ts`) — unchanged; goals reference sessions by id, no schema change.
- `$CH_HOME/goals.json` — bump to `version: 2` with a one-time v1→v2 upgrade; never silently drop old records.

### 5.2 What to delete

- The existing one-shot `ch goal` runner block in `src/cli.ts:538-...` is replaced by the new goal-runner. Specifically: the inline runner in cli.ts (the function that pulls the goal, calls `runAgent`, and writes `finalText`) — it moves to `src/agent/goal-runner.ts`. The CLI keeps a thin wrapper that just `await runner.runOnce(goal, deps)`.
- `src/agent/council.ts`'s `runCouncil` body — moves into the goal-runner (see §3.1). The file shrinks to a system-prompt bundle + a CLI adapter; existing tests in `council.test.ts` are updated to assert the goal-loop shape.
- Any OpenTUI-specific import in the **main** (`bin/ch`, `src/cli.ts` default branch, `src/runtime.ts` default render path). Only `src/ui/tui.ts`, `src/ui/tui-app.ts`, `src/ui/approval-modal.ts`, and `src/__tests__/tui.test.ts` may import `@opentui/core`.
- `package.json` `"@opentui/core": "^0.3.4"` is **kept** (it stays in `dependencies` for `--legacy`). Optional cleanup: move to `optionalDependencies` later if we want to slim the `node_modules` for users who never use `--legacy` — but that is a Phase 2 task.

### 5.3 Dep audit (current count)

```
$ grep -rE '@opentui' src/ electron/
src/ui/tui.ts:1
src/ui/approval-modal.ts:1
src/__tests__/tui.test.ts:3
TOTAL: 5 lines across 3 files
```

`@opentui/core` is referenced in `package.json:dependencies` only (no other dep tree). `bun` is the test runner that requires OpenTUI's FFI binding; `npm run test:node` is the fallback that already skips OpenTUI tests.

### 5.4 What we can drop safely

| Item | Safe to drop? | Why |
|---|---|---|
| `@opentui/core` from `dependencies` | **No** (not yet) | Still required by `--legacy` and `tui.test.ts`. Move to `optionalDependencies` in Phase 2. |
| `bun` requirement for tests | **No** | `@opentui/core/testing` needs `bun`'s FFI; `npm run test:node` is the fallback but skips the TUI tests. |
| `tui-app.ts`'s sidebar logic | **No** | The legacy TUI keeps it; only the new REPL doesn't use it. |
| Old `repl.ts` | **No** | It stays as the non-TTY fallback. `repl-v2.ts` extends it. |

### 5.5 Behavior-preserving shims

- `ch goal` with no flags: same as today (one-shot run to `maxSteps`), but the runner is now the same code path the AGI loop uses for `maxIterations: 1`.
- `ch council`: same inputs (`--mode`, `--rounds`, `--json`), same transcript output (`renderCouncilResult`), but internally the council is a goal — so `ch goals show <id>` shows the council's plan and evaluations. Backward-compatible CLI; the report format gains a `loopStatus` field.
- `ch goals list`: same fields, plus `loopStatus`, `currentIteration`, `parentGoalId` (only if present).
- `ch goals show <id>`: same `finalText`; adds `plan`, `evaluations[]`, `worldState` (pretty-printed, capped at 8 KB) when present.

---

## 6. Risk + Open Questions

### 6.1 Risks

1. **Council-as-goal is a behavior change.** Today `ch council` and `ch goal` are independent; the merge means `ch council` will appear in `ch goals list`. This is a *user-facing* change that some downstream users may not expect. **Mitigation:** keep `ch council` as the canonical entry point and document that it now uses the goal store.
2. **Goals JSON v1→v2 migration.** A user with an active `ch goals list` from v0.2.x will see a schema bump. **Mitigation:** write `goals.v1-backup.json` on first read of v1 and return the same `finalText` so the CLI output is unchanged; only *new* goals (or goals that get re-planned) get the v2 fields.
3. **Memory growth of `worldState`.** agnt-gg's `world_state` JSON can be "hundreds of KB per goal" (comment at `GoalModel.js:67-70`). With our `revert` feature, we'll write a snapshot per iteration. **Mitigation:** cap each `worldState` snapshot at 256 KB, prune snapshots beyond the last 5, and write the rest to `$CH_HOME/goal-snapshots/<goalId>/<iteration>.json`.
4. **Identical-replan guard** is a heuristic. If the LLM produces *semantically identical* plans with different surface text, we won't catch it. **Mitigation:** compare normalized task descriptions (lowercase, whitespace-stripped, sorted). Phase 1 ships the surface-text check; semantic check is Phase 2.
5. **Async tool queue persistence across crashes.** agnt-gg's `AsyncToolQueue` lives in-memory. We need JSON persistence so a periodic `web_search` running every 60s survives an `npm run dev` restart. **Mitigation:** Phase 1 ships a small `AsyncToolQueueStore` (SQLite-lite JSON) and replays pending/queued executions on startup; the `executeFunction` must be idempotent — we document this in `src/agent/delegation.ts`.
6. **Cancellation tree depth.** Deep `goal → sub-goal → sub-goal → sub-agent` chains mean a cancel at the top has to traverse N `signal.abort()` calls. **Mitigation:** keep the chain depth bounded (max 5 by default); emit a warning if exceeded.
7. **The new REPL rendering layer needs a renderer.** Options: (a) `readline` + manual ANSI codes (matches `repl.ts` today, but limited); (b) a small `ink`-style React renderer (new dep); (c) a tiny hand-rolled virtual-DOM in TS. **Decision needed** — see 6.2 Q3.
8. **OpenTUI version coupling.** `bun` is required by `@opentui/core/testing`'s FFI; if the legacy TUI breaks on a future OpenTUI release, `--legacy` breaks with it. **Mitigation:** pin `@opentui/core` in `package-lock.json` (already done with `^0.3.4`); add a `ch doctor --lint --json` check that OpenTUI loads.
9. **The `/steer` pattern is a UX landmine.** Stashing text and applying it to the last tool result means the user can accidentally inject text into a tool call that was already correct. **Mitigation:** show the queued steer in the footer (e.g. `steer: "..."`); pressing `Esc` while busy stashes the steer (matches Codex); provide `/steer <id>` to clear.

### 6.2 Open questions for the orchestrator

1. **Q1 — Council transcripts:** when council becomes a goal, do we keep the `renderCouncilResult` output format verbatim for `ch council --json`, or do we add `loopStatus` and `evaluations[]`? My default: keep `ch council` output as-is (backward compat) and only enrich the goal store view.
2. **Q2 — Multi-mission support:** Phase 1 says one process = one mission. Do we need multiple concurrent missions in Phase 1? My default: no — `--mission <id>` switches between them; one is active per process.
3. **Q3 — REPL renderer:** should the new REPL be (a) ANSI + readline (zero new deps, ~600 LOC), (b) `@anthropic-ai/claude-code`-style React (`ink` ~3 MB), or (c) our own tiny TS renderer (~1200 LOC, no new deps)? My default: (a) for Phase 1 (zero new deps), evaluate (b) for Phase 2 if we need a real scrollback.
4. **Q4 — `/revert` granularity:** revert the last step, revert to a specific `currentIteration`, or revert a specific sub-task? My default: revert to a specific `currentIteration`; `ch goals revert <id> --to <n>`.
5. **Q5 — Approval modal in the new REPL:** keep OpenTUI's modal (then `approval-modal.ts` is still imported by the new REPL) or hand-roll a centered box in the new ANSI renderer? My default: hand-roll, keep `approval-modal.ts` strictly for `--legacy`.
6. **Q6 — Skills & extensions integration:** the goal-runner will call subagents; subagents load skills via `src/agent/skills.ts`; do we want goals to declare a `skillAllowlist`? My default: yes — `GoalDelegation.skills?: string[]` to constrain the planner to a known toolset.
7. **Q7 — Cost guardrails:** the AGI loop can burn tokens. Do we want a `maxCostUsd` field on `GoalDelegation`? My default: yes — a hard cap that aborts when estimated cost exceeds the cap. Reuse `src/agent/cost.ts` (existing).
8. **Q8 — Multi-user:** `agnt-gg` is per-user; we're single-user. Do we need to think about `userId` anywhere in the port? My default: no — all our paths are single-user; we can leave the `userId` slot in mind but never populate it.
9. **Q9 — Tests for the AGI loop:** how do we test the plan → execute → evaluate → replan cycle without a real LLM? My default: a stub provider in `src/__tests__/goal-runner.test.ts` that yields a fixed plan on the first call, fixed `complete` output on the second, fixed `score < 70` evaluation on the third, then asserts `loopStatus = 'replanning'`. Pattern follows the existing `agent-loop.test.ts` rule from `AGENTS.md`: "Stub providers in agent-loop tests must be stateful."
10. **Q10 — `paths.goals` location:** `GoalStore` currently writes to `$CH_HOME/goals.json`. With snapshots, do we want a `$CH_HOME/goals/` directory? My default: yes, but in Phase 2 — Phase 1 keeps the single file for `GoalStore` and adds `$CH_HOME/goal-snapshots/` as a side directory.

### 6.3 Unknowns I could not resolve in 25 min

- I did not read `agnt-gg/backend/src/services/WorkflowManipulationService.js` end-to-end — only grepped the routes. The "workflow" tier is a Phase 2 stub; if we want to ship a real workflow port in Phase 1, this file is the primary source.
- I did not audit `agnt-gg/backend/src/services/ai/scripts/` — these are provider-generation scripts and likely irrelevant to the port, but a Phase 1 worker who touches providers should skim them.
- I did not look at `agnt-gg/backend/src/services/evolution/InsightEngine.js` and the `evolution/applicators/` dir — they look like meta-agents that learn from past runs. Probably out of scope for Phase 1, but flagging as a Phase 2 candidate ("golden-standards-from-history" instead of golden-standards-from-LLM).
- The agnt-gg Vue frontend's Chat UI is in `frontend/src/views/Chat*.vue` (not read). Our web UI is vanilla-JS in `src/web/`; the port target is to add a `goalList` and `delegations` panel to `index.html` + `app.js`, not to mirror the Vue components.

### 6.4 What I'd flag to the orchestrator before tracks 1-4 start

- **Confirm Q1** (council backward compat) — affects whether `council.test.ts` needs rewriting.
- **Confirm Q3** (REPL renderer choice) — affects whether we add a new npm dep.
- **Confirm Q5** (approval modal in the new REPL) — affects whether `approval-modal.ts` moves out of the main render path.
- **Decide whether Phase 1 ships a `workflow` tier or just a stub.** My recommendation: stub. A real workflow port is its own 2-3 week track.
- **Decide whether `/revert` is in Phase 1 or Phase 2.** My recommendation: Phase 1, because the snapshot machinery is cheap to add now and the user value is high. But it does add 200-300 LOC and one more public command.
- **Set a budget for `goal-runner.test.ts`.** It's the heart of Phase 1; a stub-driven test suite is ~500 LOC, but it's the single test that proves the AGI loop works. Don't cheap out.

---

## Appendix A — File-by-file touch list (Phase 1 code tracks)

| File | Action | Notes |
|---|---|---|
| `src/agent/goals.ts` | extend | bump schema to v2, add `loopStatus`, `currentIteration`, `plan`, `evaluations[]`, `worldState`, `successCriteria`, `parentGoalId` |
| `src/agent/goal-planner.ts` | **new** | `planGoal(objective, ctx): Promise<GoalPlan>` |
| `src/agent/goal-runner.ts` | **new** | the AGI loop; consumes `GoalStore` + `SubAgentManager` + `GoalEvaluator` + `GoalReplanner` |
| `src/agent/goal-evaluator.ts` | **new** | LLM-scored eval against `successCriteria` |
| `src/agent/goal-replanner.ts` | **new** | LLM regenerates failed tasks, with identical-replan guard |
| `src/agent/goal-control.ts` | **new** | `pause` / `resume` / `revert`; per-goal control channel |
| `src/agent/delegation.ts` | **new** | discriminated union + `DelegationManager` |
| `src/agent/steer.ts` | **new** | `SteerQueue` (mid-run user steering) |
| `src/util/async-queue.ts` | **new** | long-running tool queue with periodic + JSON persistence |
| `src/agent/subagent.ts` | modify | delegate to `DelegationManager`; keep public API green |
| `src/agent/loop.ts` | modify | add `steerQueue` to `AgentRunInput`; integrate between tool rounds |
| `src/agent/council.ts` | shrink | keep system prompts + `renderCouncilResult` + CLI adapter; remove `runCouncil` body (moved to goal-runner) |
| `src/ui/repl-v2.ts` | **new** | new REPL renderer (ANSI + readline, zero new deps) |
| `src/cli.ts` | modify | wire `ch goal` and `ch council` to the new `goal-runner` via `DelegationManager`; add `ch goal revert` |
| `src/ui/tui.ts`, `tui-app.ts`, `approval-modal.ts` | unchanged | legacy only |
| `src/__tests__/goal-runner.test.ts` | **new** | stub-provider AGI loop test |
| `src/__tests__/goal-evaluator.test.ts` | **new** | evaluator scoring test |
| `src/__tests__/delegation.test.ts` | **new** | union + cancel-tree test |
| `src/__tests__/council.test.ts` | update | assert goal-loop shape, not standalone orchestrator |
| `src/__tests__/goals.test.ts` | update | add v2 schema tests |
| `package.json` | unchanged | `@opentui/core` stays; no new deps in Phase 1 |
| `CHANGELOG.md` | extend | new "Unreleased" section for Phase 1 |
| `AGENTS.md` | update | add `goal-planner`/`goal-runner`/`delegation` to layout; document `--legacy` |

## Appendix B — OpenTUI call-site count (verified)

```
$ grep -rE '@opentui' src/ electron/
src/ui/tui.ts                                (1 import)
src/ui/approval-modal.ts                    (1 import)
src/__tests__/tui.test.ts                   (3 imports; one inside dynamic import)
TOTAL: 5 lines, 3 files

$ grep -E '@opentui' package.json
    "@opentui/core": "^0.3.4",              (1 dep)
```

Conclusion: the OpenTUI surface is tiny and isolated. `--legacy` can keep it indefinitely with no cost beyond a single npm dep.

---

*End of plan. Author: Developer @ CodingHarness, 2026-06-09. Status: ready for Phase 1 worker review.*
