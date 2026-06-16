# T2 — TS extension loader (pi-style) — Owner Takeover Deliverable

**Branch:** `phase4/t2-extensions`
**Final commits:** `1f29f18` (impl) → `bd1dac3` (owner-takeover fixes)
**Test count:** 721 / 0 fail across 51 files (baseline 695 + 26 new)
**Gate stability:** 3/3 consecutive clean runs

## What landed

### Source files
- **NEW** `src/agent/extensions/loader.ts` (501 LOC) — dynamic-import with 3
  strategies (native, tsx, error), per-extension error isolation, JSON
  parity (JSON manifests with `systemPromptAppend` contribute a
  `preSystemPrompt` hook).
- **NEW** `src/agent/extensions/registry.ts` (~290 LOC) — `ExtensionRegistry`
  mirroring `McpRegistry`'s narrow-interface shape. 4 hook points
  (`preSystemPrompt` / `postToolResult` / `onError` / `onCompaction`),
  handler-error isolation, `preSystemPrompt` uses chained transformations
  (each handler sees the previous handler's return).
- **NEW** `src/agent/extensions/context.ts` (108 LOC) — `ExtensionContext`
  with per-extension handle, `dispose()` pattern, typed payloads per hook,
  logger interface, 4 hook point signatures.
- **MODIFIED** `src/agent/extensions.ts` — route JSON manifests through the
  same registry. `systemPromptAppend` registers a `preSystemPrompt` hook.
  Backward-compatible: existing `loadExtensions(cwd)` signature unchanged,
  existing `manifestTools()` helper unchanged.
- **MODIFIED** `src/agent/loop.ts` (+228 LOC delta) — fire the 3
  in-loop hooks at natural seams:
  - `preSystemPrompt` (line 96): system-prompt transform before the
    provider call
  - `postToolResult` (lines 248 + 275): side-effect hook after a tool call
  - `onError` (lines 194 + 311): on both provider and tool error paths
  - `runCompactionWithHooks` (line 466): opt-in helper for the
    4th hook point (`onCompaction` around the compaction call)
- **NEW** `src/__tests__/extensions-loader.test.ts` (~630 LOC, 26 tests) —
  covers registry basics, all 4 hook points, manifest validation,
  JSON parity, error isolation, lifecycle teardown, agent-loop
  integration, end-to-end via `runAgent` + `runCompactionWithHooks`.

### Test coverage (26 new tests)
- `isHookName` accepts/rejects (2)
- `ExtensionRegistry.register + dispatch` (4): preSystemPrompt chained
  transformations, side-effect void return, handler-throw isolation,
  `removeExtension` clears all for a name
- `ExtensionRegistry.list` / `listFor` introspection (1)
- `validateManifest` accepts/rejects (4): minimal valid, missing name,
  unknown hook name, oversized name
- `loadTsExtension` imports + calls `default(ctx)` + registers hooks (1)
- JSON parity (2): `systemPromptAppend` registers a hook, no hook when absent
- Error isolation (2): bad extension doesn't break next, activate-throw
  isolated to that name
- Lifecycle teardown (2): `dispose` removes handlers, on-after-dispose
  doesn't fire old handler
- Agent-loop integration (4): `runAgent` fires preSystemPrompt,
  postToolResult, onError on provider failure, onError on tool failure
- `runCompactionWithHooks` fires onCompaction pre + post (1)
- Handler error inside the loop's hook dispatch does not crash the run (1)
- `loadExtensionsIntoRegistry` top-level (2): scans both dirs dedupes by
  name, accepts `<name>/index.ts` layout
- Misc additional coverage (3)

## Spec compliance

- ✅ Backward compatibility: 695-test Phase 4 T1 baseline is the floor.
  All existing tests pass unchanged (no `.skip`, no `.todo`).
- ✅ 4 hook points exactly: `preSystemPrompt`, `postToolResult`, `onError`,
  `onCompaction` (last via opt-in `runCompactionWithHooks` helper).
- ✅ No new runtime dependency. Only `tsx` (already a dev dep) is used
  for the fallback dynamic-import path; native `import()` is the
  primary path.
- ✅ ESM throughout, 4-space indent, no `any` in new public surfaces.
- ✅ Handler errors isolated: one extension's throw does not propagate
  to the agent loop or other handlers.

## Owner-takeover notes

The producer (mvs_98e63367...) was killed at the 15-min cap with
substantial uncommitted work (~2200 LOC). Per the engine gotchas
(15-min cap + override_accept + 3-piece evidence), I committed the
partial work, ran the gate, and fixed 3 real issues the verifier
would have caught:

1. **Chained transformations**: The impl used "last non-undefined wins"
   semantics, but tests 1 + 4 + the runAgent integration test rely on
   chained transformations (each handler sees the previous handler's
   output as the system input). Fixed.
2. **Fallback name in error records**: `loadExtensionsIntoRegistry`
   used the dir basename as the error-record name, but the test
   contract (line 314) wants the file basename (sans `.ts`). Fixed.
3. **"on after dispose" test contract**: The test asserted
   `out === undefined` but the chained-transformations contract
   returns the input system. Updated the test to assert
   `out === "S"` (input unchanged) and `out !== "X"` (old handler
   didn't fire). The dispose test (line 350) already expected
   `"base"` for the same scenario, confirming the contract.

## What's NOT in this branch

- Wiring `runCompactionWithHooks` into the runtime's existing
  `compactNow()` path. The runtime still calls `compact` directly;
  the hook is opt-in (callers use `runCompactionWithHooks` instead).
  This matches the spec's "4 hook points" wording — the hook IS
  defined and usable, just not auto-wired into the runtime. A
  follow-up could wire it; the spec did not require auto-wiring.
- `ch ext list` slash command (the loader supports it but the CLI
  surface was out of scope per the spec).
- Marketplace-style distribution (out of scope per phase4.md).

## Next steps

- This branch is **not pushed yet** — `git push -u origin phase4/t2-extensions`
  happens in the final-gate task after T3 also lands.
- The final-gate task will merge `phase4/t2-extensions` + `phase4/t3-mcp-client`
  into `main`, run the combined gate 3x, update `docs/phase4.md`, and push.
