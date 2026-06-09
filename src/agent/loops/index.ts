// Loop<Kind> hierarchy — the public surface.
//
// Phase 1 collapses the loop layers (mission, goal, agent, workflow,
// tool) under a single tagged union. This file is the single import
// surface for consumers: `import { goalLoop, agentLoop, ... } from
// "../agent/loops/index.js"`.
//
// Per-tier factories:
//   - missionLoop()  — MissionLoop (perpetual; instantiates a GoalLoop)
//   - goalLoop()     — GoalLoop (drives a goal forward)
//   - agentLoop()    — AgentLoop (wraps `runAgent`)
//   - workflowLoop() — WorkflowLoop (multi-step sequence)
//   - toolLoopFromRegistry(registry, name) — ToolLoop (single tool)
//
// Plus `AnyLoop`, the discriminated union of the five tiers, used by
// callers that accept a loop of any kind (the test suite, the
// delegation manager, the CLI).

import type { Loop, LoopKind, LoopContext, LoopHooks } from "./loop.js";
import { toolLoopFromRegistry, type ToolLoop, type ToolInput, type ToolOutput } from "./tool.js";
import { agentLoop, type AgentLoop, type AgentLoopInput, type AgentLoopOutput } from "./agent.js";
import { workflowLoop, bugFixWorkflow, type WorkflowLoop, type WorkflowInput, type WorkflowOutput, type WorkflowStep, type WorkflowState } from "./workflow.js";
import { goalLoop, type GoalLoop, type GoalLoopInput, type GoalLoopOutput } from "./goal.js";
import { missionLoop, type MissionLoop, type MissionInput, type MissionOutput } from "./mission.js";

export type { Loop, LoopKind, LoopContext, LoopHooks } from "./loop.js";
export type { ToolLoop, ToolInput, ToolOutput } from "./tool.js";
export type { AgentLoop, AgentLoopInput, AgentLoopOutput } from "./agent.js";
export type { WorkflowLoop, WorkflowInput, WorkflowOutput, WorkflowStep, WorkflowState } from "./workflow.js";
export type { GoalLoop, GoalLoopInput, GoalLoopOutput } from "./goal.js";
export type { MissionLoop, MissionInput, MissionOutput } from "./mission.js";

export { toolLoopFromRegistry, canHandle as toolCanHandle, specFor as toolSpecFor } from "./tool.js";
export { agentLoop } from "./agent.js";
export { workflowLoop, bugFixWorkflow } from "./workflow.js";
export { goalLoop } from "./goal.js";
export { missionLoop } from "./mission.js";

/** The tagged union of all five loop tiers. Discriminated by `kind`.
 *  Useful for type guards and for callers that accept any loop. */
export type AnyLoop =
  | MissionLoop
  | GoalLoop
  | AgentLoop
  | WorkflowLoop
  | ToolLoop;

/** Narrow a loop to a specific tier. */
export function isMission(loop: AnyLoop): loop is MissionLoop { return loop.kind === "mission"; }
export function isGoal(loop: AnyLoop): loop is GoalLoop { return loop.kind === "goal"; }
export function isAgent(loop: AnyLoop): loop is AgentLoop { return loop.kind === "agent"; }
export function isWorkflow(loop: AnyLoop): loop is WorkflowLoop { return loop.kind === "workflow"; }
export function isTool(loop: AnyLoop): loop is ToolLoop { return loop.kind === "tool"; }

/** The exhaustive list of kinds, in spec order. Useful for tests. */
export const LOOP_KINDS: readonly LoopKind[] = ["mission", "goal", "agent", "workflow", "tool"];
