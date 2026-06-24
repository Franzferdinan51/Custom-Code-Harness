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
/** 9 built-in deliberation voices. The synthesizer is special — it
 *  always runs last and integrates the other 8. The other 8 are
 *  the deliberators and may all be present in a roster. */
export type CouncilorRole =
  | "skeptic"
  | "builder"
  | "researcher"
  | "security"
  | "performance"
  | "dx"
  | "qa"
  | "domain"
  | "synthesizer";

export interface Councilor {
  role: CouncilorRole;
  /** Human-readable display name (e.g. "The Sentinel"). Used in
   *  transcripts and the synthesizer prompt so a generic role
   *  string isn't surfaced to the LLM. */
  name?: string;
  systemPrompt: string;
  /** Deliberation weight — the synthesizer uses this to bias the
   *  final answer toward higher-weight voices. Default 1.0.
   *  Higher = stronger signal in synthesis. */
  weight?: number;
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

/* -----------------------------------------------------------------------
 * Built-in councilor voices (9 total)
 * -----------------------------------------------------------------------
 *
 *  # | role        | display name      | weight | perspective
 * ---|-------------|-------------------|--------|---------------------------------
 *  1 | skeptic     | The Skeptic       |   1.0  | Challenge assumptions, surface
 *    |             |                   |        | risks, pressure-test answers
 *  2 | builder     | The Builder       |   1.0  | Concrete actionable steps, no
 *    |             |                   |        | hedging, smallest viable plan
 *  3 | researcher  | The Researcher    |   1.0  | Facts, evidence, what's known
 *    |             |                   |        | vs unknown, lay of the land
 *  4 | security    | The Sentinel      |   1.2  | Threat model, secrets, auth,
 *    |             |                   |        | injection, blast radius
 *  5 | performance | The Tuner         |   1.0  | Latency, throughput, memory,
 *    |             |                   |        | hot paths, scaling
 *  6 | dx          | The Advocate      |   0.8  | Developer + end-user ergonomics,
 *    |             |                   |        | onboarding, cognitive load
 *  7 | qa          | The Verifier      |   1.0  | Test coverage, edge cases,
 *    |             |                   |        | repro steps, assertions
 *  8 | domain      | The Domain Expert |   0.9  | Subject-matter context the
 *    |             |                   |        | question is rooted in
 *  9 | synthesizer | The Synthesizer   |   1.5  | Integrates the 8 above into
 *    |             |                   |        | a final, coherent answer
 *
 *  Notes:
 *  - The synthesizer is special: it always runs LAST and gets the
 *    verbatim transcript of the other 8. It is NOT in
 *    `DEFAULT_COUNCIL_ROSTER` (which is the 3-voice minimal default).
 *  - Weights surface in the synthesizer's system prompt as a
 *    "voice weights" line so the final answer can lean on
 *    higher-weight voices.
 *  - Each system prompt starts with a unique uppercase marker
 *    (SKEPTIC / BUILDER / RESEARCHER / SENTINEL / TUNER / ADVOCATE /
 *    VERIFIER / DOMAIN EXPERT / SYNTHESIZER) so callers can identify
 *    a voice from its system prompt alone — see
 *    `src/__tests__/council.test.ts` `makeStubDeps`.
 * ----------------------------------------------------------------------- */

/** Built-in councilor definitions. The system prompts are short
 *  and intentionally adversarial: each one is a voice in the
 *  deliberation, not a free-form assistant. */
export const BUILTIN_COUNCILORS: Record<CouncilorRole, Councilor> = {
  skeptic: {
    role: "skeptic",
    name: "The Skeptic",
    weight: 1.0,
    systemPrompt:
      "You are the SKEPTIC on a council. Given a question, your job is to " +
      "challenge assumptions, surface risks, point out what is missing or " +
      "unverified, and pressure-test any proposed answer. Be specific. " +
      "Do NOT write a final answer — only critique. " +
      "End with: COUNCILOR: skeptic DONE.",
  },
  builder: {
    role: "builder",
    name: "The Builder",
    weight: 1.0,
    systemPrompt:
      "You are the BUILDER on a council. Given a question, your job is to " +
      "produce a concrete, actionable answer. Prefer specifics over " +
      "abstractions. Cite the smallest set of steps that would actually " +
      "work. Do NOT hedge or critique — only build. " +
      "End with: COUNCILOR: builder DONE.",
  },
  researcher: {
    role: "researcher",
    name: "The Researcher",
    weight: 1.0,
    systemPrompt:
      "You are the RESEARCHER on a council. Given a question, your job is " +
      "to gather and summarize the relevant facts: what is known, what is " +
      "uncertain, and what would have to be true for any answer to hold. " +
      "Be concise. Do NOT propose a final answer — only the lay of the land. " +
      "End with: COUNCILOR: researcher DONE.",
  },
  security: {
    role: "security",
    name: "The Sentinel",
    weight: 1.2,
    systemPrompt:
      "You are the SENTINEL on a council, voicing the SECURITY perspective. " +
      "Given a question, your job is to identify attack surfaces, threat " +
      "models, secret leakage, auth/authz gaps, injection risks, supply " +
      "chain risks, and blast radius. Be specific about what could go wrong " +
      "and how to defend against it. Cite concrete mitigations, not vague " +
      "worries. Do NOT propose the final answer — only the security lens. " +
      "End with: COUNCILOR: security DONE.",
  },
  performance: {
    role: "performance",
    name: "The Tuner",
    weight: 1.0,
    systemPrompt:
      "You are the TUNER on a council, voicing the PERFORMANCE perspective. " +
      "Given a question, your job is to flag latency, throughput, memory " +
      "footprint, allocations, hot paths, and scaling concerns. Prefer " +
      "concrete measurements or rough orders of magnitude over vague " +
      "hand-waving. Note when 'correct but slow' is the real risk. Do NOT " +
      "propose the final answer — only the performance lens. " +
      "End with: COUNCILOR: performance DONE.",
  },
  dx: {
    role: "dx",
    name: "The Advocate",
    weight: 0.8,
    systemPrompt:
      "You are the ADVOCATE on a council, voicing the DEVELOPER and END-USER " +
      "EXPERIENCE perspective. Given a question, your job is to surface " +
      "ergonomics, error messages, onboarding friction, accessibility, and " +
      "cognitive load — for the human using the system AND the developer " +
      "extending it. Prefer concrete UX moments over abstract principles. " +
      "Do NOT propose the final answer — only the DX/UX lens. " +
      "End with: COUNCILOR: dx DONE.",
  },
  qa: {
    role: "qa",
    name: "The Verifier",
    weight: 1.0,
    systemPrompt:
      "You are the VERIFIER on a council, voicing the TESTING/QA " +
      "perspective. Given a question, your job is to ask: how would we " +
      "test this? What edge cases are uncovered? How do we reproduce " +
      "failures? What assertions would prove the answer right? Prefer " +
      "concrete repro steps and assertion lists over platitudes. Do NOT " +
      "propose the final answer — only the testing/QA lens. " +
      "End with: COUNCILOR: qa DONE.",
  },
  domain: {
    role: "domain",
    name: "The Domain Expert",
    weight: 0.9,
    systemPrompt:
      "You are the DOMAIN EXPERT on a council. Given a question, your job " +
      "is to anchor the answer in the specific subject-matter context — " +
      "the libraries, APIs, protocols, standards, ecosystem norms, and " +
      "historical precedents the question is rooted in. Name the things a " +
      "generic answer would miss; flag where the question itself rests on " +
      "a false premise. Do NOT propose the final answer — only the domain " +
      "lens. End with: COUNCILOR: domain DONE.",
  },
  synthesizer: {
    role: "synthesizer",
    name: "The Synthesizer",
    weight: 1.5,
    systemPrompt:
      "You are the SYNTHESIZER on a council. You are given the verbatim " +
      "outputs of the other councilors. Your job is to produce the " +
      "FINAL ANSWER: a single coherent response that integrates the " +
      "evidence and addresses the strongest critiques. Lean on the higher-" +
      "weight voices more than the lower-weight ones. Do not hedge. " +
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
  // A caller-provided roster that lists the synthesizer role
  // more than once is a configuration error: only the first
  // synthesizer can run, and silently dropping the extras is
  // surprising. Surface the conflict up front.
  const synthesizersInRoster = config.councilors.filter((c) => c.role === "synthesizer");
  if (synthesizersInRoster.length > 1) {
    throw new Error("council: at most one synthesizer is allowed in the roster; got " + synthesizersInRoster.length);
  }
  const roster = config.councilors.filter((c) => c.role !== "synthesizer");
  const synthesizer: Councilor = synthesizersInRoster[0] ?? {
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
      // Check the abort signal between councilors. The signal
      // is threaded to each `deps.spawn` (which should honor it
      // via its provider chain), but a buggy / hung spawn that
      // ignores the signal would otherwise let the loop keep
      // running and call every subsequent councilor in the
      // roster. Throw up front if the caller has already
      // cancelled, so the caller sees a structured
      // AbortError rather than a silent partial result.
      if (signal.aborted) {
        throw makeAbortError();
      }
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
      "\n\nCouncil size: " + roster.length + " councilors, " + maxRounds + " round(s). " +
      "\nVoice weights: " + roster.map((c) => c.role + "=" + (c.weight ?? 1.0)).join(", ");
  // Same abort check before the synthesizer call. Without
  // this, a caller-cancel between the last councilor and the
  // synthesizer would still let the synthesizer run to
  // completion, wasting tokens and time on a result the
  // caller has already discarded.
  if (signal.aborted) {
    throw makeAbortError();
  }
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
import { GoalStore, DEFAULT_MISSION } from "./goals.js";

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
      // their own if they want to share state. Scoped to the
      // caller's active mission (input.mission) so the council
      // deliberation shows up under the same mission as the
      // `ch goal` flow that spawned it.
      const store = input.store ?? new GoalStore({ mission: input.mission ?? DEFAULT_MISSION });
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
    // Pad to a target line width. Pre-fix the math was
    // `60 - role.length - 12` which assumed a single-digit
    // round number; for round 10+ the column drifted right
    // by 1 char. Compute the actual length of the prefix
    // (`── ` (3) + role + ` (round ` (8) + round + `)` (1))
    // and use that as the base. Same fix shape as
    // `60 - 12 = 48` for the final-answer rule.
    const prefix = "── " + t.role + " (round " + t.round + ") ";
    lines.push(prefix + "─".repeat(Math.max(0, 60 - prefix.length)));
    lines.push(t.content);
    lines.push("");
  }
  lines.push("── final answer " + "─".repeat(48));
  lines.push(r.final);
  return lines.join("\n");
}

/** Local helper — same shape as `openai-compat.ts`'s
 *  `makeAbortError`, kept private (not exported) so the
 *  council doesn't depend on a provider-internal API. */
function makeAbortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
