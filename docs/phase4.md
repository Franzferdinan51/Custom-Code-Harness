# Phase 4 Roadmap — Workflow Engine Real Port + Capability Expansion

**Ratifies:** [`phase3.md`](./phase3.md) "Tracks explicitly deferred" (D-WORKFLOW-IMPL, D-INSIGHT, D-INK) and the [D-WORKFLOW source audit](./agnt-workflow-audit.md)
**Source plan:** `plans/plan_phase1/notes/agnt-port-plan.md` §6.3–§6.4
**Date:** 2026-06-15
**Status:** T1 + T2 + T3 + T4 SHIPPED 2026-06-16/17. T5 (closeout) next.

Phase 3 closed out on 2026-06-10 with the 8-kind `Delegation` union's
`workflow` kind still as a stub, the D-WORKFLOW audit shipped as
research-only, and three "what's next" items queued:

- **D-WORKFLOW-IMPL** — the real `WorkflowManipulationService.js` port
  (L, ≈ 1500 LOC; fully sized in `agnt-workflow-audit.md` §8).
- **D-INK** — REPL ink-renderer swap, gated on observed scrollback
  pain (L if `ink`, M if hand-rolled TS VDOM).
- **D-INSIGHT** — `InsightEngine` + `evolution/applicators` port
  (L, 1500+ LOC), deferred behind user adoption data.

Phase 4 picks up the headline item (D-WORKFLOW-IMPL) and three capability
expansions that unlock the same user workflows the workflow tier is
designed for but that are currently half-built:

- **TS extension loader (pi-style)** — JSON-only manifests are a v2
  limitation called out in the README roadmap. Wiring up the TS hook
  system is sized M.
- **Real MCP client** — symmetric with the existing `ch mcp` *server*.
  Lets CodingHarness consume other MCP servers (Claude Code's, Cursor's,
  any third-party). Sized M+.
- **REPL scrollback pain spike (D-INK-pre)** — 2-day spike to measure
  actual scrollback pain in `repl-v2.ts` with the 9-voice council and
  the web UI panels, then pick (b) `ink` or (c) hand-rolled TS VDOM.
  Sized S (the spike) + L/M (the swap, separately tracked).

Phase 4 closes with a **version bump 0.2.2 → 0.3.0** that captures the
breadth of capability added since v0.2.2 (40+ HTTP routes, vector
memory, goal state machine, 9-voice council, web UI panels, MCP server,
D-WORKFLOW engine, TS extension loader, MCP client, REPL upgrade).

Size legend: **S** ≤ 200 LOC, **M** 200–600 LOC, **L** 600+ LOC. All tracks
assume the Phase 3 baseline (`npm run typecheck` + `npm test` both green;
604 pass / 0 fail across 44 files, 2026-06-15 snapshot).

---

## T1 Shipped (2026-06-15)

D-WORKFLOW-IMPL landed via four task branches merged in series with
`--no-ff` to keep the chain visible. The `workflow` kind in the
8-kind `Delegation` union is no longer a stub; it drives a real
in-process `WorkflowEngine` end-to-end. Per-track decisions live
in each branch's deliverable; the closeout index is below.

- **`feat(workflow): foundation — types, graph helpers, template+edge eval`**
  — commit `ed65376`, merge `da9c907` (T1 steps 1-2 of audit §8.4).
  3 NEW source files (`workflow-types.ts` 199 LOC, `workflow-graph.ts`
  273 LOC, `workflow-eval.ts` 373 LOC) + `toolLibrary.json` 62 LOC +
  2 NEW tests (33 + 19 = 52 tests).
- **`feat(workflow): executor + store + engine — steps 3-4 of audit §8.4`**
  — commit `46df149`, merge `0852a5c`. 3 NEW source files
  (`workflow-store.ts` 387 LOC, `workflow-steps.ts` 398 LOC,
  `workflow.ts` 503 LOC) + 2 NEW tests (30 tests) + 1 MODIFIED
  (`paths.ts` added workflows dir).
- **`feat(workflow): delegation + runtime + CLI + slash — steps 5-7 of audit §8.4`**
  — commit `0820460`, merge `d9b29d4`. 4 MODIFIED files
  (`delegation.ts` +276, `runtime.ts` +96, `cli.ts` +395,
  `slash/builtin.ts` +104) + 1 NEW test (`workflow-cli.test.ts` 6
  tests) + 1 MODIFIED test (`delegation.test.ts` stub→failed).
- **`test(workflow): E2E — load real agnt-gg workflow JSON, execute, assert output shape`**
  — commit `a6dfe0e`, merge `399c88c` (T1 step 8). 2 NEW files
  (`automated_email_summarizer.json` 198 LOC verbatim from agnt-gg,
  `workflow-e2e.test.ts` 434 LOC, 2 tests) + 1 MODIFIED
  (`workflow-steps.ts` +105 — generic `WorkflowToolRegistry` path
  template-resolves `node.parameters` before dispatch, mirroring
  agnt-gg `NodeExecutor.js:145`; v1 gap the E2E test surfaced).

**Final gate (T1 closeout moment, 2026-06-15):** `npm run typecheck`
clean, `npm test` **694 / 694 / 0 fail** across **50 files** stable
across 3 consecutive runs (was 604 in the Phase 3 baseline; +90 net
new tests across T1's 8 audit steps). `main` is at `399c88c`;
`git push origin main` succeeded.

The T1 scope, decision matrix, and target files sections below
remain unchanged — they are the planner's work, per the Phase 3
closeout rule (planner-owned, not closeout-rewritten).

---

## T2 Shipped (2026-06-16)

TS extension loader (pi-style) landed via a single branch
`phase4/t2-extensions` merged with `--no-ff`. JSON-manifest extensions
keep working (the v1 public surface is preserved); users can now ship
`extensions/<name>/index.ts` modules that hook into the agent loop
at 4 well-defined seams.

- **`feat(extensions): pi-style TS extension loader`**
  — commit `1f29f18`, merge `b150a38`. 4 NEW source files
  (`extensions/loader.ts` 506 LOC, `extensions/registry.ts` 295 LOC,
  `extensions/context.ts` 108 LOC, `__tests__/extensions-loader.test.ts`
  632 LOC) + 2 MODIFIED (`extensions.ts` route JSON manifests through
  the same registry, `loop.ts` fire 3 in-loop hooks at natural seams).
- **`fix(extensions): chain transformations in preSystemPrompt dispatch`**
  — commit `bd1dac3`. Tests 1 + 4 + the runAgent integration test
  rely on chained transformations (each handler sees the previous
  handler's output). Fixed the registry's "last non-undefined wins"
  semantics to chained.
- **`docs(extensions): add owner-takeover deliverable.md`**
  — commit `a38e66f`.

**Final gate (T2 closeout moment, 2026-06-16):** `npm run typecheck`
clean, `npx bun test src/__tests__/` **721 / 0 fail** across **51 files**
stable across 3 consecutive runs (was 695 in the post-T1 baseline;
+26 net new tests for the loader/registry/context + 4 hook-point
integration tests, all passing). `main` is at `1ab6a50` after T3
merges in (T2 alone: `b150a38`).

---

## T3 Shipped (2026-06-16)

Real MCP client (consume side) landed via a single branch
`phase4/t3-mcp-client` merged with `--no-ff`. Symmetric with the
existing `ch mcp` *server*; CodingHarness can now consume other MCP
servers (Claude Code's `~/.claude/mcp_servers.json`, Cursor's, any
third-party via `npx`).

- **`fix(mcp): stdio dispatch routes responses, tighten package-name validation`**
  — commit `4242a5c`. Routes stdio dispatch responses correctly,
  tightens `validatePackageName` to reject path traversal (`..`),
  multi-slash subpaths (`foo/bar/baz`), and oversized names per npm
  spec.
- **`feat(mcp): real MCP client (consume side) + LocalMcpRegistry + shared transport`**
  — commit `dde8567`. 4 NEW source files (`agent/mcp-client.ts` 754
  LOC, `agent/mcp-registry.ts` 175 LOC, `agent/mcp-store.ts` 296 LOC,
  `mcp-transport.ts` 224 LOC) + 1 NEW test file
  (`__tests__/mcp-client.test.ts` 614 LOC, 33 tests) + 1 NEW fixture
  (`__tests__/mcp-fixture-server.mjs` 65 LOC) + 4 MODIFIED
  (`mcp-server.ts` refactored to use shared transport, `cli.ts`
  +227 LOC for `ch mcp get/add/list/remove`, `config/paths.ts` +9 LOC
  for `MCP_CONFIG_PATH`, `runtime.ts` +19 LOC for env var wiring).

**Final gate (T3 closeout moment, 2026-06-16):** `npm run typecheck`
clean, `npx bun test src/__tests__/` **754 / 0 fail** across
**52 files** stable across 3 consecutive runs (was 695 in the
post-T1 baseline; +59 net new tests across T2 + T3, all passing).
`main` is at `1ab6a50`; `git push origin main` succeeded.

### Concurrent `mcp add` safety

`mcp-store.ts` serializes concurrent `mcp add` calls via a per-process
mutex (a module-scoped `Promise<void>` chain). The test covers 3
parallel `add` calls in the full suite and the final file is
well-formed with all 3 entries — no JSON corruption.

### Transport reuse

`src/mcp-server.ts` was refactored to import the JSON-RPC framing
helpers from the new `src/mcp-transport.ts`. No duplicated JSON-RPC
parsing; both sides (server + client) use the same parse/format
helpers. Public surface of `mcp-server.ts` is unchanged.

---

## Phase 4 tracks (4 bounded + 1 spike + 1 closeout)

### T1 — D-WORKFLOW-IMPL — Workflow real port (HEADLINE)

**Source:** full spec in [`docs/agnt-workflow-audit.md` §8](./agnt-workflow-audit.md#8-port-plan) — sized at **L (≈ 1500 LOC)**, with 8-step conservative sequencing.

**Scope:** Port `WorkflowManipulationService.js` + `WorkflowEngine.js` +
`NodeExecutor.js` + `EdgeEvaluator.js` + `ParameterResolver.js` from
agnt-gg against our `Delegation { kind: "workflow" }` kind. The
agnt-gg IPC layer (`WorkflowProcessBridge` + `WorkflowProcess` +
`ProcessManager` + `ProcessWorker`, ≈ 880 LOC) is **dropped** — we run
the engine in-process, matching the existing `goal` kind's pattern.

**Decision matrix on the audit's 5 open questions:**

| # | Open question | Phase 4 decision |
|---|---|---|
| 1 | Where do tool definitions live; does `node.type` map? | Reuse the existing `McpRegistry` (`src/agent/delegation.ts:316`) as the `MCP`/`tool` resolution layer. For built-in `action` nodes, register a new `WorkflowToolRegistry` mirroring `McpRegistry`'s narrow-interface pattern; map `node.type` → tool at step-execution time. |
| 2 | In-process vs forked child for trigger lifecycle? | **In-process** for v1. `ch workflow run` is synchronous; trigger listeners that need to survive a CLI exit (webhook, timer) are out of scope and explicitly deferred to a T1.5 follow-up if user demand surfaces. The audit's open question #2 is resolved by "in-process, fire-and-forget for v1". |
| 3 | How does `maxCostUsd` interact with workflows? | **Per-workflow-run cap**, not per-step. The `WorkflowEngine` accumulates cost from every `agent` / `api` / `mcp` step and aborts when the cap is hit (mirroring `WorkflowEngine.js:248-262`'s `Insufficient credits` check). The cap lives on `WorkflowDelegation.maxCostUsd` (a new field on the `WorkflowDelegation` interface). |
| 4 | Template syntax — `nodeName` vs `nodeId`? | **Prefer `nodeId` (`{{node_abc123.field}}`).** Stable IDs are the harness's default; `nodeName`-based resolution from agnt-gg (`ParameterResolver.js:45-55`) is fragile because it depends on `node.text.toLowerCase().replace(/\s+/g, '')` and breaks silently on renames. The resolver falls back to `nodeName` resolution for agnt-gg-imported workflows (back-compat), but native workflows should use `nodeId`. |
| 5 | Versioning service — port or defer? | **Defer.** Use git-based versioning (workflows-as-files in `~/.codingharness/workflows/`) for v1. Import/export envelopes (`WorkflowRoutes.js:152-181` in agnt-gg) ship in T1 for workflow sharing. A real `WorkflowVersionService` is a T1.5 candidate if user demand surfaces. |

**8-step sequencing** (adopted verbatim from the audit §8.4):

1. **S** — `workflow-types.ts` + `workflow-graph.ts` + tests (pure
   functions, data-model verification).
2. **M** — `workflow-eval.ts` + tests (template + edge condition resolution,
   10 operators, `{{nodeId.field}}` resolution per decision #4).
3. **M** — `workflow-store.ts` + tests (CRUD over per-workflow JSON files
   in `~/.codingharness/workflows/<id>.json`; SQLite is a follow-up).
4. **M** — `workflow-steps.ts` + `workflow.ts` (the executor) + tests.
   This is the heart of the port.
5. **S** — `delegation.ts` updates (expand `WorkflowDelegation`,
   `DelegationResult`, replace `runStubKind` with `runWorkflowKind`).
6. **S** — `src/runtime.ts` wiring (expose `runtime.runWorkflow`).
7. **S** — CLI subcommands + slash command (`ch workflow list/show/new/edit/delete/run/import/export` + `/workflow`).
8. **S** — End-to-end test: load a real
   `agnt-gg` `automated_email_summarizer.json` (with the agnt-gg-specific
   action types stubbed), execute it via the harness, assert output shape.

**Target files (NEW):**
- `src/agent/workflow-types.ts` (~100 LOC)
- `src/agent/workflow-graph.ts` (~250 LOC, 8 pure helpers from
  `WorkflowManipulationService.js`)
- `src/agent/workflow-eval.ts` (~200 LOC, 10 condition operators + template resolver)
- `src/agent/workflow-store.ts` (~250 LOC, per-workflow JSON files)
- `src/agent/workflow-steps.ts` (~200 LOC, `NodeExecutor` + dispatch)
- `src/agent/workflow.ts` (~400 LOC, the in-process `WorkflowEngine`)
- `src/__tests__/workflow-graph.test.ts` (~120 LOC)
- `src/__tests__/workflow-eval.test.ts` (~80 LOC)
- `src/__tests__/workflow.test.ts` (~150 LOC, integration + E2E)
- `src/__tests__/workflow-cli.test.ts` (~50 LOC, CLI smoke)

**Target files (MODIFIED):**
- `src/agent/delegation.ts:56-64` — add `trigger?` to `WorkflowDelegation`
- `src/agent/delegation.ts:257` — expand `DelegationResult { kind: "workflow" }`
  from `{ workflowId, status: "stub" }` to `{ workflowId, status: "completed" | "failed" | "running", steps, error?, costUsd? }`
- `src/agent/delegation.ts:1112-1115` — replace `runStubKind` with
  `runWorkflowKind` that instantiates `WorkflowEngine` and dispatches
  `_executeWorkflow`
- `src/runtime.ts` — wire `WorkflowStore` + `WorkflowEngine` factory on
  `HarnessRuntime` (analogous to T1's `runGoalAgent` wiring in Phase 3)
- `src/cli.ts` — add `ch workflow *` subcommands
- `src/slash/builtin.ts` — add `/workflow` slash command

**Estimated size:** **L** (≈ 1500 LOC), per the audit §8.1. The IPC
layer drop (≈ 880 LOC) is the single biggest reduction.

**Dependencies on other tracks:** none (all 5 open questions answered
above; `McpRegistry` already exists at `src/agent/delegation.ts:316`).

**Resolves:**
- The Phase 3 `D-WORKFLOW-IMPL` deferral
- The `kind: "workflow"` stub in the 8-kind `Delegation` union
  (`src/agent/delegation.ts:1112-1115`)
- The "real workflow engine" follow-up called out in the
  agnt-port-plan §6.3 spike
- The 4 §6.1 risk items the spike flagged (#10 already closed in
  Phase 3 T1; #11–#13 closed by this track)

---

### T2 — TS extension loader (pi-style)

**Scope:** Today, extensions work via JSON manifests only
(`src/agent/extensions.ts`). The README roadmap calls out the
TS extension loader as the v3 unblocker — let users ship
`extensions/<name>/index.ts` modules that hook into the agent
loop (post-tool-result, pre-system-prompt, on-message, on-error,
on-compaction). The pi-style loader is dynamic-import based
with a manifest wrapper:

```ts
// ~/.codingharness/extensions/my-ext/index.ts
import type { ExtensionContext } from "codingharness/extensions";
export const manifest = {
  name: "my-ext",
  version: "0.1.0",
  description: "Logs every bash command to ~/.my-ext.log",
  hooks: { postToolResult: "default" },
};
export default function activate(ctx: ExtensionContext) {
  ctx.on("postToolResult", ({ tool, result }) => { /* ... */ });
}
```

The loader `await import()`s the entrypoint, validates the
`manifest` shape, calls `default(activateContext)` with the
extension context, and registers the hook handlers on a new
`ExtensionRegistry`.

**Target files:** NEW `src/agent/extensions/loader.ts` (the dynamic
importer); NEW `src/agent/extensions/registry.ts` (the hook handler
registry); modify `src/agent/extensions.ts` (route JSON manifests
through the same registry as TS modules); NEW `src/agent/extensions/context.ts`
(the `ExtensionContext` interface); modify `src/agent/loop.ts` (call
hook registry at the 4 hook points: pre-system-prompt, post-tool-result,
on-error, on-compaction); NEW `src/__tests__/extensions-loader.test.ts`.

**Estimated size:** **M** (~450 LOC) — loader + context ~200 LOC,
registry ~100 LOC, tests ~150 LOC.

**Dependencies on other tracks:** none. The `McpRegistry` /
`PluginManager` patterns give us the narrow-interface shape to mirror.

**Resolves:** README roadmap "TS extension loader (pi-style)"; the
"What's NOT in v0.2" section call-out that JSON-only is a v2
limitation.

---

### T3 — Real MCP client (consume side)

**Scope:** Today, `ch mcp` is the **server** side of MCP
(`src/mcp-server.ts`) — CodingHarness exposes its 13 tools to
other clients. The **client** side — CodingHarness consuming
external MCP servers (Claude Code's `~/.claude/mcp_servers.json`,
Cursor's, third-party servers from `mcp get`) — is the natural
symmetric capability. The `McpRegistry` narrow interface at
`src/agent/delegation.ts:316` already exists; this track implements
the client that *populates* the registry.

Wire `mcp get <package>` and `mcp add <package>` CLI subcommands
that:
1. Resolve the package (npm-style for now; pip/pypi follow-up).
2. Spawn the server subprocess per the MCP stdio or HTTP+SSE
   transport (we already have both transports in `src/mcp-server.ts`).
3. Negotiate `initialize` + `tools/list`.
4. Register each discovered tool in the `McpRegistry` so the
   `Delegation { kind: "mcp" }` path can dispatch to it.
5. Persist the registration in `~/.codingharness/mcp.json` (one
   entry per installed server).

**Target files:** NEW `src/agent/mcp-client.ts` (the client
implementation); modify `src/agent/delegation.ts:316` (`McpRegistry`
becomes the registration target — no interface change); modify
`src/cli.ts` (add `ch mcp get/add/list/remove` subcommands); NEW
`src/__tests__/mcp-client.test.ts`.

**Estimated size:** **M+** (~600 LOC) — client ~350 LOC (stdio +
HTTP+SSE transports, initialize/handshake, tool list, call
dispatch), CLI ~100 LOC, tests ~150 LOC.

**Dependencies on other tracks:** none. The transports are
already in `src/mcp-server.ts` and we just need the symmetric
client.

**Resolves:** README roadmap "Real MCP client (lazy-loaded)"; the
gap that today the harness can *serve* MCP but not *consume* it.

---

### T4 — D-INK-pre: REPL scrollback pain spike (2 days)

**Scope:** Run the 2-day spike evaluating (a) **status quo**
(measure scrollback pain quantitatively in `repl-v2.ts`), (b)
**ink** (React-based, lots of ecosystem, but adds a runtime dep
on React), (c) hand-rolled TS VDOM. Pick one of (b) or (c) and
ship the swap as a separate follow-up plan (D-INK-IMPL).

The spike measures:
- 9-voice council transcripts (longest realistic transcript).
- `/tree` output on a 200-node session tree.
- 50-message session with a 100k-token context compaction.
- The current `repl-v2.ts` lines-emitted, screen-refresh latency,
  and any "scrollback gap" reports from the field.

**Target files:** NEW `docs/ink-spike.md` (the spike report —
which option, why, what it costs); modify
`docs/phase4.md` (T4.5 — D-INK-IMPL section) if a swap is
recommended; new or modified `src/ui/repl-v3.ts` if a swap is
recommended (L or M depending on choice).

**Estimated size:** **S** for the spike itself (the doc + measurement
script, ~200 LOC). The swap is L (ink) or M (VDOM) and ships as
T4.5 in a follow-up plan.

**Dependencies on other tracks:** none. The TUI mode in
`src/ui/tui.ts` is independent and the spike is REPL-only.

**Resolves:** D-INK deferral from Phase 3. The spike is the
gating work for the swap.

---

### T5 — Closeout: version bump 0.2.2 → 0.3.0

**Scope:** After all four tracks ship, bump `package.json`
version 0.2.2 → 0.3.0. The minor version bump is justified by
the capability added since 0.2.2:

- 40+ HTTP routes (`server.ts` expansion)
- Vector memory layer (T2)
- Goal state machine (T1)
- 9-voice council
- Web UI panels (goals, delegations)
- `ch mcp` server
- `ch serve` hardening (bearer auth, body cap, abort, health)
- (T1) Workflow real engine
- (T2) TS extension loader
- (T3) MCP client
- (T4/T4.5) REPL scrollback upgrade

Update `README.md` banner + version table, update the
`/v1/info` endpoint's `version` field (if not already sourced
from `package.json`), update the `--version` CLI flag output,
update the electron-builder config `version` field (mirrors
`package.json`).

**Target files:** modify `package.json` (version field); modify
`README.md` (banner + any version table); modify `electron/package.json`
(mirror version); modify `docs/CHANGELOG.md` (new "0.3.0" section).

**Estimated size:** **S** (~50 LOC, mostly doc updates).

**Dependencies on other tracks:** T1, T2, T3, T4 (T4.5 if it ships
in Phase 4; otherwise defer the bump until T4.5 lands).

**Resolves:** The semver-cuts-on-meaningful-surface-change principle
called out in the AGENTS.md "Code style" + "PR & commit conventions"
sections.

---

## Tracks explicitly deferred (out of scope for Phase 4)

### D-INSIGHT — `InsightEngine` + `evolution/applicators`

The "golden-standards-from-history" pattern. T2 (vector memory) shipped
in Phase 3 is the **recall-quality precondition**; user adoption data
is the **adoption precondition**. Neither has accumulated yet.
**Estimated size:** **L** (1500+ LOC). **Why deferred:** the
preconditions are not met.

### D-WORKFLOW-IMPL follow-ups: T1.5 / T2.5

- **T1.5 — Long-lived trigger listeners** (webhook, timer) behind a
  forked child process (or a daemon mode). Sized L if/when demanded.
- **T1.5 — Versioning service** (real `WorkflowVersionService`).
  Sized L; git-based versioning is the v1 stand-in.
- **T2.5 — Workflow marketplace plugin system** (agnt-gg's
  install/uninstall plugin flow). Sized M; current `McpRegistry` +
  `PluginRegistry` cover the v1 surface.

### T4.5 — D-INK-IMPL (the actual swap, if T4 picks (b) or (c))

**T4 outcome (2026-06-17):** [`ink-spike.md`](./ink-spike.md) ships.
**Recommended pick when T4.5 fires: (c) hand-rolled TS VDOM**
(~1200 LOC, $0 new deps). **T4.5 itself is deferred** — the spike
measured bounded but real pain (22-68 KB per event, perf is fine,
missing folding/in-place-update affordances) and the original
"gated on observed scrollback pain in the field" principle still
applies. **Re-trigger for T4.5:** when 2+ user reports of
"the council transcript pushed my prompt off-screen" /
"I can't fold /tree output" / "I lost my place in /compact"
land in issues.

Sized M when it ships (≈ 1200 LOC for the VDOM + ~200 LOC
`repl-v2.ts` → `repl-v3.ts` swap + ~20 tests). Shipped as a
separate plan post-T4 spike.

---

## Track order and dependencies

```
T1 (D-WORKFLOW-IMPL)         ──> (none)
T2 (TS extension loader)     ──> (none)
T3 (MCP client)              ──> (none)
T4 (D-INK-pre spike)         ──> (none)
T5 (closeout / version bump) ──> T1, T2, T3, T4 (T4.5 if it ships in Phase 4)
```

T1, T2, T3, T4 are **independent** — none has a `depends_on` on
another. They can ship in parallel as separate `mavis-team` plans
without coordination. T5 is the natural closeout after all four
land.

**Recommended dispatch order** (one `mavis-team` plan per track,
each with its own 15-min producer cap respected per the engine
gotchas memory):

1. **T1 first** (L, ≈ 1500 LOC) — the headline track. 8-step
   sequencing means it should ship as ONE plan with the
   8 steps broken into per-step worktrees, OR as two
   `mavis-team` plans (steps 1-4 first, steps 5-8 second).
   The first option matches the Phase 1-3 pattern better.
2. **T2 + T3 in parallel** (both M) — independent, both
   small enough to be single-plan.
3. **T4** (S for the spike) — can run in parallel with
   T2/T3 since it's REPL-only.
4. **T5** (S) — final closeout, 30 minutes of doc work.

**Wall-clock budget** with 1 producer per track and parallel
dispatch: ~2-3 days (T1 dominates).

---

## What lands in the repo when Phase 4 ships

- A real in-process `WorkflowEngine` (8 new files in
  `src/agent/workflow*.ts`, ~ 1500 LOC).
- A `ch workflow *` CLI surface (8 subcommands).
- A `/workflow` slash command.
- A `WorkflowStore` JSON-file persistence layer.
- 14+ new `ch workflow` subcommands surfaced via the existing
  `/v1/delegations` HTTP API (kind: "workflow" stops being a stub).
- A TS extension loader (`src/agent/extensions/loader.ts` +
  `registry.ts` + `context.ts`, ~ 450 LOC).
- A real MCP client (`src/agent/mcp-client.ts` + 4 new `ch mcp
  get/add/list/remove` subcommands, ~ 600 LOC).
- An REPL scrollback spike report (`docs/ink-spike.md`).
- A `0.3.0` version bump + updated `CHANGELOG.md` and `README.md`.
- Net new tests: ~ +30 (T1), ~ +10 (T2), ~ +8 (T3), ~ +2 (T4 spike).
  Total: 604 → 654 across 50 files.

---

## What Phase 4 explicitly does **not** ship

- No `InsightEngine` / `evolution/applicators` port (D-INSIGHT —
  preconditions not met).
- No forked child process for workflow triggers (T1.5 — in-process
  for v1).
- No workflow versioning service (T1.5 — git-based for v1).
- No workflow marketplace plugin system (T2.5 — current registries
  cover v1).
- No `ink` swap yet (T4.5 — spike first, swap in a follow-up).
- No multi-user `userId` field (Q8 — locked in single-user).
- No `Delegation` union expansion beyond 8 kinds (the 8 kinds
  are the Phase 1 ceiling; T1 just makes the `workflow` kind
  real).

---

## Open questions for orchestrator decision (same as audit §7)

The 5 open questions in `docs/agnt-workflow-audit.md` §7 are
answered in T1's "Decision matrix" table above. Summary:

1. **Tool registry:** reuse `McpRegistry` + new `WorkflowToolRegistry`.
2. **Trigger lifecycle:** in-process, fire-and-forget for v1.
3. **`maxCostUsd`:** per-workflow-run, abort on cap.
4. **Template syntax:** `nodeId`-first, `nodeName` fallback.
5. **Versioning:** git-based, deferred real service.
