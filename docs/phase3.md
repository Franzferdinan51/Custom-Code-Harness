# Phase 3 Roadmap — Goal Delegation Real Path + Vector Memory + Workflow Source Audit

**Ratifies:** [`phase2-decisions.md`](./phase2-decisions.md) (Q1–Q10) and [`phase2.md`](./phase2.md) (T1–T5)
**Source plan:** `plans/plan_phase1/notes/agnt-port-plan.md` §6.3
**Date:** 2026-06-09
**Status:** SHIPPED 2026-06-10 (all 5 production tracks + closeout on `main`) + 2 followup drops on 2026-06-11 / 2026-06-12

## Post-closeout drops

Five followup commits landed on `main` after the Phase 3 closeout.
None was a Phase 3 track — all are stability / correctness fixes
that surfaced in the days after the closeout as the system got
exercised in new environments. All are fully documented in
[`CHANGELOG.md` Unreleased](../../CHANGELOG.md) (they are the first
five entries there), so this section is the short index, not a
duplicate.

- **`e721c55` — `fix(delegation): honor actual goal store state on
  post-state-machine abort`** (2026-06-11). `runGoalKind` was
  short-circuiting to `status: "failed", iterations: 0` on any
  post-state-machine abort, even when the goal had reached a
  terminal state (`done` / `failed` / `paused`) on the store.
  Fix reads the live state off the goal store, so a goal that
  finished cleanly and then got a late Ctrl-C is now reported as
  `status: "done", iterations: N, cancelled: true`. Two new
  regression tests cover both the "done then cancel" and "runner
  throws mid-execute" paths. `src/agent/delegation.ts`,
  `src/__tests__/delegation.test.ts`. Suite 588 pass / 0 fail.

- **`b8d01ca` — `feat(server): wire bash-tool approval over
  HTTP/SSE` + `fix(memory): stable 4th-layer sort`**
  (2026-06-12). Two changes landed together because they both
  crossed the 588 → 592 threshold on the same session and the
  approval-bridge work surfaced a memory-layer flake during
  verification. The first closes the gap where the web UI's
  approval modal was wired up but the server never produced the
  `approval_required` SSE event the modal was waiting on. The
  second is the vector-memory stability fix called out in
  CHANGELOG (RRF sort + drop the `s > 0` vec filter) — it
  closed a 1-in-10 flake in the "doc with more matches ranks
  first" test. Suite 592 pass / 0 fail, stable across 10
  consecutive runs.

- **`458f5f6` — `fix(server): reject readJson on
  client-disconnect-mid-body + once-listeners`** (2026-06-13).
  Latent resource bug: when a client disconnected mid-body
  (TCP RST before end-of-body), the `end` and `error` events
  fired inconsistently across OS / Node versions, the
  `close` handler had no reject path, and the Promise could
  hang forever pinning the HTTP connection. Fix: settled
  flag + close handler that rejects with `AbortError` (or
  `BodyTooLargeError` if the oversize flag was set on the
  way down). Also: `abortOnDisconnect` used to register
  persistent `req.on('close', …)` / `req.on('aborted', …)`
  listeners per request — replaced with `once` to release
  the closure on the first event so long-lived SSE streams
  don't keep a stale AbortController alive. 2 new tests
  pin both contracts. Suite 593 pass / 0 fail.

- **`a2d7a6b` — `feat(http): configurable timeout_ms + GET/DELETE
  no-body guard; fix(council): throw on multiple synthesizers`**
  (2026-06-14). The http tool's timeout was hard-coded to 30s
  with no override. Tool now accepts `timeout_ms` (default
  30000, max 300000 = 5 min), parallel to the bash tool's
  `timeout_ms` and the delegation API's `timeoutSeconds`.
  Also dropped a long-standing bug where `fetch(…, { body:
  '…' })` for GET / DELETE / HEAD requests sent the body
  anyway — matches `DelegationManager.runApiKind`'s
  body-suppression behavior. Council: `runCouncil` used
  `find(...)` to pick the synthesizer and silently dropped
  any extras — the new check throws with a clear error
  message ("at most one synthesizer is allowed in the
  roster; got N"). 5 new tests. Suite 602 pass / 0 fail.

- **`1546c40` — `fix(cost): formatUSD zero + negative + drop
  dead records_()`** (2026-06-15). `formatUSD` had two
  cosmetic-but-recurring issues: zero hit the `< 0.01` branch
  and emitted "$0.0000" (visible on every cold start before
  the first model call), and negative values rendered as
  "$-0.5000" reading as a credit instead of a charge. Two
  new tests pin both contracts; the web app's duplicate
  `formatUSD` updated in lockstep. Also dropped the dead
  `CostTracker.records_()` accessor (defined, never called,
  leftover from an early sketch). Suite 604 pass / 0 fail,
  stable across 5 consecutive runs.

`docs/phase3.md` itself was NOT revised in those five commits —
the `final gate` line below reflects the closeout moment
(586 tests). The current on-`main` test count is **604**; the
`final gate` line is the closeout-snapshot number, not the
post-closeout number.

## Shipped

- **T1 — Goal delegation: wire the goal kind for real** —
  landed 2026-06-09 (commit `b24f94e`,
  `merge: feat/web-panels into main` ancestor). The `goal`
  kind in the 8-kind `Delegation` union is no longer a
  dispatcher stub; it drives the real state machine.
- **T2 — Vector memory layer (4th layer) with RRF fusion** —
  landed 2026-06-10 (merge `0d7c8f8`, feature commit `d34f6fb`).
  New `src/agent/memory-vector.ts`; `MemoryLayerStore.search()`
  fuses BM25 + brute-force cosine via reciprocal-rank fusion.
- **T3 — D-WORKFLOW source audit (research only)** —
  landed 2026-06-10 (merge `50d3eb0`, feature commit `b041c28`).
  `docs/agnt-workflow-audit.md` ships the ≈ 4,000-LOC audit +
  sized L-port spec; D-WORKFLOW-IMPL stays out of scope and
  lands in a follow-up plan.
- **T3-endpoint-security — `ch serve` hardening** —
  landed 2026-06-10 (feature commit `0fb358b`). Bearer auth
  via `CH_HTTP_TOKEN`, 1 MB body cap via
  `CH_HTTP_MAX_BODY_BYTES`, disconnect-abort propagation on
  `/v1/chat` + `/v1/chat/stream` + `/v1/spawn`, and a public
  `GET /v1/health` liveness probe.
- **T3-endpoint-expansion — discoverable HTTP API** —
  landed 2026-06-10 (merge `5a2e77f`, feature commit `ca7ffc2`).
  10 new endpoints built off the security pass: `GET /v1/`
  discovery index from a single ROUTES source-of-truth,
  `POST /v1/delegations` with discriminated-union validation,
  drill-downs (delegations / agents / skills / sessions /
  messages / loops), `DELETE /v1/chat/stream/:id` for stream
  cancellation, and a consistent `{ error: string }` shape
  across all JSON endpoints.
- **T5 — Goal followups (Q6 skills allowlist + Q7 maxCostUsd
  cap)** — landed 2026-06-10 (merge `86f50ae`, feature commit
  `775766b`). The `goal` kind forwards the `skills` allowlist
  end-to-end and enforces a cumulative `maxCostUsd` cap on
  the state machine.

Final gate: `npm run typecheck` clean, `bun test`
**586 / 586 / 0 fail** across **42 files** (was 518 in the
Phase 3 kickoff baseline; +68 net new tests across T1, T2,
T3-security, T3-expansion, T5, and adjacent Phase 2 closes).

---

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
