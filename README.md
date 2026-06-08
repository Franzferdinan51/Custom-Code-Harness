# CodingHarness

A versatile terminal coding harness, written in TypeScript. Multi-provider,
extensible, and built to never crash mid-edit.

```
$ ch
┌─ CodingHarness v0.2.0 ──────────────────────────────────────────┐
│ openai/gpt-4o · session:abc123 · 1.2k in / 340 out                 │
├───────────────────────────────────────────────────────────────────┤
│  › list the files in src/ and tell me which ones import lodash   │
│                                                                   │
│  ✓ read /Users/you/Desktop/CodingHarness/src/cli.ts (210 lines)  │
│                                                                   │
│  The CLI entrypoint parses args and routes to one of 16            │
│  subcommands...                                                   │
├───────────────────────────────────────────────────────────────────┤
│ ⏎ send · ⇧⏎ newline · Tab complete · ↑/↓ history · Ctrl+C abort │
└───────────────────────────────────────────────────────────────────┘
```

## Startup commands

Following the same pattern as `grok` / `grok agent` / `codex`:

| Command        | What it does                                                     |
| -------------- | ---------------------------------------------------------------- |
| `ch`           | **TUI** (auto-detected in a TTY), or simple REPL                 |
| `ch chat`      | TUI / REPL (explicit)                                            |
| `ch repl`      | Force the simple line-based REPL (no TUI)                        |
| `ch tui`       | Force the full TUI                                               |
| `ch run`       | Quick one-shot prompt, exits after one response                  |
| `ch agent`     | Full-power one-shot: sub-agents, skills, all tools              |
| `ch code`      | Code-focused one-shot (editor persona)                           |
| `ch goal`      | Multi-step auto-planning toward an objective                    |
| `ch loop`      | Re-send a prompt N times, with optional sentinel                 |
| `ch doctor`    | Run diagnostics and print the report                             |
| `ch skills`    | List installed skills                                            |
| `ch agents`    | List available sub-agents                                        |
| `ch skill`     | Load a skill by name and feed it to the agent                    |
| `ch memory`    | Read, append, or search persistent memory                        |
| `ch cron`      | Manage scheduled jobs                                            |
| `ch sessions`  | List, show, fork, or send to a session                          |
| `ch init`      | Generate a starter `.codingharness/AGENTS.md` in the cwd        |
| `ch serve`     | Run a headless HTTP server with `/v1/chat`, `/v1/spawn`, etc.    |
| `ch export`    | Export a session as a JSONL trajectory (hermes / openai / share) |
| `ch web`       | Start the server AND open the web UI in your browser            |
| `ch desktop`   | Launch the native desktop app (Electron)                        |
| `ch update`    | Self-update: `git pull && npm install && build && link`          |
| `ch version`   | Print the version                                                |
| `ch help`      | Show help (or `ch help <subcommand>` for a specific one)        |

## Web UI & desktop app

The same `ch serve` server powers three UIs:

1. **TUI** (the default in a TTY) — built on OpenTUI.
2. **Web UI** — `ch web` starts the server and opens your browser at
   `http://127.0.0.1:<port>/`. Dark mode, sidebar with sessions / active
   sub-agents / cost totals, streaming chat, slash autocomplete,
   approval modal, settings modal. Vanilla JS, zero build step.
3. **Native desktop app** — `npm run electron` from the project root
   opens the web UI in a real `BrowserWindow` with a system-tray icon.
   Build distributables with `npm run dist:mac` (`.dmg` + `.zip`),
   `dist:win` (`.exe` + portable), or `dist:linux` (`.AppImage` + `.deb`).

The HTTP+SSE API is stable and can also be driven by anything that
speaks `fetch` and `EventSource`:

```bash
# status
curl http://127.0.0.1:18800/v1/status

# stream a chat
curl -N -X POST http://127.0.0.1:18800/v1/chat/stream \
  -H 'content-type: application/json' \
  -d '{"prompt":"list the files in src/","sessionId":"default"}'
```

## Trajectory export

`ch export` writes a session as JSONL for fine-tuning or sharing:

```bash
ch export --latest --format=hermes   # full event log
ch export --latest --format=openai   # chat-completions format for SFT
ch export --latest --format=share    # anonymized openai (no secrets, relative paths)
```

Default output: `~/.codingharness/exports/<session-prefix>-<timestamp>-<format>.jsonl`.

The legacy flag style still works: `ch -p "hi"` is equivalent to
`ch run "hi"`. So is `ch --doctor` to `ch doctor`.

## TUI mode

`ch` in a TTY automatically opens a full-screen TUI built on
[OpenTUI](https://github.com/anomalyco/opentui) — the native Zig
TUI library that powers [OpenCode](https://opencode.ai) in
production. The harness owns no TUI code itself; we just compose
OpenTUI primitives (`Box`, `Text`, `Textarea`, `ScrollBox`) under a
Yoga flexbox layout.

What you get:

- **RGBA colors** — no more ANSI 16-color palette; full 24-bit color
  per cell
- **Yoga flexbox layout** — header / messages / input / footer are
  flex children that reflow on resize
- **Native rendering** — the draw loop runs in Zig, not by emitting
  ANSI strings
- **Mouse support** — click to focus, drag to select text
- **Box borders, titles, focus states** — keyboard nav between focusables
- **ScrollBox** — the message area scrolls and sticks to the bottom
  on new content
- **Textarea** — multi-line input with selection, undo, word-jump,
  paste handling

The TUI binding is the same as before: ⏎ send · ⇧⏎ newline · Tab
slash autocomplete · ↑/↓ history · Ctrl+C abort · Ctrl+D quit ·
Ctrl+L clear.

If you'd rather not have the TUI (e.g. in a script or a tiny terminal):

```bash
ch repl           # or: ch --no-tui
```

**Runtime requirement:** OpenTUI needs `bun` (or Node with
`--experimental-ffi --allow-ffi`) for the native FFI binding. The
`ch` launcher auto-detects `bun` and falls back to node if bun
isn't installed. Install bun with `curl -fsSL https://bun.sh/install | sh`.

## Self-updating

`ch update` pulls the latest source, reinstalls deps, rebuilds, and
re-links the global `ch` binary:

```bash
ch update         # pull + install + build + link
ch update --check # just check, don't apply
ch update --channel dev
```

The updater only works if CodingHarness was installed from a git repo
(`ch` is a symlink back to the source tree via `npm link`). For an
npm-published install, run `npm install -g codingharness@latest`
instead.

## What's in v0.2

A full **sub-agent** system, a **skills** system following the
[agentskills.io](https://agentskills.io) standard, **persistent memory**,
**AGENTS.md** context loading, **automatic + manual compaction**,
**cron scheduling**, **30+ slash commands**, **doctor diagnostics**,
a fresh **extension manifest** format, a **`serve` mode** that
exposes the agent over HTTP, a full **TUI**, and a self-updater —
all inspired by the best parts of Hermes, OpenClaw, openclaude, pi,
goose, and codex.

| From              | What we pulled                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------- |
| **Hermes**        | Sub-agents with isolation, skills system, memory, cron, doctor, multi-provider, retry/undo   |
| **OpenClaw**      | Multi-agent routing, AGENTS.md/SOUL.md context files, sandbox flag, sessions_spawn, /compact  |
| **openclaude**    | Per-agent model routing (`agentRouting`), gRPC-style headless server hooks (extensible)        |
| **goose**         | Recipe pattern → `/goal` auto-planner; self-test recipe philosophy                            |
| **pi**            | Minimal core, JSONL sessions with tree, prompt templates, extensions, "no MCP" stance         |
| **codex**         | ChatGPT OAuth detection in registry, prompt-caching mindset, sandbox thinking                 |

## Quick start

```bash
# Install (zero runtime deps — just Node 18+)
cd /Users/duckets/Desktop/CodingHarness
npm install

# Configure a provider
export OPENAI_API_KEY=sk-...   # or ANTHROPIC_API_KEY=sk-ant-...

# Run
node bin/ch                                   # REPL (default)
node bin/ch chat                              # REPL (explicit)
node bin/ch run "explain src/cli.ts"          # quick one-shot
node bin/ch agent "add a /healthcheck"        # full-power one-shot
node bin/ch code "review the auth flow"       # code-focused one-shot
node bin/ch goal "wire OAuth" --max-steps=8   # multi-step objective
node bin/ch loop 5 "run tests until pass"     # loop
node bin/ch doctor                            # diagnostics
node bin/ch agents                            # list sub-agents
node bin/ch skills                            # list skills
node bin/ch sessions                          # list sessions
node bin/ch memory read                       # read memory
node bin/ch cron list                         # list cron jobs
node bin/ch init                              # init project
node bin/ch serve --port 7777                 # headless HTTP API
```

## Slash commands (v0.2: 30 commands)

| Group        | Commands                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------- |
| **Session**  | `/help`, `/session`, `/sessions list/show/fork/send`, `/resume`, `/new`, `/reset`, `/clear`, `/quit`, `/exit` |
| **Model**    | `/model`, `/provider`, `/status`, `/usage`, `/think <level>`                              |
| **Time**     | `/retry`, `/undo`                                                                         |
| **Context**  | `/compact`, `/memory read/add/search/user/useradd`, `/tree`, `/fork`                       |
| **Sub-agents** | `/agents` (list), spawn via `spawn_subagent` tool with `explore\|plan\|review\|summarize\|implement\|test` |
| **Skills**   | `/skill list/<name>`                                                                     |
| **Schedule** | `/cron list/add/remove/run/enable/disable`                                                 |
| **Other**    | `/goal`, `/loop`, `/doctor`, `/init`, `/prompts list/<name>`, `/mcp`, `/personality`      |

### `/goal` and `/loop` (the headline features)

```
/goal "add a /healthcheck slash command that pings the configured provider"
```

The agent plans, executes step-by-step, stops on `GOAL COMPLETE` / `GOAL BLOCKED`,
or hits `--max-steps=N`. Internally it just calls the agent in a loop.

```
/loop 5 GOAL COMPLETE
```

Re-sends the previous prompt N times, with optional sentinel text for early exit.

## Sub-agents

The model can call a `spawn_subagent` tool to delegate. Built-in types:

| Name        | Tools                          | Use for                                              |
| ----------- | ------------------------------ | ---------------------------------------------------- |
| `explore`   | read, grep, find, ls, bash     | Read-only codebase research, no edits                |
| `plan`      | read, grep, find, ls           | Producing a structured plan, no edits                |
| `review`    | read, bash, grep               | Reviewing code for bugs/security/perf                |
| `summarize` | read, grep                     | Compressing long text/files/transcripts              |
| `implement` | (all)                          | Making a well-specified change with full tool access |
| `test`      | bash, read, edit, grep         | Running tests and iterating on failures              |

User-defined sub-agents: drop a JSON file into
`~/.codingharness/agents/<name>.json`:

```json
{
  "name": "frontend-reviewer",
  "description": "Reviews frontend code",
  "systemPromptAppend": "Focus on accessibility, performance, and bundle size.",
  "tools": ["read", "grep", "bash"],
  "maxSteps": 16,
  "tags": ["read-only", "frontend"]
}
```

## Skills (agentskills.io)

Drop a `SKILL.md` into `~/.codingharness/skills/<name>/`:

```markdown
---
name: code-review
description: How to do a thorough code review in this repo
---

# Code Review

When reviewing, follow these steps:
1. Read the diff with `git diff`
2. Look for: ...
```

Then `/skill code-review` loads it. Skills are also auto-discovered and
their names appear in the system prompt as a catalog.

## Memory (cross-session)

```bash
# inside the REPL
/memory add "user prefers dark mode"
/memory search "theme"
/memory read
/memory useradd "name: Ryan, role: builder"
```

The agent itself can call the `memory` tool to read/append/search.

## Context files

`AGENTS.md` (or `CLAUDE.md`) is automatically discovered and injected into
the system prompt. Walking order (highest priority last):

1. `~/.codingharness/AGENTS.md` (global)
2. `~/.agents/AGENTS.md` (agentskills.io user)
3. Walk up from `cwd` to filesystem root, collect all `AGENTS.md` / `CLAUDE.md`
4. `.codingharness/AGENTS.md` in the cwd

Run `/init` in a new project to drop a starter `AGENTS.md`.

## Cron scheduling

```bash
/cron add every 30 min "summarize recent changes"
/cron add daily 09:00 "run the test suite"
/cron add "*/5 * * * *" "check the build status"
/cron list
/cron run <id>      # run once now
/cron disable <id>
```

Schedules: `every N min` / `every Nh` / `daily HH:MM` / `at <iso>` / raw cron expr.
Jobs are stored in `~/.codingharness/cron/jobs.json`.

## Per-agent model routing

```json
{
  "agentRouting": {
    "explore":  { "model": "deepseek/deepseek-chat" },
    "review":   { "model": "anthropic/claude-sonnet-4-5" },
    "implement":{ "provider": "openai", "model": "gpt-4o" }
  }
}
```

The `explore` sub-agent will then use deepseek, the `review` sub-agent will
use Claude, and `implement` will use OpenAI — all from one harness, one
session, one transcript.

## Compaction

Long sessions auto-compact when rough token count exceeds 85% of the
soft cap. Manual:

```
/compact
/compact "focus on API decisions and open questions"
```

The summarization uses the current provider/model. Original messages
stay in the session JSONL — compaction is reversible (load and rewind).

## Settings

`~/.codingharness/settings.json`:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-4o",
  "providers": {
    "openai":      { "apiKey": "sk-...", "model": "gpt-4o" },
    "openrouter":  { "apiKey": "sk-or-...", "baseUrl": "https://openrouter.ai/api/v1", "model": "anthropic/claude-3.5-sonnet" },
    "anthropic":   { "apiKey": "sk-ant-...", "model": "claude-sonnet-4-5" }
  },
  "agentRouting": {
    "explore":  { "model": "deepseek/deepseek-chat" },
    "implement":{ "model": "gpt-4o" }
  },
  "failover": [
    { "provider": "openai", "model": "gpt-4o" },
    { "provider": "openrouter", "model": "anthropic/claude-3.5-sonnet" }
  ],
  "sandbox": { "mode": "host" },
  "thinking": "medium",
  "loadContextFiles": true,
  "contextCompactionThreshold": 0.85,
  "ui": { "color": "auto", "showTokenUsage": true }
}
```

## Architecture

```
src/
  cli.ts                 # Entry point, arg parsing
  runtime.ts             # Wires everything (provider + agent + session + slash + sub-agents + skills + memory)
  types.ts               # ChatMessage, Provider, Tool, ToolResult

  agent/
    loop.ts              # The agent loop (the file that does or doesn't crash)
    session.ts           # JSONL session with tree structure (parent/child links)
    agents.ts            # Sub-agent definitions (built-ins + user JSON)
    subagent.ts          # SubAgentManager — spawn isolated child runs
    skills.ts            # SkillRegistry (agentskills.io loader)
    memory.ts            # Persistent MEMORY.md / USER.md
    context.ts           # AGENTS.md/CLAUDE.md walker
    prompts.ts           # Prompt template loader (~/.codingharness/prompts/)
    cron.ts              # CronStore + cron expression parser
    compaction.ts        # /compact logic
    extensions.ts        # Extension manifest loader
    tools/
      read.ts            # Atomic read
      write.ts           # Atomic write (temp + rename)
      edit.ts            # Targeted replacement (refuses on ambiguity)
      bash.ts            # Shell exec with timeout + abort
      grep.ts            # Content search (JS fallback, no ripgrep dep)
      find.ts            # File finder
      ls.ts              # Directory listing
      http.ts            # HTTP fetch with timeout
      web-search.ts      # DuckDuckGo search (no API key)
      todo.ts            # In-session todo list
      spawn-subagent.ts  # The spawn_subagent tool
      skill.ts           # The skill tool
      memory.ts          # The memory tool
      registry.ts        # Tool interface, validation helpers
      index.ts           # Default registry

  providers/
    openai-compat.ts     # OpenAI, OpenRouter, LM Studio, vLLM, DeepSeek, ...
    anthropic.ts         # Native Anthropic Messages API
    registry.ts          # Provider discovery + stub registration (for tests)

  slash/
    registry.ts          # Slash command interface
    builtin.ts           # 30 built-in commands

  config/
    paths.ts             # ~/.codingharness/ paths (lazy-evaluated)
    settings.ts          # settings.json loader

  ui/
    colors.ts            # Tiny ANSI helpers
    repl.ts              # Line-based REPL with AbortSignal plumbing

  util/
    logger.ts            # Leveled logger
    errors.ts            # ToolError, withTimeout, anySignal
    retry.ts             # Exponential backoff

  doctor.ts              # ch doctor diagnostics
```

## Reliability notes

The places where most harnesses crash, and what we do:

1. **SSE stream parse failure** — wrapped in `try {} finally { reader.releaseLock() }`.
2. **Tool that throws** — every tool runs inside a try/catch in the loop. Crashes become `isError: true` results.
3. **Half-written file** — `write` and `edit` use temp file + `rename`. Power loss between them leaves the original intact.
4. **Context explosion** — tool results > 200 KB are truncated before being added to the transcript.
5. **Network hang** — every provider call uses a derived `AbortSignal` that fires on user Ctrl+C **and** after `requestTimeoutMs`.
6. **Sub-agent crash** — sub-agents run in their own try/catch; parent never sees their internal errors, only the result.

## Testing

```bash
npm test               # 42 tests across agent loop, tools, slash, new systems
npm run test:smoke     # end-to-end smoke with stub provider
npx tsc --noEmit       # type check
```

## What's NOT in v0.2 (and why)

- **MCP** — pi's argument is right; a CLI tool with a README beats a protocol for v1. Stub only.
- **Multi-channel gateway** (Telegram/Discord) — out of scope for a coding harness.
- **TS extension loader** — extensions work via JSON manifests in v0.2. Full TS hooks are a v2 item.
- **Real sandboxing** — Docker sandbox is in the config schema but the v0.2 runner just sets `mode: "host"`. Wire in `dockerode` when you need it.

## Roadmap

- [ ] TS extension loader (pi-style)
- [ ] Real MCP client (lazy-loaded)
- [ ] Docker sandbox runtime
- [ ] Session branching UI (`/tree`)
- [ ] Trajectory export for training (Hermes-style)
- [x] Web UI (alongside TUI) — done in v0.2.2
- [x] Provider failover in the loop (config is there, runner is not) — done in v0.2.2
- [ ] Compaction UI: show diff of what was summarized
- [x] Wire the TUI approval modal into the bash tool flow — done in v0.2.2
- [x] Trajectory export for training (Hermes-style) — done in v0.2.2
- [x] Session branching UI (`/tree`) — done in v0.2.2
- [x] Compaction UI: show diff of what was summarized — done in v0.2.2
- [x] Real desktop shell (modeled on opencode) — done in v0.2.2

## License

MIT
