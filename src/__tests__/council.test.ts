// Tests for the Council module. We stub CouncilDeps.spawn
// directly so the tests don't need a real Provider / LLM loop.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODINGHARNESS_HOME = mkdtempSync(join(tmpdir(), "ch-council-test-"));
process.env.NO_COLOR = "1";
// Some modules import paths.* eagerly; pre-create the dirs they expect.
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
  mkdirSync(join(process.env.CODINGHARNESS_HOME, sub), { recursive: true });
}

import {
  runCouncil,
  BUILTIN_COUNCILORS,
  DEFAULT_COUNCIL_ROSTER,
  renderCouncilResult,
  type CouncilDeps,
  type Councilor,
  type CouncilorRole,
} from "../agent/council.js";

/** Build a deterministic stub spawner. Each councilor gets one
 *  canned reply; the synthesizer gets a separate one. */
function makeStubDeps(opts: {
  perRole?: Partial<Record<CouncilorRole, string>>;
  synthesizer?: string;
  callLog?: string[];
}): CouncilDeps {
  const synthesizerDefault = "FINAL: " + (opts.perRole?.skeptic ?? "?") + " | " + (opts.perRole?.builder ?? "?") + " | " + (opts.perRole?.researcher ?? "?");
  return {
    spawn: async (spawnOpts) => {
      // Detect synthesizer: its system prompt starts with the
      // "SYNTHESIZER" marker, and its prompt contains the
      // "Council transcript" header.
      if (spawnOpts.prompt.includes("Council transcript")) {
        const text = opts.synthesizer ?? synthesizerDefault;
        opts.callLog?.push("synthesizer");
        return { text, usage: { inputTokens: 10, outputTokens: 5 } };
      }
      // Otherwise it's a regular councilor. The system prompt
      // identifies the role via a unique uppercase marker — see
      // the table comment in `src/agent/council.ts`.
      const role: CouncilorRole =
        spawnOpts.system.includes("SKEPTIC") ? "skeptic" :
        spawnOpts.system.includes("BUILDER") ? "builder" :
        spawnOpts.system.includes("RESEARCHER") ? "researcher" :
        spawnOpts.system.includes("SENTINEL") ? "security" :
        spawnOpts.system.includes("TUNER") ? "performance" :
        spawnOpts.system.includes("ADVOCATE") ? "dx" :
        spawnOpts.system.includes("VERIFIER") ? "qa" :
        spawnOpts.system.includes("DOMAIN EXPERT") ? "domain" :
        "synthesizer";
      const text = opts.perRole?.[role] ?? "[no reply for " + role + "]";
      opts.callLog?.push(role);
      return { text, usage: { inputTokens: 7, outputTokens: 3 } };
    },
  };
}

test("council: builtins are all present", () => {
  for (const r of [
    "skeptic",
    "builder",
    "researcher",
    "security",
    "performance",
    "dx",
    "qa",
    "domain",
    "synthesizer",
  ] as CouncilorRole[]) {
    assert.ok(BUILTIN_COUNCILORS[r], "missing built-in: " + r);
    assert.ok(BUILTIN_COUNCILORS[r].systemPrompt.length > 50, r + " system prompt is suspiciously short");
  }
  assert.deepEqual(DEFAULT_COUNCIL_ROSTER, ["skeptic", "builder", "researcher"]);
});

test("council: 9 deliberation voices (was 4), each with name + system prompt + weight", () => {
  const voices = Object.values(BUILTIN_COUNCILORS);
  assert.equal(voices.length, 9, "council must ship 9 built-in voices");

  const expectedRoles: CouncilorRole[] = [
    "skeptic",
    "builder",
    "researcher",
    "security",
    "performance",
    "dx",
    "qa",
    "domain",
    "synthesizer",
  ];
  assert.deepEqual(
    Object.keys(BUILTIN_COUNCILORS).sort(),
    expectedRoles.slice().sort(),
    "council must expose the 9 expected roles",
  );

  for (const v of voices) {
    // Non-empty system prompt fragment (the test asks for >0; the
    // older test asked for >50 — we keep the lower bar here so
    // this is a pure presence check).
    assert.ok(typeof v.systemPrompt === "string", v.role + " system prompt must be a string");
    assert.ok(v.systemPrompt.length > 0, v.role + " system prompt is empty");
    // Display name is set for every built-in voice.
    assert.ok(typeof v.name === "string" && v.name.length > 0, v.role + " must have a non-empty display name");
    // Weight is a positive number; default 1.0.
    assert.ok(typeof v.weight === "number" && v.weight > 0, v.role + " must have a positive weight");
  }
});

test("council: new voices have unique perspectives (system prompts are distinct)", () => {
  const voices = Object.values(BUILTIN_COUNCILORS);
  const prompts = new Set(voices.map((v) => v.systemPrompt));
  assert.equal(prompts.size, voices.length, "every built-in voice must have a distinct system prompt");
});

test("council: full 8-voice deliberator roster + synthesizer runs in consensus mode", async () => {
  const log: string[] = [];
  const deps = makeStubDeps({ callLog: log });
  // All 8 deliberators (synthesizer is injected automatically).
  const deliberators: CouncilorRole[] = [
    "skeptic",
    "builder",
    "researcher",
    "security",
    "performance",
    "dx",
    "qa",
    "domain",
  ];
  const roster: Councilor[] = deliberators.map((r) => BUILTIN_COUNCILORS[r]);
  const result = await runCouncil("Expand to 9?", {
    mode: "consensus",
    councilors: roster,
    cwd: process.cwd(),
  }, deps);

  // 1 round × 8 deliberators + 1 synthesizer = 9 transcript entries.
  assert.equal(result.transcript.length, 9, "1 round × 8 councilors + 1 synthesizer = 9 entries");
  // All 8 deliberators + 1 synthesizer must appear in the call log.
  const sorted = [...log].sort();
  assert.deepEqual(
    sorted,
    [...deliberators, "synthesizer" as CouncilorRole].sort(),
    "every deliberator and the synthesizer must be called exactly once",
  );
  // Synthesizer runs last.
  assert.equal(result.transcript[result.transcript.length - 1]!.role, "synthesizer");
});

test("council: synthesizer system prompt includes the voice weights", async () => {
  let capturedSystem = "";
  const deps: CouncilDeps = {
    spawn: async (opts) => {
      if (opts.prompt.includes("Council transcript")) {
        capturedSystem = opts.system;
        return { text: "FINAL", usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { text: "ok", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const roster: Councilor[] = [
    BUILTIN_COUNCILORS.skeptic,
    BUILTIN_COUNCILORS.security, // weight 1.2 — non-default
  ];
  await runCouncil("Q", { mode: "consensus", councilors: roster, cwd: process.cwd() }, deps);
  assert.match(capturedSystem, /Voice weights:/);
  assert.match(capturedSystem, /skeptic=1/);
  assert.match(capturedSystem, /security=1\.2/);
});

test("council: consensus mode runs 1 round + synthesizer", async () => {
  const log: string[] = [];
  const deps = makeStubDeps({
    perRole: {
      skeptic: "What about X?",
      builder: "Build Y.",
      researcher: "Facts: ...",
    },
    synthesizer: "FINAL ANSWER",
    callLog: log,
  });
  const roster: Councilor[] = DEFAULT_COUNCIL_ROSTER.map((r) => BUILTIN_COUNCILORS[r]);
  const result = await runCouncil("Should we ship Phase 0?", {
    mode: "consensus",
    councilors: roster,
    cwd: process.cwd(),
  }, deps);

  assert.equal(result.mode, "consensus");
  assert.equal(result.transcript.length, 4, "1 round × 3 councilors + 1 synthesizer = 4 entries");
  assert.deepEqual(log.sort(), ["builder", "researcher", "skeptic", "synthesizer"].sort());
  assert.equal(result.final, "FINAL ANSWER");
  // The 3 councilors should have been in round 1, the synthesizer in round 1 too.
  assert.ok(result.transcript.every((t) => t.round === 1));
  assert.equal(result.usage.inputTokens, 10 + 7 * 3);
  assert.equal(result.usage.outputTokens, 5 + 3 * 3);
});

test("council: adversarial mode runs 2 rounds + synthesizer", async () => {
  const log: string[] = [];
  const deps = makeStubDeps({
    perRole: {
      skeptic: "Round skeptic",
      builder: "Round builder",
      researcher: "Round researcher",
    },
    synthesizer: "ADVERSARIAL FINAL",
    callLog: log,
  });
  const roster: Councilor[] = DEFAULT_COUNCIL_ROSTER.map((r) => BUILTIN_COUNCILORS[r]);
  const result = await runCouncil("Trade-offs?", {
    mode: "adversarial",
    councilors: roster,
    cwd: process.cwd(),
  }, deps);

  assert.equal(result.mode, "adversarial");
  assert.equal(result.transcript.length, 7, "2 rounds × 3 councilors + 1 synthesizer = 7 entries");
  const rounds = result.transcript.map((t) => t.round);
  assert.deepEqual([...new Set(rounds)].sort(), [1, 2]);
  // Synthesizer runs at the max round.
  const synth = result.transcript.find((t) => t.role === "synthesizer")!;
  assert.equal(synth.round, 2);
  // Round 2 councilors should have received round-1 transcript in their prompt.
  // We can't see the prompt here, but the stub always fires, so we just
  // confirm the count is right.
  const round1Count = result.transcript.filter((t) => t.round === 1 && t.role !== "synthesizer").length;
  const round2Count = result.transcript.filter((t) => t.round === 2 && t.role !== "synthesizer").length;
  assert.equal(round1Count, 3);
  assert.equal(round2Count, 3);
});

test("council: round-2 prompt includes round-1 transcript", async () => {
  let round2Prompt = "";
  const deps: CouncilDeps = {
    spawn: async (opts) => {
      if (opts.prompt.includes("Council transcript")) {
        return { text: "SYNTH", usage: { inputTokens: 0, outputTokens: 0 } };
      }
      // The 4th call is round 2; capture its prompt.
      if (opts.prompt.includes("Other councilors have already spoken")) {
        round2Prompt = opts.prompt;
      }
      return { text: "ok", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const roster: Councilor[] = DEFAULT_COUNCIL_ROSTER.map((r) => BUILTIN_COUNCILORS[r]);
  await runCouncil("Q?", { mode: "adversarial", councilors: roster, cwd: process.cwd() }, deps);
  assert.ok(round2Prompt.length > 0, "round-2 prompt should include prior transcript");
  assert.match(round2Prompt, /Other councilors have already spoken/);
});

test("council: rejects empty question", async () => {
  const deps = makeStubDeps({});
  await assert.rejects(
    () => runCouncil("", { mode: "consensus", councilors: [BUILTIN_COUNCILORS.skeptic], cwd: process.cwd() }, deps),
    /input question is required/,
  );
  await assert.rejects(
    () => runCouncil("   ", { mode: "consensus", councilors: [BUILTIN_COUNCILORS.skeptic], cwd: process.cwd() }, deps),
    /input question is required/,
  );
});

test("council: rejects empty roster", async () => {
  const deps = makeStubDeps({});
  await assert.rejects(
    () => runCouncil("Q", { mode: "consensus", councilors: [], cwd: process.cwd() }, deps),
    /at least one councilor/,
  );
});

test("council: rejects roster of only synthesizers", async () => {
  const deps = makeStubDeps({});
  await assert.rejects(
    () => runCouncil("Q", { mode: "consensus", councilors: [BUILTIN_COUNCILORS.synthesizer], cwd: process.cwd() }, deps),
    /non-synthesizer/,
  );
});

test("council: renderCouncilResult includes header + final", () => {
  const r = {
    final: "ANSWER",
    transcript: [
      { round: 1, role: "skeptic" as CouncilorRole, content: "S", usage: { inputTokens: 1, outputTokens: 1 } },
      { round: 1, role: "synthesizer" as CouncilorRole, content: "SYNTH", usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    mode: "consensus" as const,
    usage: { inputTokens: 2, outputTokens: 2 },
    durationMs: 12,
  };
  const text = renderCouncilResult(r);
  assert.match(text, /\[council: consensus/);
  assert.match(text, /skeptic \(round 1\)/);
  assert.match(text, /synthesizer \(round 1\)/);
  assert.match(text, /final answer/);
  assert.match(text, /ANSWER/);
});

test("council: synthesizer is always the last entry", async () => {
  const deps = makeStubDeps({});
  const roster: Councilor[] = DEFAULT_COUNCIL_ROSTER.map((r) => BUILTIN_COUNCILORS[r]);
  const r = await runCouncil("Q", { mode: "consensus", councilors: roster, cwd: process.cwd() }, deps);
  const last = r.transcript[r.transcript.length - 1]!;
  assert.equal(last.role, "synthesizer");
});
