// WorkflowLoop — multi-step task driver.
//
// Tier 4 in the loop hierarchy. A workflow is a pre-authored
// multi-step sequence. The canonical shape is the 4-step loop
// `reproduce → diagnose → patch → test` used for bug-fix tasks.
//
// The WorkflowLoop in Phase 1 is the *slot* — it accepts a sequence
// of named steps and a runner for each, and walks the sequence with
// state passing between them. Concrete workflows register their own
// steps; the loop is the engine.
//
// `src/agent/loop.ts` (now AgentLoop) is the LLM turn primitive; a
// workflow is a higher-level composition that may call the AgentLoop
// zero or more times per step.
//
// Phase 1 ships the slot + the canonical 4-step pattern. Phase 2 will
// add the `WorkflowService`-style pre-authored YAML/JSON loading.

import type { Loop, LoopContext } from "./loop.js";
import { runAgent, DEFAULT_LIMITS } from "../loop.js";
import { defaultToolRegistry } from "../tools/index.js";
import type { Provider } from "../../types.js";
import type { ToolRegistry } from "../tools/registry.js";

/** A named step in a workflow. The step is responsible for building
 *  its own user prompt from the shared state, and for producing the
 *  next piece of state. The loop's only job is to chain them. */
export interface WorkflowStep {
  name: string;
  /** Build the user prompt for this step from the current state. */
  buildPrompt(state: WorkflowState): string;
  /** Apply the model's response to the state. May mutate or return
   *  a new state. Optional — the loop always appends the raw output
   *  to `state.steps[]` so workflows that don't need to parse the
   *  output can skip this hook. */
  apply?(response: string, state: WorkflowState): WorkflowState | Promise<WorkflowState>;
}

export interface WorkflowState {
  /** The original task / question the workflow is solving. */
  task: string;
  /** Per-step outputs, in order. */
  steps: Array<{ name: string; output: string; at: number }>;
  /** Free-form bag for workflow-specific state. */
  meta: Record<string, unknown>;
}

export interface WorkflowInput {
  task: string;
  steps: WorkflowStep[];
  provider: Provider;
  model: string;
  system?: string;
  tools?: ToolRegistry;
  cwd: string;
  signal: AbortSignal;
  /** Optional: cap per-step LLM rounds. Defaults to 4. */
  maxStepsPerStep?: number;
  /** Optional: extra initial state fields. */
  initialMeta?: Record<string, unknown>;
}

export interface WorkflowOutput {
  state: WorkflowState;
  finalText: string;
  stepsRun: number;
}

/** A Loop<"workflow">. */
export interface WorkflowLoop extends Loop<"workflow", WorkflowInput, WorkflowOutput> {}

/** Build a WorkflowLoop. */
export function workflowLoop(): WorkflowLoop {
  return {
    kind: "workflow",
    description: "multi-step task driver (named steps chained via shared state)",
    async run(input: WorkflowInput, ctx: LoopContext): Promise<WorkflowOutput> {
      const tools = input.tools ?? defaultToolRegistry();
      const limits = { ...DEFAULT_LIMITS, maxSteps: input.maxStepsPerStep ?? 4 };
      const state: WorkflowState = {
        task: input.task,
        steps: [],
        meta: { ...(input.initialMeta ?? {}) },
      };
      let finalText = "";
      for (const step of input.steps) {
        if (ctx.signal.aborted) break;
        const userPrompt = step.buildPrompt(state);
        const messages = [{ role: "user" as const, content: userPrompt }];
        const ac = new AbortController();
        const onAbort = () => ac.abort(ctx.signal.reason);
        if (ctx.signal.aborted) ac.abort();
        else ctx.signal.addEventListener("abort", onAbort, { once: true });
        try {
          const result = await runAgent({
            provider: input.provider,
            model: input.model,
            ...(input.system !== undefined ? { system: input.system } : {}),
            messages,
            tools,
            cwd: input.cwd,
            signal: ac.signal,
            limits,
            hooks: {
              onInfo: (m) => ctx.hooks?.onInfo?.("[" + step.name + "] " + m),
              onError: (e) => ctx.hooks?.onError?.(e),
            },
          });
          const output = result.final.content;
          state.steps.push({ name: step.name, output, at: Date.now() });
          if (step.apply) {
            const next = await step.apply(output, state);
            // The step may return a new state; merge steps/meta but
            // preserve the step log we just appended.
            state.meta = next.meta;
            for (const s of next.steps) {
              if (s !== state.steps[state.steps.length - 1]) state.steps.push(s);
            }
          }
          finalText = output;
          ctx.hooks?.onState?.(step.name);
        } finally {
          ctx.signal.removeEventListener("abort", onAbort);
        }
      }
      return { state, finalText, stepsRun: state.steps.length };
    },
  };
}

// ---------- The canonical 4-step pattern: reproduce → diagnose → patch → test ----------

/** Build the canonical bug-fix workflow. The four steps are:
 *   1. reproduce  — produce a minimal failing case
 *   2. diagnose   — narrow down the cause
 *   3. patch      — write the fix
 *   4. test       — verify the fix
 *  Each step passes the previous step's output to the next. The
 *  model sees the full chain in its context. */
export function bugFixWorkflow(): WorkflowStep[] {
  return [
    {
      name: "reproduce",
      buildPrompt: (s) => [
        "Workflow step 1 of 4: REPRODUCE",
        "Task: " + s.task,
        "",
        "Produce a minimal failing case (commands, code snippet, or steps) that demonstrates the bug.",
        "Be specific — assume the next step (diagnose) only sees what you write here.",
      ].join("\n"),
    },
    {
      name: "diagnose",
      buildPrompt: (s) => [
        "Workflow step 2 of 4: DIAGNOSE",
        "Task: " + s.task,
        "",
        "Reproduction from the previous step:",
        s.steps[s.steps.length - 1]?.output ?? "(no reproduction)",
        "",
        "Identify the root cause. Be specific about which file/line is wrong and why.",
      ].join("\n"),
    },
    {
      name: "patch",
      buildPrompt: (s) => [
        "Workflow step 3 of 4: PATCH",
        "Task: " + s.task,
        "",
        "Diagnosis:",
        s.steps[s.steps.length - 1]?.output ?? "(no diagnosis)",
        "",
        "Write the smallest patch that fixes the issue. Use the read/edit/bash tools if available.",
        "Do NOT include unrelated cleanups.",
      ].join("\n"),
    },
    {
      name: "test",
      buildPrompt: (s) => [
        "Workflow step 4 of 4: TEST",
        "Task: " + s.task,
        "",
        "Patch:",
        s.steps[s.steps.length - 1]?.output ?? "(no patch)",
        "",
        "Verify the fix. Run the test suite or add a regression test. Report pass/fail.",
      ].join("\n"),
    },
  ];
}
