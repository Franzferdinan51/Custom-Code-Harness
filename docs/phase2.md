# Phase 2 Roadmap — agnt-gg Port Follow-ups

**Ratifies:** [`phase2-decisions.md`](./phase2-decisions.md) (Q1–Q10)
**Source plan:** `plans/plan_phase1/notes/agnt-port-plan.md` §6.3–§6.4
**Date:** 2026-06-09
**Status:** Ready for Phase 2 kickoff

Phase 1 (the agnt-gg port) shipped the goal lifecycle state machine, the
`Delegation` discriminated union, the unified `Loop<*>` hierarchy, and the
streaming REPL. Phase 2 picks up the small/medium items that the Phase 1
spike either deferred or couldn't fit in a single merge.

The tracks below are the bounded Phase 2 work the team owns. Two larger
items — the **workflow tier real implementation** and the **InsightEngine
/ golden-standards-from-history** port — are explicitly **out of scope**
for Phase 2; each needs its own dedicated plan (and a fresh source audit
that the Phase 1 spike noted was not done end-to-end). A third item — the
**REPL ink-renderer swap** — is also deferred, gated behind a 2-day spike
once scrollback pain is observed in practice.

Size legend: **S** ≤ 200 LOC, **M** 200–600 LOC, **L** 600+ LOC. All tracks
assume the Phase 1 baseline (`npm run typecheck` + `npm test` both green;
103+ tests across the 5 critical files).

---

## Phase 2 tracks (5 bounded)

### T1 — `/steer` queue + slash command

**Scope:** Implement the `SteerQueue` (mid-run user text injection between
tool rounds, mirroring agnt-gg's `OrchestratorService.js:40-85`) and wire
it into `src/agent/loop.ts` post-tool-result. Add the `/steer <text>` and
`/steer --clear` slash commands. Show the queued steer in the REPL
footer; `Esc` while busy stashes the steer (matches Codex). Resolves the
`/steer` UX landmine documented in the plan §6.1 risk #9.

**Target files:** NEW `src/agent/steer.ts`; modify `src/agent/loop.ts`
(add `steerQueue: SteerQueue` to `AgentRunInput`); modify
`src/slash/builtin.ts` (register `/steer` + `/steer --clear`); modify
`src/ui/repl-v2.ts` (render queued steer in footer); NEW
`src/__tests__/steer.test.ts`.

**Estimated size:** **M** (~300 LOC) — main file ~120 LOC, REPL footer
~50 LOC, tests ~120 LOC.

**Dependencies on other tracks:** none.

**Resolves:** Plan §6.1 risk #9 (`/steer` UX landmine); the `SteerQueue`
reference in the Phase 1 delegation `Deps` interface.

---

### T2 — `mcp` / `api` / `plugin` delegation real implementations

**Scope:** Replace the Phase 2 stubs in the `Delegation` discriminated
union (`src/agent/delegation.ts`) with real dispatchers. `mcp`: load
`MCPService` from `mcp-cli.ts` (already wired via the `mcp` MCP server),
invoke a tool by name with a JSON-arg map. `api`: raw HTTP call
(`fetch` against a URL with method/headers/body, returning the parsed
JSON). `plugin`: load a `.agnt` package (matches the `PluginManager`
contract from the Phase 1 spike). Update the union types from
`never`-typed stubs to real interfaces. Add tests for each kind.

**Target files:** modify `src/agent/delegation.ts` (replace stubs with
real shapes); NEW `src/agent/delegations/mcp.ts`,
`src/agent/delegations/api.ts`, `src/agent/delegations/plugin.ts`;
modify `src/runtime.ts` (wire the new kinds into
`DelegationManager.submit`); extend
`src/__tests__/delegation.test.ts` (real-implementation tests).

**Estimated size:** **M** (~500 LOC across the 4 files + tests).

**Dependencies on other tracks:** none (mcp-cli, fetch, and the
`PluginManager` pattern from the plan are all available).

**Resolves:** The 3 Phase 2 stub kinds still typed as `never` in the
`Delegation` union; expands the union's usable surface from 4 kinds
(`agent` / `goal` / `async_tool` / `human_approval`) to 7.

---

### T3 — Goal-runner hardening: semantic replan guard + `maxCostUsd` cap

**Scope:** Two evaluator-hook changes bundled into one track because they
share a code path (the goal-runner's "did this iteration pass?" gate).
(1) Replace the surface-text identical-replan guard with a semantic
similarity check (lowercase + whitespace + sorted tokens; for richer
semantic equivalence, an embedding cosine via the configured provider).
(2) Add `maxCostUsd?: number` to `GoalDelegation`; abort when the
running cost accumulator (from `src/agent/cost.ts`) exceeds the cap.

**Target files:** modify `src/agent/goal-runner.ts` (add the two checks
in the `evaluating` step); modify `src/agent/delegation.ts` (add
`maxCostUsd?` to `GoalDelegation`); NEW
`src/agent/semantic-similarity.ts` (the token-sort similarity helper);
modify `src/__tests__/goals.test.ts` + `src/__tests__/delegation.test.ts`.

**Estimated size:** **S** (~200 LOC) — semantic helper ~60 LOC,
runner integration ~60 LOC, delegation field + abort hook ~30 LOC,
tests ~80 LOC.

**Dependencies on other tracks:** none.

**Resolves:** Plan §6.1 risk #4 (semantic replan guard — the surface-text
check is the Phase 1 mitigation; this is the Phase 2 follow-up);
**Q7** (cost guardrail) — small enough to fold into this track.

---

### T4 — `goals/` directory split + web UI panels

**Scope:** (1) Migrate `$CH_HOME/goals.json` (v2 envelope) to a
`$CH_HOME/goals/<id>.json` per-goal file layout. Keep the read-side
backward compat: v1 single-file records still load (write a
`.v1-backup.json` on first read, exactly like the v1→v2 upgrade path).
(2) Add a `goalList` panel to the web UI (`src/web/index.html` +
`src/web/app.js`) showing active / paused / done goals with their
`loopStatus` + `currentIteration`. Add a `delegations` panel showing
in-flight `DelegationRun` handles from `DelegationManager.list()`. (3)
Add a CLI bridge: `ch web` polls `GET /goals` and `GET /delegations`
(server already has `GET /sessions` etc.).

**Target files:** modify `src/agent/goals.ts` (read-side: per-file
layout; write-side: per-file writes); modify `src/cli.ts` (add
`ch goals migrate` to do the one-shot split); modify
`src/server.ts` (new `/goals` and `/delegations` GET routes); modify
`src/web/index.html` + `src/web/app.js` (panel DOM + polling handler);
NEW `src/__tests__/goals-dir.test.ts` + `src/__tests__/info-endpoints.test.ts`
extensions.

**Estimated size:** **M** (~500 LOC) — store migration ~150 LOC, server
routes ~80 LOC, web UI panel ~200 LOC, tests ~100 LOC.

**Dependencies on other tracks:** none.

**Resolves:** **Q10** (`paths.goals` location); the "web UI panels"
small item from the Phase 1 plan §6.3; the `goalList` and
`delegations` panels the Phase 1 spike flagged as a Phase 2 add.

---

### T5 — Council 9 voices (full deliberation roster)

**Scope:** Add 5 more built-in councilor roles to bring the default
roster from 4 (skeptic / builder / researcher / synthesizer) to 9
(adding: planner, critic, empath, contrarian, pragmatist). Each is a
short system-prompt block in `src/agent/council.ts`'s
`BUILT_IN_COUNCILORS` constant. Extend the `Councilor` type with a
`voice: string` discriminator (a stable id like `"skeptic"`,
`"builder"`, …) so the CLI can target a single voice via
`ch council --voice skeptic`. Update the default `consensus` mode
roster to 7 non-synthesizer voices + 1 synthesizer = 8 rounds + the
synthesizer = the full 9-voice deliberation.

**Target files:** modify `src/agent/council.ts` (5 new `Councilor`
entries + the `voice` field on the type); modify `src/cli.ts`
(`ch council --voice`); extend `src/__tests__/council.test.ts` (roster
count, voice filter, default vs explicit roster).

**Estimated size:** **S** (~180 LOC) — system prompts ~80 LOC, type
extension + CLI flag ~40 LOC, tests ~60 LOC.

**Dependencies on other tracks:** none.

**Resolves:** The "council 9 voices" smaller item from the Phase 1
plan; the `Agent-Teams` (46 voices, 9 modes) reference mentioned in
the council file's header comment.

---

## Tracks explicitly deferred (out of scope for Phase 2)

### D-WORKFLOW — Workflow tier real implementation

The `WorkflowManipulationService.js` port from agnt-gg is a Tier 4
(Workflow) real driver. The Phase 1 spike noted the source was not
read end-to-end (only routes were grepped); a Phase 2 dedicated plan
needs to do that audit first, then port the multi-step workflow DSL.
**Estimated size:** **L** (1500+ LOC). **Why deferred:** too large to
fit alongside T1–T5; deserves its own 2-3 week plan with a fresh
source-file audit.

### D-INSIGHT — `InsightEngine` + `evolution/applicators`

The "golden-standards-from-history" pattern (instead of the Phase 1
"golden-standards-from-LLM" pattern). The Phase 1 spike noted these
files were not audited. A dedicated plan needs to read
`agnt-gg/backend/src/services/evolution/InsightEngine.js` and the
`evolution/applicators/` directory, decide which patterns are
applicable to CodingHarness (we don't have a multi-user history of
runs to learn from), and design the meta-agent loop.
**Estimated size:** **L** (1500+ LOC). **Why deferred:** depends on
having enough historical data to learn from — premature without Phase
1 + Phase 2 user adoption.

### D-INK — REPL ink-renderer swap

Q3 deferred: once the user base reports scrollback pain in
`src/ui/repl-v2.ts`, run a 2-day spike evaluating (b) `ink` (React
renderer, ~3 MB dep) and (c) a hand-rolled TS virtual DOM (~1200 LOC,
no new deps) against the current (a) ANSI + readline implementation.
**Estimated size:** **L** if (b) is chosen, **M** if (c) is chosen.
**Why deferred:** zero measured user pain today; the cost is not
worth paying speculatively.

---

## Track order and dependencies

```
T1 ──> (none)              # independent
T2 ──> (none)              # independent
T3 ──> (none)              # independent
T4 ──> (none)              # independent
T5 ──> (none)              # independent
```

All five tracks are **independent** — none has a `depends_on` on
another. The natural order, if parallelizing is limited:

1. **T3 first** (small, ships the cost cap which is the highest-value
   hardening for the AGI loop) — ~1 day.
2. **T1 next** (small, makes `/steer` real — referenced in the
   existing `DelegationDeps` interface) — ~2 days.
3. **T5 in parallel with T1** (small, just system prompts) — ~1 day.
4. **T2** (medium, three real delegation impls) — ~3 days.
5. **T4 last** (medium, has the longest tail with the web UI work) — ~3 days.

Wall-clock budget: **~2 weeks** with two developers working in
parallel (T1+T5 in parallel; T2 in parallel with T4). With a single
developer, **~10 days** end-to-end.

---

## What lands in the repo when Phase 2 ships

- Five new modules / three extended modules across `src/agent/`,
  `src/web/`, `src/slash/`, and `src/server.ts`.
- One CLI subcommand (`ch goals migrate`).
- One new CLI flag (`ch council --voice`).
- One new slash command (`/steer`).
- ~25–30 new tests (bringing the total from 103+ to ~135).
- `CHANGELOG.md` "Unreleased — Phase 2" section summarising the
  five tracks.
- `AGENTS.md` updated with the new files in the project layout
  block.
- One open question (`Q6` — `skillAllowlist` on `GoalDelegation`).
  If the team wants it, fold it into **T2** as a small extension.

---

## What Phase 2 explicitly does **not** ship

- No workflow tier real driver (D-WORKFLOW — needs its own plan).
- No `InsightEngine` / `evolution/applicators` port (D-INSIGHT —
  needs its own plan + user adoption data).
- No `ink` swap (D-INK — gated behind a 2-day spike).
- No `skillAllowlist` on `GoalDelegation` (Q6 — could fold into T2
  if T2 is thin; otherwise a Phase 3 small track).
- No multi-user `userId` field (Q8 — single-user is locked in).
