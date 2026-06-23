// DelegationManager — the discriminated union for sub-work.
//
// Phase 1 port from `agnt-gg/agnt` per
// `plans/plan_phase1/notes/agnt-port-plan.md` §2. The harness has
// many ways to spawn sub-work — sub-agents, sub-goals, async tool
// queues, MCP calls, plugin calls, HTTP APIs, human approval
// modals. Before this file, each kind had its own ad-hoc API
// (`SubAgentManager.spawn`, the bash tool's approval flow, etc).
// Now every kind shares one typed entry point:
//
//   delegate(work, ctx): Promise<DelegationResult>
//
// and one observable handle:
//
//   DelegationRun { events, result(), cancel() }
//
// The union is exhaustive at compile time. The manager records
// `parentId` on every submission and walks the tree on cancel, so a
// `cancelAll(parentId)` from a parent goal fires `signal.abort()`
// on every descendant.
//
// Implemented in Phase 1: `agent`, `goal`, `async_tool`,
// `human_approval`. Stubbed for Phase 2: `workflow`, `mcp`,
// `plugin`, `api` — the union covers them so the discriminator
// stays closed, but their runners throw "not yet implemented" at
// runtime.

import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { log } from "../util/logger.js";
import { runGoalStateMachine, type GoalRecord, type GoalState, type GoalStore } from "./goals.js";
import type { GoalRunAgentFn, RunGoalOptions } from "./goals.js";
import type { Settings } from "../config/settings.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { SubAgentManager, type SubAgentResult } from "./subagent.js";
import { paths } from "../config/paths.js";
import { CostTracker, formatUSD } from "./cost.js";

// ---------- The union ----------

export type DelegationId = string;

/** Generate a short, sortable, collision-resistant id. */
function newDelegationId(): DelegationId {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return "del-" + ts + "-" + rand;
}

/** All worker kinds the harness can delegate to. The order is the
 *  exhaustive-check order — add new kinds at the bottom to keep
 *  diffs clean. */
export type DelegationKind =
  | "agent"
  | "goal"
  | "workflow"
  | "async_tool"
  | "mcp"
  | "plugin"
  | "api"
  | "human_approval";

export interface DelegationBase {
  id?: DelegationId;
  kind: DelegationKind;
  /** Parent delegation / goal id. Cancellation propagates here. */
  parentId?: string;
  /** Working directory. */
  cwd: string;
  /** Abort signal. The manager owns the signal — callers don't
   *  abort directly, they call `run.cancel()`. */
  signal?: AbortSignal;
  /** Created at (ms). Set by the manager. */
  createdAt?: number;
  /**
   * Hard cap on estimated cost (USD) for this delegation. When
   * the cap is exceeded mid-run, the manager aborts and surfaces
   * a `{ kind, status: "failed", error: "maxCostUsd cap exceeded: $X.XX" }`
   * result. Cost is computed via `src/agent/cost.ts` against the
   * `CostTracker` injected on `DelegationRuntimeDeps` (defaulting
   * to a per-delegation tracker that is discarded after the run).
   * Applies to any kind that makes model calls (agent, goal). For
   * kinds without a model call (mcp, plugin, api, async_tool,
   * human_approval, workflow stub), the cap is recorded but
   * never triggers — the result is still returned with the
   * un-exceeded cost.
   */
  maxCostUsd?: number;
  /**
   * Skills allowlist for the child runner (e.g. the
   * sub-agent spawned by the `agent` kind). When set, the
   * `SubAgentManager` only sees skills whose name appears in
   * this list — the list is forwarded via
   * `SubAgentSpawnInput.skills` and echoed back on
   * `SubAgentResult.skillsUsed`. Other kinds ignore the field
   * (mcp / api / plugin / etc. don't load skills directly). The
   * runtime's `/skill` tool inside the sub-agent consults
   * `services.loadSkill`; v1 of this allowlist is a contract
   * assertion — the SubAgentManager passes the list through
   * and the actual filter on the sub-agent's services layer
   * is wired in a follow-up that takes the SkillRegistry.
   *
   * For the `goal` kind (Phase 3 T5), the same field is
   * stamped on the new `GoalRecord` (`record.skills`) and
   * inherited by sub-delegations submitted from
   * `onGoalEnter("executing")`. A parent goal with
   * `skills: ["http", "search"]` therefore spawns a sub-goal
   * that exposes the same allowlist to its runner, unless the
   * sub-delegation explicitly overrides `skills` on its own
   * work. This is the forward-side of Q6 (skills allowlist on
   * the goal kind) — the field is the source of truth, and
   * every nested `submit()` payload threads it by default.
   */
  skills?: string[];
}

export interface AgentDelegation extends DelegationBase {
  kind: "agent";
  agent: string;
  prompt: string;
  model?: string;
  providerId?: string;
  parentSessionId?: string;
  ephemeral?: boolean;
}

export interface GoalDelegation extends DelegationBase {
  kind: "goal";
  objective: string;
  successCriteria?: { deliverables: string[]; qualityChecks?: string[] };
  /** Cap on iterations. Default: 8. */
  maxIterations?: number;
  model?: string;
  providerId?: string;
  /** Sub-goal parent (when spawning a child from a goal). */
  parentGoalId?: string;
}

export interface AsyncToolDelegation extends DelegationBase {
  kind: "async_tool";
  toolName: string;
  args: Record<string, unknown>;
  /** Optional periodic control. Phase 1: single-shot only —
   *  `iterations` and `stopAfter` accept a count, schedule is
   *  reserved for Phase 2 (matches agnt-gg `_interval` / `_duration`). */
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
  context: { tool?: string; args?: unknown; reason: string };
  /** Decision when the user does not respond before the timeout. */
  defaultDecision: "allow" | "deny";
  /** Timeout in seconds. Default: 120. */
  timeoutSeconds?: number;
}

/** Phase 2 stubs. Declared now so the union is closed and the
 *  discriminator exhausts cleanly. Each carries only `kind` + the
 *  fields the runner needs to fail fast.
 *
 *  `trigger` is a discriminated union per audit §2.5: the runner
 *  dispatches by `kind`. v1 only honors `{ kind: "manual" }` —
 *  the audit's open question #2 is resolved by "in-process,
 *  fire-and-forget" and the `webhook` / `timer` arms are
 *  reserved T1.5 follow-ups that require long-lived listeners
 *  surviving a CLI exit (see `docs/phase4.md` T1.5). The
 *  discriminator is still closed (TS exhaustiveness) so adding
 *  a new arm is a one-line change in both this type and the
 *  runner. */
export interface WorkflowDelegation extends DelegationBase {
  kind: "workflow";
  workflowId: string;
  inputs?: Record<string, unknown>;
  /**
   * How this workflow run was triggered. Default is `manual` —
   * the caller is invoking the workflow directly (e.g. `ch
   * workflow run <id>` or a one-shot CLI invocation). Webhook
   * and timer triggers are reserved for T1.5.
   */
  trigger?:
    | { kind: "manual" }
    | { kind: "webhook"; path: string }
    | { kind: "timer"; cron: string };
}
/**
 * MCP kind — invoke a tool on a registered MCP server. The
 * `McpRegistry` injected on `DelegationRuntimeDeps` is the
 * narrow boundary between the manager and the (out-of-process)
 * MCP server registry; the runtime wires the default
 * implementation. If the server is not registered, the
 * delegation returns `status: "failed"` with a clear reason.
 */
export interface McpDelegation extends DelegationBase {
  kind: "mcp";
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Optional per-call timeout in seconds. Default: 30. */
  timeoutSeconds?: number;
}
/**
 * Plugin kind — load a `.agnt`-style plugin from
 * `$CH_HOME/plugins/<id>.{ts,js}` and invoke a tool on it. The
 * plugin module exports `{ name, tools: { [toolName]: (args, ctx)
 * => Promise<any> } }`. If the file is not found, the
 * delegation returns `status: "failed"` with reason. v1 only
 * supports the file-based shape; directory-based plugin
 * packages (with `package.json` / `index.ts`) land in a
 * follow-up.
 */
export interface PluginDelegation extends DelegationBase {
  kind: "plugin";
  pluginId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Optional per-call timeout in seconds. Default: 30. */
  timeoutSeconds?: number;
}
/**
 * API kind — POST (or whatever `method` is set to) the work
 * prompt to `url` as JSON `{ prompt, context, timeoutSeconds }`.
 * The response is parsed as JSON and surfaced as `output`. Uses
 * Node's built-in `fetch` (no new deps). Default timeout 30s;
 * override via `timeoutSeconds`.
 */
export interface ApiDelegation extends DelegationBase {
  kind: "api";
  /** HTTP method. Defaults to POST when omitted. */
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  /** The work prompt sent in the request body. */
  prompt?: string;
  /** Optional context payload (echoed back in the request body). */
  context?: Record<string, unknown>;
  /** Per-request timeout in seconds. Default: 30. */
  timeoutSeconds?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Override the JSON body. When set, the default
   *  `{ prompt, context, timeoutSeconds }` body is replaced. */
  body?: unknown;
}

export type Delegation =
  | AgentDelegation
  | GoalDelegation
  | AsyncToolDelegation
  | HumanApprovalDelegation
  | WorkflowDelegation
  | McpDelegation
  | PluginDelegation
  | ApiDelegation;

// ---------- Events ----------

export type DelegationEvent =
  | { kind: "started"; at: number }
  | { kind: "log"; line: string }
  | { kind: "progress"; at: number; ratio: number; note?: string }
  | { kind: "subevent"; delegationId: DelegationId; event: DelegationEvent }
  | { kind: "completed"; at: number; result: DelegationResult }
  | { kind: "failed"; at: number; error: string }
  | { kind: "cancelled"; at: number };

// ---------- Results ----------

/** The status field on a Phase 2 (mcp / plugin / api) delegation
 *  result. The same shape works for all three: the kind-specific
 *  fields (serverId / pluginId / url / output) are added by the
 *  discriminated union arms below. */
export type Phase2Status = "completed" | "failed";

export type DelegationResult =
  | { kind: "agent"; text: string; usage: { inputTokens: number; outputTokens: number }; steps: number; sessionId?: string; status: SubAgentResult["status"]; error?: string }
  | { kind: "goal"; goalId: string; status: GoalState; finalText?: string; iterations: number; /** Optional error message. Set when the goal was
   *  aborted for a structured reason — e.g. the `maxCostUsd`
   *  cap fired and the runner threw to break the state
   *  machine. The same string is also recorded on
   *  `GoalRecord.lastError` so it survives across the
   *  on-disk store. Absent on `done` / normal `failed`
   *  outcomes — the goal's evaluations + status carry the
   *  reason for those. */
  error?: string }
  | { kind: "async_tool"; toolName: string; iterations: number; result: unknown }
  | { kind: "human_approval"; decision: "allow" | "deny"; reason?: string }
  | {
      kind: "workflow";
      workflowId: string;
      /**
       * The terminal status of the run. `completed` /
       * `failed` are the v1 terminal states; `running` is
       * reserved for a future "detach" mode that returns
       * a handle without awaiting completion. The audit's
       * status vocabulary (audit §4.1) uses
       * `completed` / `failed` only; `running` is added
       * here so the type stays forward-compatible without
       * a v2 reshape.
       */
      status: "completed" | "failed" | "running";
      /**
       * Number of distinct nodes that executed (counts
       * re-executions once each per `WorkflowEngine`).
       * Mirrors `WorkflowRunResult.stepsRun`.
       */
      steps: number;
      /**
       * First error message when `status: "failed"`,
       * absent on success. Comes from
       * `WorkflowRunResult.error` (which is the
       * engine's `firstErrorMessage` /
       * `result.error` for the abort / cap-exceeded
       * paths). Mirrors the `error?` field on
       * `agent` / `mcp` / `api` results.
       */
      error?: string;
      /**
       * Cumulative cost (USD) from every model call
       * inside the workflow. Mirrors
       * `WorkflowRunResult.costUsd`. Tracked so the
       * runtime / CLI can report the per-run cap usage
       * alongside the per-step `maxCostUsd` cap on
       * the engine (audit decision #3).
       */
      costUsd?: number;
    }
  | { kind: "mcp"; serverId: string; tool: string; status: Phase2Status; output?: unknown; error?: string }
  | { kind: "plugin"; pluginId: string; tool: string; status: Phase2Status; output?: unknown; error?: string }
  | { kind: "api"; url: string; method: string; status: Phase2Status; output?: unknown; error?: string };

// ---------- Handle ----------

export type DelegationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface DelegationRun {
  id: DelegationId;
  kind: DelegationKind;
  status: DelegationStatus;
  parentId?: string;
  startedAt?: number;
  completedAt?: number;
  /** Resolve when the run reaches a terminal state. */
  result(): Promise<DelegationResult>;
  /** Best-effort cancel. Idempotent. */
  cancel(): Promise<void>;
  /** Async iterator over events. Closes when the run terminates. */
  events(): AsyncIterable<DelegationEvent>;
}

// ---------- Dependencies ----------

/** Narrow interface over the MCP server registry. Keeps the
 *  manager decoupled from the (out-of-process) `mavis mcp`
 *  registry — the runtime wires a default implementation that
 *  shells out to the local MCP config; tests inject a stub.
 *
 *  `listServers` is used for the "is the server registered?"
 *  check before `callTool` — failing fast with a clear
 *  `unknown MCP server: <id>` is friendlier than letting the
 *  tool call hang or surface a generic transport error. */
export interface McpRegistry {
  /** Stable, machine-friendly id of the registry. */
  readonly id: string;
  listServers(): Array<{ id: string; name?: string }>;
  callTool(
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<McpCallResult>;
}

export interface McpCallResult {
  /** True when the tool call completed without an error. */
  ok: boolean;
  /** The tool's return value. Shape is MCP-server-defined. */
  output?: unknown;
  /** Set when `ok` is false. */
  error?: string;
  /** Optional structured error data (MCP servers can attach any JSON). */
  errorData?: unknown;
}

/** The subset of `HarnessRuntime` the manager needs. Lets us wire
 *  the manager from a slim test fixture without dragging in the
 *  full runtime. */
export interface DelegationRuntimeDeps {
  providers: ProviderRegistry;
  settings: Settings;
  cwd: string;
  /** Sub-agent manager. Required for `agent` kind. */
  subagent: SubAgentManager;
  /** Goal store. Required for `goal` kind. */
  goalStore: GoalStore;
  /** Approval gate. Optional. When unset, `human_approval` runs
   *  synchronously and uses `defaultDecision`. */
  askApproval?: (req: {
    prompt: string;
    context: HumanApprovalDelegation["context"];
    timeoutSeconds?: number;
  }) => Promise<{ decision: "allow" | "deny"; reason?: string }>;
  /** Async-tool queue store. Optional. When set, async_tool
   *  delegations are persisted to disk so a kill mid-run can be
   *  replayed on the next startup. The constructor of
   *  `DelegationManager` will call `store.replayPending(...)` (if a
   *  replayer is also wired) to drain the queue. */
  asyncToolQueue?: AsyncToolQueueStore;
  /**
   * Function to actually execute an async tool. The harness is
   * crash-resistant across restarts: pending async_tool delegations
   * are persisted to disk and replayed on the next startup.
   * Therefore the function MUST be idempotent — calling it twice
   * with the same `(toolName, args)` must produce the same
   * observable result, with no duplicate side effects on the
   * second call. The AsyncToolQueueStore uses the delegation id +
   * toolName + args as the dedup key.
   *
   * Idempotency contract (callers MUST honor):
   *   - Pure functions: trivially idempotent. No state to dedupe.
   *   - Side-effectful functions: callers are expected to check
   *     whether the work has already been done (e.g. by looking up
   *     a record by some derived key) and short-circuit if so.
   *   - The function should not throw on a "duplicate" detection —
   *     return the existing result instead.
   *
   * When unset, the manager falls back to the legacy in-memory
   * echo (Phase 1 behavior).
   */
  executeFunction?: AsyncToolExecuteFn;
  /**
   * Custom file path for the async-tool queue. Defaults to
   * `$CH_HOME/async-tool-queue.json`. Tests pass a per-fixture tmp
   * file here to keep state isolated.
   */
  asyncToolQueueFile?: string;
  /** MCP registry. Required for `mcp` kind. When unset, an `mcp`
   *  delegation fails with `no MCP registry wired`. */
  mcpRegistry?: McpRegistry;
  /** Cost tracker for the `maxCostUsd` cap. When unset, the
   *  manager uses a per-delegation `CostTracker` that's
   *  discarded after the run. The HarnessRuntime's own
   *  `cost: CostTracker` is the natural production wiring. */
  costTracker?: CostTracker;
  /** Override the directory that hosts plugin files. Defaults
   *  to `$CH_HOME/plugins`. Used by `plugin` kind. */
  pluginHome?: string;
  /**
   * Function the goal delegation kind uses to drive the
   * `planning` / `executing` phases. The signature is the
   * `GoalRunAgentFn` from `src/agent/goals.ts` — a small
   * closure that builds a fresh system prompt + single user
   * turn per phase, calls the underlying agent loop, and
   * returns the final content + step count.
   *
   * **Required** for the `goal` kind. When unset, `runGoalKind`
   * returns a `failed` delegation with a clear "no goal runner
   * wired" error rather than throwing — this lets tests that
   * only exercise non-goal kinds skip the dep.
   *
   * The `HarnessRuntime` builds a default that mirrors the
   * CLI's `ch goal` flow (`src/cli.ts:runGoalCmd`'s
   * `callAgent` closure): per-phase system prompt via
   * `runtime.buildSystemPrompt()`, the runtime's tool
   * registry, the configured `defaultProvider` /
   * `defaultModel`, and the per-call abort signal forwarded
   * from the manager. Tests inject a stateful stub to drive a
   * full lifecycle.
   */
  runGoalAgent?: GoalRunAgentFn;
  /**
   * Workflow store. Required for the `workflow` kind. When
   * unset, `runWorkflowKind` returns a `failed` delegation
   * with "no workflow store wired" (matches the `mcp` /
   * plugin patterns). The runtime wires a `WorkflowStore`
   * instance constructed lazily against
   * `paths.workflows` — the directory is created on first
   * write, not at constructor time.
   */
  workflowStore?: import("./workflow-store.js").WorkflowStore;
  /**
   * Tool registry for built-in workflow actions. The v1
   * registry ships empty (`defaultWorkflowToolRegistry()`);
   * the engine's `NodeExecutor` inlines the 4 built-ins
   * (`generate-with-ai-llm`, `execute-javascript`,
   * `mcp-client`, `stop-workflow`) for cost-tracking
   * proximity. The runtime wires a default here so the
   * `workflow` delegation kind can construct a
   * `WorkflowEngine` without the caller having to
   * pre-register anything. Tests inject a stripped-down
   * registry.
   */
  workflowToolRegistry?: import("./workflow-steps.js").WorkflowToolRegistry;
  /**
   * Default provider / model for the `workflow` kind. The
   * engine's `NodeExecutor` consults these when a
   * `generate-with-ai-llm` node does not specify its own
   * provider / model in `parameters`. The runtime wires
   * the configured `defaultProvider` / `defaultModel`.
   */
  workflowProvider?: import("../types.js").Provider;
  workflowModel?: string;
  /**
   * Per-workflow-run `maxCostUsd` cap (USD). When set, the
   * engine aborts the run *between* steps if the cumulative
   * cost exceeds the cap. Optional. The runtime forwards its
   * own cap from the `WorkflowDelegation.maxCostUsd` (or
   * `runtime.cost` accumulator if unset).
   */
  workflowMaxCostUsd?: number;
}

/** Signature of the function that actually executes an async tool.
 *  See `DelegationRuntimeDeps.executeFunction` for the idempotency
 *  contract. */
export type AsyncToolExecuteFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

// ---------- AsyncToolQueueStore ----------
//
// Crash-resilience for the async_tool delegation kind. The store is
// a tiny JSON file under $CH_HOME that records every entry with its
// status. On every state change the file is rewritten atomically
// (temp + rename). On startup, the DelegationManager scans the file
// for entries stuck in "pending" or "running" and replays them.
//
// The store deliberately does NOT know how to run the tool — it
// only persists state. The replay happens in the manager, which
// owns the executeFunction.

export type AsyncToolQueueStatus = "pending" | "running" | "completed" | "failed";

export interface AsyncToolQueueEntry {
  /** Delegation id. Stable across restarts. */
  id: string;
  /** Tool name. */
  toolName: string;
  /** Tool args. */
  args: Record<string, unknown>;
  status: AsyncToolQueueStatus;
  /** ms-since-epoch when the entry was added. */
  queuedAt: number;
  /** ms-since-epoch when the entry was last advanced to "running". */
  startedAt?: number;
  /** ms-since-epoch when the entry reached a terminal status. */
  completedAt?: number;
  /** Successful result (terminal status: "completed"). */
  result?: unknown;
  /** Error message (terminal status: "failed"). */
  error?: string;
}

export interface AsyncToolQueueStoreOptions {
  /** Path to the JSON file. Defaults to `paths.asyncToolQueue`. */
  file?: string;
}

/** Persisted async-tool queue. Reads the JSON file on construction
 *  and rewrites it on every mutation. Safe to construct multiple
 *  times against the same file — atomic temp+rename ensures
 *  concurrent writers don't corrupt the file.
 *
 *  Schema (v1):
 *
 *      {
 *        "version": 1,
 *        "entries": [AsyncToolQueueEntry, ...]
 *      }
 *
 *  Future versions can add new fields; readers must tolerate unknown
 *  ones. The store never deletes entries on its own — completed /
 *  failed entries stay in the file for audit until the user calls
 *  `purge()`.
 */
export class AsyncToolQueueStore {
  readonly file: string;
  private entries: AsyncToolQueueEntry[] = [];

  constructor(opts: AsyncToolQueueStoreOptions = {}) {
    this.file = opts.file ?? paths.asyncToolQueue;
    this.entries = this.readPersisted(this.file);
  }

  /** Add a new entry in "pending" state. Returns the entry as
   *  persisted. */
  add(input: { id: string; toolName: string; args: Record<string, unknown> }): AsyncToolQueueEntry {
    const entry: AsyncToolQueueEntry = {
      id: input.id,
      toolName: input.toolName,
      args: input.args,
      status: "pending",
      queuedAt: Date.now(),
    };
    this.entries.push(entry);
    this.writePersisted();
    return entry;
  }

  /** Mark an entry as "running". Idempotent: a second call is a
   *  no-op. */
  markRunning(id: string, at: number = Date.now()): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    if (e.status === "running" || e.status === "completed" || e.status === "failed") return;
    e.status = "running";
    e.startedAt = at;
    this.writePersisted();
  }

  /** Mark an entry as "completed" with a result. */
  markCompleted(id: string, result: unknown, at: number = Date.now()): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.status = "completed";
    e.completedAt = at;
    e.result = result;
    delete e.error;
    this.writePersisted();
  }

  /** Mark an entry as "failed" with an error message. */
  markFailed(id: string, error: string, at: number = Date.now()): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.status = "failed";
    e.completedAt = at;
    e.error = error;
    delete e.result;
    this.writePersisted();
  }

  /** Remove a specific entry by id. Returns true when an entry was
   *  removed. */
  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    this.writePersisted();
    return true;
  }

  /** All entries (snapshot). */
  list(): AsyncToolQueueEntry[] {
    return [...this.entries];
  }

  /** Pending + running entries — the ones that the manager should
   *  consider for replay on startup. */
  listPending(): AsyncToolQueueEntry[] {
    return this.entries.filter((e) => e.status === "pending" || e.status === "running");
  }

  /** Drop every terminal entry (completed / failed) from the file.
   *  Returns the number of entries removed. */
  purge(): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.status === "pending" || e.status === "running");
    const removed = before - this.entries.length;
    if (removed > 0) this.writePersisted();
    return removed;
  }

  /** Wipe the file. Used by tests; rarely useful in production. */
  clear(): void {
    this.entries = [];
    this.writePersisted();
  }

  // ---------- internals ----------

  private readPersisted(file: string): AsyncToolQueueEntry[] {
    if (!existsSync(file)) return [];
    try {
      const raw = readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
        return parsed.entries.filter((e: unknown) => e && typeof e === "object" && "id" in (e as Record<string, unknown>));
      }
      return [];
    } catch (e) {
      log.warn("async-tool-queue: failed to parse " + file + " — starting empty (" + (e as Error).message + ")");
      return [];
    }
  }

  private writePersisted(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    const payload = JSON.stringify({ version: 1, entries: this.entries }, null, 2);
    try {
      writeFileSync(tmp, payload, "utf-8");
      renameSync(tmp, this.file);
    } catch (e) {
      // Pre-fix: a failed `renameSync` (e.g. the target is a
      // directory, or the FS is full) leaked the `.tmp` next
      // to the queue file. Same pattern as the workflow /
      // goal / mcp / session / trajectory stores.
      try { unlinkSync(tmp); } catch { /* best-effort */ }
      throw e;
    }
  }
}

// ---------- The manager ----------

interface InternalRun {
  id: DelegationId;
  work: Delegation;
  status: DelegationStatus;
  parentId?: string;
  controller: AbortController;
  emitter: EventEmitter;
  /** All events emitted so far, in order. Buffered so that
   *  `events()` can replay them even if iteration starts after
   *  the run has already completed. */
  buffer: DelegationEvent[];
  result: Promise<DelegationResult>;
  startedAt?: number;
  completedAt?: number;
}

export class DelegationManager {
  private runs = new Map<DelegationId, InternalRun>();
  private childrenOf = new Map<string, Set<DelegationId>>();

  constructor(private readonly deps: DelegationRuntimeDeps) {
    this.deps.goalStore.subscribe({
      onEnter: (state, goal) => this.onGoalEnter(state, goal),
    });
    // Crash-resilience: replay any async_tool entries that were
    // pending / running when the previous process died. The
    // AsyncToolQueueStore writes the file atomically on every state
    // change, so even a SIGKILL leaves a coherent record.
    this.replayAsyncToolQueue();
  }

  /** The primary contract. Submit a delegation; return a handle
   *  immediately. The handle resolves to a typed result. */
  submit(work: Delegation): DelegationRun {
    const id = work.id ?? newDelegationId();
    const controller = new AbortController();
    // If the caller already aborted, propagate.
    if (work.signal?.aborted) controller.abort();
    const startedAt = Date.now();
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);

    const internal: InternalRun = {
      id,
      work: { ...work, id, createdAt: startedAt },
      status: "queued",
      parentId: work.parentId,
      controller,
      emitter,
      buffer: [],
      startedAt: undefined,
      completedAt: undefined,
      result: undefined as unknown as Promise<DelegationResult>,
    };

    // Wire parent→child for cancel propagation.
    if (work.parentId) {
      let set = this.childrenOf.get(work.parentId);
      if (!set) {
        set = new Set();
        this.childrenOf.set(work.parentId, set);
      }
      set.add(id);
    }

    const resultPromise = (async (): Promise<DelegationResult> => {
      internal.status = "running";
      internal.startedAt = Date.now();
      this.emitEvent(internal, { kind: "started", at: internal.startedAt });
      try {
        const res = await this.runKind(internal.work, controller.signal, (ev) => this.emitEvent(internal, ev));
        internal.status = res.cancelled ? "cancelled" : "completed";
        internal.completedAt = Date.now();
        if (res.cancelled) {
          this.emitEvent(internal, { kind: "cancelled", at: internal.completedAt });
        } else {
          this.emitEvent(internal, { kind: "completed", at: internal.completedAt, result: res.value });
        }
        return res.value;
      } catch (e) {
        internal.status = "failed";
        internal.completedAt = Date.now();
        const msg = (e as Error).message;
        this.emitEvent(internal, { kind: "failed", at: internal.completedAt, error: msg });
        throw e;
      } finally {
        // Detach from parent's child set.
        if (internal.parentId) this.childrenOf.get(internal.parentId)?.delete(id);
      }
    })();
    internal.result = resultPromise.catch((e): DelegationResult => {
      // Convert throws into a typed failed result so callers
      // awaiting `result()` never have to try/catch for the
      // typical case. The status field on the handle still reads
      // "failed".
      return { kind: "agent", text: "", usage: { inputTokens: 0, outputTokens: 0 }, steps: 0, status: "error" } as DelegationResult;
    });

    this.runs.set(id, internal);
    return this.toHandle(internal);
  }

  /** List currently running + recently-completed delegations. */
  list(filter?: { kind?: DelegationKind; parentId?: string }): DelegationRun[] {
    const all: DelegationRun[] = [];
    for (const r of this.runs.values()) {
      if (filter?.kind && r.work.kind !== filter.kind) continue;
      if (filter?.parentId && r.parentId !== filter.parentId) continue;
      all.push(this.toHandle(r));
    }
    return all;
  }

  /** Cancel one. Returns true if a run was found. */
  async cancel(id: DelegationId): Promise<boolean> {
    const r = this.runs.get(id);
    if (!r) return false;
    r.controller.abort();
    return true;
  }

  /** Cancel everything matching a parent (recursively). Returns the
   *  number of runs cancelled. Used by the goal loop when a parent
   *  goal is paused / failed. */
  async cancelAll(parentId: string): Promise<number> {
    const queue = [parentId];
    let n = 0;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const child of this.childrenOf.get(cur) ?? []) {
        const cancelled = await this.cancel(child);
        if (cancelled) n += 1;
        queue.push(child);
      }
    }
    return n;
  }

  // ---------- Lifecycle hook: goal → delegate ----------

  /** When a goal enters `executing`, dispatch its work through
   *  `delegate` instead of `runAgent` directly. This is the
   *  integration point the port plan requires. The hook only
   *  fires once per goal (first `executing` entry per
   *  `currentIteration` is fine — the runner only emits
   *  `executing` once per iteration).
   *
   *  **Phase 3 T5 (Q6):** the `skills` allowlist stamped on
   *  the goal record (which `runGoalKind` forwards from the
   *  parent `GoalDelegation.skills`) is threaded into the
   *  sub-delegation's `submit()` payload. This means a parent
   *  goal that sets `skills: ["http", "search"]` produces a
   *  sub-goal sub-delegation with the same allowlist, which
   *  the `agent` kind's runner then forwards into
   *  `SubAgentManager.spawn({ skills })` — closing the
   *  forward-side of Q6 (skills allowlist on the goal kind).
   *  The sub-delegation can still override `skills` by
   *  passing its own value; when the parent's `skills` is
   *  undefined (backwards compat), the sub-delegation's
   *  `skills` field is also undefined. */
  private onGoalEnter(state: GoalState, goal: GoalRecord): void {
    if (state !== "executing") return;
    // Avoid re-submitting if we already submitted for this goal's
    // current executing state.
    const key = goal.id + ":" + (goal.currentIteration ?? 0);
    if (this.submittedGoals.has(key)) return;
    this.submittedGoals.add(key);
    const sub = this.submit({
      kind: "goal",
      objective: goal.objective,
      maxIterations: 1,
      model: goal.model,
      providerId: goal.providerId,
      parentGoalId: goal.parentGoalId,
      parentId: goal.parentGoalId ?? undefined,
      cwd: this.deps.cwd,
      successCriteria: goal.successCriteria,
      // Phase 3 T5: forward the skills allowlist. Only
      // include the field when the parent set it — an
      // explicit `undefined` would still satisfy the
      // `skills?: string[]` shape, but the discriminated
      // union doesn't need the noise and existing test
      // snapshots (which read the work object back) stay
      // cleaner.
      ...(goal.skills !== undefined ? { skills: goal.skills } : {}),
    });
    // Detach: the goal is its own owner. The run is observable
    // but the goal's lifecycle drives the run.
    void sub.result().catch(() => undefined);
  }
  private submittedGoals = new Set<string>();

  // ---------- The runner dispatcher ----------

  private async runKind(
    work: Delegation,
    signal: AbortSignal,
    emit: (ev: DelegationEvent) => void,
  ): Promise<{ value: DelegationResult; cancelled: boolean }> {
    switch (work.kind) {
      case "agent":
        return this.runAgentKind(work, signal, emit);
      case "goal":
        return this.runGoalKind(work, signal, emit);
      case "async_tool":
        return this.runAsyncToolKind(work, signal, emit);
      case "human_approval":
        return this.runHumanApprovalKind(work, signal, emit);
      case "workflow":
        return this.runWorkflowKind(work, signal, emit);
      case "mcp":
        return this.runMcpKind(work, signal, emit);
      case "plugin":
        return this.runPluginKind(work, signal, emit);
      case "api":
        return this.runApiKind(work, signal, emit);
      default: {
        // Exhaustiveness guard.
        const _exhaustive: never = work;
        throw new Error("unknown delegation kind: " + (_exhaustive as { kind: string }).kind);
      }
    }
  }

  // ---- agent ----

  private async runAgentKind(
    work: AgentDelegation,
    signal: AbortSignal,
    emit: (ev: DelegationEvent) => void,
  ): Promise<{ value: DelegationResult; cancelled: boolean }> {
    emit({ kind: "log", line: "[agent] spawning " + work.agent });
    // The model used for cost accounting. Falls back to the
    // settings default — same precedence as the SubAgentManager
    // (which uses `input.model ?? def.model ?? defaultModel`).
    const costModel = work.model
      ?? this.deps.settings.defaultModel
      ?? "default";
    // Per-delegation tracker. If the runtime injected its own
    // `CostTracker`, we read the cumulative total at the end
    // (not just this run's slice) — the cap is on total spend
    // since the runtime started, which is the more useful
    // semantic. For a per-delegation tracker we just track
    // this run's cost.
    const tracker = this.deps.costTracker ?? new CostTracker();
    const r = await this.deps.subagent.spawn({
      agent: work.agent,
      prompt: work.prompt,
      model: work.model,
      providerId: work.providerId,
      cwd: work.cwd,
      signal,
      ephemeral: work.ephemeral,
      parentSessionId: work.parentSessionId,
      ...(work.skills !== undefined ? { skills: work.skills } : {}),
    });
    // Record the sub-agent's cost on the tracker. Provider id
    // is best-effort — when the sub-agent routed to a different
    // provider for vision, the SubAgentResult doesn't surface
    // it. v1 of the cap uses the sub-agent's input provider id.
    const providerId = work.providerId ?? this.deps.settings.defaultProvider ?? "unknown";
    tracker.record(costModel, providerId, r.usage.inputTokens, r.usage.outputTokens, work.agent);
    // Apply the maxCostUsd cap. The cap is checked post-run for
    // the agent kind; for goal / loop kinds the same check
    // fires after the inner state machine finishes. The result
    // shape mirrors the spec: `{ kind, status: "failed",
    // error: "maxCostUsd cap exceeded: $X.XX" }`. The "kind"
    // is the originating delegation kind so the caller can
    // still discriminate.
    if (work.maxCostUsd !== undefined) {
      const total = tracker.total().cost;
      if (total > work.maxCostUsd) {
        const msg = "maxCostUsd cap exceeded: " + formatUSD(total) + " > " + formatUSD(work.maxCostUsd);
        emit({ kind: "log", line: "[agent] " + msg });
        return {
          value: {
            kind: "agent",
            text: r.text,
            usage: r.usage,
            steps: r.steps,
            sessionId: r.sessionId,
            status: "error",
            error: msg,
          },
          cancelled: false,
        };
      }
    }
    return {
      value: {
        kind: "agent",
        text: r.text,
        usage: r.usage,
        steps: r.steps,
        sessionId: r.sessionId,
        status: r.status,
      },
      cancelled: r.status === "cancelled",
    };
  }

  // ---- goal ----

  private async runGoalKind(
    work: GoalDelegation,
    signal: AbortSignal,
    emit: (ev: DelegationEvent) => void,
  ): Promise<{ value: DelegationResult; cancelled: boolean }> {
    if (!this.deps.runGoalAgent) {
      // No runner wired — fail fast with a clear reason rather
      // than throwing. Throwing would crash the harness from a
      // single bad dispatch; returning a failed delegation is
      // the same contract every other kind uses.
      const reason = "delegation: goal kind requires DelegationRuntimeDeps.runGoalAgent " +
        "(see HarnessRuntime.runGoalAgent or wire your own)";
      emit({ kind: "log", line: "[goal] " + reason });
      return { value: { kind: "goal", goalId: "", status: "failed", iterations: 0 }, cancelled: false };
    }

    // Phase 3 T5: forward the `skills` allowlist onto the new
    // record. `onGoalEnter("executing")` reads it back when it
    // dispatches the per-iteration sub-delegation, so the
    // forward-side of Q6 (skills allowlist on the goal kind)
    // is closed at the goal store boundary.
    const goal = this.deps.goalStore.add({
      objective: work.objective,
      maxSteps: work.maxIterations ?? 8,
      model: work.model,
      providerId: work.providerId,
      successCriteria: work.successCriteria,
      parentGoalId: work.parentGoalId,
      ...(work.skills !== undefined ? { skills: work.skills } : {}),
    });
    this.deps.goalStore.markInProgress(goal.id);
    emit({ kind: "log", line: "[goal] created " + goal.id + " — running state machine" });
    // Pre-register this goal in `submittedGoals` so the
    // `onGoalEnter("executing")` hook doesn't recursively
    // dispatch another goal delegation for the goal we just
    // created. The state machine is going to fire that hook
    // when the runner transitions to `executing`; we want the
    // hook to no-op for this goal (we're already running it
    // inline below). Without this, the goal delegation kind
    // infinite-recurses: goal → executing → submit → goal →
    // executing → submit → ... The dedup key in `onGoalEnter`
    // is `goal.id + ":" + currentIteration`, so we register
    // the (id, iter=1) key here. Subsequent iterations (if
    // any) are still allowed to re-dispatch.
    this.submittedGoals.add(goal.id + ":1");

    // Bridge to the goal-runner. The `runGoalAgent` dep is the
    // real runner — it builds the per-phase prompt and calls
    // the underlying agent loop. The state machine is driven
    // for real, and the goal's `loopStatus` reaches `done` /
    // `re-planning` / `failed` based on the model's outputs.
    //
    // Phase 3 T5 (maxCostUsd cap): wrap the runner so each
    // call's `usage` (when the runner returns it — see
    // `GoalRunAgentFn` in `src/agent/goals.ts`) is recorded
    // on a per-delegation `CostTracker` and the `maxCostUsd`
    // cap is checked after every phase. When the cap fires
    // the goal record is stamped with `status: "failed"` +
    // `lastError: "maxCostUsd cap exceeded: $X.XX"`, the
    // state machine is broken via a thrown error, and the
    // manager surfaces the same message on the delegation's
    // `error` field. When the runner doesn't return `usage`
    // (test stubs, custom integrations) the cap is a no-op
    // — zero cost is recorded, zero cost can exceed the cap.
    // The tracker is the runtime's own `CostTracker` when
    // injected, otherwise a per-delegation tracker that's
    // discarded after the run (same pattern as `agent` kind).
    const costModel = work.model
      ?? this.deps.settings.defaultModel
      ?? "default";
    const costProvider = work.providerId
      ?? this.deps.settings.defaultProvider
      ?? "unknown";
    const tracker = this.deps.costTracker ?? new CostTracker();
    let capError: string | null = null;
    const runGoalAgent: GoalRunAgentFn = async (phase, ctx, sig) => {
      emit({ kind: "log", line: "[goal] phase=" + phase + " iteration=" + ctx.iteration });
      const out = await this.deps.runGoalAgent!(phase, ctx, sig);
      // Record usage when the runner returns it. Optional —
      // absence means "no model call was attributed" (e.g. a
      // test stub). The cost tracker tolerates the omission;
      // it's the cap check that cares, not the accumulation.
      if (out.usage) {
        tracker.record(costModel, costProvider, out.usage.inputTokens, out.usage.outputTokens, "goal");
      }
      if (work.maxCostUsd !== undefined && capError === null) {
        const total = tracker.total().cost;
        if (total > work.maxCostUsd) {
          const msg = "maxCostUsd cap exceeded: " + formatUSD(total) + " > " + formatUSD(work.maxCostUsd);
          capError = msg;
          emit({ kind: "log", line: "[goal] " + msg });
          // Mark the goal as failed with the structured
          // reason. The `update()` call validates the
          // `loopStatus` transition; from `executing` /
          // `evaluating` / `re-planning` to `failed` is
          // legal in the state machine. From a terminal
          // state it's a no-op (the cap is double-checked
          // above so we don't recurse).
          try {
            this.deps.goalStore.update(goal.id, {
              status: "failed",
              lastError: msg,
              ...(this.deps.goalStore.get(goal.id)?.loopStatus !== "failed"
                ? { loopStatus: "failed" as GoalState }
                : {}),
            });
          } catch (e) {
            // The state machine's `update` may reject an
            // illegal transition (e.g. if the goal is
            // already in a different state). The cap is
            // still enforced — the manager just won't
            // re-stamp the loopStatus. `lastError` is the
            // primary signal callers look at.
            log.debug("delegation: goal maxCostUsd — could not stamp loopStatus (" + (e as Error).message + ")");
          }
          // Throw to break the state machine out of its
          // current iteration. The manager's outer
          // try/catch swallows the error; the capError
          // string is what the result carries.
          throw new Error(msg);
        }
      }
      return out;
    };
    const opts: RunGoalOptions = {
      store: this.deps.goalStore,
      runAgent: runGoalAgent,
      maxIterations: work.maxIterations,
      signal,
      onStateChange: (state) => {
        emit({ kind: "log", line: "[goal] " + state });
      },
    };
    try {
      await runGoalStateMachine(goal, opts);
    } catch (e) {
      log.debug("delegation: goal runner returned — " + (e as Error).message);
    }

    if (signal.aborted) {
      // Cancellation arrived after the state machine reached a
      // terminal state (e.g. a SIGINT that landed the same tick
      // as the agent's `GOAL COMPLETE`). The goal record is the
      // source of truth — surface its actual `loopStatus` and
      // iteration count, not a hard-coded "failed/0" — so the
      // caller can distinguish "cancelled a finished goal" from
      // "cancelled a still-running goal". The `cancelled: true`
      // flag is what callers use to detect the abort event.
      const abortedFinal = this.deps.goalStore.get(goal.id);
      return {
        value: {
          kind: "goal",
          goalId: goal.id,
          status: abortedFinal?.loopStatus ?? "failed",
          finalText: abortedFinal?.finalText,
          iterations: abortedFinal?.currentIteration ?? 0,
          ...(capError !== null ? { error: capError } : (abortedFinal?.lastError ? { error: abortedFinal.lastError } : {})),
        },
        cancelled: true,
      };
    }
    const final = this.deps.goalStore.get(goal.id);
    return {
      value: {
        kind: "goal",
        goalId: goal.id,
        status: final?.loopStatus ?? "failed",
        finalText: final?.finalText,
        iterations: final?.currentIteration ?? 0,
        // Surface the cap-exceeded message (or any other
        // structured failure reason recorded on the goal
        // record) on the delegation result. Absent on
        // normal `done` / `failed` outcomes — the goal's
        // `evaluations` + `status` carry the reason.
        ...(capError !== null ? { error: capError } : (final?.lastError ? { error: final.lastError } : {})),
      },
      cancelled: false,
    };
  }

  // ---- async_tool ----

  private async runAsyncToolKind(
    work: AsyncToolDelegation,
    signal: AbortSignal,
    emit: (ev: DelegationEvent) => void,
  ): Promise<{ value: DelegationResult; cancelled: boolean }> {
    emit({ kind: "log", line: "[async_tool] " + work.toolName });
    // Two paths:
    //   1. With a store + executeFunction (crash-resilient): the
    //      entry is added to the store before run, marked running,
    //      then completed/failed when the function returns. If the
    //      manager is killed mid-run, the file has the entry in
    //      "running" state and the next startup will replay it
    //      (see `replayAsyncToolQueue`).
    //   2. Without a store (legacy in-memory): echo result, like
    //      Phase 1.
    if (!this.deps.asyncToolQueue || !this.deps.executeFunction) {
      // Legacy in-memory path. Kept for backward compatibility with
      // the Phase 1 tests and any host that doesn't wire the store.
      const result: DelegationResult = {
        kind: "async_tool",
        toolName: work.toolName,
        iterations: 1,
        result: { echoed: work.toolName, args: work.args, at: Date.now() },
      };
      if (signal.aborted) return { value: result, cancelled: true };
      emit({ kind: "progress", at: Date.now(), ratio: 1, note: "single-shot complete" });
      return { value: result, cancelled: false };
    }
    return this.runAsyncToolPersisted(work, signal, emit);
  }

  /** Crash-resilient async_tool path. Writes the entry to the
   *  AsyncToolQueueStore before run, then runs `executeFunction`,
   *  then records the terminal state. The function MUST be
   *  idempotent — see the `executeFunction` doc on
   *  `DelegationRuntimeDeps`. */
  private async runAsyncToolPersisted(
    work: AsyncToolDelegation,
    signal: AbortSignal,
    emit: (ev: DelegationEvent) => void,
  ): Promise<{ value: DelegationResult; cancelled: boolean }> {
    const store = this.deps.asyncToolQueue!;
    const exec = this.deps.executeFunction!;
    const id = work.id ?? newDelegationId();
    // Add (or adopt) the entry. The replay path may have already
    // added it as "running" — `add` is not idempotent (it would
    // duplicate), so we use a check first.
    let entry = store.list().find((e) => e.id === id);
    if (!entry) entry = store.add({ id, toolName: work.toolName, args: work.args });
    store.markRunning(id);
    emit({ kind: "log", line: "[async_tool] persisted entry " + id + " (" + entry.status + ")" });

    if (signal.aborted) {
      store.markFailed(id, "cancelled before run");
      return { value: { kind: "async_tool", toolName: work.toolName, iterations: 1, result: { cancelled: true } }, cancelled: true };
    }
    try {
      const result = await exec(work.toolName, work.args);
      if (signal.aborted) {
        store.markFailed(id, "cancelled after run");
        return { value: { kind: "async_tool", toolName: work.toolName, iterations: 1, result }, cancelled: true };
      }
      store.markCompleted(id, result);
      emit({ kind: "progress", at: Date.now(), ratio: 1, note: "single-shot complete" });
      return { value: { kind: "async_tool", toolName: work.toolName, iterations: 1, result }, cancelled: false };
    } catch (e) {
      const msg = (e as Error).message;
      store.markFailed(id, msg);
      throw e;
    }
  }

  /** On startup, scan the queue for entries stuck in pending / running
   *  and re-run them. The executeFunction MUST be idempotent — see
   *  the doc on `DelegationRuntimeDeps.executeFunction`. Each replay
   *  is fire-and-forget at the manager level (the AsyncToolQueueStore
   *  records the result), but we await the function for ordering
   *  with the constructor so tests can assert the result
   *  deterministically. */
  private replayAsyncToolQueue(): void {
    const store = this.deps.asyncToolQueue;
    const exec = this.deps.executeFunction;
    if (!store || !exec) return;
    const pending = store.listPending();
    if (pending.length === 0) return;
    log.info("async-tool-queue: replaying " + pending.length + " pending entr" + (pending.length === 1 ? "y" : "ies"));
    for (const entry of pending) {
      // Replay is best-effort and detached: the manager is already
      // up; we just want the function to run and record its result.
      // The caller never sees the replay's result — the originating
      // `submit()` handle has long since resolved (or been dropped
      // when the previous process died).
      void this.runReplay(entry, store, exec);
    }
  }

  private async runReplay(
    entry: AsyncToolQueueEntry,
    store: AsyncToolQueueStore,
    exec: AsyncToolExecuteFn,
  ): Promise<void> {
    store.markRunning(entry.id);
    try {
      const result = await exec(entry.toolName, entry.args);
      store.markCompleted(entry.id, result);
    } catch (e) {
      store.markFailed(entry.id, (e as Error).message);
    }
  }

  // ---- human_approval ----

  private async runHumanApprovalKind(
    work: HumanApprovalDelegation,
    signal: AbortSignal,
    emit: (ev: DelegationEvent) => void,
  ): Promise<{ value: DelegationResult; cancelled: boolean }> {
    if (!this.deps.askApproval) {
      // No approval service wired — use the default decision.
      emit({ kind: "log", line: "[human_approval] no askApproval wired — using default " + work.defaultDecision });
      return {
        value: { kind: "human_approval", decision: work.defaultDecision, reason: "default (no askApproval service)" },
        cancelled: false,
      };
    }
    emit({ kind: "log", line: "[human_approval] awaiting user" });
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const decision = await this.deps.askApproval({
        prompt: work.prompt,
        context: work.context,
        timeoutSeconds: work.timeoutSeconds,
      });
      if (signal.aborted) {
        return { value: { kind: "human_approval", decision: work.defaultDecision, reason: "cancelled before response" }, cancelled: true };
      }
      return { value: { kind: "human_approval", decision: decision.decision, reason: decision.reason }, cancelled: false };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  // ---- workflow (Phase 4 T1) ----
  //
  // Instantiates a `WorkflowEngine` against the injected
  // `WorkflowStore` and awaits `_executeWorkflow()`. The
  // engine owns the lifetime — the manager does not detach
  // (v1 is fire-and-forget per the audit's open question #2
  // resolution: "in-process, fire-and-forget"). The
  // delegation is the integration seam: it maps the
  // engine's `WorkflowRunResult` onto the `DelegationResult`
  // discriminated union's `kind: "workflow"` arm.
  //
  // Failure modes:
  //   - No `workflowStore` wired: returns
  //     `status: "failed", error: "no workflow store wired"`.
  //   - Unknown `workflowId`: returns
  //     `status: "failed", error: "workflow not found"` after
  //     the store throws `WorkflowStoreError("not_found")`.
  //   - No `workflowToolRegistry` wired: same pattern, with
  //     a clear "no workflow tool registry wired" message.
  //     The runtime always wires the default
  //     (`defaultWorkflowToolRegistry()`) so this only fires
  //     in tests that skip the wiring.
  //   - Engine throws / aborts: the abort path is special —
  //     the engine's final state is read even on `signal`
  //     abort, so partial work (steps / cost) is not lost.
  //     This mirrors the Phase 3 T1 goal-store fix at
  //     commit `e721c55`.

  private async runWorkflowKind(
    work: WorkflowDelegation,
    signal: AbortSignal,
    emit: (ev: DelegationEvent) => void,
  ): Promise<{ value: DelegationResult; cancelled: boolean }> {
    const store = this.deps.workflowStore;
    if (!store) {
      const err = "no workflow store wired (set DelegationRuntimeDeps.workflowStore)";
      emit({ kind: "log", line: "[workflow] " + err });
      return { value: { kind: "workflow", workflowId: work.workflowId, status: "failed", steps: 0, error: err }, cancelled: false };
    }
    const tools = this.deps.workflowToolRegistry;
    if (!tools) {
      const err = "no workflow tool registry wired (set DelegationRuntimeDeps.workflowToolRegistry)";
      emit({ kind: "log", line: "[workflow] " + err });
      return { value: { kind: "workflow", workflowId: work.workflowId, status: "failed", steps: 0, error: err }, cancelled: false };
    }
    // 1. Load the workflow record.
    let record;
    try {
      record = await store.get(work.workflowId);
    } catch (e) {
      const err = "workflow not found: " + work.workflowId + " (" + (e as Error).message + ")";
      emit({ kind: "log", line: "[workflow] " + err });
      return { value: { kind: "workflow", workflowId: work.workflowId, status: "failed", steps: 0, error: err }, cancelled: false };
    }
    // 2. Resolve trigger data. v1 only honors `manual` —
    //    webhook / timer are T1.5 (long-lived listeners).
    //    The audit's open question #2 is resolved by
    //    "in-process, fire-and-forget"; a `webhook` /
    //    `timer` trigger in v1 surfaces a clear error
    //    rather than silently no-op'ing.
    const trig = work.trigger ?? { kind: "manual" as const };
    if (trig.kind === "webhook" || trig.kind === "timer") {
      const err = `workflow trigger "${trig.kind}" is a T1.5 follow-up; v1 only supports "manual" (audit §2.5)`;
      emit({ kind: "log", line: "[workflow] " + err });
      return { value: { kind: "workflow", workflowId: work.workflowId, status: "failed", steps: 0, error: err }, cancelled: false };
    }
    // 3. Build the trigger data. For `manual`, the caller's
    //    `inputs` is the trigger payload (renamed under
    //    `trigger.*` for template resolution, matching the
    //    audit §3.2 "the trigger's output is the trigger
    //    payload" rule).
    const triggerData: Record<string, unknown> = {
      trigger: { kind: "manual", ...(work.inputs ?? {}) },
      inputs: work.inputs ?? {},
    };
    emit({ kind: "log", line: "[workflow] " + work.workflowId + " (manual)" });

    // 4. Instantiate the engine. The maxCostUsd cap is
    //    forwarded from the delegation when set; otherwise
    //    from the runtime's wired default. When neither
    //    is set, the engine runs with no cap (matches
    //    audit decision #3 — cap is opt-in).
    const maxCostUsd = work.maxCostUsd ?? this.deps.workflowMaxCostUsd;
    // Dynamic imports keep the delegation file's cold
    // path slim for the non-workflow kinds (Phase 1
    // pre-existing tests don't pay the import cost).
    const { WorkflowEngine } = await import("./workflow.js");
    const engine = new WorkflowEngine(record, {
      provider: this.deps.workflowProvider,
      model: this.deps.workflowModel,
      mcpRegistry: this.deps.mcpRegistry,
      tools,
      triggerData,
      signal,
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    });
    // 5. Run.
    let cancelled = false;
    let result;
    try {
      result = await engine._executeWorkflow();
    } catch (e) {
      // A throw here is rare — the engine catches
      // `NodeExecutionError` internally and records it
      // on `engine.errors`. The abort path produces
      // `result.status: "failed", result.error: "cancelled"`,
      // not a throw. So a real throw usually means a
      // programming error (e.g. a misconfigured
      // `nodeExecutor` callback). Surface it as a
      // failed result; the engine's partial state is
      // still readable for the `steps` / `costUsd`
      // accounting.
      const err = (e as Error).message;
      emit({ kind: "log", line: "[workflow] engine threw: " + err });
      return {
        value: {
          kind: "workflow",
          workflowId: work.workflowId,
          status: "failed",
          steps: engine.nodeExecutionCounts.size,
          error: err,
          costUsd: engine.costUsd,
        },
        cancelled: false,
      };
    }
    // 6. Abort-path: the engine returns a "failed /
    //    cancelled" result when the signal fires, but
    //    the partial `steps` and `costUsd` are still on
    //    the engine. Surface them.
    if (signal.aborted) {
      cancelled = true;
      return {
        value: {
          kind: "workflow",
          workflowId: work.workflowId,
          status: "failed",
          steps: engine.nodeExecutionCounts.size,
          error: result.error ?? "aborted",
          costUsd: result.costUsd,
        },
        cancelled: true,
      };
    }
    // 7. Normal path. Map the engine's `WorkflowRunResult`
    //    to the `DelegationResult` shape. `error` is
    //    only set on `status: "failed"` (the engine
    //    fills `result.error` with the first node
    //    error or a cap-exceeded / cancel / iter-cap
    //    message; absent on `status: "completed"`).
    const status: "completed" | "failed" = result.status === "completed" ? "completed" : "failed";
    return {
      value: {
        kind: "workflow",
        workflowId: work.workflowId,
        status,
        steps: result.stepsRun,
        ...(status === "failed" && result.error !== undefined ? { error: result.error } : {}),
        costUsd: result.costUsd,
      },
      cancelled: false,
    };
  }

  // ---- mcp ----
  //
  // Look up `serverId` in the injected `McpRegistry`, then call
  // the named tool with `args`. The registry is the narrow
  // boundary; the runtime wires a default that shells out to
  // `mavis mcp call`, tests inject a stub. Result is the
  // structured tool output (whatever the MCP server returned)
  // plus a status field. Unknown server / tool errors are
  // surfaced as `status: "failed"` with a clear reason rather
  // than throwing — the manager swallows the throw and emits
  // a `failed` event, so callers always get a typed result.

  private async runMcpKind(
    work: McpDelegation,
    signal: AbortSignal,
    emit: (ev: DelegationEvent) => void,
  ): Promise<{ value: DelegationResult; cancelled: boolean }> {
    const registry = this.deps.mcpRegistry;
    if (!registry) {
      const err = "no MCP registry wired (set DelegationRuntimeDeps.mcpRegistry)";
      emit({ kind: "log", line: "[mcp] " + err });
      return { value: { kind: "mcp", serverId: work.serverId, tool: work.tool, status: "failed", error: err }, cancelled: false };
    }
    const servers = safeListServers(registry);
    const found = servers.find((s) => s.id === work.serverId);
    if (!found) {
      const known = servers.map((s) => s.id).join(", ") || "(none registered)";
      const err = `unknown MCP server: ${work.serverId} (known: ${known})`;
      emit({ kind: "log", line: "[mcp] " + err });
      return { value: { kind: "mcp", serverId: work.serverId, tool: work.tool, status: "failed", error: err }, cancelled: false };
    }
    emit({ kind: "log", line: "[mcp] " + work.serverId + "." + work.tool });
    const timeoutMs = (work.timeoutSeconds ?? 30) * 1000;
    try {
      const r = await registry.callTool(work.serverId, work.tool, work.args, { signal, timeoutMs });
      if (!r.ok) {
        const err = r.error ?? "MCP tool call failed";
        return { value: { kind: "mcp", serverId: work.serverId, tool: work.tool, status: "failed", error: err }, cancelled: false };
      }
      return { value: { kind: "mcp", serverId: work.serverId, tool: work.tool, status: "completed", output: r.output }, cancelled: false };
    } catch (e) {
      if (signal.aborted) {
        return { value: { kind: "mcp", serverId: work.serverId, tool: work.tool, status: "failed", error: "cancelled" }, cancelled: true };
      }
      const err = (e as Error).message;
      return { value: { kind: "mcp", serverId: work.serverId, tool: work.tool, status: "failed", error: err }, cancelled: false };
    }
  }

  // ---- plugin ----
  //
  // Load `$pluginHome/<id>.js` (then `.ts` as a fallback for the
  // dev / tsx runtime). The module exports
  // `{ name, tools: { [toolName]: (args, ctx) => Promise<any> } }`.
  // We look up `tool` in `tools` and invoke it. A missing file /
  // missing tool returns `status: "failed"` with a clear reason.
  // The plugin's tool receives `(args, ctx)` where `ctx` is the
  // `ToolContext`-shaped object with cwd + signal so plugins can
  // do file IO without importing internals.

  private async runPluginKind(
    work: PluginDelegation,
    signal: AbortSignal,
    emit: (ev: DelegationEvent) => void,
  ): Promise<{ value: DelegationResult; cancelled: boolean }> {
    const home = this.deps.pluginHome ?? defaultPluginHome();
    // Try .js first (compiled output), then .ts (dev / tsx).
    const candidates = [join(home, work.pluginId + ".js"), join(home, work.pluginId + ".ts")];
    let loadedPath: string | null = null;
    for (const p of candidates) {
      if (existsSync(p)) { loadedPath = p; break; }
    }
    if (!loadedPath) {
      const err = `plugin not found: ${work.pluginId} (looked in ${candidates.join(", ")})`;
      emit({ kind: "log", line: "[plugin] " + err });
      return { value: { kind: "plugin", pluginId: work.pluginId, tool: work.tool, status: "failed", error: err }, cancelled: false };
    }
    emit({ kind: "log", line: "[plugin] " + work.pluginId + "." + work.tool + " (from " + loadedPath + ")" });
    let mod: PluginModule;
    try {
      // Dynamic import. Use file:// URL so the loader treats
      // it as an absolute path under both ESM and tsx.
      mod = (await import(pathToFileURL(loadedPath).href + "?ch_plugin=" + Date.now())) as PluginModule;
    } catch (e) {
      const err = "plugin load failed: " + (e as Error).message;
      emit({ kind: "log", line: "[plugin] " + err });
      return { value: { kind: "plugin", pluginId: work.pluginId, tool: work.tool, status: "failed", error: err }, cancelled: false };
    }
    if (!mod || typeof mod !== "object" || !mod.tools || typeof mod.tools !== "object") {
      const err = `plugin ${work.pluginId} does not export { name, tools }`;
      return { value: { kind: "plugin", pluginId: work.pluginId, tool: work.tool, status: "failed", error: err }, cancelled: false };
    }
    const toolFn = (mod.tools as Record<string, unknown>)[work.tool];
    if (typeof toolFn !== "function") {
      const err = `plugin ${work.pluginId} has no tool "${work.tool}" (known: ${Object.keys(mod.tools).join(", ") || "(none)"})`;
      return { value: { kind: "plugin", pluginId: work.pluginId, tool: work.tool, status: "failed", error: err }, cancelled: false };
    }
    const timeoutMs = (work.timeoutSeconds ?? 30) * 1000;
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal.reason);
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    const t = setTimeout(() => ac.abort(new Error("plugin timeout after " + work.timeoutSeconds + "s")), timeoutMs);
    try {
      const ctx: PluginContext = { cwd: work.cwd, signal: ac.signal };
      const output = await (toolFn as PluginToolFn)(work.args, ctx);
      if (signal.aborted) {
        return { value: { kind: "plugin", pluginId: work.pluginId, tool: work.tool, status: "failed", error: "cancelled" }, cancelled: true };
      }
      return { value: { kind: "plugin", pluginId: work.pluginId, tool: work.tool, status: "completed", output }, cancelled: false };
    } catch (e) {
      if (signal.aborted) {
        return { value: { kind: "plugin", pluginId: work.pluginId, tool: work.tool, status: "failed", error: "cancelled" }, cancelled: true };
      }
      const err = (e as Error).message;
      return { value: { kind: "plugin", pluginId: work.pluginId, tool: work.tool, status: "failed", error: err }, cancelled: false };
    } finally {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
    }
  }

  // ---- api ----
  //
  // POST (or whatever `method` is set to) the work prompt to
  // `url` as JSON. The default body is `{ prompt, context,
  // timeoutSeconds }` — callers can override with `body` for
  // raw JSON. Default timeout 30s; override via
  // `timeoutSeconds`. Response is parsed as JSON; non-JSON
  // responses are returned as the raw text. Node's built-in
  // `fetch` is used (no new deps).

  private async runApiKind(
    work: ApiDelegation,
    signal: AbortSignal,
    emit: (ev: DelegationEvent) => void,
  ): Promise<{ value: DelegationResult; cancelled: boolean }> {
    const method = work.method ?? "POST";
    const timeoutMs = (work.timeoutSeconds ?? 30) * 1000;
    emit({ kind: "log", line: "[api] " + method + " " + work.url });
    const body: unknown = work.body !== undefined
      ? work.body
      : { prompt: work.prompt ?? "", context: work.context ?? {}, timeoutSeconds: work.timeoutSeconds ?? 30 };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(work.headers ?? {}),
    };
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal.reason);
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    const t = setTimeout(() => ac.abort(new Error("api timeout after " + work.timeoutSeconds + "s")), timeoutMs);
    try {
      // GET and DELETE are body-less by spec. POST / PUT / PATCH
      // get a JSON-encoded body. Pre-fix the same guard was
      // already in place, but the type for `work.method` only
      // covers POST / PUT / PATCH (GET / DELETE would already
      // arrive from the caller as the explicitly-allowed values),
      // so this comparison is correct for the supported set.
      const bodyless = method === "GET" || method === "DELETE";
      const res = await fetch(work.url, {
        method,
        headers,
        body: bodyless ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      // Stream-read with a cap so a hostile / runaway response
      // can't OOM the harness. Pre-fix: `await res.text()`
      // materialized the full body before parsing. Same fix
      // pattern as the `http` / `web_search` tools.
      const API_MAX_BYTES = 5_000_000;
      const chunks: Uint8Array[] = [];
      let received = 0;
      let truncated = false;
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            if (received + value.byteLength > API_MAX_BYTES) {
              const allowed = Math.max(0, API_MAX_BYTES - received);
              if (allowed > 0) {
                chunks.push(value.subarray(0, allowed));
                received += allowed;
              }
              truncated = true;
              try { await reader.cancel(); } catch { /* best-effort */ }
              break;
            }
            chunks.push(value);
            received += value.byteLength;
          }
        }
      }
      const bytes = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
      const text = new TextDecoder("utf-8").decode(bytes);
      if (signal.aborted) {
        return { value: { kind: "api", url: work.url, method, status: "failed", error: "cancelled" }, cancelled: true };
      }
      // Try to parse as JSON; fall back to the raw text.
      let output: unknown = text;
      if (text.length > 0) {
        try { output = JSON.parse(text); } catch { /* leave as text */ }
      }
      if (!res.ok) {
        const err = `HTTP ${res.status} ${res.statusText} — ${typeof output === "string" ? output : JSON.stringify(output).slice(0, 500)}`;
        return { value: { kind: "api", url: work.url, method, status: "failed", error: err, output }, cancelled: false };
      }
      return { value: { kind: "api", url: work.url, method, status: "completed", output }, cancelled: false };
    } catch (e) {
      if (signal.aborted) {
        return { value: { kind: "api", url: work.url, method, status: "failed", error: "cancelled" }, cancelled: true };
      }
      const err = (e as Error).message;
      return { value: { kind: "api", url: work.url, method, status: "failed", error: err }, cancelled: false };
    } finally {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
    }
  }

  // ---------- Internals ----------

  private toHandle(r: InternalRun): DelegationRun {
    return {
      id: r.id,
      kind: r.work.kind,
      // Live read so callers see status / startedAt / completedAt
      // progress as the run advances. The internal run is mutated by
      // the runner promise; the handle's getters forward to it.
      get status() { return r.status; },
      parentId: r.parentId,
      get startedAt() { return r.startedAt; },
      get completedAt() { return r.completedAt; },
      result: () => r.result,
      cancel: async () => { r.controller.abort(); },
      events: () => this.iterateEvents(r),
    };
  }

  private async *iterateEvents(r: InternalRun): AsyncIterable<DelegationEvent> {
    // Replay anything that was buffered before iteration started.
    let cursor = 0;
    while (cursor < r.buffer.length) {
      yield r.buffer[cursor]!;
      cursor += 1;
    }
    // Then subscribe to live events. If the run has already
    // terminated, the loop is a no-op.
    const queue: DelegationEvent[] = [];
    let done = false;
    const onEvent = (ev: DelegationEvent) => queue.push(ev);
    r.emitter.on("event", onEvent);
    try {
      while (!done) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (r.status === "completed" || r.status === "failed" || r.status === "cancelled") {
          done = true;
          break;
        }
        // Yield to the event loop so we don't busy-wait.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      r.emitter.off("event", onEvent);
    }
  }

  private emitEvent(r: InternalRun, ev: DelegationEvent): void {
    r.buffer.push(ev);
    r.emitter.emit("event", ev);
  }
}

// ---------- Top-level helper ----------

/** The single entry point described in the port plan. The manager
 *  lives on the runtime; this is sugar for `runtime.delegations.submit(w)`.
 *
 *  The signature is the one the spec asks for:
 *      delegate(work, ctx): Promise<DelegationResult>
 *
 *  where `ctx` is the slim deps bag. */
export async function delegate(
  work: Delegation,
  ctx: DelegationRuntimeDeps,
): Promise<DelegationResult> {
  const mgr = new DelegationManager(ctx);
  const handle = mgr.submit(work);
  return await handle.result();
}

// ---------- Plugin helpers (mcp / plugin / api runners) ----------

/** Plugin module shape. v1: a single JS/TS file exporting this. */
export interface PluginModule {
  /** Plugin display name. */
  name: string;
  /** Map of tool name → tool function. */
  tools: Record<string, PluginToolFn>;
  /** Optional version / author metadata. Ignored by the runner. */
  version?: string;
}

/** A plugin tool's function signature. */
export type PluginToolFn = (args: Record<string, unknown>, ctx: PluginContext) => Promise<unknown> | unknown;

/** Context passed to plugin tool functions. */
export interface PluginContext {
  /** Working directory. */
  cwd: string;
  /** Abort signal — fires when the delegation is cancelled or
   *  the per-call timeout elapses. */
  signal: AbortSignal;
}

/** Default plugin home. `$CH_HOME/plugins`. Resolved lazily so
 *  tests can override `CODINGHARNESS_HOME` / `CH_HOME` before the
 *  first call. */
function defaultPluginHome(): string {
  // Avoid importing `paths` at module top so the file can load
  // before `paths.home` is wired (the test suite overrides
  // CODINGHARNESS_HOME then mkdirSync's subdirs). A dynamic
  // import would also work; this is simpler.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const home = process.env.CODINGHARNESS_HOME
    ? process.env.CODINGHARNESS_HOME
    : process.env.CH_HOME
    ? process.env.CH_HOME
    : "";
  return join(home, "plugins");
}

/** Defensive: the registry's `listServers` is allowed to throw or
 *  return non-array. Coerce to a safe empty list so the
 *  "unknown server" branch can always be reached. */
function safeListServers(reg: McpRegistry): Array<{ id: string; name?: string }> {
  try {
    const out = reg.listServers();
    if (Array.isArray(out)) {
      return out.filter((s): s is { id: string; name?: string } =>
        typeof s === "object" && s !== null && typeof (s as { id?: unknown }).id === "string");
    }
    return [];
  } catch {
    return [];
  }
}
