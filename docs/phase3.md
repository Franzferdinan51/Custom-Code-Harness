# Phase 3 Roadmap — Goal Delegation Real Path + Vector Memory + Workflow Source Audit

**Ratifies:** [`phase2-decisions.md`](./phase2-decisions.md) (Q1–Q10) and [`phase2.md`](./phase2.md) (T1–T5)
**Source plan:** `plans/plan_phase1/notes/agnt-port-plan.md` §6.3
**Date:** 2026-06-09
**Status:** Ready for Phase 3 kickoff

Phase 2 (the agnt-gg port follow-ups) shipped the 8-kind `Delegation` union
with real implementations for `mcp` / `api` / `plugin` / `async_tool` /
`human_approval` / `agent` / `workflow`-stub, the multi-mission + per-file
goal store, the council 9-voice roster, the OpenTUI optional dep, and the
web UI panels for goals + delegations. Phase 3 picks up the gaps the
Phase 1+2 spike explicitly deferred, plus one small follow-up that landed
partially in Phase 2.

The tracks below are the bounded Phase 3 work. The deferred items
(D-WORKFLOW, D-INSIGHT, D-INK) from Phase 2 remain deferred — D-WORKFLOW
gets a **research track** this phase that does the source audit the
Phase 1 spike flagged as not done, but the implementation port stays out
of scope and lands in a follow-up plan.

Size legend: **S** ≤ 200 LOC, **M** 200–600 LOC, **L** 600+ LOC. All tracks
assume the Phase 2 baseline (`npm run typecheck` + `npm test` both green;
518+ tests across 12+ files).

---

## Phase 3 tracks (3 bounded + 1 research)

### T1 — Goal delegation: wire the goal kind for real

**Scope:** Today the `goal` kind in the `Delegation` union is a
**dispatcher stub**. `runGoalKind` (`src/agent/delegation.ts:852`) creates
a goal record, installs a `runAgent` closure that throws, and exits with
the goal still in the initial state. The Phase 1 port explicitly
documented this: "the real 'run a goal through the manager' path lands
in a follow-up that wires `runtime.runAgent` here." This track closes
that gap.

1. Add a required `runGoalAgent: GoalRunAgentFn` slot to
   `DelegationRuntimeDeps`. The signature mirrors the existing
   `GoalRunAgentFn` from `src/agent/goals.ts:731` — takes `(phase,
   context)` and returns `{ content, steps }`. When the dep is absent,
   `runGoalKind` returns a clear "no goal runner wired" error rather
   than a generic throw.
2. In `runGoalKind`, replace the throwing stub with `this.deps.runGoalAgent`.
   The state machine is then driven for real — the goal's
   `loopStatus` reaches `done` / `re-planning` / `failed` based on the
   model's outputs.
3. Add a `runGoalAgent()` builder on `HarnessRuntime`
   (`src/runtime.ts`) that constructs the closure the CLI's `ch goal`
   already uses (`src/cli.ts:665` `callAgent`). The closure wraps the
   lower-level `runAgent` from `src/agent/loop.ts` with a fresh
   `messages` array per phase, the runtime's `buildSystemPrompt()`, the
   runtime's `tools`, and the per-call `signal` (forwarded from the
   delegation manager).
4. Wire it in the runtime constructor — `new DelegationManager({ ...,
   runGoalAgent: this.buildRunGoalAgent() })`.
5. Update the existing `delegation.test.ts` `makeDeps()` helper to
   inject a stateful stub `runGoalAgent`. The existing 2 goal-kind
   tests (`src/__tests__/delegation.test.ts:209`, `:631`) currently
   assert the stub-throw behavior — they get reworked to assert the
   real-runner behavior (state machine transitions, `loopStatus`).
6. Add a new test that drives a **full lifecycle** through the goal
   kind: planning → executing → evaluator says "complete" → final
   state is `done`. Use a stateful stub provider pattern (per the
   `AGENTS.md` rule on stateful stubs for state-machine drivers).

**Target files:** modify `src/agent/delegation.ts` (add dep slot,
update `runGoalKind`); modify `src/runtime.ts` (build closure, wire
in constructor); modify `src/__tests__/delegation.test.ts` (rework
existing goal tests); NEW test in `src/__tests__/delegation.test.ts`
(full-lifecycle). Optionally modify `src/__tests__/delegation-stubs.test.ts`
to drop its goal-kind stub assertion (the stub is gone).

**Estimated size:** **M** (~300 LOC) — interface + closure ~80 LOC,
manager update ~30 LOC, test rework + new lifecycle test ~190 LOC.

**Dependencies on other tracks:** none.

**Resolves:** The Phase 1 plan §6.1 risk #10 follow-up
("dispatcher stub" → "real goal path"); unblocks Q6 (skills allowlist
on goal); enables the `maxCostUsd` cap to actually fire on goal
delegations end-to-end.

---

### T2 — Vector memory layer (4th layer)

**Scope:** The 3-layer memory store
(`src/agent/memory-layers.ts`) ships RAW NOTES (line-numbered) +
BM25 INDEX + LESSONS. The header explicitly notes a 4th layer
behind the same `MemoryStore` interface — an ANN index keyed by the
existing `Bm25Hit.docId`s, ranked on cosine similarity, then fused
with BM25 via reciprocal-rank fusion (RRF). The file layout and APIs
are designed to accept a 4th layer without refactor.

1. New `src/agent/memory-vector.ts` — the ANN index module. v1
   uses a **brute-force cosine** scan over the on-disk corpus
   (the corpus is small — tens of MB at most — and the v1 surface
   doesn't need real ANN). Embeddings come from the configured
   provider's embedding endpoint when available (OpenAI
   `text-embedding-3-small`, Anthropic doesn't ship embeddings
   directly so we fall back to a provider that does, or to a
   pure-TS local model like `@xenova/transformers` if no provider
   exposes embeddings). v1 uses the **configured chat provider's
   embedding endpoint when it has one**, otherwise falls back to
   a stable hash-based pseudo-embedding (so the code path is
   always runnable in tests and minimal installs).
2. Wire the 4th layer into `MemoryLayerStore.search()` — after
   BM25 returns `k` hits, also return the top-`k` vector hits,
   then fuse via RRF (`1 / (k0 + rank_i)` summed across the two
   lists, sorted descending).
3. Cache the embeddings on disk (alongside MEMORY.md) as
   `MEMORY.embeddings.json` — keyed by the line number, so
   re-indexing only re-embeds new lines.
4. Tests: brute-force cosine is easy to assert; RRF is a
   deterministic function; the integration test asserts the
   recall is no worse than BM25 alone on a known corpus (the
   existing `bm25.test.ts` corpus is the natural baseline).

**Target files:** NEW `src/agent/memory-vector.ts`; modify
`src/agent/memory-layers.ts` (add 4th-layer hook + RRF fusion);
modify `src/config/paths.ts` (add `memoryEmbeddingsFile` helper);
NEW `src/__tests__/memory-vector.test.ts`; extend
`src/__tests__/memory-layers.test.ts` (RRF fusion test).

**Estimated size:** **M** (~400 LOC) — vector module ~200 LOC,
RRF + cache ~80 LOC, tests ~120 LOC.

**Dependencies on other tracks:** none (the TODO was Phase 1).

**Resolves:** The `TODO(phase-1)` in
`src/agent/memory-layers.ts:28`; the D-INSIGHT deferral's
"need recall quality" precondition (this is a recall-quality
pre-step, not the full InsightEngine port).

---

### T3 — D-WORKFLOW source audit + port plan (research)

**Scope:** The Phase 1 plan §6.3 explicitly noted
"**I did not read `agnt-gg/backend/src/services/WorkflowManipulationService.js`
end-to-end — only grepped the routes. The 'workflow' tier is a Phase 2
stub; if we want to ship a real workflow port in Phase 1, this file is
the primary source.**" Phase 3 closes that gap with a research track
that **audits the source** but **does not implement the port** —
the implementation lands in a follow-up plan, sized correctly based
on the audit's findings.

1. **Source audit** (the only deliverable that ships this track):
   `docs/agnt-workflow-audit.md` — read
   `agnt-gg/backend/src/services/WorkflowManipulationService.js` +
   the related `WorkflowService.js` + `chatConfigs.js:workflow`
   entry end-to-end. Document:
   - The workflow DSL shape (YAML / JSON / in-code?).
   - The step types and their contract.
   - How the manager loads, validates, and executes a workflow.
   - How workflows interact with the existing `Delegation` union
     (`Delegation { kind: "workflow" }` is the natural boundary).
   - The "manipulation" surface (CRUD on workflow records, like
     `chatConfigs.js`'s `workflow` field) — what does the
     agnt-gg UI do, and how does it map to our CLI?
   - Open questions that need a follow-up spike.
2. **Port plan**: end of the audit, a sized spec for the port
   (L? M?), with file-by-file breakdown. The port is **not** in
   scope for this track.

**Target files:** NEW `docs/agnt-workflow-audit.md`.

DONE: see `docs/agnt-workflow-audit.md` (Phase 3 T3 research shipped; the
implementation port remains out of scope and lands as
`### D-WORKFLOW-IMPL — Workflow real port` in a Phase 3.5/4 follow-up).

**Estimated size:** **S** for the audit doc itself (~150 LOC of
markdown), but the **work** is reading 1-2k LOC of agnt-gg source
end-to-end and synthesizing. Realistic 1-2 days.

**Dependencies on other tracks:** none (research only).

**Resolves:** The Phase 1 spike's open research item
(`agnt-port-plan.md:620`); unblocks the D-WORKFLOW implementation
plan as a Phase 3.5 / Phase 4 follow-up.

---

## Tracks explicitly deferred (out of scope for Phase 3)

### D-INSIGHT — `InsightEngine` + `evolution/applicators`

The "golden-standards-from-history" pattern. The T2 vector layer is a
**precondition** for this (we need recall quality to learn from
history). After T2 ships and we have user adoption data, the
InsightEngine audit + port becomes a Phase 4 candidate.
**Estimated size:** **L** (1500+ LOC). **Why deferred:** T2 is the
recall-quality precondition; user adoption data is the
adoption precondition.

### D-INK — REPL ink-renderer swap

Q3 deferred: gated behind observed scrollback pain in
`src/ui/repl-v2.ts`. Phase 2 shipped 9 council voices (longer
transcripts) and the web UI panels (longer list views), which
both stress scrollback more than Phase 1 did. If the user base
reports scrollback pain during the Phase 3 cycle, run the 2-day
spike evaluating (b) `ink` and (c) hand-rolled TS VDOM.
**Estimated size:** **L** if (b), **M** if (c).
**Why deferred:** still speculative; no measured pain yet.

### D-WORKFLOW-IMPL — Workflow real port

The implementation of `WorkflowManipulationService.js` against
the `Delegation { kind: "workflow" }` kind. Sized and specified by
T3's audit. Not in scope for Phase 3 — the audit IS the Phase 3
deliverable.

---

## Track order and dependencies

```
T1 ──> (none)               # independent
T2 ──> (none)               # independent
T3 ──> (none)               # research only
```

All three tracks are **independent** — none has a `depends_on` on
another. The natural order, if parallelizing is limited:

1. **T1 first** (small-medium, closes the goal kind gap and
   unblocks Q6 + the `maxCostUsd` cap end-to-end) — ~2 days.
2. **T3 next** (research, ~1-2 days for the source audit). The
   audit is reading + writing; it doesn't block T1 or T2.
3. **T2 in parallel with T3** (medium, the 4th memory layer is
   the largest bounded track and benefits from T1 being done
   first if the goal kind's evaluator ever wants richer recall) — ~3 days.

Wall-clock budget: **~1.5 weeks** with one developer (T1 first,
then T2 + T3 in parallel).

---

## What lands in the repo when Phase 3 ships

- `runGoalAgent` adapter on `HarnessRuntime`; the goal kind in
  the `Delegation` union becomes a real dispatcher.
- A 4th memory layer (vector + RRF fusion) behind the existing
  `MemoryStore` interface.
- A source audit for `WorkflowManipulationService.js` + a
  sized port spec for the D-WORKFLOW-IMPL follow-up.
- ~10-15 new tests (bringing the total from 518+ to ~535).
- `CHANGELOG.md` "Unreleased — Phase 3" section summarising the
  three tracks.
- `AGENTS.md` updated with the new files in the project layout
  block.

---

## What Phase 3 explicitly does **not** ship

- No `WorkflowManipulationService.js` port (T3 audits, doesn't
  implement — D-WORKFLOW-IMPL is a follow-up).
- No `InsightEngine` / `evolution/applicators` port (D-INSIGHT —
  needs T2 + user adoption data, then becomes Phase 4).
- No `ink` swap (D-INK — gated on observed scrollback pain).
- No multi-user `userId` field (Q8 — locked in single-user).
- No new council voices beyond 9 (the 9-voice roster is the
  Phase 2 ceiling; "46 voices, 9 modes" reference is on hold).
