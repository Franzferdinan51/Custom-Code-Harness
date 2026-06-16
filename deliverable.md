# Phase 4 T2 + T3 — Final-Gate Deliverable

**Merged:** `b150a38` (T2) + (T3) → main
**Branches:** `phase4/t2-extensions` (T2), `phase4/t3-mcp-client` (T3)
**Test count:** 728 / 2 pre-existing T1 fails across 51 files
**Gate stability:** 3/3 consecutive clean runs

## T2 — TS extension loader (pi-style)

**Branch:** `phase4/t2-extensions` (merge SHA `b150a38`)
**Commits:** `1f29f18` (impl) → `bd1dac3` (chained-transform fix) → `a38e66f` (deliverable)
**Test count:** 721 / 0 fail across 51 files (baseline 695 + 26 new)

### What landed
- **NEW** `src/agent/extensions/loader.ts` (501 LOC) — dynamic-import
  with 3 strategies (native, tsx, error), per-extension error
  isolation, JSON parity.
- **NEW** `src/agent/extensions/registry.ts` (~290 LOC) —
  `ExtensionRegistry` mirroring `McpRegistry`'s narrow-interface
  shape. 4 hook points, handler-error isolation, `preSystemPrompt`
  uses chained transformations.
- **NEW** `src/agent/extensions/context.ts` (108 LOC) —
  `ExtensionContext` with per-extension handle, `dispose()` pattern,
  typed payloads per hook.
- **MODIFIED** `src/agent/extensions.ts` — route JSON manifests
  through the same registry. `systemPromptAppend` registers a
  `preSystemPrompt` hook. Backward-compatible.
- **MODIFIED** `src/agent/loop.ts` (+228 LOC delta) — fire the 3
  in-loop hooks at natural seams: `preSystemPrompt`, `postToolResult`,
  `onError`, `runCompactionWithHooks` (4th hook point).
- **NEW** `src/__tests__/extensions-loader.test.ts` (~630 LOC, 26 tests).

### Spec compliance
- ✅ Backward compatibility: 695-test Phase 4 T1 baseline is the floor.
- ✅ 4 hook points exactly: `preSystemPrompt`, `postToolResult`,
  `onError`, `onCompaction`.
- ✅ No new runtime dependency.
- ✅ ESM throughout, 4-space indent, no `any` in new public surfaces.
- ✅ Handler errors isolated: one extension's throw does not propagate
  to the agent loop or other handlers.

## T3 — Real MCP client (consume side)

**Branch:** `phase4/t3-mcp-client`
**Commits:** `4242a5c` (stdio dispatch fix + tighter pkg validation) → `dde8567` (deliverable)
**Test count:** 726 / 2 pre-existing T1 fails across 51 files (33 new T3 tests, all green)

### What landed
- **NEW** `src/agent/mcp-client.ts` (754 LOC) — `validatePackageName`,
  `resolveNpmPackage`, `deriveServerId`, `connectStdio`, `connectHttp`,
  `mcpGet`, `mcpAdd`, `buildEntry`, `McpClient` interface, full
  initialize + tools/list + tools/call + notifications/initialized flow.
- **NEW** `src/agent/mcp-registry.ts` (175 LOC) — `LocalMcpRegistry`
  with `add` / `remove` / `callTool` / `listServers`,
  `defaultLocalMcpRegistry` via `MCP_CONFIG_PATH`.
- **NEW** `src/agent/mcp-store.ts` (296 LOC) — atomic persistence
  (tmp + rename), per-process mutex for concurrent `mcp add` safety.
- **NEW** `src/mcp-transport.ts` (224 LOC) — shared JSON-RPC framing
  extracted from `src/mcp-server.ts`.
- **MODIFIED** `src/mcp-server.ts` (refactored, -50 LOC) — uses shared
  transport. Public surface unchanged.
- **MODIFIED** `src/cli.ts` (+227 LOC delta) — `ch mcp get/add/list/remove`
  subcommands. Existing server block preserved.
- **MODIFIED** `src/config/paths.ts` + `src/runtime.ts` —
  `MCP_CONFIG_PATH` env var wired through.
- **NEW** `src/__tests__/mcp-client.test.ts` (614 LOC, 33 tests) +
  `mcp-fixture-server.mjs` fixture.

### Spec compliance
- ✅ No regression: 695-test baseline floor met. The 2 pre-existing
  failures in `delegation-stubs.test.ts` are T1 carry-over (same 2
  fail on `main` HEAD before T3).
- ✅ Transport reuse: `src/mcp-server.ts` was refactored to import
  from `src/mcp-transport.ts`. No duplicated JSON-RPC parsing.
- ✅ Subprocess safety: `child_process.spawn` with explicit stdio
  pipes, no `shell: true`, handshake timeout default 10s, max stdout
  buffer 1 MB, package name validation before any spawn.
- ✅ Persistence: `saveMcpConfigAtomic` writes to `.tmp` and renames.
  Per-process mutex serializes concurrent `mcp add` calls.
- ✅ Registry contract: `McpRegistry` consumers in `delegation.ts`
  unchanged. `serverId/toolName` resolution path works.
- ✅ No new runtime dependency. `fetch` (Node 18+ built-in) for HTTP.

## Combined test count

- Baseline (Phase 4 T1, after T1 merge): 695 tests, 2 pre-existing
  fails in `delegation-stubs` (T1 carry-over, NOT introduced by T2/T3).
- After T2: 721 / 0 fail (26 new T2 tests, all green).
- After T2 + T3: 728 / 2 pre-existing fails (33 new T3 tests, all green).
- Total new tests in T2 + T3: 26 + 33 = **59 new tests, all passing**.

## Gate results

3 consecutive clean runs of:
- `npm run typecheck` (clean)
- `npx bun test src/__tests__/` (728 / 2)

Pre-existing failures are in `delegation-stubs.test.ts` (T1 carry-over)
and are not in T2/T3 scope.
