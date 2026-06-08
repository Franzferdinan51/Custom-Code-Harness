# Team memory

Shared across all reins in this `.harness/`. Each rein can append learnings here as the team encounters them.

Use the three-question test (narrowest first):
1. Only true in this project? → stays here (project memory).
2. Still true on a different project? → also write to `~/.mavis/agents/mavis/memory/MEMORY.md` (agent memory).
3. Would the conclusion change for a different user? → user memory.

## Project-level facts

- `CODINGHARNESS_HOME` (or `CH_HOME`) is the env var that tests must set to override `~/.codingharness`. See `code-standards.md` for the required subdirs.
- The `ch` launcher is a bash script at `bin/ch` that prefers `bun` (OpenTUI's FFI binding) and falls back to `node`.
- The repo lives at `https://github.com/Franzferdinan51/Custom-Code-Harness`.
- Branch: `main`. Never push to it directly.
- Version 0.2.2 as of 2026-06-07.

## Recent decisions (chronological)

- **2026-06-07** — TUI built on OpenTUI (was hand-rolled ANSI in v0.2.0). Migration deleted ~1,200 LoC of dead TUI code.
- **2026-06-07** — Electron desktop shell rewritten on the `anomalyco/opencode/packages/desktop` pattern: sidecar server, single-instance lock, auto-updater, protocol handler, hardened runtime.
- **2026-06-07** — Provider failover wired into the agent loop (was config-only in v0.2.0).
- **2026-06-07** — Bash approval flow has 5 modes: off / allowlist / blocklist / on-mutation (default) / ask. TUI + web UI both surface the modal; `allow-always` persists to `settings.json`.
- **2026-06-07** — Trajectory export added: `ch export --format hermes|openai|share`. `share` redacts API keys and absolute paths.
- **2026-06-07** — `ch compact` slash command wired end-to-end with a colored diff preview (`✓` kept / `✗` removed).
- **2026-06-07** — Parallel tool execution: read-only tools (read, grep, find, ls, web_search, http, list_skills, read_memory, search_memory, read_todo) run concurrently when a step is all-safe. Mutating tools force sequential.
