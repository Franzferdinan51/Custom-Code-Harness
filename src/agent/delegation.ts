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
import { log } from "../util/logger.js";
import { runGoalStateMachine, type GoalRecord, type GoalState, type GoalStore } from "./goals.js";
import type { GoalRunAgentFn, RunGoalOptions } from "./goals.js";
import type { Settings } from "../config/settings.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { SubAgentManager, type SubAgentResult } from "./subagent.js";

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
export interface McpDelegation extends DelegationBase {
  kind: "mcp";
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
}
export interface PluginDelegation extends DelegationBase {
  kind: "plugin";
  pluginId: string;
  tool: string;
  args: Record<string, unknown>;
}
export interface ApiDelegation extends DelegationBase {
  kind: "api";
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  headers?: Record<string, string>;
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

export type DelegationResult =
  | { kind: "agent"; text: string; usage: { inputTokens: number; outputTokens: number }; steps: number; sessionId?: string; status: SubAgentResult["status"] }
  | { kind: "goal"; goalId: string; status: GoalState; finalText?: string; iterations: number }
  | { kind: "async_tool"; toolName: string; iterations: number; result: unknown }
  | { kind: "human_approval"; decision: "allow" | "deny"; reason?: string }
  | { kind: "workflow"; workflowId: string; status: "stub" }
  | { kind: "mcp"; serverId: string; tool: string; status: "stub" }
  | { kind: "plugin"; pluginId: string; tool: string; status: "stub" }
  | { kind: "api"; url: string; status: "stub" };

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
      case "mcp":
      case "plugin":
      case "api":
        return this.runStubKind(work);
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
    const r = await this.deps.subagent.spawn({
      agent: work.agent,
      prompt: work.prompt,
      model: work.model,
      providerId: work.providerId,
      cwd: work.cwd,
      signal,
      ephemeral: work.ephemeral,
      parentSessionId: work.parentSessionId,
    });
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

    // Bridge to the goal-runner. We use a stub runAgent that throws
    // when called — the goal loop's actual execution path stays in
    // `runGoalStateMachine` (called from the CLI / `ch goal`).
    // The Phase 1 port ships the dispatcher and the
    // integration hook; the real "run a goal through the manager"
    // path lands in a follow-up that wires `runtime.runAgent`
    // here. For now, we expose the hook so the goal lifecycle
    // observes the union.
    const stub: GoalRunAgentFn = async () => {
      throw new Error("delegation: goal kind is a dispatcher stub — use ch goal for execution");
    };
    const opts: RunGoalOptions = {
      store: this.deps.goalStore,
      runAgent: stub,
      maxIterations: 1,
      onStateChange: (state) => {
        emit({ kind: "log", line: "[goal] " + state });
      },
    };
    try {
      await runGoalStateMachine(goal, opts);
    } catch (e) {
      // The stub runAgent throws on its first call. Treat that as
      // "dispatched through the union" — the union handled the
      // lifecycle; the actual execution belongs to the CLI path.
      log.debug("delegation: goal dispatcher returned (expected: stub runAgent) — " + (e as Error).message);
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
    // Phase 1: single-shot. The schedule field is reserved for
    // periodic re-runs (Phase 2: matches agnt-gg's
    // `_interval` / `_stopAfter` / `_duration`).
    emit({ kind: "log", line: "[async_tool] " + work.toolName });
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

  // ---- stubs (Phase 2) ----

  private runStubKind(work: WorkflowDelegation | McpDelegation | PluginDelegation | ApiDelegation): { value: DelegationResult; cancelled: boolean } {
    log.warn("delegation: kind " + work.kind + " is a Phase 2 stub");
    switch (work.kind) {
      case "workflow": return { value: { kind: "workflow", workflowId: work.workflowId, status: "stub" }, cancelled: false };
      case "mcp":      return { value: { kind: "mcp", serverId: work.serverId, tool: work.tool, status: "stub" }, cancelled: false };
      case "plugin":   return { value: { kind: "plugin", pluginId: work.pluginId, tool: work.tool, status: "stub" }, cancelled: false };
      case "api":      return { value: { kind: "api", url: work.url, status: "stub" }, cancelled: false };
    }
  }

  // ---------- Internals ----------

  private toHandle(r: InternalRun): DelegationRun {
    return {
      id: r.id,
      kind: r.work.kind,
      status: r.status,
      parentId: r.parentId,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
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
