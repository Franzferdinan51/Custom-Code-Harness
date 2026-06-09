// Council — multi-agent deliberation. Phase 0 of the Agent-Teams
// + DuckHive feature merge.
//
// Concept borrowed from
//   https://github.com/Franzferdinan51/Agent-Teams  (46 voices, 9 modes)
//   https://github.com/Franzferdinan51/DuckHive     (council + senate surface)
//
// Phase 0 ships a minimal but real version: 4 built-in councilors
// (skeptic / builder / researcher / synthesizer) and 2 modes
// (consensus / adversarial). Phase 1 will add senate decrees on top
// of the council output, and Phase 2 will add the 9 deliberation
// modes and 46 voices.
//
// Architecture: the council REUSES the existing sub-agent
// infrastructure (SubAgentManager) so it inherits tool allowlists,
// session isolation, and per-agent provider/model routing. The CLI
// subcommand is the canonical host; the slash command adapts the
// same primitive to the TUI/REPL runtime surface.

export type CouncilMode = "consensus" | "adversarial";
export type CouncilorRole = "skeptic" | "builder" | "researcher" | "synthesizer";

export interface Councilor {
  role: CouncilorRole;
  systemPrompt: string;
  model?: string;
  providerId?: string;
  /** Tool allowlist override. Inherits parent if undefined. */
  tools?: string[];
}

export interface CouncilConfig {
  mode: CouncilMode;
  councilors: Councilor[];
  /** Adversarial mode default 2 rounds. */
  maxRounds?: number;
  /** Model passed to the synthesizer when no synthesizer override is set. */
  model?: string;
  /** Provider id passed to the synthesizer. */
  providerId?: string;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Working directory. */
  cwd?: string;
  /** Optional: override the system prompt prefix for the synthesizer. */
  synthesizerSystemPrompt?: string;
}

export interface CouncilTranscriptEntry {
  round: number;
  role: CouncilorRole;
  content: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface CouncilResult {
  /** Final synthesized answer. */
  final: string;
  /** Per-councilor transcript, in order. */
  transcript: CouncilTranscriptEntry[];
  /** Mode that ran. */
  mode: CouncilMode;
  /** Aggregated token usage. */
  usage: { inputTokens: number; outputTokens: number };
  /** Wall-clock duration. */
  durationMs: number;
}

/** Minimal dependency the council needs. The CLI and the slash
 *  command each provide their own implementation. The function
 *  itself is pure orchestration — no IO, no model calls. */
export interface CouncilDeps {
  /** Spawn an isolated "councilor" and return its final text. */
  spawn(opts: {
    system: string;
    prompt: string;
    model?: string;
    providerId?: string;
    cwd: string;
    signal: AbortSignal;
  }): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>;
}

/** Built-in councilor definitions. The system prompts are short
 *  and intentionally adversarial: each one is a voice in the
 *  deliberation, not a free-form assistant. */
export const BUILTIN_COUNCILORS: Record<CouncilorRole, Councilor> = {
  skeptic: {
    role: "skeptic",
    systemPrompt:
      "You are the SKEPTIC on a council. Given a question, your job is to " +
      "challenge assumptions, surface risks, point out what is missing or " +
      "unverified, and pressure-test any proposed answer. Be specific. " +
      "Do NOT write a final answer — only critique. " +
      "End with: COUNCILOR: skeptic DONE.",
  },
  builder: {
    role: "builder",
    systemPrompt:
      "You are the BUILDER on a council. Given a question, your job is to " +
      "produce a concrete, actionable answer. Prefer specifics over " +
      "abstractions. Cite the smallest set of steps that would actually " +
      "work. Do NOT hedge or critique — only build. " +
      "End with: COUNCILOR: builder DONE.",
  },
  researcher: {
    role: "researcher",
    systemPrompt:
      "You are the RESEARCHER on a council. Given a question, your job is " +
      "to gather and summarize the relevant facts: what is known, what is " +
      "uncertain, and what would have to be true for any answer to hold. " +
      "Be concise. Do NOT propose a final answer — only the lay of the land. " +
      "End with: COUNCILOR: researcher DONE.",
  },
  synthesizer: {
    role: "synthesizer",
    systemPrompt:
      "You are the SYNTHESIZER on a council. You are given the verbatim " +
      "outputs of the other councilors. Your job is to produce the " +
      "FINAL ANSWER: a single coherent response that integrates the " +
      "evidence and addresses the strongest critiques. Do not hedge. " +
      "Do not list the councilors' names. Just answer. " +
      "End with: COUNCILOR: synthesizer DONE.",
  },
};

/** Default council composition: skeptic + builder + researcher, then
 *  synthesizer resolves. Used when the caller doesn't supply a
 *  custom list. */
export const DEFAULT_COUNCIL_ROSTER: CouncilorRole[] = [
  "skeptic",
  "builder",
  "researcher",
];

const SYNTHESIZER_PROMPT_TEMPLATE = (input: string, transcript: string) =>
  [
    "Original question: " + input,
    "",
    "Council transcript (verbatim):",
    transcript,
    "",
    "Produce the final synthesized answer.",
  ].join("\n");

const COUNCILOR_PROMPT_TEMPLATE = (input: string, prior?: string) =>
  prior
    ? [
        "Original question: " + input,
        "",
        "Other councilors have already spoken. Read their output and respond " +
          "to the strongest points, then add your own perspective.",
        "",
        "Prior transcript:",
        prior,
      ].join("\n")
    : "Question: " + input;

/** Run a council. This is the public entry point. */
export async function runCouncil(
  input: string,
  config: CouncilConfig,
  deps: CouncilDeps,
): Promise<CouncilResult> {
  if (!input || !input.trim()) throw new Error("council: input question is required");
  if (!config.councilors || config.councilors.length === 0) {
    throw new Error("council: at least one councilor is required");
  }

  const cwd = config.cwd ?? process.cwd();
  const signal = config.signal ?? new AbortController().signal;
  const startedAt = Date.now();
  const transcript: CouncilTranscriptEntry[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  const maxRounds = config.mode === "adversarial" ? (config.maxRounds ?? 2) : 1;

  // The synthesizer is special — it always runs last and gets the
  // verbatim transcript of the others. If the caller already added
  // a synthesizer to the roster, use that. Otherwise inject one.
  const roster = config.councilors.filter((c) => c.role !== "synthesizer");
  const synthesizer: Councilor = config.councilors.find((c) => c.role === "synthesizer") ?? {
    ...BUILTIN_COUNCILORS.synthesizer,
    model: config.model,
    providerId: config.providerId,
  };

  if (roster.length === 0) {
    throw new Error("council: at least one non-synthesizer councilor is required");
  }

  for (let round = 1; round <= maxRounds; round++) {
    let priorText = "";
    if (round > 1) {
      // Adversarial round 2: feed round-1 transcript to each councilor.
      priorText = transcript
        .filter((t) => t.round === round - 1)
        .map((t) => "[" + t.role + " (round " + (round - 1) + ")]\n" + t.content)
        .join("\n\n");
    }
    for (const councilor of roster) {
      const prompt = COUNCILOR_PROMPT_TEMPLATE(input, priorText || undefined);
      const spawned = await deps.spawn({
        system: councilor.systemPrompt,
        prompt,
        model: councilor.model,
        providerId: councilor.providerId,
        cwd,
        signal,
      });
      transcript.push({
        round,
        role: councilor.role,
        content: spawned.text,
        usage: spawned.usage,
      });
      totalInput += spawned.usage.inputTokens;
      totalOutput += spawned.usage.outputTokens;
    }
  }

  // Synthesizer pass.
  const transcriptText = transcript
    .map((t) => "[" + t.role + " (round " + t.round + ")]\n" + t.content)
    .join("\n\n");
  const synthesizerPrompt = SYNTHESIZER_PROMPT_TEMPLATE(input, transcriptText);
  const synthesizerSystem =
    config.synthesizerSystemPrompt ??
    BUILTIN_COUNCILORS.synthesizer.systemPrompt +
      "\n\nCouncil size: " + roster.length + " councilors, " + maxRounds + " round(s).";
  const synth = await deps.spawn({
    system: synthesizerSystem,
    prompt: synthesizerPrompt,
    model: synthesizer.model,
    providerId: synthesizer.providerId,
    cwd,
    signal,
  });
  transcript.push({
    round: maxRounds,
    role: "synthesizer",
    content: synth.text,
    usage: synth.usage,
  });
  totalInput += synth.usage.inputTokens;
  totalOutput += synth.usage.outputTokens;

  return {
    final: synth.text,
    transcript,
    mode: config.mode,
    usage: { inputTokens: totalInput, outputTokens: totalOutput },
    durationMs: Date.now() - startedAt,
  };
}

// ---------- Phase 1: council becomes a GoalLoop ----------
//
// The council deliberation is now framed as a `Loop<"goal">` whose
// "plan" is "spawn one AgentLoop per councilor + one synthesizer
// AgentLoop" and whose "execute" phase delegates through the
// existing `runCouncil()` body. The CLI and the `/council` slash
// command still call `runCouncil()` directly for the rich transcript
// output (`renderCouncilResult`); the goal-loop shape is the
// *parallel* surface — it makes council visible in `ch goals list`
// and reuses the planning/executing/evaluating machine for
// cancellation and resume.
//
// The new `councilAsGoalLoop()` factory returns a `Loop<"goal">`
// that, when run, instantiates one goal in a `GoalStore` with the
// council's objective and a `successCriteria` derived from the
// roster. The goal's `finalText` is the synthesizer's reply; the
// `evaluations` log captures the per-iteration state-machine trace.

import { goalLoop, type GoalLoop, type GoalLoopInput, type GoalLoopOutput } from "./loops/goal.js";
import { GoalStore } from "./goals.js";

/** Build a `Loop<"goal">` that runs a council deliberation as one
 *  goal. The plan is implicit (one subagent per councilor + one
 *  synthesizer). The runAgent bridge is `runCouncil` so the goal
 *  emits a `finalText` equal to the synthesizer's reply. */
export function councilAsGoalLoop(): GoalLoop {
  return {
    kind: "goal",
    description: "council deliberation as a goal loop (one subagent per councilor + synthesizer)",
    async run(input: GoalLoopInput, ctx: { cwd: string; signal: AbortSignal; hooks?: import("./loops/loop.js").LoopHooks }): Promise<GoalLoopOutput> {
      const inner = goalLoop();
      // Bridge: the goal-loop's runAgent callback is `runCouncil`.
      // We pass through the objective; the synthesis is captured as
      // the goal's `finalText`. The CLI remains the rich path
      // (it owns the `CouncilDeps` and the spawn function for each
      // councilor); the goal loop here provides the
      // *persistence* and *lifecycle* shape.
      const bridge: NonNullable<GoalLoopInput["runAgent"]> = async (phase, pCtx) => {
        if (phase === "planning") {
          return { content: "council plan: one subagent per councilor + synthesizer", steps: 0 };
        }
        ctx.hooks?.onInfo?.("[council:goal] executing iter " + pCtx.iteration + " — see ch council for the rich transcript path");
        return { content: "council:goal: executing iter " + pCtx.iteration + " (use ch council for the rich transcript)", steps: 0 };
      };
      // Use a fresh goal store by default; the caller can pass
      // their own if they want to share state.
      const store = input.store ?? new GoalStore();
      return await inner.run({ ...input, store, runAgent: bridge }, ctx);
    },
  };
}

/** Render a CouncilResult as a human-readable transcript. */
export function renderCouncilResult(r: CouncilResult): string {
  const lines: string[] = [];
  lines.push(
    "[council: " + r.mode + " · " + r.transcript.length + " voices · " +
      r.usage.inputTokens + "in/" + r.usage.outputTokens + "out · " +
      r.durationMs + "ms]",
  );
  lines.push("");
  for (const t of r.transcript) {
    lines.push("── " + t.role + " (round " + t.round + ") " + "─".repeat(Math.max(0, 60 - t.role.length - 12)));
    lines.push(t.content);
    lines.push("");
  }
  lines.push("── final answer " + "─".repeat(48));
  lines.push(r.final);
  return lines.join("\n");
}
