# Changelog

All notable changes to CodingHarness are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

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
