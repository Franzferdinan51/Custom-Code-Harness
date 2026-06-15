# AGENTS.md

A versatile terminal coding harness — multi-provider, extensible, crash-resistant. Web UI + native desktop app.

**HTTP API surface:** `ch serve` exposes a discoverable JSON API under `/v1/`.
`GET /v1/` is the public discovery index (returns the full route table with
`auth: "required" | "none"`); `POST /v1/delegations` is the external entry
point for structured delegations (kind: `agent | goal | async-tool | mcp |
plugin | api | human-approval | workflow`). Other notable endpoints:
`GET /v1/health` (public liveness), `POST /v1/chat/stream` (SSE; the first
event is `event: stream_id` with the id used by `DELETE /v1/chat/stream/:id`
to cancel), `GET /v1/loops` and `GET /v1/loops/:id` (active + recent
loops), `GET /v1/delegations/:id` (drill-down). Auth is opt-in via
`CH_HTTP_TOKEN` (bearer); the index, health probe, and `OPTIONS` preflight
bypass auth. The full route table is the `ROUTES` array at the top of
`src/server.ts` and is the single source of truth — adding a new endpoint
without an entry there fails the `server-expansion` test.

**Design influences (primary):** [OpenCode](https://opencode.ai) (server-first CLI/desktop — `ch serve` + `ch attach` + shared web UI, OpenTUI, `@file` / `!shell` input prefixes, Build/Plan modes) and [OpenClaw](https://openclaw.ai) (onboard auth choices, doctor `--lint --json`, SOUL.md/TOOLS.md workspace context, `/think`/`/verbose`/`/trace` directives, multi-agent routing).

## Setup commands

- Install deps: `npm install`
- Start dev:    `npm run dev`  (runs `tsx src/cli.ts` — TUI in a TTY, REPL otherwise)
- Build:        `npm run build`  (tsc + copies `src/web/` to `dist/web/`)
- Test:         `npm test`  (bun — required by OpenTUI's FFI binding)
- Test (Node):  `npm run test:node`  (tsx fallback, skips OpenTUI tests)
- Typecheck:    `npm run typecheck`
- Electron:     `npm run electron`  (launches desktop shell)
- Distribute:   `npm run dist:mac` / `dist:win` / `dist:linux`

## Project layout

- `bin/ch` — bash launcher; prefers `bun` (OpenTUI FFI), falls back to `node`
- `src/cli.ts` — 22+ subcommands (`ch serve`, `ch web`, `ch tui`, `ch run`, `ch agent`, `ch code`, `ch goal`, `ch loop`, `ch doctor`, `ch skills`, `ch agents`, `ch skill`, `ch memory`, `ch cron`, `ch sessions`, `ch init`, `ch update`, `ch export`, `ch compact`, …)
- `src/runtime.ts` — `HarnessRuntime`; wires provider, agent loop, session, sub-agents, skills, memory, compaction, approval
- `src/agent/` — core agent logic: `loop.ts`, `session.ts`, `tools/`, `subagent.ts`, `skills.ts`, `memory.ts`, `memory-layers.ts`, `memory-vector.ts` (4th layer: brute-force cosine + RRF), `compaction.ts`, `context.ts`, `extensions.ts`, `cron.ts`, `prompts.ts`, `trajectory.ts`, `approval.ts`, `cost.ts`
- `src/providers/` — `openai-compat.ts` (works for OpenAI / xAI / local / LM Studio), `anthropic.ts`, `registry.ts`
- `src/slash/` — slash commands (`builtin.ts`, `registry.ts`, `tree-render.ts`)
- `src/ui/` — OpenTUI TUI (`tui.ts`, `tui-app.ts`, `approval-modal.ts`, `colors.ts`, `repl.ts`)
- `src/web/` — vanilla-JS web UI (`index.html`, `styles.css`, `app.js`); no build step
- `src/server.ts` — unified HTTP + SSE server (used by `ch serve` / `ch web` / Electron)
- `electron/` — Electron desktop shell (CommonJS, loaded by `electron .`); modeled on `anomalyco/opencode/packages/desktop`
- `src/config/` — `settings.ts`, `paths.ts`, `providers.ts` — env-var + JSON config layer
- `src/util/` — `errors.ts`, `logger.ts` — crash-resistance primitives
- `scripts/copy-web.mjs` — copies `src/web/` to `dist/web/` after `tsc`
- `src/__tests__/` — 692+ tests across 50 files (`bun test`)

## Code style

- TypeScript strict mode (`tsconfig.json: strict: true`, `noUncheckedIndexedAccess: true`)
- ESM throughout (`"type": "module"`); Electron main process is CommonJS (`.cjs`)
- Zero runtime deps when possible — only `@opentui/core`; the rest is dev tooling
- No framework for the web UI — vanilla JS, no React/Vue/Svelte
- 4-space indent in TS, 2-space in CSS, 2-space in HTML/JSON/YAML
- Run `npm run typecheck && npm test` before opening a PR

## Testing instructions

- Unit tests: `npm test` (bun — fast, runs OpenTUI FFI tests)
- Tests must pass before merging to `main`
- Add tests for every new behavior — see existing `src/__tests__/*.test.ts` files
- **Fresh worktrees need `npm run build` before `npm test`.** `dist/` is
  gitignored; several tests `spawn` `bun src/cli.ts serve` and that path
  resolves through `dist/cli.js`. With no `dist/`, ~30 unrelated tests
  fail with "Module not found". Run `npm install && npm run build` once
  in a new worktree before `npm test`.
- Test files that need a writable `~/.codingharness/` must set `process.env.CODINGHARNESS_HOME = tmp` and `mkdirSync` the subdirs (`sessions`, `logs`, `cache`, `extensions`, `prompts`, `skills`, `agents`, `cron`, `memory`, `context`) BEFORE importing modules that read `paths.*`
- Stub providers in agent-loop tests must be stateful: yield tool calls on call 1, then `done` on call 2+ — otherwise the loop runs forever
- Discriminated union types: `e.payload.kind` is the narrow discriminator, not `e.type` — the latter is a coarse label

## PR & commit conventions

- Branch from `main`; never push to it directly
- Commit message: conventional commits (`feat:` / `fix:` / `docs:` / `refactor:` / `chore:`)
- Push to a feature branch, then merge via PR (or fast-forward locally for solo work)
- The repo lives at `https://github.com/Franzferdinan51/Custom-Code-Harness`
- Reference commits by `commit hash` (7+ chars) in changelogs and PRs

## Security

- Never commit secrets — `.env` is in `.gitignore`; API keys come from env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, etc.) or `settings.json` (which is also gitignored)
- Bash tool requires user approval under `on-mutation` mode for any command matching `MUTATION_PATTERNS` (`rm -rf`, `git push --force`, `curl|bash`, `sudo`, etc.)
- `ch export --format share` redacts `sk-*` / `sk-ant-*` / `xai-*` / `ghp_*` / `AKIA*` / `AIza*` / PEM blocks before writing JSONL
- Electron desktop uses `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` — no Node in the renderer
- Off-site links in the desktop app open in the system browser, not in-app
- **`ch serve` hardening env vars** (see `src/server.ts`):
  - `CH_HTTP_TOKEN` — when set, every `/v1/*` request (except `OPTIONS` preflight and `GET /v1/health`) must include `Authorization: Bearer <CH_HTTP_TOKEN>`. Unset = open server (backwards compat). Token compare is constant-time; 401s never echo the token.
  - `CH_HTTP_MAX_BODY_BYTES` — positive integer cap on POST bodies (default 1 MB). Oversize bodies get 413.
