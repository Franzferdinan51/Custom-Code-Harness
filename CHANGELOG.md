# Changelog

All notable changes to CodingHarness are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Phase 4 T1 (D-WORKFLOW-IMPL) post-merge cleanups

Three code-quality / correctness fixes that didn't make
it into the original Phase 4 T1 PRs but were found on
the first read of the new code:

- **`workflow-graph.jsonEqual` deep-equal was
  key-order-insensitive AND nested-value-blind**
  (`src/agent/workflow-graph.ts`): the helper was meant
  to give a "stable" deep-equal via
  `JSON.stringify(a, Object.keys(a).sort()) === ...`, but
  `JSON.stringify`'s second arg is a *replacer*, not a
  key-sorter. Pass it an array of keys and it filters
  the output to *only* those keys — meaning two
  structurally-different objects with different
  nested values both stringify to the same string and
  are reported equal (e.g. `{outer:{y:2}}` and
  `{outer:{y:99}}` both became `'{"outer":{}}'`).
  `diffWorkflows` then *missed* real modifications. The
  fix is a small recursive deep-equal that walks the
  structure directly. New test in
  `src/__tests__/workflow-graph.test.ts` pins both
  halves of the contract: same shape / different key
  order is "no diff", and different nested values is
  "modified".

- **`workflow-steps.executeNode` had a dead
  `case "stop-workflow" as string:` arm**
  (`src/agent/workflow-steps.ts`): the literal
  `"stop-workflow"` is not a valid `WorkflowNodeCategory`
  (the union is `trigger | action | utility | control |
  widget | custom | mcp`), so this case label was
  unreachable. The real `stop-workflow` handling is in
  the `case "control":` arm via the `if (node.type ===
  "stop-workflow")` check. The dead label was a code
  smell — it implied `node.category === "stop-workflow"`
  was a real possibility. Removed.

- **`workflow.runSubWorkflow` private bracket-access on
  the executor's `deps`**
  (`src/agent/workflow.ts`, `src/agent/workflow-steps.ts`):
  `this.nodeExecutor["deps"].provider` etc. — a TS
  `private` field accessed via bracket notation to bypass
  the access check. Compiles, but reads as a code smell
  and would break if the field were renamed. Added a
  `NodeExecutor.getDep<K>(key: K)` accessor and switched
  `runSubWorkflow` to use it.

### `formatUSD`: zero renders as `$0.00`, negatives render as `-$X.XX`

The cost-UI display helper had two cosmetic-but-recurring
issues. `formatUSD(0)` hit the `< 0.01` branch and emitted
`"$0.0000"` — visible in the web UI sidebar's "session
cost" line on every cold start before the first model
call had run, and in the runtime's "(tokens in=X out=Y
· session cost $0.0000)" footer. Negative values rendered
as `"$-0.5000"`, reading as a credit instead of a charge
for the rare refund / correction path. Two new tests
pin the zero and negative contracts; the web app's
duplicate `formatUSD` was updated in lockstep.

### Cost: drop the dead `CostTracker.records_()` accessor

`CostTracker.records_()` was a `private`-prefixed
accessor that returned the full record array. It was
defined, never called, and its name + underscore suffix
were leftovers from an early sketch — the public
`perModel()` / `perAgent()` / `total()` accessors are
what callers use. Removed.

- **fix(cost): `formatUSD` zero + negative + drop dead `records_()`**
  (`src/agent/cost.ts`, `src/web/app.js`,
  `src/__tests__/cost-approval.test.ts`):
  2 new tests cover the zero / negative contract.
  Full suite 604 pass / 0 fail (was 602 before this
  session).

### http tool: configurable `timeout_ms` + GET/DELETE no longer transmit a body

The `http` tool's timeout was hard-coded to 30 seconds
(per-request) with no way for the caller to override it —
annoying for endpoints that genuinely need longer (large
file downloads, slow upstream APIs) and impossible to
shorten for tight retry loops. The tool now accepts a
`timeout_ms` field (default 30000, max 300000 = 5 min),
parallel to the bash tool's `timeout_ms` and the
delegation API's `timeoutSeconds`.

The tool also dropped a long-standing bug where
`fetch(..., { body: "..." })` for GET / DELETE / HEAD
requests sent the body anyway — many servers (incl.
strict REST APIs and several CDNs) reject the request
or return 411 Length Required. The fix matches
`DelegationManager.runApiKind`'s body-suppression
behavior: methods that have no spec-mandated body
(GET, DELETE, HEAD) strip `body` from the request
before the call, even if the caller passed one.

- **feat(http): configurable `timeout_ms` + GET/DELETE body guard**
  (`src/agent/tools/http.ts`, `src/__tests__/http-tool.test.ts`):
  4 new tests cover the GET/DELETE no-body contract
  and the timeout-cap contract. Full suite 602
  pass / 0 fail (was 593 before this session).

### Council: throw on multiple synthesizers in the roster (fail-fast on config error)

`runCouncil` used `config.councilors.find(...)` to pick
the synthesizer and silently dropped any extras. A
caller who accidentally listed the synthesizer role
twice (e.g. merged two council configs) would have
one synthesizer run and the others vanish with no
warning — surprising and hard to debug from a
transcript alone. The new check throws with a clear
error message: "council: at most one synthesizer is
allowed in the roster; got N".

- **fix(council): throw on multiple synthesizers in the roster**
  (`src/agent/council.ts`, `src/__tests__/council.test.ts`)

### Server: `readJson` rejects on client-disconnect-mid-body (no more pinned connection)

The server's `readJson` body reader had a latent resource
bug: when a client disconnected mid-body (TCP RST before the
end-of-body marker), the `end` and `error` events would
fire inconsistently depending on the OS / Node version, and
the `close` handler had no reject path. The Promise could
hang forever, pinning the HTTP connection (Node's default
2-minute socket timeout would eventually fire, but the
handler slot stayed consumed in the meantime). Every
mid-disconnect POST was effectively a 2-minute resource
leak.

The fix: a `settled` flag plus a `close` handler that
rejects with an `AbortError` (or `BodyTooLargeError` if
the oversize flag was set on the way down). The `end`
and `error` handlers go through the same `settled` gate
so a clean path is unaffected. New test in
`server-hardening.test.ts` posts a partial body, calls
`req.destroy()`, and asserts the server is still
responsive on a follow-up `/v1/health` within the
2-minute budget.

- **fix(server): `readJson` rejects on client-disconnect-mid-body**
  (`src/server.ts`, `src/__tests__/server-hardening.test.ts`):
  closes the "pinned connection" gap. Full suite
  593 pass / 0 fail (was 592 before this session).

### Server: `abortOnDisconnect` listeners are `once` (no IncomingMessage listener leak)

The server's `abortOnDisconnect(req)` helper registered
two `req.on("close", ...)` / `req.on("aborted", ...)`
listeners per request. The `IncomingMessage` is one of
the longest-lived objects in the request lifecycle (an
SSE stream can stay open for the whole chat turn, easily
30+ seconds), so persistent `on(...)` listeners held a
closure reference to the `AbortController` + `fire` arrow
until the message itself was GC'd. The same TCP-tear-down
event is fired by Node within microseconds of each
other, so the listeners don't need to be persistent —
`once` is enough. Each listener auto-deregisters on the
first fire, freeing the closure for GC.

- **fix(server): `abortOnDisconnect` listeners are `once`**
  (`src/server.ts`): belt-and-suspenders next to the
  `readJson` fix — the long-lived SSE request shape
  means a `once` vs `on` listener is the difference
  between a request handler that frees its closure
  on the first event vs one that pins the closure
  until the response is GC'd.

### Server: wire bash-tool approval over HTTP/SSE (`approval_required` event)

The server's `POST /v1/chat/stream` endpoint now bridges the
runtime's `askApprovalHandler` (the callback the bash tool calls
when it hits a destructive command) to the server's
`pendingApprovals` map + a new `approval_required` SSE event.
The web UI's approval modal is wired to `POST /v1/approval/respond`,
so the end-to-end flow is now functional: a chat run that
trips the bash tool's approval gate emits `approval_required`
with a stable id, the user clicks the modal, the response
resolves the underlying promise, the bash tool continues,
and the run completes.

Pre-bridge, the chat/stream ran without an approval hook
and the bash tool auto-denied (or never reached the user) on
the server, so destructive commands only worked in the CLI
or TUI hosts. The bridge is per-stream: a fresh
`askApprovalHandler` is installed at stream start and restored
in `finally` so concurrent streams / TUI sessions are not
disturbed. If the client disconnects mid-approval, the bridge
cleanup deny-resolves the in-flight entries so the bash tool
gets a clean `"bash: denied by user"` instead of hanging
forever waiting for a response that will never arrive.

- **feat(server): bridge `askApprovalHandler` to `approval_required` SSE event**
  (`src/server.ts`, `src/__tests__/server-approval-bridge.test.ts`):
  closes the gap where the web UI's approval modal was
  wired up but the server never produced the event the
  modal was waiting on. New `bridgeApprovalForStream()`
  helper + new `coerceDecision()` for the strict-union
  return type. The `pendingApprovals` map gained a
  `stream: string` field so the cleanup can identify
  orphans belonging to a specific stream.

### Memory: 4th-layer RRF no longer demotes the BM25 best hit on a vec-rank disagreement

`MemoryLayerStore.search` had a latent flakiness in its
4th-layer (vector + RRF) sort: a vanilla `b.rrf - a.rrf` RRF
sort with BM25-rank as a tiebreak for exact ties. Because
RRF floats are O(1/60) ≈ 0.016 apart per rank step, a
vec-rank gap of 2 could outweigh a BM25-rank gap of 1 in
the float compare, and the BM25 best hit could be demoted
to 2nd place even when the BM25 ranks differed. Symptom:
the "doc with more matches ranks first" test
flaked roughly 1 in 10 runs depending on the
random-embedding alignment.

The fix is a lexicographic sort: BM25 rank first, RRF
score as the numeric tiebreak. Items missing a BM25
rank (vector-only) sort last. Lexicographic on a rank
vs a float can't have a precision-loss gap. The
`vector search()` also dropped the `s > 0` filter —
the hash-based pseudo-embedding is random, so a
relevant entry can have a negative cosine against a
query that *does* contain the text; filtering those
out meant the entry lost its RRF contribution.

- **fix(memory): stable 4th-layer sort + drop the `s > 0` vec filter**
  (`src/agent/memory-layers.ts`, `src/agent/memory-vector.ts`):
  closes the flake in the "doc with more matches ranks
  first" test. Full suite 592 pass / 0 fail (was 588
  before this session) and stable across 10 consecutive
  runs (was 1-in-10 flaky).

### Bug fix: goal delegation result honors the actual store state on post-state-machine abort

`DelegationManager.runGoalKind` short-circuited to a hard-coded
`status: "failed"`, `iterations: 0` whenever its `signal` was
aborted after the state machine ran — even if the goal had
reached a terminal state (`done`, `failed`, `paused`, etc.)
on the store. The result's `cancelled: true` flag is the right
signal for "an abort happened", but the `status` / `iterations`
fields were misleading: a goal that finished cleanly and then
got a late Ctrl-C was reported as broken.

The fix reads the live state off the goal store, so the
delegation result reflects what actually happened. A goal that
reached `done` and was then cancelled is reported as
`status: "done", iterations: N, cancelled: true`, not as
`status: "failed", iterations: 0, cancelled: true`. Two new
regression tests in `src/__tests__/delegation.test.ts` cover
both the "done then cancel" and "runner throws mid-execute"
paths.

- **fix(delegation): honor actual goal store state on post-state-machine abort**
  (`src/agent/delegation.ts`,
  `src/__tests__/delegation.test.ts`)

### Phase 3 closedout (2026-06-10)

All five Phase 3 production tracks ship on `main` (commits
`b24f94e`, `d34f6fb`, `0fb358b`, `ca7ffc2`, `775766b` +
audit `b041c28`). See the "Shipped" section at the top of
[`docs/phase3.md`](./docs/phase3.md) for the per-track commit
SHAs and scope, and the "Phase 3 (T1–T5)" subsections below
for the per-track changelogs. The deferred items
(D-WORKFLOW-IMPL, D-INSIGHT, D-INK) from the Phase 3 roadmap
remain deferred — D-WORKFLOW-IMPL is sized at L (≈ 1,500 LOC)
in `docs/agnt-workflow-audit.md` §7 and is the next obvious
follow-up plan.

### Phase 3 (T2: vector memory layer)

The 3-layer `MemoryLayerStore` gains a 4th layer — a brute-force
cosine ANN index fused with BM25 via reciprocal-rank fusion
(RRF). Embeddings are cached on disk and the embedder defaults to
a deterministic hash-based pseudo-embedding so the path is
runnable in tests and minimal installs.

- **feat(memory): 4th vector layer + RRF fusion**
  (`src/agent/memory-vector.ts`, `src/agent/memory-layers.ts`,
  `src/config/paths.ts`, `src/__tests__/memory-vector.test.ts`,
  `src/__tests__/memory-layers.test.ts`,
  `docs/phase3.md`): closes the
  Phase 1 `TODO(phase-1)` in `src/agent/memory-layers.ts` and
  the recall-quality pre-step the D-INSIGHT deferral was
  waiting on.

  1. **`src/agent/memory-vector.ts`** — the new module:
     `VectorIndex` (add / search / serialize / load),
     `embedText()` (deterministic hash fallback that derives a
     `Float32Array(64)` from `crypto.createHash("sha256")` of
     the text), `embedTextWithProvider()` (provider hook with
     hash fallback), `cosineSimilarity()`, `loadOrBuildIndex()`
     (re-uses the on-disk cache keyed by line number, re-embeds
     only changed text), and the pure `reciprocalRankFusion()`
     helper (Cormack et al. 2009, `k0 = 60` default). Vectors
     are typed `Float32Array` so the cosine loop is
     allocation-free in the hot path.
  2. **`MemoryLayerStore.search()`** runs BM25 over the full
     corpus (notes + lessons), then a brute-force cosine
     search over the same source list, then fuses the two
     ranked lists with RRF. RRF ties are broken by BM25 rank
     so the existing dense-match BM25 tests stay green
     unchanged. The 3-layer public API stays the same;
     `searchLessons()` is unchanged; legacy substring fallback
     is unchanged. The cache writes through
     `$CH_HOME/memory/MEMORY.embeddings.json` (atomic tmp +
     rename).
  3. **`paths.memoryEmbeddingsFile`** new helper on
     `src/config/paths.ts` — joins `$CH_HOME/memory/` with
     `MEMORY.embeddings.json`.
  4. **Tests** (`src/__tests__/memory-vector.test.ts`,
     16 new tests): cosine on known vectors, hashEmbed
     determinism + content-sensitivity, `VectorIndex` add /
     search / serialize round-trip, brute-force ranking
     matches argmax on a small corpus, RRF on two synthetic
     lists with one overlap + one unique each, RRF on empty /
     single-element input, RRF rejects non-positive `k0`,
     `loadOrBuildIndex` writes the cache on a miss and reuses
     on a hit, `loadOrBuildIndex` re-embeds on changed text,
     `loadOrBuildIndex` rebuilds on a corrupt cache file, and
     `embeddingsFilePath()` resolves correctly.
  5. **Tests** (`src/__tests__/memory-layers.test.ts`,
     3 new tests): fused `search()` recall is no worse than
     BM25 alone (≥1 of fused top-3 overlaps BM25 top-3 on a
     known corpus), fused `search()` is deterministically
     sorted by RRF score, and the embeddings cache file is
     created on the first `search()`.

  Net new tests: 19. The 3-layer test suite in
  `src/__tests__/memory-layers.test.ts` stays green unchanged
  (every pre-existing assertion still holds with the fused
  default — confirmed by full `npm test` pass at 545 / 545 / 0
  fail). `npm run typecheck` is clean.

  Resolves the Phase 1 `TODO(phase-1)` in
  `src/agent/memory-layers.ts`; clears the "need recall
  quality" precondition the D-INSIGHT deferral was waiting
  on. Follow-up tracks can wire a real embedding endpoint via
  `embedTextWithProvider()` without touching the call site.

### Added — Endpoint expansion

External programs (MCP clients, dashboards, scripts) need a
discoverable, complete API surface to drive the harness. This pass
adds ten endpoints on top of the security pass: a discovery index,
the delegation submit + drill-down, agent / skill / session
detail endpoints, the loops list + detail, stream cancellation,
and a tighter error shape contract. Every new endpoint honors the
`CH_HTTP_TOKEN` bearer gate from the security pass; the discovery
index and `/v1/health` stay public.

- **`GET /v1/`** — discovery index. Returns
  `{ name: "codingharness", version, endpoints: Array<{ method,
  path, description, auth: "required" | "none" }> }`. The endpoint
  list is generated from a single source-of-truth `ROUTES` table
  near the top of `src/server.ts`; the new
  `server-expansion.test.ts` cross-checks that every
  `if (req.method === ...)` handler in the file has a matching
  entry, so the index can't drift from reality. Public (no auth),
  like `/v1/health`.
- **`POST /v1/delegations`** — submit a new delegation. Body is a
  discriminated union mirroring `Delegation` in
  `src/agent/delegation.ts`; valid `kind` values are `agent`,
  `goal`, `async_tool`, `mcp`, `plugin`, `api`, `human_approval`,
  `workflow`. The runtime's `DelegationManager.submit()` is called
  and the response is the handle's first four fields
  (`id, status, kind, parentId`). For `human_approval` the
  response is the synchronous `{ approved: boolean }` (the
  manager resolves once the user responds via
  `/v1/approval/respond`, or falls back to `defaultDecision` when
  no `askApproval` is wired). 400 on missing/invalid body.
- **`GET /v1/delegations/:id`** — drill-down. Same shape as the
  list entries (`id, kind, status, parentId, parentChain,
  startedAt, completedAt, createdAt`). 404 if the id is unknown.
- **`GET /v1/agents/:id`** and **`GET /v1/skills/:id`** — detail
  endpoints mirroring `ch agents show <name>` and
  `ch skills show <name>`. Agents return
  `{ name, description, systemPrompt, tools, model? }`; skills
  return `{ name, description, body }` (the full SKILL.md
  contents). 404 if unknown.
- **`GET /v1/sessions/:id`** and
  **`GET /v1/sessions/:id/messages`** — session drill-down. The
  metadata endpoint returns the same shape as the list entries;
  the messages endpoint returns
  `{ messages: Array<{ role, content, timestamp? }> }` via
  `sessionToMessages`. 404 if the id is unknown.
- **`GET /v1/loops`** and **`GET /v1/loops/:id`** — list active +
  recent loops (delegations + spawned sub-agents) and drill down
  into one. The goal kind's response includes the resolved
  `GoalRecord` summary so dashboards don't need a second
  round-trip to `/v1/goals`. 404 if the loop id is unknown.
- **`DELETE /v1/chat/stream/:id`** — abort an in-flight SSE
  stream. The server mints a stream id when `/v1/chat/stream`
  starts (returned in the first `event: stream_id` SSE event)
  and registers its `AbortController` in a server-side map. The
  DELETE handler looks the controller up, calls `.abort()`, and
  the existing `abortOnDisconnect(req)` path propagates the
  signal into `runAgent`. 404 if the id is unknown / the stream
  already finished.
- **Error shape consistency** — every JSON-returning endpoint
  uses `{ error: string }` for failures. `/v1/memory` and
  `/v1/memory/search` still return `text/plain` on success
  (external programs that consume the raw MEMORY.md want the
  text); their error path is JSON.
- **24 new tests** in `src/__tests__/server-expansion.test.ts`
  cover the discovery index, every new endpoint, auth-gated
  401 paths on four of the new routes, the
  unknown-id-returns-404 contract, the stream cancellation
  flow, and the error-shape guarantee.

### Added — Endpoint security

The HTTP API exposed by `ch serve` was hard to use safely from external
programs (MCP clients, dashboards, scripts) — there was no auth, no
body size cap, and a client disconnect during a long chat stream would
leave the in-flight LLM call running to completion. This pass closes
the four most important gaps and adds a public liveness probe.

- **Bearer-token auth, opt-in via `CH_HTTP_TOKEN`**
  (`src/server.ts`): new `authenticate(req)` helper near the top of
  the file. When the env var is set, every `/v1/*` request (except
  `OPTIONS` preflight and `GET /v1/health`) must include
  `Authorization: Bearer <CH_HTTP_TOKEN>`; mismatched or missing
  tokens get `401 { error: "unauthorized" }`. The response is
  always the same generic shape — the configured token is never
  echoed in errors (defense against a misconfigured client
  recovering the secret from the body). When the env var is unset,
  the server is open — exactly the previous behavior. Token compare
  is constant-time to deny a timing oracle.
- **Body size cap, opt-in via `CH_HTTP_MAX_BODY_BYTES`**
  (`src/server.ts`): the request body is capped at 1 MB by default
  for all `readJson` callers; the cap can be tightened or loosened
  with the positive-integer env var. Oversize bodies are detected
  inside the read loop and surfaced as `413 { error: "body too
  large (limit: N bytes)" }`. Rewrote `readJson` to use the
  `data`/`end`/`close` stream events instead of `for await` so the
  throw is observable in `bun` (the for-await iterator was
  swallowing the throw in this runtime).
- **Abort propagation in `/v1/chat`, `/v1/chat/stream`,
  `/v1/spawn`** (`src/server.ts`): the previously-unused
  `new AbortController().signal` default is replaced with a real
  `abortOnDisconnect(req)` controller that fires on the request's
  `close` and `aborted` events. When the client disconnects mid-run
  the SSE stream ends with
  `event: error\ndata: {"text":"aborted"}\n\n` followed by
  `event: done` and `res.end()`. The session append that happens
  AFTER the agent run is guarded — a disconnected client doesn't
  get an orphan assistant entry polluting the next reload's
  session. The server does not crash.
- **`GET /v1/health` liveness probe** (`src/server.ts`): returns
  `200 { ok: true, uptime: process.uptime(), version: "0.2.2" }`.
  Bypasses auth (k8s / load balancer / smoke checks don't carry
  bearer tokens), never reads a body, never blocks. The docstring
  header at the top of the file is updated to list the new
  endpoint and to fix three other drift items (`GET /v1/memory`
  was listed as `POST /v1/memory/read`; `version: "0.2.2"` was
  duplicated; the body-size and auth sections were absent).
- **Tests** (`src/__tests__/server-hardening.test.ts`, new,
  10 tests, 2.9s): cover the four pillars + edge cases. Auth:
  no-token / wrong-token / right-token / malformed-header
  (no token leak in 401 body). Body: 413 on oversize, 200 on
  under-cap. Abort: client disconnect during `/v1/chat/stream`
  with a hanging OpenAI-compatible provider — the test asserts
  the server stays up (`/v1/health` returns 200 after the
  disconnect) and the provider actually got the in-flight
  request (proves we exercised the long-running path, not a
  fast-fail).   Health: returns 200 with the expected shape and
  bypasses auth when `CH_HTTP_TOKEN` is set.

### Fixed

- **Project detection glob bug** (`src/project/init.ts`): the
  Ruby and .NET detection paths used `existsSync(cwd + "/*.csproj")`
  and `existsSync(cwd + "/*.gemspec")` — but `fs.existsSync` does
  not expand globs, so a literal file named `*.csproj` or
  `*.gemspec` was the only thing that would ever match. A real
  Rails project with `rails_demo.gemspec` was silently NOT
  detected as Ruby, and a real .NET project with `MyApp.csproj`
  was silently NOT detected as .NET. Replaced with a
  `readdirSync` + `findFirstFileWithSuffix()` helper. The existing
  Java branch was already correct (literal file names: `pom.xml`,
  `build.gradle`). 4 new tests in `src/__tests__/init.test.ts`
  cover Ruby/Gemfile+gemspec, Ruby-no-gemspec, .NET/csproj, and
  .NET/sln — all of which would have failed before the fix.
- **`ch goals show` and `/goals show` silently dropped half the
  record** (`src/cli.ts`, `src/slash/builtin.ts`): the
  `renderGoalDetail()` function and the slash's `show` branch
  only printed `status`, `steps`, `created`, `updated`, and
  `objective` — the data the user most often needs (`loopStatus`,
  `currentIteration`, `lastError`, `evaluations[]`, `mission`,
  `parentGoalId`, `successCriteria`) was on disk but invisible.
  The fix adds a complete 6-line block (loop + iter), the
  `lastError:` line, the `evaluations (N):` block with per-iter
  pass/fail + score + feedback, the `mission:` and `parent:`
  lines, and the `deliverables:` list. Both the CLI and the
  slash command are fixed in lockstep so the two surfaces never
  drift. 1 new E2E test in `src/__tests__/goals-cli.test.ts` seeds
  a v2 goal with all the new fields, runs `ch goals show`, and
  asserts each one appears in stdout.

### Phase 4 T2 / T3 (extension loader + MCP client) post-merge fixes

Two real bugs found in the new Phase 4 T2 (TS extension loader)
and T3 (real MCP client) merges, both uncovered by the existing
test suite:

- **`mcp-server.handleSse` ignored its `res` argument and
  fished the response out of `req` via an unsafe cast**
  (`src/mcp-server.ts`): the function signature is
  `handleSse(req, res, tools, opts)`, but the body renamed `res`
  to `_res` and then read it back from the request object via
  `(req as unknown as { res: ServerResponse }).res`. That cast
  returns `undefined` (Node's `IncomingMessage` has no such
  property), so the next line took the `if (!res)` branch and
  called `req.destroy()` — silently closing every SSE
  connection. The fix is to use the `res` parameter directly.
  The bug went uncaught because no existing test exercised
  `GET /sse` end-to-end. New regression test in
  `src/__tests__/mcp-server.test.ts` opens an SSE stream,
  reads the `: codingharness mcp stream` comment line, and
  confirms `text/event-stream` content-type. End-to-end
  manual verification: `curl -N http://127.0.0.1:23456/sse`
  now streams the harness's SSE events instead of dropping
  the connection. (Pre-fix: `ECONNRESET` immediately.)

- **`mcp-client.buildEntry` dropped the stdio `cwd` and
  `env` from the persisted `McpServerEntry`**
  (`src/agent/mcp-client.ts`): `mcpGet` accepts `cwd` and
  `env` on `McpGetOpts` and uses them to spawn the
  subprocess for the initial handshake + `tools/list`.
  But `buildEntry(result)` (called by `mcpAdd`) only
  serialized `command` / `args` / `url` and ignored `cwd` /
  `env`. The `McpServerEntry` type already had `cwd?` and
  `env?` fields, `parseEntry` already validated them, and
  `LocalMcpRegistry.openClient` already used them on every
  `callTool` — so the wiring was right, the persistence was
  the gap. Effect: any stdio server added with non-default
  cwd / env (e.g. `ch mcp add <pkg> --cwd /tmp --env
  FOO=bar`, when the CLI gains those flags) would install
  correctly but break on the very first tool call, because
  the registry would re-spawn the subprocess with the
  runtime's cwd + parent env. The fix is to thread `opts`
  through `buildEntry(result, opts)` and persist `cwd` /
  `env` when set. New tests in
  `src/__tests__/mcp-client.test.ts` pin the round-trip:
  `cwd` / `env` are written when supplied, omitted when
  empty, defensive-copied so caller mutations don't bleed
  in, and HTTP entries still ignore the stdio-only fields.


### Phase 4 T4 — D-INK-pre spike

Spike result for the REPL scrollback-pain question deferred from
`phase3.md` §D-INK and `phase2-decisions.md` §Q3. Measures
`repl-v2.ts` against four realistic scenarios (9-voice council
transcript, `/tree` on a 200-node session, 50-msg / 100k-token
compaction preview, and a render-helpers micro-bench) and picks
between (b) `ink` and (c) hand-rolled TS VDOM for a future
`D-INK-IMPL` swap.

- **`docs/ink-spike.md`** — the spike report. Headline numbers:
  9-voice council = 28 lines / 21.5 KB; `/tree` on 200-node =
  202 lines / 68.2 KB (the worst case); compaction preview = 54
  lines / 5.2 KB; render helpers = 0.0175 ms/turn (perf is NOT
  the pain point). Pain is bounded but real — missing folding,
  in-place replacement, alt-screen isolation, and semantic
  search. **Recommendation: (c) hand-rolled TS VDOM** when
  `D-INK-IMPL` ships, because the project's zero-runtime-dep
  contract is sacred and `ink` would add `react` +
  `react-reconciler` (~1.68 MB) + `scheduler` + `yoga-layout` +
  ~20 transitive deps (~3-5 MB total). **T4.5 itself is
  deferred** until user-adoption signals land (re-trigger
  criterion documented in `phase4.md` §T4.5 + `ink-spike.md`).
- **`scripts/bench-repl-pain.mts`** — reproducible measurement
  harness. Imports the actual `repl-v2.ts` render helpers (no
  mocks), seeded RNG (mulberry32, seed `20260617`), 200 LOC.
  Run any time with `npx tsx scripts/bench-repl-pain.mts` —
  outputs JSON to stdout, human summary to stderr. Useful for
  re-running against future REPL changes (Phase 5+ additions
  to the transcript surface) to catch a pain spike before users
  do.
- **`docs/phase4.md`** — status line updated to "T1 + T2 + T3 +
  T4 SHIPPED". T4.5 section updated with the (c) recommendation
  and the re-trigger criterion.

No production code changed. No new npm deps added. 785 tests
across 53 files still pass; `npm run typecheck` clean.

### `/tree --depth=N --limit=N` — the worst-case scrollback pain, tamed

The T4 spike above identified `/tree` on a 200-node session
(202 lines / 68.2 KB) as the worst scrollback case in the
current REPL. The deferral to T4.5 was the "swap the renderer"
track, but a 1-line flag on the slash command addresses the
*user pain* without waiting on a VDOM rewrite:

- **`renderSessionTree(entries, headId, opts?: { depth?; limit? })`**
  (`src/slash/tree-render.ts`): both knobs default to
  `undefined` (unlimited — preserves the v0.2.x output for
  every existing call site and the existing 5-test suite). The
  `walk` function:
  - Stops recursing once `depth` is hit and emits a single
    `(… N more below — pass --depth=K+1 to expand)` leaf so
    the user sees the omission count + a one-keystroke fix.
  - Stops emitting lines once `limit` is hit and appends a
    one-line `(truncated at N lines — pass --depth=K or
    --limit=K to expand)` footer so the user can tell
    truncation happened and how to expand.
  - The two compose: if the limit fires first, no depth leaf
    is ever emitted; if the depth cap fires first, the
    truncation footer is still appended when the cap is hit.
- **`treeCommand.run(args, ctx)`** (`src/slash/builtin.ts`):
  parses `--depth=N` and `--limit=N` from the args string in
  any order, validates each as a positive int in a sane
  range (`depth: 0..1000`, `limit: 1..10_000`), and threads
  them through to `renderSessionTree`. Bad / unknown flags
  return a one-line usage hint rather than silently rendering
  the unfiltered tree (the exact scrollback-pain case the
  flag exists to prevent).
- **4 new tests in `src/__tests__/tree-render.test.ts`** pin
  the behavior: `depth=0` emits only the root + leaf,
  `limit=3` produces 3 lines + footer, `limit=100` on a
  3-entry tree is a no-op (no footer), and `depth + limit`
  compose (limit fires first → no depth leaf).

**End-to-end verification** (4-entry linear session with
`head = last`):

```
$ /tree                          # default — 4 lines
└─ → r  10:11:53  message  root
   └─ → a  10:11:53  message  L1
      └─ → b  10:11:53  message  L2
         └─ ● c  10:11:53  message  L3

$ /tree --depth=0                # 1 line + 1 leaf
└─ → r  10:11:53  message  root
       (…3 more below — pass --depth=1 to expand)

$ /tree --depth=1                # 2 lines + 1 leaf
└─ → r  10:11:53  message  root
   └─ → a  10:11:53  message  L1
          (…2 more below — pass --depth=2 to expand)

$ /tree --limit=2                # 2 lines + 1 footer
└─ → r  10:11:53  message  root
   └─ → a  10:11:53  message  L1
(truncated at 2 lines — pass --depth=K or --limit=K to expand)
```

The flags don't paper over the deeper T4.5 problem
(folding / in-place replacement / alt-screen) but they do
make a 68 KB scrollback runnable in 2 lines + a footer.
Recommended default for power users: alias `/tree` →
`/tree --limit=50` in their REPL config.

### MCP: `McpGetResult.resolved` now surfaces `cwd` / `env`

`src/agent/mcp-client.ts`: the `McpGetResult.resolved` type
gained optional `cwd?: string` and `env?: readonly string[]`
fields, populated from the `McpGetOpts` the caller passed to
`mcpGet`. The fields are also written into the persisted
`McpServerEntry` by `buildEntry(result, opts)` (already fixed
in the prior commit) and forwarded through the CLI's
`ch mcp get --json` / `ch mcp add --json` outputs so a
preview can see exactly what `ch mcp add` would persist.
HTTP transports still ignore both fields (stdio-only). Dead
`onError?` field on the stdio `pending` map removed.

### Dead code + doc drift cleanup

- **`ExtensionRegistry.dispatch('preSystemPrompt')` comment
  was wrong** (`src/agent/extensions/registry.ts`): the
  doc claimed the dispatch returns `string | undefined` and
  the loop falls back to `input.system` on non-string. In
  fact, the dispatch always returns a string (the input is
  echoed back when no handler transforms). Updated the
  comment to describe the actual contract.
- **`LocalMcpRegistry.openClient` had a dead `signal`
  parameter** (`src/agent/mcp-registry.ts`): the body
  contained a no-op spread (`...{ /* signal forwarded via
  timeoutMs below */ }`) that suggested the signal was
  wired through. It wasn't — the stdio transport doesn't
  honor an in-progress abort. Renamed the parameter to
  `_signal` and added a doc comment explaining the
  timeout-only contract.
- **`HarnessRuntime` constructor comment was misleading**
  (`src/runtime.ts`): the doc said "Tests can pass a
  different `filePath` here by overriding `paths.mcpJson` via
  the `MCP_CONFIG_PATH` env var". The env var doesn't
  override `paths.mcpJson` — it overrides
  `resolveMcpConfigPath()`, which is what
  `LocalMcpRegistry` actually reads. Updated the comment
  to point at the right surface.

789 tests pass / 0 fail across 53 files; `npm run typecheck`
clean. (The +4 from this commit: `--depth=0`,
`--limit` truncates, `--limit` no-op, `--depth + --limit`
compose.)


### Tool correctness + perf pass

Five real bugs found in tool code while reading the new Phase 4
T2/T3 + localpi port merges. All have regression tests that fail
without the fix.

- **`read.ts` offset/limit sliced the truncated body, not the
  original file** (`src/agent/tools/read.ts`): when a caller
  asked for `offset=3000, limit=5` on a 1 MB file, the OLD
  code first truncated to `readMaxBytes` (the first 200 KB),
  then sliced the truncated body. The result was an EMPTY body
  with a nonsensical header `lines 3000-644 of 644:` (the 644
  was the truncated line count, not the original). Fix: slice
  first on the full text, truncate as a last-resort byte cap on
  the already-sliced chunk. Line numbers now always match the
  original file. Same change also handles `offset=5000` on a
  5-line file with a clear `(offset 5000 is past the end of
  the file (6 lines))` header instead of the previous
  `lines 5000-5004 of 6:` (start > end).
- **`write.ts` / `edit.ts` leaked `<path>.<rand>.tmp` on
  rename failure** (`src/agent/tools/write.ts`,
  `src/agent/tools/edit.ts`): the atomic write creates a
  `tmp` file, writes, renames. If `rename` failed (e.g. the
  target is a directory, or the FS is full), the OLD code
  returned an error but left the `tmp` orphan next to the
  target — visually noisy in the working tree, harmless but
  embarrassing. Fix: track `tmp` locally, unlink in the catch
  block. New regression test pre-creates the destination as a
  directory (forces rename to fail) and asserts no orphan
  `.tmp` remains.
- **`http.ts` materialized the full response body before
  applying `max_bytes`** (`src/agent/tools/http.ts`):
  `await res.arrayBuffer()` loaded the entire response into
  memory, THEN the cap was applied. A hostile / runaway
  1 GB response would OOM the harness. Fix: stream-read
  `max_bytes + 1` via `res.body.getReader()` and cancel the
  stream at the cap. New regression test races `httpTool.run`
  with a 3-second timeout — pre-fix the run hung past the
  server's keep-alive; post-fix it returns in ~30ms with the
  truncation footer.
- **`ls.ts` was O(n) sequential `stat()` calls on a 2000-entry
  dir** (`src/agent/tools/ls.ts`): each `await stat(...)` was
  a separate roundtrip, making `ls` on a maxed-out dir take
  2-5 seconds on macOS. Fix: pre-stat every FILE entry with
  `Promise.all`. Same time, same output. Also fixes a
  follow-on bug where `raw.max_entries ?? MAX_ENTRIES` was
  needed because the OLD `count >= raw.max_entries` check
  treated `undefined` as no-cap, but the new
  `slice(0, raw.max_entries + 1)` math turned undefined into
  `NaN + 1 = NaN`, producing an empty list. New test exercises
  the raw-call path (`tool.run` without `validate`) to pin
  the fallback.
- **`runAgent` leaked the `turnSignal` timer on the
  successful-turn path** (`src/agent/loop.ts`): the
  `timedSignal(parent, requestTimeoutMs)` was created per
  attempt, disposed in the catch block (failover, user-abort)
  but NOT in the success path — the `for await` completed
  normally, `break outer` exited the loop, and the
  `setTimeout(..., requestTimeoutMs)` kept the event loop
  alive for up to `requestTimeoutMs` (default 5 min) after
  every successful provider turn. Fix: wrap the per-attempt
  block in `try / finally` so `turnSignal.dispose()` runs on
  every exit path.

### Dead code / doc cleanup

- **`ToolRegistry._registerRaw` was identical to
  `register()`** (`src/agent/tools/registry.ts`,
  `src/agent/tools/index.ts`): both did
  `this.tools.set(t.spec.name, t)`. The "internal" prefix
  was a comment, not a constraint. Merged into one method.
  Three call sites updated.
- **`bash.ts` `__approval_bypass = true` was dead code**
  (`src/agent/tools/bash.ts`): after the user approved via
  the `askFn` callback, the OLD code set the bypass on the
  local `raw` object, but the rest of the function runs the
  command without re-checking the bypass (the check is at
  the top of the function). The bypass is for SUBSEQUENT
  invocations, but those get a new `raw` from `validate()`
  which strips the field. Removed the no-op assignment and
  rewrote the comment to describe the actual contract (the
  bypass IS honored when the field is present, e.g. in
  direct `tool.run` calls — the cost-approval test covers
  that path). The runtime's `allow-always` decision is
  already persisted to `settings.approval.allowlist` by
  `runtime.ts:782`; the per-call bypass is only meaningful
  for one-shot test / programmatic re-runs.
- **`HarnessRuntime.readTodo()` returned the internal array
  by reference** (`src/runtime.ts`): callers could mutate
  `runtime.todoItems` by splicing the returned array. The
  current call sites don't, but the surface was unsafe.
  Returns `this.todoItems.slice()` now.

797 pass / 0 fail across 53 files; `npm run typecheck` clean.
(The +3 from this commit: read offset/limit on full text,
read past-the-end header, write rename-failure orphan
cleanup, http stream-cancel, ls parallel stat + undefined
fallback. The -1 is the merge of `register` /
`_registerRaw`.)


### Storage atomicity + tmp-orphan cleanup pass

While reading the workflow / memory / session / store code I
found four places that did "write to a sibling `.tmp` then
rename" but had gaps in the failure path that could leave
orphan `.tmp` files. Pattern is the same as the prior
`writeTool` / `editTool` fix: a successful `writeFileSync`
followed by a failed `renameSync` leaks the `.tmp` until the
user cleans up manually. All four fixed; the regression test
from the prior commit's pattern (force a rename failure by
pre-creating the destination as a directory) is in
`src/__tests__/workflow-e2e.test.ts` and pins the workflow
case end-to-end. The other three are smaller, with the same
orphan-cleanup shape.

- **`WorkflowStore.createOrUpdate()` + `writeMeta()` leaked
  `<id>.json.tmp` + `<id>.json.meta.json.tmp` on rename
  failure** (`src/agent/workflow-store.ts`): the same
  `writeFileSync(tmp, ...); renameSync(tmp, f);` pattern as
  `write.ts` / `edit.ts`, with no try/catch. Fixed both
  call sites — the main `createOrUpdate()` and the private
  `writeMeta()` sidecar writer. New regression test in
  `workflow-e2e.test.ts` pre-creates `<id>.json` as a
  directory and asserts no `.tmp` remains after the throw.
- **`GoalStore.writePersisted()` had the same pattern**
  (`src/agent/goals.ts`): the `writeFileSync(tmp, ...);
  renameSync(tmp, file);` was sync and uncaught. A failed
  rename leaked the `.tmp` next to the goal state file. Fixed
  with the same try/catch.
- **`mcp-store.writeMcpConfigUnlocked()` had the same
  pattern** (`src/agent/mcp-store.ts`): the `writeFileSync +
  renameSync` is async and uncaught. Fixed.
- **`Session.persistMeta()` wrote `<file>.meta.json`
  non-atomically** (`src/agent/session.ts`): a pre-fix
  `await writeFile(metaPath, ...)` could leave a half-written
  meta on disk if the process died mid-write. `loadSession`
  would then fail to parse the meta and fall back to
  defaults — losing the user's `head` pointer and
  parent-session id. Fixed with tmp + rename. Also removed
  the dead `void tmp;` in `persistEntry()` (the variable
  was assigned but never used — the O_APPEND write doesn't
  need a tmp).
- **`exportSession()` wrote the trajectory non-atomically**
  (`src/agent/trajectory.ts`): `ch session export` would
  leave a half-written `.jsonl` if the process died
  mid-write. Fixed with tmp + rename.
- **`memory-layers.atomicWrite()` had a partial cleanup**:
  the `writeFileSync(tmp, ...)` was outside the try/catch, so
  a `writeFileSync` failure (disk full) left the `.tmp` on
  disk. Moved inside the try; the existing rename-failure
  direct-write fallback now also unlinks the `.tmp` in its
  success path.

### Dead import cleanup

- `compaction.ts` had `import { withTimeout }` and
  `ProviderStreamEvent` from previous iterations that no
  longer had call sites. Removed.

### Provider: `parseSSE` flushes partial tool calls on stream error

`src/providers/openai-compat.ts`'s `parseSSE` had a tidy happy
path and a tidy `[DONE]` path, but the *error* path — the
catch block around the inner `await reader.read()` loop —
returned without emitting any of the accumulated
`partialToolCalls`. Result: when an upstream provider died
mid-stream (broken pipe, malformed SSE chunk, host reset)
between a `tool_calls` delta and the final `finish_reason`,
the consumer saw *only* the `{type:"error"}` event and lost
the call entirely. The downstream loop in `src/agent/loop.ts`
also couldn't dispatch a tool call it never received, so the
model's intent (e.g. "please run `bash` to …") silently
vanished. The fix mirrors the post-loop flush at the end of
`parseSSE` (gated on `finishReason` there, but unconditional
on the error path because we have no reason to think the
in-progress call is invalid — just incomplete). Args that
never reached a parseable JSON shape are emitted with the
literal `"{}"` fallback, matching the existing convention.
New regression test in `src/__tests__/omni-providers.test.ts`
constructs a pull-based `ReadableStream` that delivers one
SSE event with unclosed tool-call args, then errors on the
next read, and asserts that the consumer receives a
`tool_call` event *before* the `error` event and that no
`done` event ever lands.

812 pass / 0 fail across 53 files; `npm run typecheck` clean.
(The +1 from this commit: parseSSE partial-tool-call-flush test.)


## Unreleased — Phase 3 (T3: D-WORKFLOW source audit)

Closes the Phase 1 spike's open research item
(`plans/plan_phase1/notes/agnt-port-plan.md:620`) — "I did not read
`WorkflowManipulationService.js` end-to-end." The audit ships; the
implementation port remains out of scope and lands as
`### D-WORKFLOW-IMPL — Workflow real port` in a Phase 3.5/4
follow-up plan.

- **docs(delegation): D-WORKFLOW source audit + port plan**
  (`docs/agnt-workflow-audit.md`, `docs/phase3.md`): research-only
  deliverable. Reads ≈ 4,000 LOC of agnt-gg source
  (`WorkflowEngine.js`, `NodeExecutor.js`, `EdgeEvaluator.js`,
  `ParameterResolver.js`, `CustomToolExecutor.js`,
  `WorkflowService.js`, `WorkflowManipulationService.js`,
  `WorkflowRoutes.js`, `WorkflowModel.js`, the three control
  nodes, the example `automated_email_summarizer.json`, and the
  `WorkflowForge` Vue screen) end-to-end. Documents the workflow
  DSL shape (single JSON blob in a `workflow_data` TEXT column,
  no schema), enumerates the step-type vocabulary (trigger /
  custom / stop-workflow / action / utility / widget / control /
  mcp, dispatched by file lookup with a plugin fallback — **no
  formal registry**), traces the load → validate → execute flow
  (HTTP controller → IPC → forked child process → ProcessManager
  → ProcessWorker → WorkflowEngine → NodeExecutor with
  EdgeEvaluator + ParameterResolver), maps every agnt-gg step
  type to the closest `Delegation` kind in our 8-kind union
  (`workflow` is the natural top-level container; triggers and
  control-flow nodes have **no** direct analog and either get a
  new `trigger` property on `WorkflowDelegation` or live inside
  the workflow kind), catalogs the 19-route HTTP manipulation
  surface (mapped 1:1 to 14 `ch workflow *` CLI subcommands),
  lists 5 open questions for the follow-up, and sizes the port
  at **L (≈ 1,500 LOC)** with a file-by-file breakdown: 6 new
  files in `src/agent/` (`workflow.ts`, `workflow-graph.ts`,
  `workflow-steps.ts`, `workflow-eval.ts`, `workflow-store.ts`,
  `workflow-types.ts`), 3 new test files, modifications to
  `src/agent/delegation.ts` (replace the `workflow` stub at
  `delegation.ts:1112-1115` with a real `runWorkflowKind`,
  expand `WorkflowDelegation` with a `trigger` field, and widen
  the `DelegationResult` for `workflow`), `src/runtime.ts`
  (wire the engine factory, mirror T1's `runGoalAgent` wiring),
  `src/cli.ts`, and `src/slash/builtin.ts`. The audit explicitly
  drops the agnt-gg child-process IPC architecture
  (`WorkflowProcessBridge` + `WorkflowProcess` + `ProcessManager`
  + `ProcessWorker`, ≈ 880 LOC combined) and the versioning
  service (`WorkflowVersionService.js`, 357 LOC) from the v1
  port. Trigger listeners that need to survive a CLI exit
  (webhooks, timers) are out of scope for v1; `ch workflow run`
  is synchronous. No production code ships in this track.


## Unreleased — Phase 3 (T1: goal delegation real path)

The `goal` kind in the 8-kind `Delegation` union is no longer a
dispatcher stub — it drives the state machine for real.

- **feat(delegation): wire the goal kind for real**
  (`src/agent/delegation.ts`, `src/agent/goals.ts`,
  `src/agent/loops/goal.ts`, `src/runtime.ts`,
  `src/__tests__/delegation.test.ts`,
  `docs/phase3.md`): closes the
  Phase 1 deferred item "the real 'run a goal through the
  manager' path lands in a follow-up that wires `runtime.runAgent`
  here." The goal kind now goes through the same lifecycle as
  any other kind: `submit()` returns a handle, `events()` emits
  planning / executing / done / failed transitions, `result()`
  resolves to the final `loopStatus`, and a per-call `signal`
  forwarded from the manager cleanly aborts the inner LLM
  call (so `cancelAll(parentId)` works end-to-end on goal
  delegations).

  1. **`DelegationRuntimeDeps.runGoalAgent`**
     (`src/agent/delegation.ts`): new optional slot on the
     deps interface. Signature is the existing
     `GoalRunAgentFn` from `src/agent/goals.ts` — `(phase,
     context, signal?) => Promise<{ content, steps }>`.
     `signal` is a new optional 3rd parameter (existing
     2-arg call sites still typecheck). When the dep is
     absent, `runGoalKind` returns a `failed` delegation
     with a clear "no goal runner wired" reason rather than
     throwing — lets slim test fixtures skip the runner.
  2. **`runGoalKind` real path** (`src/agent/delegation.ts`):
     replaces the throwing stub from the Phase 1 port with
     the real `runGoalAgent` dep. The state machine is
     driven for real; the goal's `loopStatus` reaches
     `done` / `re-planning` / `failed` based on the model's
     outputs. The pre-existing `onGoalEnter("executing")`
     hook (which dispatches sub-delegations) is suppressed
     for the goal we just created — without this, the goal
     delegation kind would infinite-recurse: goal →
     executing → submit → goal → executing → submit → ...
     The dedup key in `onGoalEnter` is `goal.id +
     ":" + currentIteration`; we pre-register the
     `(id, iter=1)` key when we create the goal.
  3. **`HarnessRuntime.buildRunGoalAgent()`**
     (`src/runtime.ts`): builds the closure the manager
     uses. Mirrors the CLI's `ch goal` `callAgent`
     (`src/cli.ts:runGoalCmd`) — per-phase system prompt
     via `runtime.buildSystemPrompt()`, the runtime's
     tool registry, the configured `defaultProvider` /
     `defaultModel`, the per-call `signal` (forwarded from
     the manager), and the runtime's failover chain. Wired
     in the `HarnessRuntime` constructor:
     `new DelegationManager({ ..., runGoalAgent:
     this.buildRunGoalAgent() })`.
  4. **`RunGoalOptions.signal`** (`src/agent/goals.ts`):
     new optional field, forwarded to both `runAgent` calls
     inside `runGoalStateMachine` so a parent cancellation
     cleanly aborts the inner LLM call. Backward-compatible
     — the existing CLI flow uses its own AbortController
     and doesn't pass one.
  5. **Tests** (`src/__tests__/delegation.test.ts`):
     `makeDeps` factory now injects a stateful stub
     `runGoalAgent` (planning → "1. read\n2. ship\nReady
     to execute."; executing → "done. GOAL COMPLETE") so
     every existing test that exercises the goal kind
     drives a full lifecycle. The pre-existing "goal kind
     dispatches a goal through the store" test is
     reworked to assert `loopStatus === "done"` and
     `res.iterations === 1` (the stub-throw assertion is
     gone). 3 new tests:
     - `goal kind returns a clear failure when no
       runGoalAgent is wired` — slim-fixture contract.
     - `goal kind drives a full lifecycle to done via a
       stateful runner` — planning + executing logs
       observed, `loopStatus === "done"`, store reflects
       `complete`.
     - `goal kind respects the per-call abort signal` —
       slow runner + aborted signal lands in a
       non-`done` terminal state (not "done", not crash).
  6. **`docs/phase3.md`**: new roadmap ratifying T1
     (this track), T2 (vector memory layer), and T3
     (D-WORKFLOW source audit research). The Phase 1
     spike noted `agnt-port-plan.md §6.3` that the
     workflow tier port needed a fresh end-to-end source
     audit; T3 closes that research gap.

  Net new tests: 3. The `delegation.test.ts` "goal kind
  dispatches..." test is reworked, not added. Test count
  moves from 518 → 521; gate stays clean (`typecheck`
  clean, `build` clean, `bun test` 521 / 521 / 0 fail).

  Resolves the Phase 1 plan §6.1 follow-up
  ("dispatcher stub" → "real goal path"); unblocks Q6
  (skills allowlist on `GoalDelegation` — the field
  already exists via `DelegationBase`, and a follow-up
  track can now pass it through to the planner / spawned
  subagents without first having to wire the runner);
  enables the `maxCostUsd` cap to actually fire on goal
  delegations end-to-end.

## Unreleased — Phase 3 (T5: goal followups — Q6 skills + maxCostUsd cap)

Two follow-ups on the goal delegation kind, both unblocked
by the T1 real-path track:

- **feat(delegation): skills allowlist on goal kind (Q6)**
  (`src/agent/delegation.ts`, `src/agent/goals.ts`,
  `src/__tests__/delegation.test.ts`): closes the
  forward-side of Q6 (skills allowlist on `GoalDelegation`).
  The `DelegationBase.skills` field was already shipped in
  Phase 2's `feat(delegation): real impls` PR and forwarded
  to `SubAgentManager.spawn({ skills })` for the `agent`
  kind, but the `goal` kind's runner didn't pass it
  through. `runGoalKind` now stamps `work.skills` on the new
  `GoalRecord` (`goalStore.add({ skills })`) and the
  `onGoalEnter("executing")` hook reads it back to thread
  the same allowlist into the sub-delegation's `submit()`
  payload. A parent goal with `skills: ["http", "search"]`
  therefore spawns a sub-goal that exposes the same
  allowlist to its runner, unless the sub-delegation
  explicitly overrides `skills` on its own work. The
  `DelegationBase.skills` JSDoc documents the inheritance
  contract.

  1. **`GoalRecord.skills?: string[]`**
     (`src/agent/goals.ts`): new optional field, threaded
     through `GoalStore.add({ skills })`. v1 / v2 records
     load fine without the field — backwards compat.
  2. **`runGoalKind` stamps the allowlist**
     (`src/agent/delegation.ts`): reads `work.skills` and
     forwards it into the new `GoalRecord` via
     `goalStore.add({ ... work.skills !== undefined ? { skills } : {} })`.
  3. **`onGoalEnter("executing")` threads the allowlist**
     (`src/agent/delegation.ts`): the per-iteration
     sub-delegation's `submit()` payload now includes
     `goal.skills` (when set) so the sub-spawn inherits the
     parent's allowlist. The hook doc explains the
     forward-side and the override escape hatch.
  4. **Tests** (`src/__tests__/delegation.test.ts`):
     three new tests — (a) the onGoalEnter sub-delegation
     inherits the parent goal's `skills: ["http", "search"]`
     when the parent sets it; (b) a goal without `skills`
     produces a sub-delegation with `skills` undefined
     (backwards compat — no field is set on the work);
     (c) end-to-end `runGoalKind` path: submitting a goal
     delegation with `skills` stamps the field on the
     persisted `GoalRecord`.

- **feat(delegation): maxCostUsd cap on goal kind**
  (`src/agent/delegation.ts`, `src/agent/goals.ts`,
  `src/__tests__/delegation.test.ts`): wires Q7 (cost
  guardrails on goals) for the goal delegation kind.
  The `agent` kind already enforces `maxCostUsd` via the
  `CostTracker`; the `goal` kind runs the state machine
  across multiple `runGoalAgent` calls (planning +
  executing per iteration, repeated up to `maxIterations`),
  so the cap needs to fire on the *cumulative* cost.
  `runGoalKind` now wraps the `runGoalAgent` closure so
  each call's optional `usage` is recorded on a
  per-delegation `CostTracker` (or the runtime's shared
  tracker when injected) and the cap is checked after
  every phase. When the cap fires the goal record is
  stamped with `status: "failed"` +
  `lastError: "maxCostUsd cap exceeded: $X.XX"`, the state
  machine is broken via a thrown error, and the manager
  surfaces the same message on the delegation's new
  optional `error` field.

  1. **`GoalRunAgentFn` return shape**
     (`src/agent/goals.ts`): the per-call return value
     gains an optional `usage?: { inputTokens; outputTokens }`
     field. Runners that don't track usage (test stubs,
     custom integrations) simply omit it; the manager
     records zero for that call and the cap is a no-op for
     the run. The shape matches `AgentRunResult.usage`
     from `src/agent/loop.ts` so
     `HarnessRuntime.buildRunGoalAgent()` can plumb
     `result.usage` straight through with a one-line
     change (a follow-up to update the production runner
     lives outside this track).
  2. **`runGoalKind` cap enforcement**
     (`src/agent/delegation.ts`): wraps `runGoalAgent` so
     each call's `usage` is recorded on the
     `CostTracker`, the cumulative `cost` is checked
     against `work.maxCostUsd`, and when exceeded the
     goal record is updated with
     `{ status: "failed", lastError: msg, loopStatus: "failed" }`
     and the state machine is broken via `throw`. The
     outer try/catch (already present in the manager)
     swallows the throw; the manager reads the goal's
     final state and surfaces the cap message on the
     delegation's new `error` field.
  3. **`DelegationResult` for goal kind**
     (`src/agent/delegation.ts`): gains an optional
     `error?: string` field so callers can read the cap
     message (or any other structured failure reason
     recorded on the goal's `lastError`) directly from
     the result, matching the `agent` kind's shape.
  4. **Tests** (`src/__tests__/delegation.test.ts`):
     four new tests — (a) cap fires when cumulative
     cost exceeds it: a stub returning
     `{500_000 in / 500_000 out}` per call at
     `gpt-4o-mini` pricing (=$0.375) with a $0.001 cap
     fails the goal with the expected
     `maxCostUsd cap exceeded: $X.XX > $Y.YY` message on
     both the delegation's `error` field and the goal
     record's `lastError`; (b) no cap, same usage —
     completes normally, no cap error; (c) high cap
     ($1.0) — cumulative $0.75 doesn't fire; (d) cap
     present but stub returns no `usage` — no false
     cap hit, goal completes normally.

  Net new tests: 7 (3 for skills forwarding + 4 for
  maxCostUsd cap). Test count moves from 526 → 533;
  gate stays clean (`typecheck` clean, `build` clean,
  `bun test` 533 / 533 / 0 fail).

  Closes Q6 (skills allowlist on the goal kind) and Q7
  (cost guardrails on goals) end-to-end on the
  delegation path. The follow-up that updates
  `HarnessRuntime.buildRunGoalAgent()` to plumb
  `result.usage` through the closure lives in a separate
  track — without it, the production cap enforcement
  fires only on runners that explicitly return `usage`.

## Unreleased — Goals (revert + semantic replan + multi-mission)

Two related changes to the goal lifecycle land in the same release:

- **feat(goals): /revert CLI + semantic identical-replan guard**
  (`src/agent/goals.ts`, `src/cli.ts`,
  `src/__tests__/goals-semantic-replan.test.ts`,
  `src/__tests__/goals-cli.test.ts`): ships the Q4 revert
  granularity recommendation and the Phase-2 semantic
  replan guard from
  `plans/plan_phase1/notes/agnt-port-plan.md` §6.2 Q4 and
  §6.1 Risk 4.

  1. **`ch goals revert <id> --to <n>`** — wires the Q4
     recommendation: revert to a specific `currentIteration`.
     The CLI parses `--to` (and the equals form `--to=N`),
     defaults to 1 ("revert the last step"), and rejects
     non-positive integers as a usage error. The store's
     `revert(id, to, opts)` now accepts an optional
     `opts.targetIteration`; the existing `currentIteration: 0`
     default is preserved for backward compatibility. The
     subcommand is in the `ch goals` help text and in the
     `ch help` "Inspect & manage" group. `--json` emits the
     reverted record.

  2. **Semantic identical-replan guard** — replaces the
     surface-text check in `runGoalStateMachine`'s re-planning
     branch with a normalized comparison: lowercase, whitespace
     strip, token sort, then compare. Two new helpers,
     `normalizeForSemanticCompare(s)` and
     `isSemanticallyIdentical(a, b)`, plus a stable
     `SEMANTIC_IDENTICAL_REPLAN_REASON` constant. When the
     runner detects a semantically identical plan on a
     re-planning iteration, it aborts with
     `status="failed"`, `loopStatus="failed"`, and writes the
     reason to a new optional `GoalRecord.lastError` field
     (also recorded as an evaluation with feedback carrying
     the same reason). This catches the common LLM failure
     mode where the planner regenerates the same plan in
     different surface form ("Run tests" vs "run  tests"),
     which the old byte-equal check missed.

  New tests: 6 in `goals-semantic-replan.test.ts` (helpers +
  state-machine integration, including the canonical
  "Run tests" / "run  tests" case) and 13 in
  `goals-cli.test.ts` (direct `GoalStore.revert` with
  stubbed records + end-to-end subprocess tests of the CLI
  command, default, equals form, usage errors, runtime
  errors, and JSON output). One pre-existing test
  (`goals: runGoalStateMachine reaches re-planning on
  failed evaluation`) was updated to produce distinct plans
  on each iteration — the old stub's identical-content
  plans now correctly trigger the guard, which is the
  intended behavior.

- **feat(goals): multi-mission support + `goals/` directory split**
  (`src/agent/goals.ts`, `src/agent/loops/mission.ts`,
  `src/agent/loops/goal.ts`, `src/agent/council.ts`,
  `src/config/paths.ts`, `src/runtime.ts`, `src/cli.ts`,
  `src/__tests__/goals-mission.test.ts`): adds the Q2 + Q10
  pieces — multiple missions per process, one active at a time,
  scoped to a per-mission state file. The runtime carries the
  active mission; the CLI exposes it via `--mission <id>` on
  `ch goal`, `ch goals`, and `ch council`.
  - **`GoalStore({ mission })`** (`src/agent/goals.ts`):
    per-mission isolation. Two stores for two missions see
    two different files (`$CH_HOME/goals/<mission>/state.json`)
    and never share records. New records are stamped with the
    active mission. The legacy `{ file }` option is preserved
    as a test escape hatch (no per-mission path, no migration).
  - **Directory split** (`src/config/paths.ts`): `paths.goals`
    is kept as a sentinel for the legacy single-file. New reads
    and writes go through `paths.goalsMissionFile(mission)`.
    The default mission triggers a one-time migration on
    first access: a `$CH_HOME/goals.json` v1/v2 file is moved
    to `$CH_HOME/goals/legacy/state.json` (records stamped
    with `mission: "legacy"`) and the original is unlinked.
  - **`--mission <id>` CLI flag** (`src/cli.ts`): added to
    `buildContext` and forwarded through `SubcommandContext`
    to the runtime. `ch goal`, `ch goals`, and `ch council`
    accept it; the help text is updated. `ch goals list` now
    prints `Goals in mission "<id>" (N):` so the active
    mission is visible in the output. The `ch council` /
    `councilAsGoalLoop` path also threads `mission` through
    so a council deliberation shows up in the same mission
    as the goal flow that spawned it.
  - **`runtime.mission`** (`src/runtime.ts`): the active mission
    is surfaced as a public readonly on `HarnessRuntime`,
    defaulting to `DEFAULT_MISSION` ("default"). The runtime
    constructs its `GoalStore` with `{ mission: this.mission }`
    so all per-mission behavior flows from a single source.
  - **13 new tests** (`src/__tests__/goals-mission.test.ts`)
    covering: per-mission file isolation, cross-mission
    invisibility, mission stamps round-tripping through
    disk, the `<direct>` test escape hatch, the legacy
    v1/v2 single-file migration (default-mission only),
    no-clobber when the "legacy" mission already exists,
     v1 `loopStatus = "pending"` backfill, and the path
     shape (`$CH_HOME/goals/<mission>/state.json`).

## Unreleased — OpenTUI optional

- **chore(deps): move @opentui/core to optionalDependencies** +
  **refactor(tui): make @opentui/core load lazily**
  (`package.json`, `package-lock.json`, `src/cli.ts`, `src/ui/tui-app.ts`):
  the OpenTUI-based legacy TUI is reachable via `ch tui --legacy` (or
  `CH_FORCE_TUI=1`) and is not on the default code path — the default
  REPL is the streaming REPL. Move `@opentui/core` from `dependencies`
  to `optionalDependencies` so `npm install` succeeds on
  minimal/server installs that don't need the TUI. Combined with the
  refactor, loading `cli.ts` / `tui-app.ts` no longer transitively
  requires the package: the `createTui` import in `tui-app.ts` is now
  a dynamic `await import()` inside `runTui`, and `cli.ts` wraps the
  `runTui()` call with a try/catch that falls back to the streaming
  REPL with a clear warning when the package is missing. Verified:
  `npm run typecheck` clean, `npm test` (bun) shows the same
  pre-existing `test() inside another test()` limitation as `main`
  (filtered: 39/39 pass across tui, cli-wireup, council, loops,
  doctor), `npm run build` produces `dist/cli.js` with zero static
  imports of `@opentui/core`, and `ch --help` works with the package
  uninstalled. Users who explicitly run `ch tui --legacy` on a
  minimal install see a one-line warning:
  `warning: the legacy OpenTUI TUI requires @opentui/core, which is
  not installed. Falling back to the streaming REPL. To enable the
  legacy TUI, run: npm install @opentui/core` (or use
   `ch repl` / `ch repl --no-tui`).

## Unreleased — Council

- **feat(council): 9 deliberation voices (was 4)**
  (`src/agent/council.ts`, `src/__tests__/council.test.ts`): the
  built-in council grows from 4 to 9 voices by adding 5
  deliberation perspectives tailored to a multi-agent coding
  harness — `security` (The Sentinel, weight 1.2), `performance`
  (The Tuner, weight 1.0), `dx` (The Advocate, weight 0.8),
  `qa` (The Verifier, weight 1.0), and `domain` (The Domain
  Expert, weight 0.9). `Councilor` now carries an optional
  `name` (display name) and `weight` (deliberation weight);
  weights surface in the synthesizer's system prompt as a
  `"Voice weights:"` line so synthesis can lean on higher-weight
  voices. `DEFAULT_COUNCIL_ROSTER` is unchanged (3 voices) to
  preserve the existing minimal default; callers opt into the
  full 8-deliberator council by passing the new voices
  explicitly. A table comment above `BUILTIN_COUNCILORS`
  documents all 9 voices. 4 new tests assert the count is 9,
  every voice has a non-empty system prompt + name + positive
  weight, the new voices have distinct prompts, the full
  8-deliberator roster + synthesizer produces 9 transcript
  entries in consensus mode, and the synthesizer's system
  prompt includes the voice weights. All 9 pre-existing council
  test cases stay green.

## Unreleased — Web UI panels (goalList + delegations)

- **feat(web): goalList + delegations panels**
  (`src/server.ts`, `src/web/{index.html,styles.css,app.js}`,
  `src/__tests__/web-panels.test.ts`): adds two new read-only panels
  to the web UI. The **goals panel** lives in the left sidebar
  beneath the active sub-agents list — each goal renders as a
  clickable row showing status, loop status, id, truncated
  objective, steps taken, and time-ago. Clicking a row opens the
  **right-side goal detail pane** (a third grid column), which
  surfaces the plan / latest output, success criteria (the goal's
  "world state"), evaluation history (with score + pass/fail
  coloring), and a list of sub-goals (also clickable for
  navigation). The **delegations panel** is a bottom strip above
  the composer that lists active + recent `DelegationRun`s with
  their kind, status (color-coded + pulsing for `running`),
  start/end timestamps, and a parent chain that walks back through
  other delegations and goal-store entries. Two new HTTP
  endpoints power the panels:
    - `GET /v1/goals` — list (or `?id=<id>` for one + its
      children, or `?active=1` for only pending + in_progress).
      Response envelope matches the rest of `/v1/*`:
      `{ goals: GoalRecord[] }` or
      `{ goal: GoalRecord, children: GoalRecord[] }`. The store
      auto-loads `goals.json` on boot, so the panel populates
      immediately.
    - `GET /v1/delegations` — list `DelegationRun`s. The raw
      `DelegationRun` handle has a `result()` Promise and an
      `events()` AsyncIterable (neither JSON-serializable), so the
      endpoint maps each run to a plain object carrying only
      `id`, `kind`, `status`, `parentId`, `parentChain` (a
      leaf→root walk that also resolves parent goals from the
      `GoalStore`), `startedAt`, `completedAt`, `createdAt`. No
      mutation endpoints — the manager is driven by `/goal`,
      `/spawn`, and the approval flow, not by the panel.
  Both panels use the existing dark-mode CSS variables
  (`--bg`, `--fg`, `--cyan`, `--green`, `--red`, `--yellow`,
  `--magenta`, `--border`, etc.) and the existing `.row` /
  `.sidebar-list` / `.sidebar-empty` patterns where they fit.
  The grid template gets a 3rd column (`.app.is-goal-open` →
  `260px 1fr 360px`) when a goal is selected and reverts when
  the detail pane is closed. Refresh cadence is 5s for both
  panels (matches the goal state machine's heartbeat). The
  delegations strip auto-hides when the manager is empty, so the
  composer reclaims the bottom of the chat. A new
  `src/__tests__/web-panels.test.ts` (6 tests) spawns the real
  `ch serve` on a free port, pre-seeds `goals.json`, and asserts
  the response shape for both endpoints (empty case, seeded
  parent + child goals, `?id=<id>` detail with children, 404 on
  unknown id, `?active=1` filtering). All 430 tests pass;
  `npm run typecheck` is clean.

## Unreleased — Delegation

- **feat(delegation): real impls for mcp/api/plugin kinds + maxCostUsd + skills allowlist**
  (`src/agent/delegation.ts`, `src/agent/subagent.ts`,
  `src/__tests__/delegation.test.ts`,
  `src/__tests__/delegation-stubs.test.ts`): replaces 3 of the 4
  Phase 2 stubs (`mcp`, `plugin`, `api`) with real runners;
  `workflow` remains a stub per the port plan's 2-3 week track.
  The `mcp` kind now consults a new narrow `McpRegistry`
  interface injected via `DelegationRuntimeDeps.mcpRegistry`
  (the runtime wires a default; tests inject stubs). Unknown
  server ids surface as `status: "failed"` with a clear reason
  listing the known servers. The `api` kind uses Node's
  built-in `fetch` (no new deps) with a default 30s timeout
  override-able via `timeoutSeconds`; default body is
  `{ prompt, context, timeoutSeconds }` and can be replaced
  with a raw `body`. GET / DELETE requests send no body. The
  `plugin` kind dynamically imports `$pluginHome/<id>.{js,ts}`
  (default `$CH_HOME/plugins`; override via
  `DelegationRuntimeDeps.pluginHome`), invoking the tool by
  name from the plugin's `tools` map. A new
  `maxCostUsd?: number` on `DelegationBase` enforces a hard
  cost cap on the `agent` kind: the manager uses a
  `CostTracker` (per-delegation by default; or the runtime's
  own tracker when injected on `DelegationRuntimeDeps.costTracker`)
  and aborts when the cap is exceeded, surfacing
  `status: "error"` + `error: "maxCostUsd cap exceeded: $X.XX"`.
  A new `skills?: string[]` on `DelegationBase` is forwarded
  to `SubAgentSpawnInput.skills` for the `agent` kind; the
  `SubAgentManager` echoes it back on `SubAgentResult.skillsUsed`
  so the caller can verify the allowlist was passed through.
  The SubAgentManager's own integration with the SkillRegistry
  is a follow-up — v1 of this allowlist is a contract assertion
  on the wire. 20 new tests in
  `src/__tests__/delegation-stubs.test.ts` cover: mcp tool
  call with right args + unknown server + non-ok result; api
  POST/GET body shape + non-2xx surfaces; plugin load +
  invoke + missing file/tool + bad export + tool exception;
  maxCostUsd fires when the run exceeds the cap (single-run
  + cumulative-tracker) and does not block kinds without
  model calls; skills allowlist is forwarded to
  SubAgentManager.spawn and is optional.

## Unreleased — Delegation

- **feat(delegation): discriminated union over worker kinds (agent,
  goal, async-tool, mcp, plugin, api, human-approval)**
  (`src/agent/delegation.ts`, `src/runtime.ts`,

- **feat(delegation): discriminated union over worker kinds (agent,
  goal, async-tool, mcp, plugin, api, human-approval)**
  (`src/agent/delegation.ts`, `src/runtime.ts`,
  `src/__tests__/delegation.test.ts`): ports the
  `delegate(work, ctx)` entry point from
  `plans/plan_phase1/notes/agnt-port-plan.md` §2. `DelegationManager`
  is the single dispatcher for sub-work. Each submission returns a
  `DelegationRun` handle with `events()`, `result()`, `cancel()`,
  and the manager records `parentId` so `cancelAll(parentId)`
  walks the delegation tree. The union covers 8 kinds; Phase 1
  implements `agent` (delegates to `SubAgentManager.spawn`),
  `goal` (dispatches via `runGoalStateMachine`), `async_tool`
  (single-shot, schedule field reserved for periodic Phase 2),
  and `human_approval` (asks via `deps.askApproval` or falls
  back to `defaultDecision`). The remaining four (`workflow`,
  `mcp`, `plugin`, `api`) are Phase 2 stubs but live in the
  union so the discriminator exhausts at compile time. The
  manager's constructor subscribes a `onEnter("executing")` hook
  to the goal store, so when a goal enters `executing` (including
  sub-goals) the goal lifecycle observes the union instead of
  going through `subagent.spawn()` directly. The new
  `runtime.delegations: DelegationManager` exposes the manager
  on `HarnessRuntime`. 12 new tests cover the union narrowing
  (compile-time exhaustive switch), run/observe/cancel happy
  paths for all 4 implemented kinds, the goal-loop
  `onEnter("executing")` → `delegate` integration for subgoals,
  the Phase 2 stub kinds, the parent→child cancel tree, and a
  regression check that the `agent` kind still produces the same
  `SubAgentManager.spawn()` result.

## Unreleased — Onboard OAuth

- **fix(onboard): make the first-run wizard provider-agnostic so
  xai/grok/minimax can actually use OAuth**
  (`src/web/app.js`, `src/web/index.html`, `src/web/styles.css`):
  the wizard used to hardcode the "Sign in with ChatGPT"
  device-code button to `codex` only. Picking `xai`, `grok`, or
  `minimax` (all of which advertise `authModes: ["oauth",
  "apiKey"]` with `defaultAuthMode: "oauth"`) left the user
  with an API-key-only form and no path to use OAuth. The fix
  replaces the codex-only branch with a small segmented control
  ("API key" / "OAuth") that's shown for any provider that
  advertises both modes. The Codex path keeps its device-code
  button; the other three render an OAuth-token paste input
  with a "Get a token at <authLaunchUrl>" link to the
  provider's auth docs. The selected mode is honoured by the
  "save & test" button — OAuth saves via `/v1/settings` with
  `oauthToken` + `authMode: "oauth"` and then runs `/v1/diag`;
  apiKey continues to use `/v1/provider/set-key`. The OAuth
  option's label is provider-specific ("ChatGPT OAuth",
  "xAI OAuth", "MiniMax OAuth", "Grok OAuth") so the user
  always knows which auth they're picking. Also surfaces
  catalog-fetch failures inside the wizard (previously the
  dropdown silently went empty with no diagnostic) so future
  "empty dropdown" reports are diagnosable from a screenshot.

- **fix(server): serve `/onboard-helpers.js`**
  (`src/server.ts`): the hardcoded static-asset allowlist at
  the top of the request handler listed `styles.css`, `app.js`,
  and the favicons but not `onboard-helpers.js`, so the browser
  was 404ing the helper file on every page load. The wizard's
  tiered optgroups fell back to inline defaults, masking the
  bug. Now `/onboard-helpers.js` is served alongside the other
  static assets.

- **fix(onboard-helpers): avoid duplicate-const SyntaxError and
  remove the broken `export { ... }` block**
  (`src/web/onboard-helpers.js`): the file declared
  `PROVIDER_GROUP_LABELS` and `PROVIDER_TIER_ORDER` at top
  level, then the trailing `export { ... }` block made it a
  hard SyntaxError when loaded as a classic script (which is
  how the browser loads it via `<script src=...>`). The error
  aborted the rest of `app.js`, so the wizard's first-run
  detection never ran — the dropdown stayed empty and the
  catalog fetch never happened. Wrapped the file in an IIFE
  so the constants are scoped and the file works as both a
  classic script (for the browser) and a CommonJS module (for
  the `web-onboard-helpers.test.ts` test that imports the
  helpers). The unit test still passes (425/425 in the full
  suite).

## Unreleased — Goals

- **feat(goals): real lifecycle state machine (plan→execute→evaluate→re-plan)**
  (`src/agent/goals.ts`, `src/cli.ts`, `src/__tests__/goals.test.ts`):
  ports the AGI-loop shape from `agnt-gg/agnt` per
  `plans/plan_phase1/notes/agnt-port-plan.md` §1. `goals.json` is
  no longer a one-shot record. Each goal now lives in a `GoalState`
  machine — `pending → planning → executing → evaluating →
  re-planning → done | failed`, with `paused` orthogonal. New APIs
  on `GoalStore`: `transition()`, `pause()`, `resume()`, `revert()`,
  `spawnSubgoal()`, `subscribe({ onEnter, onExit })`,
  `recordEvaluation()`. The store validates every state move through
  `canTransition(from, to)` (throws `GoalTransitionError` on illegal
  edges; a non-throwing `checkTransition()` is exported for CLI
  guards). A simple `evaluate(goal)` pass/fail heuristic matches the
  goal's `successCriteria.deliverables` keywords against the
  agent's `finalText` (>= 70% hit = pass). `runGoalStateMachine()`
  walks the state machine, calling a pluggable `GoalRunAgentFn` for
  the planning + executing steps and `evaluate()` in between; on
  `GOAL COMPLETE` / `GOAL BLOCKED` strings from the agent it
  short-circuits to `done` / `failed`. `ch goal` (`runGoalCmd` in
  `src/cli.ts`) now drives the state machine end-to-end against the
  configured provider, calling `runAgent` from `src/agent/loop.ts`
  on each iteration. Schema bumped from v1 → v2 in the persisted
  envelope; v1 records load in-memory unchanged (defaults
  `loopStatus = "pending"`). 22 new tests cover the legal/illegal
  transition table, lifecycle hooks, subgoal spawn with parent
  linkage persisted, pause/resume/revert round-trips, eval scoring,
  and a stateful-stub `runGoalStateMachine` lifecycle test.

## Unreleased — Loops

- **feat(loops): unified `Loop<Mission|Goal|Agent|Workflow|Tool>`
  hierarchy; council becomes a GoalLoop with parallel AgentLoops**
  (`src/agent/loops/{loop,mission,goal,agent,workflow,tool,index}.ts`,
  `src/agent/council.ts`, `src/cli.ts`,
  `src/__tests__/loops.test.ts`): ports the loop-tier collapse
  from `plans/plan_phase1/notes/agnt-port-plan.md` §3. The five
  tiers (mission → goal → agent → workflow → tool) now share a
  single `Loop<K extends LoopKind, I, O>` discriminated-union
  shape with a uniform `run(input, ctx): Promise<output>` method.
  Per-tier factories: `missionLoop()` (perpetual; instantiates a
  GoalLoop and resumes matched active goals from the `GoalStore`),
  `goalLoop()` (drives the state machine; supports `goal` to
  resume an existing record), `agentLoop()` (wraps `runAgent` and
  bridges the agent's hooks into the loop's hooks), `workflowLoop()`
  + `bugFixWorkflow()` (the canonical 4-step
  `reproduce→diagnose→patch→test` pattern, threading state
  between steps), `toolLoopFromRegistry(registry, name)` (thin
  wrapper over `ToolRegistry.get(name).run()` with `validate()`).
  `src/agent/loops/index.ts` exports the `AnyLoop` union, the
  `LOOP_KINDS` array, the `is*` type guards, and the per-tier
  factories. `src/agent/council.ts` adds `councilAsGoalLoop()` —
  a `Loop<"goal">` that drives a council deliberation as one
  goal (the CLI's `ch council` keeps its rich transcript path
  through `runCouncil()`; the goal-loop shape makes council
  visible in `ch goals list`). `src/cli.ts` `ch loop` registers
  the `MissionLoop` for lifecycle observability; `ch goal`
  registers the `GoalLoop` factory. 13 new tests cover the
  union narrowing (compile-time exhaustive switch on `kind`),
  the type guards, `LOOP_KINDS` spec order, `MissionLoop` create
  vs resume paths, `GoalLoop` driving the state machine with a
  stateful stub to `done`, `AgentLoop` matching `runAgent`
  behavior with a stateful stub, `WorkflowLoop` running the
  4-step pattern and threading state, `ToolLoop` success + unknown
  tool, `councilAsGoalLoop()` returning a `Loop<"goal">` and
  driving a goal, and a regression check that the existing
  `runCouncil` API still works after the refactor. All 13
  loops tests + the existing council/goals/agent-loop/delegation
  suites pass; no regressions.

- **feat(loops): wire the CLI commands through the Loop<*> factories
  (`ch goal` → `goalLoop().run()`, `ch council` → `councilAsGoalLoop().run()`),
  re-export `goalLoop`/`GoalLoop` from `src/agent/goals.ts` and
  `agentLoop`/`AgentLoop` from `src/agent/loop.ts`** (`src/cli.ts`,
  `src/agent/goals.ts`, `src/agent/loop.ts`,
  `src/__tests__/cli-wireup.test.ts`): lands the runtime integration
  that the loops/ library alone does not provide. `runGoalCmd` no
  longer drives `runGoalStateMachine` directly — it constructs a
  `Loop<"goal">` via the canonical factory, passes the `runAgent`
  bridge (the existing callAgent closure) and the `GoalStore` as
  loop input, and reads the final goal from `out.goal` /
  `out.finalText`. `runCouncilCmd` drives the council deliberation
  through `councilAsGoalLoop().run()`; the rich transcript output
  (synthesizer's final answer + per-councilor log) is preserved by
  performing the actual `runCouncil()` call inside the loop's
  `runAgent` bridge, so `ch council <q> --json` and the human
  transcript render identically to the pre-wireup CLI. `ch loop`
  retains its re-prompt semantics (a slash-command surface, not
  an objective-driven mission); the `missionLoop()` factory is
  available as the canonical MissionLoop surface for callers that
  want a perpetual / resume-aware goal driver. The re-exports in
  `goals.ts` and `loop.ts` mean `import { goalLoop } from
  "./agent/goals.js"` and `import { agentLoop } from
  "./agent/loop.js"` are the canonical surfaces — callers and
  external consumers no longer need to reach into the `loops/`
  subdir. 5 new tests in `src/__tests__/cli-wireup.test.ts` cover
  the re-exports, the goal lifecycle through the re-exported
  factory, the council goal loop with a stub bridge, and a
  `DEFAULT_LIMITS` regression. All 77 tests across the 5 critical
  files (loops, goals, council, delegation, cli-wireup) pass
  green; full `npm run typecheck` clean.

## [Unreleased]

### Added — REPL

- **Codex/Claude-Code/DuckHive-style streaming REPL replaces the
  OpenTUI TUI as the default** (`src/ui/repl-v2.ts`,
  `src/cli.ts`, `src/__tests__/repl.test.ts`): the new `ch`,
  `ch chat`, `ch tui`, and `ch repl` surfaces all default to a thin
  streaming REPL in the spirit of Codex CLI / Claude Code /
  OpenClaude / DuckHive. Layout matches `plans/plan_phase1/notes/
  agnt-port-plan.md` §4: a 1-line header, a scrolling transcript of
  user / assistant / thinking / plan / tool / info / error entries,
  a multi-line `ch › ` prompt at the bottom, and a 1-line status
  footer (`<model> · <tokens> · <steps> · <wallclock> · session · /help`).
  Multi-line input uses `\` + Enter to continue and Enter alone to
  send. Slash commands route through the same `BUILTIN_REGISTRY`
  the legacy TUI used, so the two surfaces can't drift. Tool calls
  render as inline `[tool] name k=v k=v` callout boxes that appear
  in-stream, not in a side panel. Uses `node:readline` only — zero
  new dependencies. The legacy four-pane OpenTUI TUI is still on
  disk and reachable via `ch tui --legacy` (or `CH_FORCE_TUI=1`).
  Honors `CH_FORCE_REPL=1` to force the new REPL and
  `CH_FORCE_TUI=1` to force the legacy TUI (per the spec's
  test matrix in §4.8).

- **Phase-1 AGI-loop porting blueprint** (`plans/plan_phase1/notes/
  agnt-port-plan.md`): 679-line spike document covering goal
  lifecycle (§1), sub-agent delegation union (§2), loop
  hierarchy (§3), REPL simplification spec (§4, the source of
  truth for this entry), backwards-compatibility plan (§5), and
  risks / open questions (§6). Branch `phase1/spike`; commits
  `c6af9b6` and `f814eaa`.

- **`/redo` slash command + `HarnessRuntime.undoLastTurn()` /
  `redoLastTurn()` pair + redo stack** (`src/runtime.ts`,
  `src/slash/builtin.ts`, `src/slash/registry.ts`,
  `src/__tests__/undo-redo.test.ts`): the existing `/undo` slash
  command rewound the session directly via the file API, with no
  record of the rewound-to prompt — so the user could undo, but
  not redo. The new `redoStack: string[]` on the runtime
  remembers up to 10 undone prompts (LRU-evicted). `/undo` now
  pushes the rewound-to prompt onto the stack; `/redo` pops and
  re-sends through `runUserTurn()`. Cleared on session switch
  and on `clearHistory()`. Counted by `getRedoStackDepth()` for
  the TUI status bar.

- **`/steer` real implementation + `AsyncToolQueueStore` crash
  resilience** (`src/agent/steer.ts`, `src/agent/delegation.ts`,
  `src/ui/repl-v2.ts`, `src/slash/builtin.ts`,
  `src/runtime.ts`, `src/config/paths.ts`,
  `src/__tests__/steer.test.ts`,
  `src/__tests__/async-tool-queue.test.ts`): replaces the
  `/steer not yet implemented` warning at `repl-v2.ts:473`
  with a real `SteerQueue` (push / peek / drain + `applied`
  EventEmitter), and adds disk persistence to the
  `async_tool` delegation kind.
  - **`SteerQueue`** (`src/agent/steer.ts`, 162 LOC): FIFO
    queue of `SteerEntry { id, text, queuedAt }`. `drain()`
    emits one `applied` event per entry; the REPL's
    `submitUserInput` hook reads the drained text and
    appends it to the last tool result message at the next
    turn boundary (the `OrchestratorService.js /steer`
    pattern from `plans/plan_phase1/notes/agnt-port-plan.md`
    §4). The REPL footer shows `steer: <preview>` while
    the queue is non-empty.
  - **`/steer <id> | /steer list | /steer clear` slash
    command** (`src/slash/builtin.ts`,
    `src/slash/registry.ts`): targeted removal — `/steer
    <id>` pops one queued entry, `/steer list` shows ids +
    previews, `/steer clear` empties the queue.
  - **`AsyncToolQueueStore`** (`src/agent/delegation.ts`,
    645+340 LOC, `paths.asyncToolQueue` =
    `$CH_HOME/async-tool-queue.json`): atomic tmp+rename
    JSON file, replay on `DelegationManager` startup. The
    `executeFunction` contract is now documented as
    **idempotent** (callers must check-and-short-circuit
    any side-effectful work; pure functions are trivially
    idempotent). The replay path is best-effort and
    detached — a failure on replay does not crash the
    manager.
  - 29 new tests in `src/__tests__/steer.test.ts` and
    `src/__tests__/async-tool-queue.test.ts` covering:
    push/peek/drain, append-to-last-tool-result, kill
    mid-run → restart → replay, idempotency, and the
    failure path.
  - 1-line test correction: restore the
    `assert.equal(handle.status, "failed")` assertion in
    `async-tool-queue.test.ts`. Originally removed in a
    misread post-mortem; the assertion is correct under
    the `DelegationRun` live-getter pattern from 0637a25
    (toHandle's `get status() { return r.status; }`
    forwards to the mutated internal state).

### Fixed

- **TUI still used `runtime['buildSystemPrompt']()` bracket
  notation** (`src/ui/tui-app.ts:212`): replaced with the public
  `runtime.buildSystemPrompt()` method (made public in the prior
  release). Same fix as the three call sites in `cli.ts` and
  `server.ts`.
- **`grep` tool's `include` filter was tested against the full
  file path** (`src/agent/tools/grep.ts:81`): the spec says
  "Glob-ish filter: only files whose name matches", but the
  code passed the full path. `*.ts` therefore only matched
  top-level `.ts` files (because the regex starts matching from
  the search root). Now strips to the basename before testing,
  so `*.ts` matches every TypeScript file anywhere in the tree —
  matching the documented behavior.
- **`.opencode/` and `.opencode/tmp/` were not gitignored**
  (`.gitignore`): the runtime's per-session work-dir (ch-export
  scratch space, node compile cache, etc.) was leaking into
  `git status`. Added both paths.

- **OpenRouter first-class provider preset**
  (`src/providers/presets.ts`,
  `src/__tests__/provider-presets.test.ts`,
  `src/cli.ts`): adds `openrouter` to the hosted tier so a
  single `OPENROUTER_API_KEY` unlocks the whole 100+ model
  catalog (OpenAI, Anthropic, Google, Meta, Mistral, and
  friends) through OpenRouter's `https://openrouter.ai/api/v1`
  OpenAI-compatible endpoint.
  - Default model hint: `anthropic/claude-3.5-sonnet`.
  - Honors `OPENROUTER_BASE_URL` / `OPENROUTER_MODEL` env
    overrides for users running a proxy or pinning a model.
  - Listed in `ch provider list` and the `/provider`
    slash-command catalog (already first-class because
    `presets.ts` is the single source of truth).
  - 4 new unit tests in
    `src/__tests__/provider-presets.test.ts` covering the
    preset shape, hosted-tier presence, env override
    behavior, and the missing-key fallback.

- **Persisted `/goal` lifecycle (Codex-style goal tracking)**
  (`src/agent/goals.ts`, `src/config/paths.ts`, `src/cli.ts`,
  `src/slash/builtin.ts`,
  `src/__tests__/goals.test.ts`): the existing `/goal`
  slash command and `ch goal` CLI subcommand ran in-memory
  only — once the run finished, the transcript, status, and
  result evaporated. Goals are now persisted to
  `$CH_HOME/goals.json` so the user can list past goals,
  inspect their outcome, and recover mid-run goals after a
  harness crash.
  - **`GoalStore`** (`src/agent/goals.ts`, 182 LOC):
    append-only `goals.json` with atomic tmp+rename writes.
    Status lifecycle: `pending → in_progress → complete |
    blocked | failed`. Public API: `add`, `update`, `get`,
    `list`, `listActive`, `remove`, `clear`, `markInProgress`,
    `recordStep`.
  - **`ch goals` CLI subcommand** (`src/cli.ts`): `list`,
    `show <id>`, `remove <id>`, `clear` (purges terminal
    goals). `--json` flag for `list`. Same vocabulary as
    DuckHive's persisted goal system.
  - **`/goals` slash command** (`src/slash/builtin.ts`):
    TUI/REPL equivalent. `list` shows active goals first
    with a hint to `show` for terminal ones.
  - **`runGoal` integration** (`src/slash/builtin.ts`):
    creates the goal record at start, increments
    `stepsTaken` on each step, marks `complete`/`blocked` at
    end. Best-effort: a write failure prints a warning and
    falls through to the existing in-memory run, so goal
    mode still works on a read-only filesystem.
  - **`paths.goals` config** (`src/config/paths.ts`): new
    `goals.json` path under `$CH_HOME`.
  - 16 unit tests in `src/__tests__/goals.test.ts` covering
    add/update/remove/clear, status lifecycle, atomic write
    recovery on corrupt file, id format, list sort order,
    and terminal-goal filtering.

- **Council: multi-agent deliberation (`ch council` + `/council`)**
  (`src/agent/council.ts`, `src/cli.ts`, `src/slash/builtin.ts`,
  `src/agent/agents.ts`, `src/__tests__/council.test.ts`): Phase 0
  of the Agent-Teams + DuckHive feature merge. Ships a minimal
  but real council: 4 built-in councilors (skeptic, builder,
  researcher, synthesizer) and 2 deliberation modes (consensus,
  adversarial).
  - `ch council "<question>" [--mode consensus|adversarial]
    [--rounds N] [--json]` runs the deliberation and prints the
    final synthesized answer. `--json` returns the full transcript
    + usage. The CLI bridges to the existing `SubAgentManager`
    so per-councilor provider/model routing + tool allowlists
    + session isolation all work for free.
  - `/council <question> [--mode=consensus|adversarial]` is the
    slash-command counterpart for the TUI/REPL. It uses
    `sendPromptWithCapture` per councilor (best-effort v0 — the
    CLI is the rich path).
  - `AgentRegistry.register(def)` now allows programmatic
    registration of ephemeral agent definitions (built-ins are
    still protected).
  - 9 unit tests in `council.test.ts` cover: built-in presence,
    consensus vs adversarial round counts, round-2 prompt carries
    the round-1 transcript, synthesizer always last, empty-input
    rejection, empty-roster rejection, all-synthesizer rejection,
    and the human-readable renderer.

- **First-class vllm + vllm-omni providers + live `/v1/models`
  discovery across all surfaces**
  (`src/providers/presets.ts`, `src/providers/registry.ts`,
  `src/types.ts`, `src/server.ts`, `src/cli.ts`,
  `src/slash/builtin.ts`, `src/slash/registry.ts`,
  `src/web/index.html`, `src/web/styles.css`, `src/web/app.js`,
  `src/__tests__/provider-presets.test.ts`,
  `src/__tests__/info-endpoints.test.ts`): ships the
  vllm-omni / vllm / LM Studio / codex OAuth direction end-to-end.
  - **`vllm` preset** (`http://127.0.0.1:8000/v1`,
    `optional` auth): the canonical local vLLM
    OpenAI-compatible server. API key only required when the
    server was started with `--api-key`.
  - **`vllm-omni` preset** (`http://127.0.0.1:8090/v1`,
    `optional` auth): vLLM-Omni is the vllm-project
    omni-modality framework (text/image/audio/video +
    diffusion). vllm-omni already speaks OpenAI-compat at
    `/v1/chat/completions` and exposes a `/v1/models`
    discovery endpoint, so the harness treats it as a
    first-class local server — no Python sidecar needed for
    chat. Default model hint is
    `Qwen/Qwen3-Omni-30B-A3B-Instruct`. Omni-specific
    endpoints (`/v1/image/`, `/v1/audio/`, `/v1/video/`,
    `/v1/tts/`) are documented in the preset description;
    native TS provider classes for those are deferred to a
    follow-up since they require non-OpenAI-compat wire
    formats.
  - **`codex` now accepts `oauth` auth mode** in addition
    to `apiKey`: paste a session token from a prior
    OpenAI Codex device-code flow via `CODEX_OAUTH_TOKEN` /
    `OPENAI_OAUTH_TOKEN` / `CODEX_TOKEN` (or `settings.json`
    `oauthToken` field). The full device-code flow itself
    remains a follow-up — this round just makes the
    token-accepting path first-class so users with an
    already-acquired token aren't stuck.
  - **`/provider models [id]`** slash command, **`ch
    provider models [id]`** CLI subcommand, and
    **`GET /v1/provider/models?id=<id>`** HTTP endpoint:
    all three call the provider's `listModels()` (which
    hits `/v1/models`) and render the discovered list.
    Defaults to the current default provider when no id is
    given. The web UI Settings panel gains a **"fetch
    /v1/models"** button that calls the same endpoint and
    lets the user pick a model from a dropdown that
    populates the model field.
  - **SlashRuntime now exposes `providerRegistry`**
    (`src/slash/registry.ts`) so non-default provider
    lookups work from `/provider models <id>` without
    instantiating a fresh `HarnessRuntime`.
  - 4 new tests cover: vllm + vllm-omni presets exist with
    openai protocol + optional auth; codex preset supports
    oauth; vllm provider configures from a base URL with
    no API key; `/v1/provider/models` returns 200 with an
    array even when the server is unreachable (network
    errors are swallowed, same as the slash path).

- **`/v1/todo` HTTP endpoints + web todo sidebar** (`src/server.ts`,
  `src/web/index.html`, `src/web/styles.css`, `src/web/app.js`,
  `src/__tests__/info-endpoints.test.ts`): round 2 of the
  `/todo` work. The slash + CLI surfaces were shipped in the
  previous commit; this round exposes the in-session todo
  list over HTTP and surfaces it in the web sidebar so the
  user can see what the agent is working on and add/remove
  items without typing a command.
  - `GET /v1/todo` — returns the current list
  - `POST /v1/todo` — `{ items }` replaces, `{ action: add,
    item }` appends, `{ action: clear }` empties
  - The endpoints share `HarnessRuntime.readTodo()` /
    `writeTodo()` with the slash + CLI surfaces, so all
    three read from the same backing array.
  - The web sidebar renders the list with × buttons to
    remove items and an inline input that adds a new item
    on Enter. Refreshes every 10s and immediately after
    add/remove. Mirrors the slash + CLI behavior.
  - 5 new tests cover: GET empty, POST with items replaces,
    POST `action=add` appends, POST `action=clear` empties,
    POST missing fields returns 400.

- **`/todo` slash command + `ch todo` CLI subcommand**
  (`src/slash/builtin.ts`, `src/cli.ts`, `src/runtime.ts`,
  `src/slash/registry.ts`, `src/__tests__/slash.test.ts`):
  the `todo` tool existed (the agent could call it) but the
  user had no way to view or edit the in-session todo list
  from the slash palette or CLI. Now both surfaces give the
  same operations: `list` (default), `add <text>`,
  `set <text>...` (with `|` separator for multi-word items,
  whitespace fallback when no `|`), and `clear`.
  - `HarnessRuntime.readTodo()` and `HarnessRuntime.writeTodo()`
    are the new entry points. They write to the same
    `todoItems` array the agent's `todo` tool reads from, so
    the next agent turn sees the user's manual edits.
  - 5 new tests pin: empty placeholder, add appends +
    reports count, set with `|` separator handles multi-word
    items, set with whitespace falls back to word splitting,
    and clear empties the list.

- **Web first-run onboarding modal** (`src/web/index.html`,
  `src/web/styles.css`, `src/web/app.js`): web users no longer
  hit a silent "no provider" state on first launch. The
  modal auto-opens when the app loads with no provider
  configured, walks the user through a 3-step wizard
  (pick provider → paste key → save & test), and re-shows
  after 30 days if the user previously dismissed it. A
  new "first-run setup" sidebar button (hidden when a
  provider is set) gives a manual re-entry point.
- **`/v1/info`, `/v1/provider/catalog`, `/v1/provider/set-key`
  HTTP endpoints** (`src/server.ts`, `src/web/app.js`,
  `src/__tests__/info-endpoints.test.ts`): the same
  first-run support surfaces that work on the TUI/CLI
  now also work over HTTP. Dashboards, MCP clients, and
  the web's onboard wizard all read from these endpoints
  so the three surfaces (slash command, CLI subcommand,
  HTTP endpoint) can never drift.
  - `GET /v1/info` — runtime snapshot (version, paths,
    provider, model, thinking level, approval mode)
  - `GET /v1/provider/catalog` — provider catalog with
    auth modes, env vars, default models, docs URLs
  - `POST /v1/provider/set-key` — non-interactive key
    save, runs a best-effort /diag in the back so the
    UI gets instant feedback
  - 6 new tests spawn a real server in a child process
    and exercise the wire end-to-end
- **First-run `/onboard` + `ch onboard` wizard** (`src/slash/builtin.ts`,
  `src/cli.ts`, `src/runtime.ts`, `src/ui/tui-app.ts`,
  `src/__tests__/slash.test.ts`): the harness used to silently
  boot with no provider and wait for the user to set env vars
  or hand-edit `settings.json`. Now `/onboard` (or `ch onboard`)
  walks the user through a 3-step plan: pick a provider from
  the catalog, save an API key, and run `/diag` to confirm
  the connection works. On a configured install the same
  command prints a one-line "you're all set" summary and
  points at `/provider` for changes.
  - `HarnessRuntime.isFirstRun()` is the new testable predicate
    behind the first-run banner. The TUI prints a one-line
    nudge on launch when no provider is configured so the
    user discovers `/onboard` even if they never type `/help`.
- **`/provider` setup wizard** (`src/provider/setup.ts`,
  `src/slash/builtin.ts`, `src/cli.ts`, `src/runtime.ts`,
  `src/__tests__/slash.test.ts`): the previous `/provider`
  was a one-liner that only fast-switched. Now it's a real
  guided setup flow:
  - `/provider` with no args shows current + setup hint
    (different message on first run)
  - `/provider list` shows the provider catalog with auth modes
  - `/provider setup <id>` prints a one-provider setup card
    (base URL, model, env var, docs link, two ways to give me
    the key)
  - `/provider setup <id> <key>` saves the key, runs `/diag`
    automatically, and reports first-byte / total latency
  - `/provider <id> [model]` still works as the fast switch
  - `ch provider set-key <id> <key>` is the non-interactive
    escape hatch for scripts
  - `HarnessRuntime.saveProviderApiKey()` is the new entry
    point behind all of this. It validates the key isn't
    empty / too short, persists to `settings.json`, and
    invalidates the cached provider so the new key is picked
    up on the next call. Surfaced as an optional
    `saveProviderApiKey?()` on `SlashRuntime` so non-runtime
    hosts can mock it.
  - 6 new tests cover the wizard: list, one-line save + diag,
    bad-key error, unknown provider, setup card, no-args-on-
    first-run.

- **Enter to send in the TUI** (`src/ui/tui.ts`,
  `src/__tests__/tui.test.ts`): OpenTUI's default bindings had
  Enter = newline and Meta+Enter = submit, which surprised
  every new user who pressed Enter to send a prompt. The
  textarea's `keyBindings` are now overridden so Enter (and
  keypad Enter) fire `onSubmit`, and Shift+Enter / Ctrl+Enter
  insert a newline. Footer hint updated to match. New test
  pins the behavior against a real `TextareaRenderable`.

### Changed

- **TUI tool-call display is now a 2-line block** (`src/ui/tui.ts`):
  the header line carries the status icon + tool name, an
  indented dim line shows the (truncated) args, and a
  colored result line shows the tool's display message. Old
  layout was a single line with everything jammed together;
  scanning scrollback to find which tool returned what was
  painful.

### Added (continued from prior unreleased work)

- **`/skill show <name>` + `ch skills show <name>` focused
  skill view** (`src/slash/builtin.ts`, `src/cli.ts`,
  `src/__tests__/slash.test.ts`): same pattern as the new
  `/agents show <name>`. The skill list used to be just names +
  one-line descriptions; now both surfaces render a focused
  one-skill view with description and the full SKILL.md body.
  `/skill <name>` still works as a backward-compatible shorthand
  for `load`. 3 new tests pin the focused view, the shorthand,
  and the unknown-skill error.

- **`/agents <name>` + `ch agents show <name>` focused sub-agent
  view** (`src/slash/builtin.ts`, `src/cli.ts`, `src/runtime.ts`,
  `src/slash/registry.ts`, `src/__tests__/slash.test.ts`):
  the agents list used to be just names + one-line descriptions.
  Now both surfaces render a focused one-agent view with
  description, tags, tool allowlist (or "inherits all parent
  tools" when undefined), max steps, model / provider override,
  and the system prompt verbatim. `ch agents` also accepts the
  short form `ch agents <name>` as a shorthand for `show`.
  - `HarnessRuntime.getAgent(name)` is the new pass-through to
    `AgentRegistry.get()`. `SlashRuntime.getAgent?()` is the
    optional contract for hosts that don't have a registry.
  - 2 new tests pin the focused view and the "unknown agent"
    friendly error.

- **`ch info` CLI subcommand + `/info` slash command**
  (`src/runtime/info.ts`, `src/cli.ts`, `src/slash/builtin.ts`,
  `src/__tests__/slash.test.ts`): a single one-screen snapshot of the
  running install so the user can answer "where is my config?",
  "which provider is default?", "what version is this?" without
  reading source or remembering paths.
  - Prints: version, node + platform, CLI path, cwd, home, the
    settings file path with provider/model/thinking/approval,
    and the on-disk paths for sessions / logs / memory / skills
    / agents.
  - **`ch info --json`** emits a stable structured shape for
    scripts, dashboards, and `/v1/info` consumers. The `RuntimeInfo`
    interface is exported for downstream types.
  - The `/info` slash command renders the same human view inside
    the TUI, sharing the same `renderRuntimeInfo(cwd)` so the two
    surfaces never drift.
  - Listed under "Health" in `ch help` and grouped under "Status"
    in `/help` alongside `/cost`, `/status`, `/tokens`.
  - 1 new test covers the rendered output shape.

- **Stack-aware `/init`** (`src/project/init.ts`, `src/slash/builtin.ts`,
  `src/__tests__/init.test.ts`, `src/__tests__/slash.test.ts`):
  detects the project's ecosystem from the manifest and writes a
  real first draft of `.codingharness/AGENTS.md` with build/test
  commands pre-filled.
  - **Node.js / TypeScript**: pulls `name`, `description`, `license`,
    and the `build` / `test` / `lint` / `typecheck` scripts straight
    from `package.json`. Falls back to `npm run build` / `npm test`
    when the manifest doesn't define them. Echoes are filtered out
    so the template doesn't tell the agent to run a no-op.
  - **Rust**: reads `[package]` from `Cargo.toml`. Always suggests
    `cargo build` / `cargo test` / `cargo clippy` / `cargo check`.
  - **Python**: parses `pyproject.toml`, infers `pytest` vs
    `unittest`, suggests `ruff` + `mypy`.
  - **Go**: reads `go.mod`, derives the project name from the
    module path, suggests `go build ./...` / `go test ./...`.
  - **Ruby / Java / .NET / Elixir**: lightweight detection from
    `Gemfile`, `pom.xml` / `build.gradle[.kts]`, `*.csproj` /
    `*.sln`, `mix.exs`.
  - **README fallthrough**: if the manifest doesn't have a
    description, the first `# Heading` of `README.md` is used.
  - **Source roots + tests**: the `Stack` section lists `src/`,
    `lib/`, `packages/`, `app/`, etc., when present, and mentions
    whether a top-level `test*` directory (or `src/__tests__/`)
    exists.
  - **Flags**: `/init --force` overwrites an existing file;
    `/init --no-detect` writes the legacy blank template.
  - 13 unit tests in `init.test.ts` cover each stack and the
    template renderer; 3 slash-level tests cover end-to-end init,
    refuse-to-overwrite, and `--force`.
- **Easy-to-use TUI + CLI first-run experience** (`src/slash/builtin.ts`,
  `src/ui/tui.ts`, `src/cli.ts`, `src/__tests__/slash.test.ts`):
  everything a brand-new user needs to know in one place.
  - **TUI quick-start banner** paints on launch with the 4 commands
    that matter most (`/help`, `/model`, `/goal`, `/status`) and a
    pointer to the workflow modes (`/plan`, `/build`). The same card
    is rendered by the TUI's input-preview area when the prompt is
    empty, and by the sidebar's idle line — so returning users see
    the same hint every keystroke, no scrolling required.
  - **/welcome slash command** prints the quick-start card on
    demand. Useful from inside an existing session when the user
    forgets the basics.
  - **ch welcome CLI subcommand** prints the same card outside the
    TUI. Lists as the first subcommand under "Get started" in
    `ch help`.
  - **Grouped /help output** — the flat 35-line list is now a
    7-category reference (Workflow / Session / Model / Context /
    Tools / Settings / Status), each with a one-line blurb. Quick-start
    lives at the top. /help `<name>` returns a focused one-command
    view with usage, group, and a pointer back to /help. The trailing
    keybinding hint makes the always-available shortcuts (Tab, Ctrl+G,
    Ctrl+C, Ctrl+D) visible without scrolling.
  - **Grouped `ch help` output** — same approach: 5 categories
    ("Get started", "Run a prompt", "Inspect & manage", "Health",
    "Integrate") with a "Quick start" snippet at the top showing
    the four most common commands.
  - **Sidebar idle state** now reads `idle — try a prompt` with
    the same 4 quick-start commands one line below, so the user is
    always two glances from the help they need.
  - **Footer** now mentions `Ctrl+L clear` (the existing clear
    action) and points at `/plan` / `/build` so the workflow modes
    are visible without a /help detour.
  - **Shared source of truth**: the new exported
    `renderQuickStart({ title, showHeader })` and `QUICK_START` array
    in `src/slash/builtin.ts` are the only place the quick-start text
    lives. TUI banner, /welcome, ch welcome, TUI input preview, and
    the sidebar hint all read from it — change it once, every
    surface updates. `/commands` now delegates to `/help` so the two
    commands never drift.
  - 5 new tests in `src/__tests__/slash.test.ts` cover the grouped
    help, focused one-command help, /welcome, and the "unknown
    command" hint.

- **`/diag` slash command + `ch diag` CLI subcommand + `GET /v1/diag`
  HTTP endpoint** (`src/runtime.ts`, `src/slash/builtin.ts`,
  `src/cli.ts`, `src/server.ts`, `src/slash/registry.ts`): a single
  connectivity / latency probe that hits the current default provider
  with a tiny canned prompt and reports whether the call succeeded,
  first-byte latency, total latency, input / output tokens, and the
  model's literal reply. The three surfaces (slash, CLI, REST) all
  delegate to `HarnessRuntime.runDiag()` so dashboards, scripts, and
  the TUI see the exact same shape. `ch diag --json` for
  machine-readable output; the HTTP endpoint returns 503 on failure
  so monitoring can alert on it. The new `DiagResult` interface is
  stable and exported.
- **`/tokens` slash command + `ch tokens` CLI subcommand + `GET
  /v1/tokens` HTTP endpoint** (`src/slash/builtin.ts`, `src/cli.ts`,
  `src/server.ts`): rough token count of the active session's
  model-visible messages, with a per-role breakdown for the last
  ten messages. Useful for pre-compact checks and per-turn cost
  budgeting. `ch tokens --json` for machine-readable output. Backed
  by the existing `roughTokenCount()` from `compaction.ts` so the
  number matches what `/compact` would actually compact.
- **`buildToolServices()` is now public on `HarnessRuntime`** (was
  `private`). The unit tests for the SIGINT-listener-leak fix needed
  to drive the spawn-subagent service directly; the public method
  makes that possible without exposing runtime internals to user
  code. `buildSystemPrompt()` is also public — `ch run --json` and
  one-shot modes need to stream with the same system prompt as the
  REPL, and the bracket-notation escape hatch was brittle.

### Fixed

- **`ch sessions` printed the usage string instead of the session
  list** (`src/slash/builtin.ts`, `src/__tests__/slash.test.ts`).
  The slash command did `args.trim().split(/\s+/)` and then
  `const sub = parts[0] ?? "list"` — but `"".split(/\s+/)` returns
  `[""]`, not `[]`, so `parts[0]` is the empty string (not
  nullish). The early `if (sub === "list")` branch never fired,
  and the run fell through to the usage error. Same bug in
  `/memory` (defaulted to `"read"`). Fixed by filtering empty
  strings out of the split result. Two new tests pin the
  behavior — both commands now return the empty-state marker
  or the live data, never the usage string. `ch sessions`
  becomes the one-line way to see your recent sessions; same
  for `ch memory`.
- **ESM `require()` calls in two source files** (`src/cli.ts:645`,
  `src/slash/builtin.ts:681`). Both used `require("node:fs")` /
  `require("node:child_process")` inside an ES module
  (`"type": "module"`). They worked in Bun and via tsx's CJS
  interop, but pure-Node ESM contexts would throw
  `ReferenceError: require is not defined`. Replaced with proper
  top-level `import` statements.
- **Sub-agent SIGINT listener leak** (`src/runtime.ts`). The
  `spawnSubagent` service in `buildToolServices` called
  `process.once("SIGINT", () => ac.abort())` and then in the
  `finally` block called
  `process.removeListener("SIGINT", () => ac.abort())` — but
  `removeListener` requires the SAME function reference, and the
  inline arrow on the remove line is a different function. Result:
  every spawned sub-agent left behind a permanent SIGINT listener.
  Stored the function in a `const onSig` so the `removeListener`
  call actually matches. Added a regression test that spawns 15
  sub-agents across 3 runtimes and asserts the listener count is
  unchanged.
- **`runDiag()` shape**: when no provider or model is configured,
  the result now includes `firstByteMs`, `totalMs`, `inputTokens`,
  and `outputTokens` (always zero on error) so consumers don't
  have to special-case the error path.
- **Roundabout `fs/promises` import in session reader**
  (`src/agent/session.ts:266`). The function used
  `await import("node:fs/promises").then((m) => m.readFile(...))`
  to read the sidecar meta file, even though `readFile` was
  already imported at the top of the same file. Replaced with the
  imported binding.
- **Stale `(ctx as { stdio?: boolean })` casts in `src/cli.ts`**.
  The casts predated the addition of `stdio`, `approveBash`, and
  `allowRemote` to the `SubcommandContext` interface. Dropped the
  casts and read the typed fields directly. Same fix for
  `runUpdateCmd`'s `channel` / `check` (read with a typed alias
  instead of an inline `as`).
- **Dead `currentText` accumulator in `src/providers/anthropic.ts`**
  and the dead `p.message.role === "tool"` branch in
  `payloadKindToType` (`src/agent/session.ts`). The role is narrowed
  to `user | assistant | system` by the discriminated union, so
  the `tool` check was unreachable. Removed.

### Added (continued — from prior unreleased work)

- **Electron desktop features** (`electron/desktop-features.cjs`,
  `electron/main.cjs`, `electron/preload.cjs`, `src/web/{index.html,
  app.js, styles.css}`): five new OS-level capabilities modeled on
  the patterns openai/codex and Gitlawb/openclaude use for their
  desktop apps. All additive, all degrade gracefully when the
  underlying OS feature is missing.
  - **`safeStorage` keychain** for API keys. The web server
    currently stores API keys in plain `settings.json`; on the
    desktop, `ch.keychainSet(name, value)` encrypts the value with
    the OS keychain (Keychain on macOS, Credential Vault on
    Windows, libsecret on Linux) via `electron.safeStorage` and
    stores the encrypted blob in the user data dir. `ch.keychainGet`
    decrypts on read. The Settings panel shows a "Save API key to
    Keychain" button and the current keychain status (backend,
    entry count). Falls back to plain settings.json when the
    platform's safeStorage isn't available.
  - **Auto-launch at login**: `app.setLoginItemSettings({
    openAtLogin, openAsHidden, args })`. Toggled from Settings;
    persisted via the same electron-store-on-disk pattern. On
    Windows, `--hidden` is appended so the app boots into the
    tray. Gracefully no-ops on platforms where the call fails.
  - **Native desktop notifications**: `new Notification({ title,
    body, silent, tag }).show()` for "agent done", "approval
    needed", and "MCP server up" events. Routed through a single
    `features.pushNotification()` queue with a per-session
    `notificationsEnabled` toggle. The web server's `server:notify`
    IPC event is now also bridged to the OS notification center
    so the user sees it even when the window is hidden.
  - **Recent projects menu**: tracks the last 8 project roots
    the desktop opened in `<userData>/recent-projects.json` and
    surfaces them in `File > Open Recent > [project1, ...]`.
    `File > Clear Recent` wipes the list. The Settings panel
    shows the list with per-entry "×" buttons.
  - **Tray badge count**: `app.setBadgeCount(n)` on macOS / Linux
    Unity surfaces the active-session count on the dock / launcher.
    A new IPC `ch:badge-set <n>` lets the renderer push the
    current count, and `ch:badge` notifications let the renderer
    react to changes.
  - **Update channel UI**: `stable` / `beta` toggle in Settings,
    persisted at `<userData>/update-channel.json`. Changing the
    channel re-arms `setupAutoUpdater()` so the new channel is
    honored on the next check.
- **MCP stdio transport** (`ch mcp --stdio`, new
  `startMcpStdioServer` in `src/mcp-server.ts`): the canonical MCP
  IPC — newline-delimited JSON-RPC 2.0 over stdin/stdout. Every
  MCP client can be configured to talk to a stdio MCP server by
  pointing it at the binary. The Electron desktop uses it for
  in-process IPC (no port binding, no localhost assumption, no
  firewall prompts).
  - Banner to stderr (stdout is reserved for the JSON-RPC wire).
  - Hard cap of 1 MB per line (mirrors the HTTP body cap).
  - `computeRpcResponse()` factored out of the HTTP path so both
    transports share the exact same dispatch logic.
  - 9 new tests covering: ready banner, initialize, tools/list,
    ping, notification (no reply), `id: null` → -32600, parse
    error, unknown method, and a live `tools/call` round-trip.
- **`ch mcp` now accepts `--stdio`**: the same subcommand can
  bind to HTTP+SSE (default) or speak JSON-RPC over stdio
  (`--stdio`). `--approve-bash`, `--allow-remote`, and the
  existing auth / loopback guards all work in both modes.

### Tmp-orphan pattern pass (2026-06-21)

Same `writeFileSync(tmp); renameSync(tmp, file);` audit we did
on the workflow / goal / mcp / session / trajectory stores
last week — caught one more site:

- **`AsyncToolQueueStore.writePersisted` leaked `<file>.<rand>.tmp`
  on rename failure** (`src/agent/delegation.ts:701`): the new
  persistence layer for the `Delegation { kind: "async_tool" }`
  kind had the same `writeFileSync(tmp); renameSync(tmp, file);`
  shape as the others, and the same gap — a failed `renameSync`
  (e.g. the target is a directory, or the FS is full) left the
  `.tmp` on disk next to the queue file. Wrapped the pair in
  `try { write; rename } catch { unlinkSync(tmp); throw }`,
  matching the other stores' shape. 1 new test pre-creates
  the queue path AS A DIRECTORY (forces `renameSync` to fail
  with `EISDIR`) and asserts that `readdirSync(queueDir)` has
  no `.tmp` files after the throw. 799 pass.

### Cost: Claude Opus 4.x was charged at the 3.0 price ($15/$75) (2026-06-21)

`src/agent/cost.ts`'s `^claude-opus-4` regex matched the entire
4.x line (`claude-opus-4-1`, `claude-opus-4-5`, `claude-opus-4-7`,
`claude-opus-4-8`, ...) but priced them all at the original
Claude 3 Opus rate ($15/$75 per 1M tokens) — a 3x overcharge
on input and output. Real Anthropic 4.x prices are $5/$25.

Split into two patterns:
- `^claude-opus-4-` → $5/$25 (4.x line)
- `^claude-3-opus` → $15/$75 (legacy 3.0, kept for users still
  on the original Opus model)

1 new test pins both halves of the contract.

### Bash: SIGKILL-escalation timer was never cleared on child close (2026-06-22)

`src/agent/tools/bash.ts` had two `setTimeout(() => child.kill("SIGKILL"))`
escalation timers — one for the timeout path (5 s) and one for
the abort path (1 s) — that were never tracked or cleared. On
a timed-out or aborted command, the bash subshell exits
within ~100 ms, the child's `close` handler fires, the
promise resolves... and the escalation timer is still alive
in the event loop for the full 5 s / 1 s window. The
timer's closure holds the `ChildProcess` object in the GC
root set for that whole window, and fires `child.kill("SIGKILL")`
on a PID that has already been reaped. On a busy session
that was a slow leak of `ChildProcess` handles.

Fix: track `killTimer` in a local variable, add a
`clearKillTimer()` helper, and call it from the `close` and
`error` handlers (mirroring the cleanup pattern used for the
`timer` variable on the same lines). The bash tool's promise
now resolves with no dangling escalation timer.

A direct automated test of the leak proved impractical: the
cheapest detection mechanisms (patching `setTimeout` or
`ChildProcess.prototype.kill`) break the `node:test` runner,
and waiting >5 s in a test would 10× the suite runtime.
The fix is a small, code-review-visible diff (~10 lines)
and matches the shape used by the other stores — leaving
the bug in place would be obvious in any re-review of
`src/agent/tools/bash.ts`.

### Read: hard cap on the in-memory file size (OOM guard) (2026-06-22)

`src/agent/tools/read.ts` had a `> readMaxBytes * 4` log
threshold but no hard cap. A 1 GB log file the model asked
to inspect would be `readFile`'d into memory in full, then
truncated to the output cap — OOM-ing the process before
truncation could fire. Now: if the file is bigger than
`readMaxBytes * 32` (a 6.4 MB default with the 200 KB cap),
the tool bails with a clear error pointing the caller to
`offset`/`limit` or a smaller file. Files at the exact
32× boundary are still allowed (and truncated to the
output cap, as before).

2 new tests pin the threshold: 33 KB rejected with
`readMaxBytes: 1000` (33×); 32 KB allowed (boundary).

801 pass.

### Web search: stream-cap the DDG response (OOM guard) (2026-06-22)

`src/agent/tools/web-search.ts` used `await res.text()` to
materialize the full DuckDuckGo HTML before parsing. The
DDG page is usually <100 KB but a misbehaving or hostile
response could blow up to gigabytes. Same fix pattern as
the `http` tool: stream-read with a 1 MB cap, `reader.cancel()`
at the boundary, decode the bytes at the end. No new tests
(the DDG live request isn't deterministic in CI). 801 pass.

### HTTP: drop the redundant `clearTimeout` / `removeEventListener` (2026-06-22)

`src/agent/tools/http.ts` had the cleanup pair (timer +
abort listener) running in the success path AND in the
`finally` block. Both calls are no-ops on already-fired
timers / non-listening events, so this was harmless
duplication, not a leak — but the duplicated lines were
misleading. Drop the inner pair, leave the `finally` block
as the single source of truth. No behavior change.

### Cost table: 4 model families were silently reported as $0/$0 (2026-06-23)

The `src/agent/cost.ts` table is a prefix-regex lookup;
`priceFor(model)` returns the first match's price and
falls through to `FALLBACK` ($0/$0) on no match. Four
families of real, currently-shipping models were missing:

1. **Claude Haiku 4.x** (`claude-haiku-4-5`,
   `claude-haiku-4-5-20251001`, ...). Pre-fix: real $1/$5
   per 1M calls were reported as free. Now: $1/$5
   via `^claude-haiku-4-`.
2. **GPT-5 / GPT-5.1 / GPT-5.4 / GPT-5.5 / GPT-5-mini**.
   Pre-fix: real $30/$60 (and $0.25/$2 mini, $1.25/$0.25
   5.4, $5/$0.50 5.5) calls were reported as free. The
   `presets.ts` default for OpenAI was `gpt-5.1` — the
   most-common shipping model in the OpenAI preset —
   so the cost tracker was the noisiest it could be.
   Now: 4 separate entries, ordered so the prefix-only
   `^gpt-5` (no `$`) doesn't steal `gpt-5-mini`.
3. **GPT-4.1 / GPT-4.1-mini / GPT-3.5 Turbo**. Pre-fix:
   the only GPT-4 entries were `^gpt-4o`, `^gpt-4o-mini`,
   `^gpt-4-turbo` — anything `gpt-4.1*` or `gpt-3.5-turbo`
   fell through to $0/$0. Now: 3 entries.
4. **o3 (full)** and **Grok 4.x**. The o3 (full) was
   missing; only `o3-mini` was listed. Grok 4.3 (the
   default for the xAI preset in `presets.ts`) was
   missing entirely.

Also caught an order-of-precedence bug: `^o1` was listed
BEFORE `^o1-mini`, so `o1-mini` (real $3/$12) was being
charged at the o1 (full) rate ($15/$60) — a 5x overcharge.
Same shape as o3 / o3-mini. Fix: list the more specific
pattern first.

5 new tests pin the new entries and the precedence
fix. 807 pass.

### Stream-cap the error body in 4 provider call sites (2026-06-23)

The Anthropic / openai-compat / codex / omni providers all
had the same shape on the HTTP-error path:
```ts
if (!res.ok) {
  const text = await res.text().catch(() => "");
  throw new Error(`... HTTP ${res.status}: ${text.slice(0, 500)}`);
}
```
`res.text()` materializes the FULL body before slicing to
500 chars. A hostile or runaway error response (1 GB of
`AAAA...`) would OOM the process before the slice fired.

Same fix as the `http` / `web_search` tools:
stream-read with a 1 MB cap, `reader.cancel()` at the
boundary, `TextDecoder` decode at the end. No behavior
change for normal errors; protects against OOM on the
hostile path.

Also fixed the same `await res.text()` OOM in
`DelegationManager.runApiKind` (`src/agent/delegation.ts`)
on the success path, with a 5 MB cap and `reader.cancel()`
at the boundary.

### http tool: validate the HTTP method against the standard set (2026-06-23)

`src/agent/tools/http.ts` accepted any string for `method`
and passed it to `fetch()`. A typo (`POSTT`) or
non-standard method (`PROPFIND`, `TRACE`) would fail
deep in the fetch stack with an opaque "TypeError: fetch
failed". Now: `validate()` uppercases the method (Node
fetch uppercases on the wire anyway) and rejects anything
not in the standard set (`GET / POST / PUT / PATCH /
DELETE / HEAD / OPTIONS`) with a clear "method: 'X' not
allowed; must be one of ..." message.

1 new test pins the validation for 4 invalid methods and
7 valid methods (lowercase + uppercase). 807 pass.

### http tool: also exclude OPTIONS from body transmission (2026-06-24)

`src/agent/tools/http.ts` had `hasBody` excluding GET / DELETE
/ HEAD but not OPTIONS. OPTIONS is most commonly used for
CORS preflight, where a body is uncommon and can trip up
preflight caches / strict servers. Now: OPTIONS is in the
body-less set, matching the comment about the GET/DELETE
body-guard. 1 new test pins this. 810 pass.

### Council: honor abort signal between councilors and before the synthesizer (2026-06-24)

`src/agent/council.ts`'s `runCouncil` threaded the abort
signal to each `deps.spawn` but did NOT check `signal.aborted`
between councilors or before the synthesizer call. If the
caller cancelled mid-deliberation, the loop would still
call every remaining councilor in the roster (any spawn
that ignored the signal would let the loop run to
completion) and would still fire the synthesizer even
after the caller had already discarded the result.

Now: throw `AbortError` (with a local `makeAbortError`
helper, kept private to avoid a provider-internal
dependency) at the top of each councilor iteration and
again before the synthesizer spawn. Caller's existing
try/catch on `runCouncil` sees a structured `AbortError`
and exits cleanly with the partial transcript already
built.

2 new tests pin both paths: pre-aborted signal (zero
spawns), and mid-deliberation abort (first councilor
runs, abort fires, second and third do NOT). 810 pass.

### Council: renderCouncilResult round header was off-by-one for double-digit rounds (2026-06-24)

`src/agent/council.ts`'s `renderCouncilResult` rendered
each per-councilor line as
```
── <role> (round N) ──────...
```
with the dash count computed as
`Math.max(0, 60 - role.length - 12)`. The `12` constant
assumed a single-digit round number; for `round 10+`
the column drifted right by 1-2 characters. Now: the
prefix length is computed from the actual round string,
so the dash count is right for any round number. Same
fix shape as the council's `60 - 12 = 48` rule for the
final-answer line. No new test (visual-only).

### mcp-client (HTTP): stream-cap the error body (2026-06-24)

`src/agent/mcp-client.ts`'s `McpHttpClient` did
`await res.text()` on the error path of an MCP HTTP call,
materializing the full body before slicing to 200 chars.
A hostile / runaway MCP server could OOM the harness
with a 1 GB error response. Same fix as the four
provider call sites (anthropic / openai-compat / codex /
omni) got last week: stream-read with a 1 MB cap +
`reader.cancel()` at the boundary + `TextDecoder` at
the end. 810 pass.

### Test infrastructure: `npm test` now depends on `npm run build` (2026-07-06)

`package.json`'s `test` script was
`bun test src/__tests__/*.test.ts` — but the MCP `stdio`
test suite in `src/__tests__/mcp-server.test.ts` spawns
`process.execPath` running `dist/cli.js mcp --stdio`.
The `dist/` directory is built by `npm run build`
(`tsc -p tsconfig.json && node scripts/copy-web.mjs`).
Without `dist/`, every stdio test fails with a
5-second timeout ("spawn ENOENT"). Result: a fresh
clone of the repo fails the stdio tests on `npm test`
even though the source code is correct. Add a
`"pretest": "bun run build"` script and make `test`
explicitly chain after `build`. The test cost is
~5s of `tsc` once per run; CI gets the same figure.
MCP HTTP tests + all unit tests are unaffected.

### Cost table: GPT-5 prices were stale / partially wrong (2026-07-06)

The June-2026 entries for the GPT-5 family were
back-of-the-envelope guesses rather than OpenAI's
official API pricing. Several were factually wrong:

- `gpt-5.5` was listed at `$5/$0.50` (those are the
  cached-input + GPT-5-original-output prices in the
  wrong slots). Real: **`$5/$30`** (April 2026).
- `gpt-5.4` was listed at `$1.25/$0.25`. Real:
  **`$2.50/$15`**.
- `gpt-5` (the August-2025 original) was listed at
  `$30/$60` (which is actually GPT-5.4-pro). Real:
  **`$1.25/$10`** (August 2025 launch).
- Missing entries that fell through to `$0/$0`:
  `gpt-5.5-pro` ($30/$180), `gpt-5.4-mini` ($0.75/$4.50),
  `gpt-5.4-nano` ($0.20/$1.25), `gpt-5.4-pro` ($30/$180),
  `gpt-5.3-codex` ($1.75/$14, used by Codex), and
  `gpt-5-nano` ($0.05/$0.40).

Rewrite the GPT-5 block with the verified OpenAI API
prices. The bare-`gpt-5` regex still acts as the
catch-all for any GPT-5.x model that doesn't have a
more-specific match (e.g. `gpt-5.1`, `gpt-5.6`,
future `gpt-5.7`…) — all currently priced at the same
rate, so `$1.25/$10` is a safe default. The
`/codex/` fallback catches any Codex-flavored model
id (e.g. `gpt-5.1-codex`) at the known Codex rate
of `$1.75/$14`.

Same shape as the Anthropic fix last month:
order matters, more-specific patterns first.

The existing `gpt-5 / gpt-5-mini / gpt-5.4 / gpt-5.5`
test was rewritten to also pin gpt-5-nano, gpt-5.4-mini,
gpt-5.4-nano, gpt-5.3-codex, and gpt-5.5-pro against
their published rates. 810 pass.

### bash: output-cap truncation now escalates to SIGKILL (2026-07-06)

Pre-fix, when the bash tool's output exceeded
`MAX_OUTPUT_BYTES` (200 KB), the child received
SIGTERM and further output was dropped, but there
was no SIGKILL escalation. A runaway like `yes` /
`tail -f` / `cat /dev/zero` ignores SIGTERM (bash
subshells often do for their child processes) and
would burn CPU + memory until the parent process
exited. Now: the truncation path reuses the same
`killTimer` slot the timeout / abort paths use,
scheduling a 5-second SIGKILL escalation. The
timer is cleared in `close` + `error`, matching
the cleanup pattern already used for the outer
`setTimeout`. 810 pass.

### Cost table: Claude Sonnet 5 was silently reported as $0/$0 (2026-07-07)

Anthropic launched `claude-sonnet-5` (note the
dash-less jump from `claude-sonnet-4-*` to
`claude-sonnet-5`) in July 2026. Pre-fix: the
`^claude-sonnet-4-` regex did NOT match
`claude-sonnet-5` (no dash, no `-` after the
version), and there was no `^claude-sonnet-5` entry,
so every Sonnet 5 call fell through to the $0/$0
unknown-model fallback — a real $3/$15 per 1M
charge silently reported as free. Introductory
pricing $2/$10 through August 31, 2026; we track
the standard $3/$15 rate (Anthropic applies the
discount at billing time). 1 new test pins
`claude-sonnet-5` at $3/$15. 811 pass.

### CLI council bridge: `cancelled` sub-agent throws `AbortError`, not generic `Error` (2026-07-07)

`src/cli.ts`'s `ch council` bridge spawns each
councilor via `SubAgentManager.spawn`. Pre-fix,
when the caller's signal aborted the spawn
mid-flight, the sub-agent returned `status:
"cancelled"` and the bridge threw
`new Error("cancelled")` — masking the structured
AbortError that `runCouncil`'s own `signal.aborted`
checks expect to surface. The caller would see a
generic Error instead of an AbortError, breaking
any downstream `err.name === "AbortError"` checks.

Now: the bridge detects `r.status === "cancelled"`
and throws a proper `AbortError` (via a local
`makeAbortError` helper kept private to `cli.ts`,
matching the same shape in `openai-compat.ts` and
`council.ts`). All other non-ok statuses still
throw a generic Error with the reason included. No
new test (the existing abort tests in
`src/__tests__/council.test.ts` cover the council-
side throw path; the bridge is a thin wrapper).

### Bash tool: `__approval_bypass` branch doc-only (2026-07-07)

`src/agent/tools/bash.ts` had a comment claiming
the runtime injects `__approval_bypass` on
re-emitted `deny → allow-once` tool calls. The
runtime does not do this (it persists the decision
to `settings.approval.allowlist` instead, and the
next re-emission passes the check via the allowlist).
The branch was defensive plumbing only. Updated
the comment to document the actual flow + flag the
reserved escape hatch for future use. No behavior
change.

## [0.2.2] - 2026-06-07

### Added

- **MCP server** (`ch mcp`): Model Context Protocol server exposing
  CodingHarness's 13 agent tools to external clients (Claude Code,
  Cursor, Zed, etc.). Spec-compliant JSON-RPC 2.0 with SSE transport.
  - `src/mcp-server.ts` — `startMcpServer({ port, host, cwd, approveBash,
    allowRemote, apiKey })` returns a handle with the bound port, URL,
    the public `McpServerInfo` (`name: "codingharness"`, `version: "0.2.2"`),
    and `stop()`. Protocol version pinned to `2025-06-18`.
  - JSON-RPC surface: `initialize`, `ping`, `tools/list`, `tools/call`,
    `notifications/*` (notifications are no-ops on the server side).
    `id: null` in a request body is rejected as `-32600 Invalid Request`
    (NOT a notification), and a missing `id` field is treated the same
    way — both are clearly separated from well-formed notifications.
  - HTTP endpoints: `GET /health` (JSON status), `POST /mcp` (JSON-RPC),
    `GET /sse` (Server-Sent Events for streamable clients).
  - Tool definitions carry MCP `annotations`: `readOnlyHint`,
    `destructiveHint`, `idempotentHint` (only when not read-only),
    `openWorldHint` (only when true).
  - **Security**: 1 MB body cap, slowloris timeouts (5 s headers, 30 s
    read), CORS loopback-only by default (`--allow-remote` to opt in),
    optional `Authorization: Bearer <MCP_API_KEY>` enforcement, refuses
    to bind to non-loopback addresses unless `--allow-remote` is set.
    Tool-call args are passed through the same `validateArgs` flow as
    in-process calls, so the `__approval_bypass` / `__bypass` fields
    can never be smuggled in from the wire.
  - `ch mcp [--port <p>] [--host <h>] [--approve-bash] [--allow-remote]`
    subcommand with the same auto-port / auto-host discovery as
    `ch serve`.
  - 16 new tests covering all four RPC methods, the four malformed-id
    paths, the spec-required fields on `initialize` and `tools/list`,
    the security caps, and the live wire round-trip.
- **Electron shell now spawns `ch mcp` alongside `ch serve`**: the
  desktop app acts as a hub for both the web UI and any external MCP
  client on the user's machine.
  - `electron/main.cjs` — new `startChMcpServer()` (mirrors
    `startChServer()` but on a second free port), with auto-restart
    on crash, deterministic 2 s timeout if the child never prints the
    "MCP server listening on …" banner, and `CH_DESKTOP_AUTOSTART_MCP=0`
    to disable.
  - Tray menu now reports both ports: `● Server on …` AND
    `● MCP on …`. The "Copy Server URL" / "Copy MCP URL" menu items
    enable independently.
  - IPC: `ch:info` returns `chServePort`, `chServeUrl`, `chMcpPort`,
    `chMcpUrl` so the renderer badge can show the MCP URL too.
  - Renderer: new `mcp:status` event, consumed by `app.js` to update
    the "Desktop" badge with the MCP URL.
- **`ch mcp` in the help order** (between `desktop` and `update`).
- **Reins default to `MiniMax M2.7`**: every `.harness/reins/*/config.yaml`
  now has `provider: minimax` and `model: MiniMax-M2.7` (or the
  `--model` override), so the orchestrator boots straight onto the
  user-preferred model.
- **`minimax` provider preset** default model updated to `MiniMax-M2.7`
  (was `MiniMax-M3`). Base URL, headers, and provider id are
  unchanged.

## [0.2.2] - 2026-06-07

### Added

- **Web UI** (`ch web` and `ch serve`): full dark-mode web frontend at
  `http://127.0.0.1:<port>/`. Sidebar with sessions + active sub-agents +
  cost totals (refreshed every 2s), streaming chat with Server-Sent Events,
  slash-command autocomplete, approval modal, settings modal.
  - `src/web/index.html`, `src/web/styles.css`, `src/web/app.js` — vanilla
    JS, zero build step, no framework
  - `src/server.ts` — unified HTTP + SSE server: `/`, `/v1/status`,
    `/v1/agents`, `/v1/skills`, `/v1/sessions`, `/v1/usage`, `/v1/commands`,
    `/v1/settings`, `/v1/session`, `/v1/chat`, `/v1/chat/stream` (SSE:
    text / tool_start / tool_end / info / error / approval_required /
    usage / done), `/v1/spawn`, `/v1/approval/respond`, `/v1/memory/*`
  - `scripts/copy-web.mjs` — copies `src/web/` to `dist/web/` on build
  - `ch web` opens the browser automatically (`open` / `start` / `xdg-open`)
- **Cost tracking** (`/cost`, `src/agent/cost.ts`):
  - `CostTracker` accumulates per-model + per-agent token / dollar totals
  - `priceFor(model)` looks up USD per million tokens; `callCost()` computes
    incremental cost; `formatUSD()` renders values
  - 17 new unit tests
- **Bash approval flow** (`/approval`, `src/agent/approval.ts`):
  - `needsApproval(command, mode)` blocks obvious foot-guns (rm -rf,
    git push --force, sudo, curl|bash) under `on-mutation` mode
  - `SAFE_PATTERNS` exempts read-only commands from allowlist mode
  - Modes: `off`, `allowlist`, `blocklist`, `on-mutation`, `ask`
  - Bash tool consults `ctx.services.getApproval()`; returns `isError: true`
    with a "needs approval" message when blocked. Re-running an
    already-approved command passes `__approval_bypass: true`
  - Web UI shows an approval modal and sends back via `/v1/approval/respond`
- **TUI sidebar** showing sessions, active sub-agents, and cost totals
  (refreshed every 2s, "dirty-flag" style to keep the renderer simple).
- **Electron desktop shell** (`electron/main.cjs` + `electron/preload.cjs`):
  - Spawns `ch serve` as a child on a random port
  - Waits for `/v1/status` to return 200
  - Opens a `BrowserWindow` pointing at the server URL
  - System tray icon for show/hide/quit
  - macOS hide-on-close convention; clean SIGTERM → SIGKILL shutdown
  - `electron-builder` config for `dmg` / `nsis` / `AppImage` packages
  - Scripts: `npm run electron`, `npm run dist:mac` / `dist:win` /
    `dist:linux`

### Changed

- `runtime.ts` gained `cost: CostTracker`, `activeSubagents: Map`, and
  `approval: ApprovalConfig` fields; the bash tool now blocks on
  `getApproval()`.
- `package.json` is now `0.2.2`. `electron` and `electron-builder` are
  devDependencies.
- Build is `tsc && node scripts/copy-web.mjs` (was just `tsc`).

### Added (post-0.2.2 commit, in the same release)

- **TUI approval modal wired into the bash flow**: the bash tool now
  calls `ctx.services.askApproval(command, reason)` when
  `needsApproval()` returns `"ask"`. The TUI registers a handler via
  `runtime.setApprovalRequestHandler()` that pops the modal. Decisions:
  - `allow-once` / `allow-always` → set `__approval_bypass=true` on
    the args, fall through to the real run.
  - `deny` → return `isError=true` with a "denied" message.
  - No handler registered (CLI JSON mode, server JSON mode) → fall
    back to the static "needs approval" error.
  - `allow-always` appends an exact-match regex to
    `runtime.approval.allowlist` AND mirrors to `settings.json` via
    `saveSettings` so the rule persists across restarts. Users can
    hand-edit `~/.codingharness/settings.json` to broaden the pattern.
- **`Tui.askApproval(command, reason)`** — defocuses the textarea,
  shows the modal, refocuses on resolve.
- **`ch export [session-id] [--format hermes|openai|share] [--out <dir>]`**:
  exports a session as a JSONL trajectory in one of three formats:
  - `hermes` — full event log with `{ type, ts, payload }` per line.
  - `openai` — `{ messages: [...] }` in chat-completions format
    suitable for SFT.
  - `share` — same as `openai` but anonymized: API keys / tokens
    redacted, absolute cwd paths replaced with `./`, output
    truncated.
  Default: latest session, format=openai, output to
  `~/.codingharness/exports/`. 9 new tests.
- **Provider failover**: `settings.failover` is now actually wired into
  the agent loop. If the primary provider throws (network error, 5xx,
  rate limit), the loop tries the next entry in the chain. Each entry
  is `{ provider, model }`. The failover chain is built by
  `HarnessRuntime.buildFailoverChain()` (public so the TUI / server
  can pass it to `runAgent` directly). Unconfigured providers are
  silently skipped (with a `log.warn`). User-initiated aborts (Ctrl+C)
  do not trigger failover. 4 new tests.
- **Session tree visualization**: `/tree` and `/sessions show <id>` now
  render an actual ASCII tree with branching. The current head is
  marked `●`, ancestors on the active path with `→`, and inactive
  branches with whitespace. Tool results show as `✓/✗ display`,
  compactions as `[compaction]`, and forks as `[fork ← fromEntryId]`.
  Renderer lives in `src/slash/tree-render.ts`. 4 new tests.
- **Compaction UI**: `/compact` is no longer a stub. It now actually
  compacts (or previews) the session and shows a colored diff of what
  would be removed vs kept. New API:
  - `previewCompaction(messages)` — returns `{cutoff, totalMessages,
    removed[], kept[], tokensBefore, tokensAfter, tokensSaved}` without
    calling the provider.
  - `formatCompactionPreview(p, {colorize})` — renders a multi-line
    string with green ✓ for kept, red ✗ for removed, and a gray
    `(N more messages omitted)` marker when the removed list is
    truncated. Honors `NO_COLOR`.
  - `/compact --preview` / `--dry-run` — show the diff without
    actually compacting.
  - `/compact [instructions]` — actually compact, with the diff shown
    before the result.
  - `HarnessRuntime.compactNow({dryRun, instructions})` — exposes the
    same flow to slash commands and (in v0.2.3) any control surface.
  - Auto-compaction in `runUserTurn` now prints the diff before
    summarizing so users see what got thrown away.
  9 new tests.
- **Parallel tool execution**: the agent loop now runs multiple
  read-only tool calls in the same step concurrently. A
  `PARALLEL_SAFE_TOOLS` set enumerates which tools are safe to
  parallelize (read, grep, find, ls, web_search, http, list_skills,
  read_memory, search_memory, read_todo). A step containing ANY tool
  NOT in the set — bash, write, edit, spawn_subagent, todo, etc. —
  runs sequentially to preserve ordering. Tests use timing
  assertions to prove the 3-safe / 1-mutating partition. 4 new tests.
- **Desktop app rewritten on the opencode pattern**: the Electron
  shell now mirrors the architecture of `anomalyco/opencode`'s
  desktop app. New deps:
  - `electron-updater` — auto-updates from GitHub releases (checks
    on startup, then every 6 hours; user prompts before download
    and before install).
  - `electron-store` — desktop-specific persistent state.
  - `electron-window-state` — auto-saves window size/position across
    launches via `ws.manage(window)`.
  - `electron-log` — OS-native log file
    (`~/Library/Logs/CodingHarness` on macOS, `%APPDATA%` on
    Windows, `~/.config` on Linux).
  - `electron-context-menu` — right-click menus with
    spellcheck/copy/dev-tools.
  New behaviors:
  - Single-instance lock: a second `opencode-codingharness`
    invocation focuses the existing window instead of opening a
    duplicate.
  - Background color pre-set to `#0e1116` to match the web UI; no
    white flash on launch.
  - `ch://` URL protocol handler with deep-link support on macOS
    (via `open-url`) and Windows/Linux (via argv).
  - Proper File/Edit/View/Session/Window/Help menu with
    `CmdOrCtrl+N` for new session, `CmdOrCtrl+Shift+B` to open
    in browser, "Show Logs", "Export Debug Logs…", "Check for
    Updates".
  - Tray menu shows live server status (`● server running on
    http://...`, `✗ server exited`, `○ starting`), with "Open in
    Browser", "Copy Server URL", and "Check for Updates".
  - Server crash auto-restart (1s delay, no infinite loop on quit).
  - Off-site links in the web UI open in the system browser
    instead of in-app.
  - `electron-builder` config moved to
    `electron/electron-builder.config.cjs`. Channel-based app ID
    (dev/beta/prod) so all three can coexist; GitHub publishing
    wired for prod and beta.
  - Web UI shows a "Desktop v0.2.2" badge in the sidebar when
    running under Electron (no-op in the browser).
- **`ch desktop` startup command**: a new CLI subcommand that
  launches the native desktop app. The `ch` binary is globally
  linked, but Electron is per-project — so the command walks up
  from CWD looking for a `package.json` with `name: "codingharness"`,
  falls back to the script's own location, and spawns
  `node_modules/.bin/electron` from the discovered root. Errors
  clearly when run outside a CodingHarness checkout. SIGINT and
  SIGTERM forward to the Electron child for clean shutdown.
- **Electron shell bug fix**: `APP_ROOT` walked up two levels from
  `electron/main.cjs` in dev mode, putting the binary in
  `/Users/duckets/Desktop/bin/ch` (a directory that didn't exist).
  Fixed to walk up one level: `<project>/bin/ch` is the correct
  path. Packaged build path is unchanged.
- **electron-context-menu dynamic import**: the v4 package is
  ESM-only, so a plain `require("electron-context-menu")` from the
  CommonJS main process throws `TypeError: contextMenu is not a
  function`. Replaced with a deferred `await import(...)` inside
  `app.whenReady()`. Falls back to Electron's default context menu
  if the import fails.

## [0.2.1] - 2026-06-07

### Changed

- **TUI is now built on [OpenTUI](https://github.com/anomalyco/opentui)**
  (Zig core + TypeScript bindings, the library that powers
  [OpenCode](https://opencode.ai)). The hand-rolled ANSI diff
  renderer in v0.2.0 (~1,600 LoC) is replaced by OpenTUI's Yoga
  layout + native renderables. The runtime-facing `Tui` interface
  is unchanged.
- Added `@opentui/core` as a runtime dependency.
- The `ch` launcher now prefers `bun` (required by OpenTUI's FFI
  binding) and falls back to `node` if bun is unavailable.

### Added

- **RGBA colors** throughout the TUI (no more 16-color ANSI palette)
- **Mouse support** (click to focus, drag-select text)
- **Box borders, titles, focus states** via OpenTUI's `BoxRenderable`
- **Real ScrollBox** for the message area (sticky-scroll to bottom)
- **Textarea** editor with selection, undo, word-jump, paste handling
- 6 new TUI tests using OpenTUI's `TestRenderer` (49 total)

### Removed

- `src/ui/tui/screen.ts`, `src/ui/tui/editor.ts`, `src/ui/tui/buffer.ts`,
  `src/ui/tui/render.ts`, `src/ui/tui/layout.ts` — replaced by
  OpenTUI's native equivalents. Net: ~1,200 fewer LoC.

## [0.2.0] - 2026-06-07

### Added

- **Full TUI** (`ch` in a TTY): alt-screen, status header, scrollable
  message area, multi-line input with history, slash command autocomplete,
  Ctrl+C / Ctrl+D / ↑/↓ / Tab / Shift+Enter keybindings, clean shutdown.
  Auto-detected in TTY; opt out with `ch repl` or `ch --no-tui`.
- **`ch update`**: self-update. `git pull --rebase && npm install &&
  npm run build && npm link`. Supports `--check` (just check, don't
  apply) and `--channel`.
- **16 subcommands** (vs. 9 slash commands in v0.1): `chat`, `repl`,
  `tui`, `run`, `agent`, `code`, `goal`, `loop`, `doctor`, `skills`,
  `agents`, `skill`, `memory`, `cron`, `sessions`, `init`, `serve`, `update`.
- **Sub-agent system**: 6 built-in personas (`explore`, `plan`, `review`,
  `summarize`, `implement`, `test`) + user-defined JSON. Per-agent
  model routing via `agentRouting` in settings.json.
- **Skills system** (agentskills.io): discover, load, list. Bundled
  with 4 starter skills (`code-review`, `explain-code`, `test-runner`,
  `debugger`).
- **Persistent memory** (MEMORY.md / USER.md) with `/memory` and the
  `memory` tool.
- **AGENTS.md / CLAUDE.md context walking**: walks up from cwd to root.
- **Auto-compaction** at configurable threshold + manual `/compact`.
- **Cron scheduling**: `every N min` / `every Nh` / `daily HH:MM` /
  `at <iso>` / raw cron expr, with full cron-expression parser.
- **`ch doctor`**: 8-point diagnostic (node, paths, perms, ripgrep,
  bash, settings, providers, default).
- **12 tools** (was 7): added `spawn_subagent`, `skill`, `memory`,
  `http`, `web_search`, `todo`.
- **Prompt templates** (Markdown files in `~/.codingharness/prompts/`,
  invoked as `/<name>`).
- **Extension manifests** (JSON in `~/.codingharness/extensions/`).
- **Personality (SOUL.md)**: `/personality <name>` loads a persona.
- **JSON output mode** for one-shots (`ch run --json "task"` emits
  events as JSONL).
- **Headless HTTP server** (`ch serve`): `/v1/status`, `/v1/agents`,
  `/v1/skills`, `/v1/sessions`, `POST /v1/chat`, `POST /v1/spawn`.
- **30+ slash commands** in the REPL: `/help`, `/model`, `/provider`,
  `/status`, `/usage`, `/think`, `/retry`, `/undo`, `/compact`,
  `/memory`, `/skill`, `/agents`, `/cron`, `/doctor`, `/init`, `/tree`,
  `/fork`, `/prompts`, `/mcp`, `/personality`, `/goal`, `/loop`, etc.
- **Seeded home directory**: starter `settings.json`, skills, prompts,
  agent JSON, personality, memory files, and an `AGENTS.md` template
  on first run.
- **42 tests** across agent loop, tools, slash commands, new systems,
  and TUI components.

### Changed

- CLI is subcommand-first (`ch <subcommand> [args]`), matching the
  `grok`/`grok agent`/`codex` pattern. Legacy flag form still works
  for backward compat.
- `ch` now defaults to the TUI in a TTY; use `ch repl` for the simple
  line-based REPL.
- `package.json` is now `0.2.0`.
- Tests use `tsx --test` (was `tsx src/__tests__/smoke.ts`).

## [0.1.0] - 2026-06-07

### Added

- 6 core tools (read, write, edit, bash, grep, find, ls).
- 2 providers (OpenAI-compatible, Anthropic).
- 9 slash commands (/help, /model, /provider, /goal, /loop, /clear, /quit,
  /session, /resume).
- JSONL session persistence with tree structure.
- Agent loop with error boundaries, AbortSignal plumbing, stream
  backpressure, tool result size caps.
- Atomic file writes (temp + rename).
- Per-agent provider routing.
- 22 tests.

[0.2.0]: https://github.com/Franzferdinan51/CodingHarness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Franzferdinan51/CodingHarness/releases/tag/v0.1.0

- **Codex OAuth device-flow end-to-end test suite**
  (`src/__tests__/codex-oauth.test.ts`,
  `src/providers/oauth/codex.ts`): round-3 follow-up to the codex
  ChatGPT OAuth device flow. The runtime layer was already shipped
  in round 2; this round pins the full happy / denied / refresh
  flow with mocked auth.openai.com endpoints, plus a small fix to
  the poll handler so RFC 8628 §3.5 terminal errors surface
  cleanly.
  - **New file `src/__tests__/codex-oauth.test.ts`** (6 tests, all
    pass; whole file runs in <2s). Spins up a real
    `http.createServer` on `127.0.0.1:<random-port>` and routes the
    real `https://auth.openai.com/...` URLs through it via the
    public `fetchFn` hook on `CodexOAuthLoginHooks` — NO
    `globalThis.fetch` monkey-patching. Each test isolates the
    `~/.codingharness/` dir to a fresh `mkdtempSync` tmp home
    and ALSO clears every hosted-credential env var
    (`OPENAI_API_KEY`, `MINIMAX_API_KEY`, etc.) so `mergeWithEnv`
    doesn't override the test's own `defaultProvider = "codex"`
    assertion. Tests cover: happy path (device code → poll → exchange
    → CodexProvider picks up tokens, all URLs routed through the
    mock), denied path (poll returns 403 access_denied → runtime
    returns `{ok:false, reason:denied}`, no exchange), refresh
    path (seed an expired token, run `ensureFreshCodexTokens`,
    confirm new tokens persisted), unit path (every low-level
    helper hits the mock).
  - **codex.ts fix**: `pollCodexDeviceAuthorization` now parses
    403 response bodies per RFC 8628 §3.5 — `access_denied` throws
    `Error("denied")` and `expired_token` throws `Error("expired")`
    (so the runtime surfaces the matching `reason`). The 15-min
    client deadline also now throws `Error("expired")` (was
    previously a less-actionable message).
  - Test count: 213 → 230 (in the worktree). All new codex tests
    pass; pre-existing 11 failures (MCP stdio, on-disk
    settings.json injection) unchanged.
