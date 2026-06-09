// Loop<Kind> — the discriminated union over the five loop tiers.
//
// Phase 1 unifies what agnt-gg splits across `OrchestratorService`,
// `TaskOrchestrator`, `goal-runner`, and per-tool `executeTool` into a
// single stack. The five tiers, top to bottom:
//
//   mission  → perpetual; instantiates a GoalLoop
//   goal     → drives a goal forward; uses `delegate` from p1-delegation
//   agent    → wraps `runAgent` from `src/agent/loop.ts`
//   workflow → multi-step task (reproduce → diagnose → patch → test)
//   tool     → single tool execution; thin wrapper over the registry
//
// Each tier is a `Loop<Kind>` instance with a uniform `run` shape.
// The union is discriminated by `kind`; the input/output types vary
// per kind but the runner signature is identical at the base level.
//
// See `plans/plan_phase1/notes/agnt-port-plan.md` §3.

/** The five tiers. Keep this in sync with the per-kind files and the
 *  `AnyLoop` union in `index.ts`. The order matches the spec. */
export type LoopKind = "mission" | "goal" | "agent" | "workflow" | "tool";

/** Runtime context every loop sees. */
export interface LoopContext {
  /** Working directory the loop should resolve relative paths from. */
  cwd: string;
  /** Abort signal. Every loop must respect it. */
  signal: AbortSignal;
  /** Optional streaming hooks. Loops call these to surface progress. */
  hooks?: LoopHooks;
}

export interface LoopHooks {
  onInfo?: (msg: string) => void;
  onState?: (state: string) => void;
  onError?: (err: Error) => void;
  onOutput?: (chunk: string) => void;
  onTextDelta?: (text: string) => void;
  onToolCallStart?: (name: string) => void;
  onToolCallEnd?: (name: string, isError: boolean) => void;
}

/** Base type — every loop has a `kind` tag, a description, and a `run`
 *  method that takes a kind-specific input and returns a kind-specific
 *  output. The generics let callers and tests pin input/output types
 *  per tier. The runtime value is identified by its `kind` field; the
 *  generics are compile-time only. */
export interface BaseLoop<K extends LoopKind, TInput, TOutput> {
  readonly kind: K;
  readonly description: string;
  run(input: TInput, ctx: LoopContext): Promise<TOutput>;
}

/** The short alias most call sites use. `Loop<"goal", GoalInput, GoalOutput>`. */
export type Loop<K extends LoopKind, TInput = unknown, TOutput = unknown> = BaseLoop<K, TInput, TOutput>;
