# T3 — Real MCP client (consume side) — Owner Takeover Deliverable

**Branch:** `phase4/t3-mcp-client`
**Final commit:** (see `git log -1` on the branch)
**Test count:** 726 / 2 fail across 51 files (728 total; baseline 695 + 33 new)
**Pre-existing failures:** 2 in `delegation-stubs.test.ts` (T1 carry-over, NOT T3)
**Gate stability:** 3/3 consecutive clean runs

## What landed

### Source files
- **NEW** `src/agent/mcp-client.ts` (754 LOC) — `validatePackageName`,
  `resolveNpmPackage`, `deriveServerId`, `connectStdio`, `connectHttp`,
  `mcpGet`, `mcpAdd`, `buildEntry`, `McpClient` interface, full
  initialize + tools/list + tools/call + notifications/initialized flow.
- **NEW** `src/agent/mcp-registry.ts` (175 LOC) — `LocalMcpRegistry`
  with `add` / `remove` / `callTool` / `listServers`, `defaultLocalMcpRegistry`
  via `MCP_CONFIG_PATH`, typed `RegistryCallResult` envelope (`ok: bool`,
  `output?`, `error?`).
- **NEW** `src/agent/mcp-store.ts` (296 LOC) — `parseConfig`, `parseEntry`,
  `loadMcpConfigSync` / `loadMcpConfig` (async), `saveMcpConfigAtomic`
  (tmp + rename), `upsertMcpServerEntry`, `removeMcpServerEntry`,
  `resolveMcpConfigPath`. Per-process mutex via a module-scoped
  `Promise<void>` chain serializes concurrent `mcp add` calls.
- **NEW** `src/mcp-transport.ts` (224 LOC) — shared JSON-RPC framing
  extracted from `src/mcp-server.ts`. `parseJsonRpc` (request vs
  response discrimination), `formatJsonRpcRequest`,
  `formatJsonRpcResponse`, `tryInferId`, `okResponse`, `errResponse`,
  `MCP_PROTOCOL_VERSION`, `ERR_*` constants.
- **MODIFIED** `src/mcp-server.ts` (refactored, -50 LOC) — replaced
  the duplicated framing helpers with imports from `src/mcp-transport.ts`.
  Public surface unchanged.
- **MODIFIED** `src/cli.ts` (+227 LOC delta) — added `ch mcp get/add/
  list/remove` subcommands, registered in the top-level subcommand
  table at line 210. Existing `ch mcp [--port] [--host] [--stdio] ...`
  server block at line 1266+ is preserved.
- **MODIFIED** `src/config/paths.ts` (+9 LOC) — `mcpConfigPath()`
  honors `MCP_CONFIG_PATH` env var for tests; default path is
  `~/.codingharness/mcp.json`.
- **MODIFIED** `src/runtime.ts` (+19 LOC) — `MCP_CONFIG_PATH` env
  var wired through to the runtime config so `ch mcp add` from the
  CLI lands at the same path the registry reads.

### Test coverage (33 new tests)
- `validatePackageName` accepts/rejects (3): npm-style names, bad
  names (10 cases), path traversal (2 cases).
- `resolveNpmPackage` + `deriveServerId` (3): scope collapse,
  lowercase, separator collapse.
- `parseJsonRpc` / `formatJsonRpcRequest` / `formatJsonRpcResponse` /
  `tryInferId` / `okResponse` / `errResponse` (8): round-trips,
  malformed inputs, null id handling, request/response discrimination.
- Stdio transport end-to-end against `mcp-fixture-server.mjs` (2):
  full handshake + tools/list + tools/call, surface server-side
  initialize error.
- HTTP transport end-to-end (1): auto-detect from `http(s)://` prefix,
  POST → response → dispatch.
- `mcpAdd` + `LocalMcpRegistry.callTool` round-trip (1): persists
  entry, registry dispatches through the file.
- `LocalMcpRegistry` typed errors (2): unknown server, unknown tool.
- `LocalMcpRegistry` add/remove snapshot (1).
- `defaultLocalMcpRegistry` honors `MCP_CONFIG_PATH` (1).
- `mcp-store` atomic writes + concurrent safety (4): empty → add →
  remove, persisted shape, tmp-rename atomicity, race (3 concurrent
  `add` calls produce a well-formed file with all 3 entries).
- Misc additional coverage (7).

## Spec compliance

- ✅ No regression: 695-test baseline floor is met. The 2 pre-existing
  failures in `delegation-stubs.test.ts` are T1 carry-over (same 2
  fail on `main` HEAD before T3). T3's 33 new tests are all green.
- ✅ Transport reuse: `src/mcp-server.ts` was refactored to import
  from `src/mcp-transport.ts`. No duplicated JSON-RPC parsing.
- ✅ Subprocess safety: `child_process.spawn` with explicit stdio
  pipes, no `shell: true`, no `exec`/`execSync`. Handshake timeout
  default 10s (configurable via `timeoutMs`). Max stdout buffer
  1 MB (`MCP_MAX_BODY_BYTES`). Package name validation
  (`validatePackageName`) before any spawn.
- ✅ Persistence: `saveMcpConfigAtomic` writes to `.tmp` and renames.
  Concurrent `mcp add` calls are serialized via a per-process mutex
  in `mcp-store.ts`. Test covers 3 concurrent calls.
- ✅ Registry contract: `McpRegistry` consumers in `delegation.ts`
  unchanged. New `LocalMcpRegistry` is additive. `serverId/toolName`
  resolution path in `delegation.ts:1507` works unchanged (the
  public `McpRegistry` interface is not touched).
- ✅ No new runtime dependency beyond what `package.json` already has.
  `fetch` (Node 18+ built-in) is used for HTTP transport.
- ✅ Project conventions: 4-space indent, ESM throughout, no `any` in
  new public surfaces, conventional commits, file-local helpers
  stay file-local.

## Owner-takeover notes

The producer (mvs_8ceae4ac...) was killed at the 15-min cap with
substantial uncommitted work (~2300 LOC across 4 new files + 4
modified). Per the engine gotchas (15-min cap + override_accept +
3-piece evidence), I integrated the uncommitted work, ran the gate,
and verified all target behaviors:

1. **Typecheck clean** on the merged work.
2. **Full bun test suite: 728 / 2** (the 2 fails are pre-existing
   `delegation-stubs` issues from T1, identical to main HEAD).
3. **All 33 new mcp-client tests pass** in isolation and as part of
   the full suite.
4. **Concurrent `mcp add` race test passes** (3 parallel calls, file
   is well-formed and contains all 3 entries).
5. **stdio handshake + tools/list + tools/call + close** all work
   end-to-end against the `mcp-fixture-server.mjs` fixture.
6. **HTTP transport auto-detection** from `http(s)://` prefix works
   (verified against a local `http.createServer` mock).

No code changes were needed beyond what the worker produced.

## What's NOT in this branch

- Pip / PyPI package resolution. The spec says "follow-up" — only
  npm is wired in v1.
- A persisted client-cache so `mcp list` doesn't spawn a subprocess
  for every server. The spec doesn't require it; `list` reads from
  `mcp.json` and the spawn happens only on `get` / `add` / `callTool`.
- Hooking `connectStdio` / `connectHttp` into the agent loop's
  `Delegation { kind: "mcp" }` path. The `LocalMcpRegistry` already
  exists for runtime lookup; the integration into `delegation.ts`'s
  dispatch is out of scope for T3 (delegation.ts has its own
  `McpRegistry` consumer pattern that T3 doesn't disturb).

## Next steps

- This branch is **not pushed yet** — `git push -u origin phase4/t3-mcp-client`
  happens in the final-gate task after T2 also lands.
- The final-gate task will merge `phase4/t2-extensions` + `phase4/t3-mcp-client`
  into `main`, run the combined gate 3x, update `docs/phase4.md`, and push.
