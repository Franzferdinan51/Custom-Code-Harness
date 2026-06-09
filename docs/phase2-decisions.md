# Phase 2 Decisions — Q1–Q10 Ratification

**Source:** `plans/plan_phase1/notes/agnt-port-plan.md` §6.2 (Open questions for the orchestrator)
**Ratified by:** Developer @ CodingHarness
**Date:** 2026-06-09
**Status:** Ready for Phase 2 kickoff

This document ratifies the 10 open questions raised in the Phase 1 spike plan.
Each entry pairs the question (paraphrased) with the recommended decision, a
one-sentence rationale, and an explicit status. The companion
[`phase2.md`](./phase2.md) file lays out the bounded tracks that turn the
DEFERRED and (remaining) ACCEPTED items into shipped behavior.

Status legend: **ACCEPTED** = locked in, ship as stated; **DEFERRED** = agreed
to land in Phase 2 (see `phase2.md` track); **REJECTED** = declined with a
replacement decision noted.

---

## Q1 — Council transcript output format

**Question:** When `ch council` is rewired to be a goal, do we keep the existing
`renderCouncilResult` format for `ch council --json` verbatim, or do we add
`loopStatus` and `evaluations[]` to the CLI output?

**Decision:** Keep `ch council --json` output verbatim; only enrich the goal
store view (`ch goals show <id>`) with the new fields.

**Rationale:** Backward-compat for users scripting the JSON output matters
more than API completeness; the goal store view is the right place to expose
the new shape.

**Status:** ACCEPTED *(already shipped in `phase1/unify`; `councilAsGoalLoop()`
preserves the rich transcript path — see `src/agent/council.ts` and
`src/__tests__/loops.test.ts` — and `ch council` JSON output is unchanged.)*

---

## Q2 — Multi-mission support in a single process

**Question:** Phase 1 treats one process as one mission. Do we need multiple
concurrent missions in Phase 1, or is a `--mission <id>` switch enough?

**Decision:** No — one process = one mission. `--mission <id>` switches between
them.

**Rationale:** Missions are long-lived; users don't need two parallel ones in
a single terminal. Switching keeps the in-memory state and `GoalStore`
namespace simple.

**Status:** ACCEPTED *(already shipped as `MissionLoop` in
`src/agent/loops/mission.ts`; `ch loop` registers the factory and the CLI
adopts the canonical `missionLoop().run()` path.)*

---

## Q3 — REPL renderer choice

**Question:** Should the new REPL be (a) ANSI + readline (~600 LOC, zero new
deps), (b) `ink`-style React (`@anthropic-ai/claude-code`-flavoured, ~3 MB
dep), or (c) a hand-rolled TS virtual DOM (~1200 LOC, no new deps)?

**Decision:** Ship (a) for Phase 1 — done. Defer the (b)/(c) decision to Phase 2
behind a 2-day spike that measures scrollback pain and bundle cost in
practice.

**Rationale:** Zero new deps is the right call while the REPL is young; we
should pay the bundle / complexity cost only after we know (b)/(c) actually
solves a measured problem.

**Status:** DEFERRED *(Phase 1 default (a) is already shipped as
`src/ui/repl-v2.ts` (725 LOC, hand-rolled ANSI message list + tool callouts,
no new deps). Phase 2 track **R2 — REPL renderer spike** evaluates (b) and
(c) once the user base has hit scrollback limits.)*

---

## Q4 — `/revert` granularity

**Question:** Should `/revert` undo the last step, revert to a specific
`currentIteration`, or revert a specific sub-task?

**Decision:** Revert to a specific `currentIteration` — `ch goals revert <id> --to <n>`.

**Rationale:** Iteration-level revert is the lowest-friction option that
covers the 95% case ("go back to before that last tool call") without
forcing users to name a sub-task by id.

**Status:** ACCEPTED *(already shipped in `src/agent/goals.ts` — the
`GoalStore.revert(goalId, toIteration)` API plus the v2 schema with
`worldState` snapshots; the Phase 1 risk #3 mitigation (256 KB cap + 5
snapshot ring) is in place. The CLI wire-up for `ch goal revert` is
documented in the loops CHANGELOG entry.)*

---

## Q5 — Approval modal in the new REPL

**Question:** Keep OpenTUI's `approval-modal.ts` (the new REPL imports it) or
hand-roll a centered box in the new ANSI renderer?

**Decision:** Hand-roll the modal in the ANSI renderer; keep
`approval-modal.ts` strictly for `ch tui --legacy`.

**Rationale:** The legacy TUI is `@opentui/core`-bound; the new REPL has its
own render path and should not pull in the OpenTUI modal. The split keeps
the OpenTUI surface tiny (5 imports across 3 files — see Phase 1
Appendix B).

**Status:** ACCEPTED *(split is already in place per Phase 1 §5.1:
`src/ui/tui.ts`, `tui-app.ts`, and `approval-modal.ts` are unchanged; the
new `repl-v2.ts` does not import `@opentui/core`. `approval-modal.ts` is
only reachable via `--legacy`.)*

---

## Q6 — Skills & extensions integration with goals

**Question:** Should `GoalDelegation` declare a `skillAllowlist` so the
planner only uses a known toolset?

**Decision:** Yes — `GoalDelegation.skills?: string[]` constrains the
planner and the spawned subagents to a known toolset.

**Rationale:** Without a skills allowlist, sub-goals inherit the full
`tools` registry and can accidentally call bash / network tools the parent
goal never intended. An explicit allowlist is one field on the existing
union — cheap to add and prevents footguns.

**Status:** DEFERRED *(the `Delegation` union is in `src/agent/delegation.ts`
with 8 kinds; the `GoalDelegation` schema does not yet carry a `skills`
field. Phase 2 track **D1 — Delegation: skills/permission scopes** lands
this.)*

---

## Q7 — Cost guardrails on goals

**Question:** Should `GoalDelegation` carry a `maxCostUsd` cap that aborts the
run when estimated cost exceeds the cap?

**Decision:** Yes — `maxCostUsd?: number` on `GoalDelegation`; reuse
`src/agent/cost.ts` (existing) for the per-call cost accumulator.

**Rationale:** The AGI loop is token-hungry; without a cap, a misconfigured
goal can burn $5 in a single overnight run. `cost.ts` is already a single
source of truth — plugging it into the goal-runner's `evaluating` step is
a 50-LOC change.

**Status:** ACCEPTED *(cost.ts exists and is wired into the agent loop;
Phase 2 track **D2 — Cost guardrail on `GoalDelegation`** lands the
`maxCostUsd` field and the abort hook. Small enough that it could be a
Phase 1 follow-up if a track is too thin.)*

---

## Q8 — Multi-user (`userId`) consideration

**Question:** agnt-gg is per-user; we're single-user. Do we need to think
about `userId` anywhere in the port?

**Decision:** No — leave the `userId` slot in mind but never populate it.

**Rationale:** All our paths are single-user; `$CH_HOME` is per-host. Adding
`userId` now would force every record to carry a redundant field with no
runtime difference.

**Status:** ACCEPTED *(no `userId` field anywhere in the v2 schema or the
`Delegation` union. If a multi-user mode is ever needed, the field is
additive — no migration pain.)*

---

## Q9 — Testing strategy for the AGI loop

**Question:** How do we test the plan → execute → evaluate → replan cycle
without a real LLM?

**Decision:** A stateful stub provider in `src/__tests__/goal-runner.test.ts`
(yielding a fixed plan on call 1, a fixed `complete` output on call 2, a
fixed `score < 70` evaluation on call 3) and assert `loopStatus =
'replanning'`. Mirrors the `agent-loop.test.ts` rule from `AGENTS.md`.

**Rationale:** A static stub loops forever; a stateful stub drives the
machine through the lifecycle and gives full coverage of every edge
(including the identical-replan × 3 → `stuck` branch).

**Status:** ACCEPTED *(already shipped in `src/__tests__/goals.test.ts` and
`src/__tests__/loops.test.ts` — both use the stateful-stub pattern, all
green. The pattern is also called out in the `developer` agent's
post-mortem memory entry: "Stateful stub pattern for state-machine
drivers".)*

---

## Q10 — `paths.goals` location (single file vs. directory)

**Question:** With snapshots, do we want a `$CH_HOME/goals/` directory or
keep the single `$CH_HOME/goals.json` file?

**Decision:** Yes — `$CH_HOME/goals/` directory, but in Phase 2. Phase 1
keeps the single `goals.json` and adds `$CH_HOME/goal-snapshots/` as a side
directory.

**Rationale:** A flat file scales poorly with snapshots; a directory lets
each goal be its own JSON file (with its `evaluations` and `worldState`
inline) and aligns with the future per-goal log/audit story.

**Status:** DEFERRED *(Phase 1 ships `$CH_HOME/goals.json` (v2 envelope) plus
`$CH_HOME/goal-snapshots/<goalId>/<iteration>.json` side-files. Phase 2
track **D3 — `goals/` directory split** migrates the single file to a
directory without breaking the v1→v2 read path.)*

---

## Summary table

| # | Question | Status | Resolved in |
|---|---|---|---|
| Q1 | Council transcript format | ACCEPTED | already shipped (phase1/unify) |
| Q2 | Multi-mission support | ACCEPTED | already shipped (MissionLoop) |
| Q3 | REPL renderer choice | DEFERRED | Phase 2 track R2 |
| Q4 | `/revert` granularity | ACCEPTED | already shipped (GoalStore.revert) |
| Q5 | Approval modal in new REPL | ACCEPTED | already shipped (split is in place) |
| Q6 | `skillAllowlist` on goals | DEFERRED | Phase 2 track D1 |
| Q7 | `maxCostUsd` on goals | ACCEPTED | Phase 2 track D2 (small enough) |
| Q8 | Multi-user `userId` | ACCEPTED | n/a (no work needed) |
| Q9 | AGI-loop test pattern | ACCEPTED | already shipped (stateful stubs) |
| Q10 | `goals/` directory split | DEFERRED | Phase 2 track D3 |

**Roll-up:** 7 ACCEPTED (5 already shipped, 2 small follow-ups), 3 DEFERRED
to Phase 2, 0 REJECTED. Phase 2 has 4 small/medium tracks and 2 large
deferrals (workflow tier real impl, InsightEngine/applicators) that warrant
their own plans.
