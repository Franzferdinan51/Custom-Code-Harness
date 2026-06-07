# Changelog

All notable changes to CodingHarness are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/).

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
