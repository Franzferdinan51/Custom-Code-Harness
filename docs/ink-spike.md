# D-INK-pre spike — REPL scrollback pain measurement

**Status:** complete · **Phase:** 4 (T4) · **Date:** 2026-06-17
**Author:** spike measurement + option analysis
**Resolves:** D-INK deferral from `phase3.md` and `phase2-decisions.md`

---

## Goal

Measure the scrollback pain of the current `repl-v2.ts` REPL against
four realistic scenarios, then choose between **(b) `ink`** and
**(c) hand-rolled TS VDOM** for a future `D-INK-IMPL` swap.

The measurement is the gate. No measurement, no swap — this is the
"gated on observed scrollback pain" principle from
[`phase3.md`](./phase3.md) §D-INK and [`phase2-decisions.md`](./phase2-decisions.md) §Q3.

---

## Methodology

**Bench script:** [`scripts/bench-repl-pain.mts`](../scripts/bench-repl-pain.mts)
(200 LOC). Run with `npx tsx scripts/bench-repl-pain.mts`.

**Reproducibility:** seeded RNG (mulberry32, seed `20260617`). Same
data shapes every run.

**What's measured, per scenario:**
- **lines** — number of terminal rows emitted (with ANSI escapes counted)
- **bytes** — UTF-8 byte count of the rendered output
- **renderMs** — wall-clock time to run the render path
- **notes** — qualitative observation about what the user sees

**Force-ANSI:** the script sets `CODINGHARNESS_COLOR=always` so byte
counts match what a TTY user actually sees. Non-TTY runs would
understate bytes by ~30-50% (no escape codes).

**Render helpers used:** the script imports `renderHeader`,
`renderFooter`, `renderUserLine`, `renderAssistantLine`,
`renderThinkingBlock`, `renderPlanBlock`, `renderToolCall`,
`renderInfoLine`, `renderFramedBlock` directly from
`src/ui/repl-v2.ts` — no mocks, no proxy renderers. The same code
the production REPL uses.

**Data shapes:** realistic inputs modeled on the actual production
shapes:
- council transcript: 9 voices × 200-500 word replies (matches the
  BUILTIN_COUNCILORS length range)
- session tree: 200 nodes, ~5% branch factor (matches a long
  realistic coding session)
- compaction preview: 50 messages × ~100k tokens (matches the
  compaction trigger threshold from `compaction.ts`)

---

## Measurements

| # | Scenario | lines | bytes | renderMs |
|---|----------|------:|------:|---------:|
| 1 | 9-voice council (consensus, 1 round) | 28 | 21,992 (21.5 KB) | 0.058 |
| 2 | `/tree` on 200-node session (≈5% branch factor) | **202** | **69,846 (68.2 KB)** | 1.796 |
| 3 | compaction preview (50 msg, ~100k tok) | 54 | 5,282 (5.2 KB) | 0.123 |
| 4 | repl-v2 render helpers (10k typical turns) | 180,001 | 15.2 MB | 175.4 (0.0175 ms/turn) |

### Scenario 1 — 9-voice council

A full consensus council deliberation with 8 deliberators + 1
synthesizer (the 9-voice default) renders as **one framed block** of
28 lines / 21.5 KB. The REPL dispatch path
(`repl-v2.ts:565`) routes any slash-command output that is both
> 80 chars AND multi-line into `renderFramedBlock`, which is what
council returns via `renderCouncilResult`.

**User experience:** after running `/council`, the user has ~28
lines of scrollback to scroll past before they see their next
prompt. On a 24-row terminal, that's ~1.2 screens. Manageable but
not invisible.

### Scenario 2 — `/tree` on 200-node session

THIS is the headline pain. A 200-node session tree renders as
**202 lines / 68.2 KB** — about 8-9 screens of scrollback on a
24-row terminal. Run `/tree` twice (e.g. compare head before/after
a fork) and the user is staring at 400+ lines of ASCII tree.

The render takes 1.8 ms — perf is fine. The cost is the
**permanent scrollback footprint** and the **lack of folding**. Once
the tree is in scrollback, the user has no way to collapse a
branch they've already inspected.

### Scenario 3 — 50-msg / 100k-token compaction

The `/compact --preview` slash command renders 54 lines / 5.2 KB —
about 2 screens. Not catastrophic, but the preview is typically
followed by the actual compaction summary (a separate transcript
entry), so a single `/compact` cycle dumps ~10 KB / 100 lines into
scrollback.

### Scenario 4 — repl-v2 render micro-bench

10,000 typical turns (header + user + thinking + plan + assistant +
3 tool calls + footer) render in **175 ms total** — 0.0175 ms per
turn. **Perf is not the pain point.** The current render helpers
are fast.

The actual gap is **structural**: `renderX` returns a string and
`printRaw` writes it. The transcript has no concept of "this entry
is now collapsed" or "this entry has been replaced". Once a block
is in scrollback, it's permanent.

---

## Qualitative observations

The numbers above quantify the bytes, but the **actual pain**
isn't about bytes — it's about **lack of affordances**:

1. **No folding.** A 200-node tree or 9-voice council transcript
   can't be collapsed after the user has read it. The terminal's
   native scrollback is the only view.
2. **No in-place replacement.** If the user runs `/tree` and then
   navigates the session (forks, rolls back), the old tree is
   still in scrollback next to the new one. No way to "redraw"
   just the tree region.
3. **No semantic search / jump.** Want to find the tool call that
   produced a specific result? Scroll up and visually scan.
   The terminal's search (Ctrl-R / Cmd-F in some terminals)
   works on bytes, not on transcript structure.
4. **Multi-line input is awkward.** The current `\` + Enter
   continuation works, but a user pasting a 20-line prompt sees
   the REPL echoing each line back as it goes — visually noisy
   when the prompt itself is long.
5. **No alt-screen mode for big blocks.** When `/tree` or
   `/council` dumps 60+ KB, that permanently lives in the
   user's scrollback buffer. A `less`-style alt-screen mode
   would keep it isolated.

These are **all solvable with a VDOM** (option c) and **all
solvable with `ink`** (option b). Option (a) — status quo — solves
none of them.

---

## Options

### (a) Status quo

**Cost:** $0 new code, $0 new deps.

**Pros:**
- Zero new maintenance surface
- Renders are fast (0.0175 ms/turn)
- Terminal-native scrollback is a feature for some users

**Cons:**
- All five pain observations above stay unaddressed
- Once Phase 4 ships (40+ HTTP routes, 9-voice council, workflow
  engine, MCP client), real users will hit them more often
- Already deferred from Phase 2 → Phase 3 → Phase 4 — if we don't
  fix it now, we likely defer again

### (b) `ink` v7

**Bundle cost** (from `npm view ink@7.1.0`):
- `ink` itself: 554 KB unpacked
- `react-reconciler@0.33.0`: **1.68 MB** unpacked
- `scheduler@0.27.0`: 82 KB
- `yoga-layout@3.2.1`: 224 KB
- 20+ transitive deps (`chalk`, `ansi-styles`, `cli-cursor`,
  `cli-truncate`, `slice-ansi`, `wrap-ansi`, `string-width`, etc.)
- **Total:** **~3-5 MB** added to `node_modules`

**Pros:**
- Mature, well-tested — used by Claude Code, Gemini CLI, many others
- React mental model + JSX is familiar
- Rich ecosystem: `ink-text-input`, `ink-spinner`, `ink-link`,
  `ink-gradient`, `ink-table`
- Yoga layout engine handles flexbox-style layout (no manual
  column math)
- Snapshot diffing handles incremental updates correctly

**Cons:**
- **Pulls React + reconciler + scheduler as runtime deps.** We
  currently have a zero-runtime-dep REPL (only optionalDep is
  `@opentui/core` for the legacy TUI). This breaks that contract.
- Adds JSX/TSX to the build (we'd need `tsconfig.json` `jsx: "react"`
  or `jsxImportSource` config; possible friction with strict TS).
- Yoga-layout native binding adds a C++ compile step — fragile on
  some platforms.
- React 18+ patterns (concurrent rendering, suspense) — overkill
  for a single-process REPL.
- Future React major upgrades are a maintenance risk.
- 8-10x more LOC than hand-rolled VDOM (ink + react-reconciler +
  scheduler = ~5-10k LOC of upstream code we depend on).

### (c) Hand-rolled TS VDOM

**Bundle cost:** **$0** — pure TypeScript in our own repo.

**Estimated LOC:** **~1200 LOC** for a complete VDOM with:
- `TranscriptNode` tree + append / replace / remove / collapse / expand
- `renderToString(nodes, opts)` — string output with diffing
- `renderDiff(prev, next)` — minimal-update path for in-place edits
- `Box`, `Text`, `Spacer`, `Frame` primitives
- `useAltScreen()` style hook for `/tree`, `/council`, `/compact`
  output to live in an isolated buffer
- Cols-aware wrapping (reuse the existing `truncateLine`)

**Pros:**
- **Zero new deps.** Honors the "zero runtime deps" contract.
- We control the API surface — can fit our exact transcript model
  instead of bending it into React's reconciler model.
- No native bindings (no Yoga C++ compile).
- No upstream churn. The repo currently has 51 test files and
  ~700+ tests; adding ~1200 LOC of owned code is in scale.
- Drop-in for the existing `renderX` helpers (they already return
  strings — the VDOM is just a structured wrapper around them).

**Cons:**
- More upfront work (1200 LOC vs ~200 LOC swap integration).
- We own the bug surface (snapshots, diffing edge cases, terminal
  edge cases).
- No ecosystem of plug-in widgets (no `ink-table` etc.) — would
  have to hand-roll if we want tables / sparklines later.
- Re-implementing terminal capabilities (alt-screen, mouse,
  scroll-region) that ink gives us for free.

---

## Recommendation

**Pick: (c) hand-rolled TS VDOM** when `D-INK-IMPL` (T4.5) ships.

**T4.5 ship gating: defer the actual implementation** until user
adoption generates actual pain reports matching the qualitative
observations above. The numbers say the pain is **bounded but
real** (22-68 KB per event, perf is fine, missing affordances) —
not severe enough to justify the bundle cost of `ink`, and
not severe enough to schedule the VDOM work in Phase 4.

### Why (c) over (b)

The deciding factor is the **zero-runtime-dep contract** of this
project. We currently ship a TUI harness with `optionalDependencies`
being the only runtime dep (`@opentui/core`, for the legacy TUI
path). Adding `ink` would mean adding `react`, `react-reconciler`,
`scheduler`, `yoga-layout`, and ~20 transitive deps — a ~3-5 MB
inflate that future maintenance has to carry.

Hand-rolled VDOM at ~1200 LOC is the same order of magnitude as
the existing `repl-v2.ts` (795 LOC) — and the existing code
already does most of the rendering work; the VDOM is mostly a
**structured wrapper** around the existing helpers. We pay code,
not bundle.

### Why defer T4.5

The original deferral language from `phase2-decisions.md` was
"gated on observed scrollback pain in the field". We now have
**measured** scrollback pain (this doc) — but it hasn't been
**observed in the field** yet because Phase 4 just shipped and
the user base hasn't grown. Defer T4.5 with a clear re-trigger:

> **Re-trigger for D-INK-IMPL:** when 2+ user reports of
> "I ran /tree and lost my place" / "the council transcript
> pushed my prompt off-screen" / "I can't fold /compact output"
> land in issues, schedule T4.5 (1-2 days, M-sized).

### Estimated T4.5 shape (when triggered)

Per `phase4.md` §T4.5:

- **Files:** new `src/ui/vdom.ts` (~600 LOC), modify `repl-v2.ts` to
  use it (~200 LOC), new `src/ui/repl-v3.ts` if we keep `repl-v2.ts`
  as the legacy fallback (~400 LOC).
- **Tests:** ~+5 test files, ~+20 tests (snapshot diffing, folding,
  alt-screen isolation, in-place replace).
- **External API:** zero — same `runReplV2(runtime, ctx)` signature.
- **Migration path:** `repl-v2.ts` becomes the `--legacy-repl` opt-in,
  `repl-v3.ts` is the default for `ch`, `ch chat`, `ch tui`, `ch repl`.

---

## Files added in this spike

- [`scripts/bench-repl-pain.mts`](../scripts/bench-repl-pain.mts) — the
  measurement harness. Run with `npx tsx scripts/bench-repl-pain.mts`.
  Outputs JSON to stdout and a human summary to stderr. Re-runnable
  any time to validate against future REPL changes.

## Files NOT modified

- No production code changed. The bench script is read-only against
  `repl-v2.ts`.
- `package.json` unchanged — no new deps added.
- `phase4.md` T4.5 section does NOT need modification at this time
  (the swap is deferred, not committed).

## Next steps

1. **T5 (closeout / version bump 0.2.2 → 0.3.0)** — can run
   immediately, independent of T4.5 (T5 just lists T4 as "spike
   shipped, swap deferred").
2. **D-INK-IMPL** — track as a follow-up issue. Re-trigger when
   user-adoption signals match the criterion above.
3. **Optional follow-up spike** — re-run
   `scripts/bench-repl-pain.mts` after each Phase 5+ track ships
   (especially anything that adds to transcript size: new tools,
   new slash commands, new delegation kinds) to catch a pain
   spike before users do.
