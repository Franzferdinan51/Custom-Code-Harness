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
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
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
 *  fields the runner needs to fail fast. */
export interface WorkflowDelegation extends DelegationBase {
  kind: "workflow";
  workflowId: string;
  inputs?: Record<string, unknown>;
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
  | { kind: "goal"; goalId: string; status: GoalState; finalText?: string; iterations: number }
  | { kind: "async_tool"; toolName: string; iterations: number; result: unknown }
  | { kind: "human_approval"; decision: "allow" | "deny"; reason?: string }
  | { kind: "workflow"; workflowId: string; status: "stub" }
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
    writeFileSync(tmp, payload, "utf-8");
    renameSync(tmp, this.file);
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
   *  `executing` once per iteration). */
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
        return this.runStubKind(work);
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

    const goal = this.deps.goalStore.add({
      objective: work.objective,
      maxSteps: work.maxIterations ?? 8,
      model: work.model,
      providerId: work.providerId,
      successCriteria: work.successCriteria,
      parentGoalId: work.parentGoalId,
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
    // The skills allowlist (when set on the work) is forwarded
    // to the runner so the planner / spawned subagents only see
    // a known toolset.
    const runGoalAgent: GoalRunAgentFn = async (phase, ctx, sig) => {
      emit({ kind: "log", line: "[goal] phase=" + phase + " iteration=" + ctx.iteration });
      return this.deps.runGoalAgent!(phase, ctx, sig);
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
      return { value: { kind: "goal", goalId: goal.id, status: "failed", iterations: 0 }, cancelled: true };
    }
    const final = this.deps.goalStore.get(goal.id);
    return {
      value: {
        kind: "goal",
        goalId: goal.id,
        status: final?.loopStatus ?? "failed",
        finalText: final?.finalText,
        iterations: final?.currentIteration ?? 0,
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

  // ---- workflow stub (Phase 2) ----
  //
  // The workflow kind is the only remaining stub — the port plan
  // calls it a 2-3 week track (per
  // `plans/plan_phase2/notes/agnt-port-plan.md` §2.4). The other
  // three Phase 2 kinds (mcp, plugin, api) have real impls
  // below.

  private runStubKind(work: WorkflowDelegation): { value: DelegationResult; cancelled: boolean } {
    log.warn("delegation: kind " + work.kind + " is a Phase 2 stub");
    return { value: { kind: "workflow", workflowId: work.workflowId, status: "stub" }, cancelled: false };
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
      const res = await fetch(work.url, {
        method,
        headers,
        body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
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
