# CodingHarness — Project Standards

Single source of truth for the rules every rein follows. Linked from each `agent.md` body instead of inlined, so updates happen in one place.

## Code style

- TypeScript strict mode, `noUncheckedIndexedAccess: true`. No `any` without a comment justifying it.
- ESM throughout, **except** the Electron main process (CommonJS — `.cjs`).
- Indent: 4 spaces in TS, 2 in CSS/HTML/JSON/YAML, 2 in `.cjs`.
- One thing per file where it helps clarity; long files are fine when cohesion demands it.
- Comments explain WHY, not WHAT. The code is the WHAT.

## Module boundaries

- New providers implement `Provider` in `src/types.ts`; they get registered in `src/providers/registry.ts`.
- New tools implement `Tool` in `src/agent/tools/registry.ts`; they get registered in `src/agent/tools/index.ts`.
- New slash commands implement `SlashCommand` in `src/slash/registry.ts`; they get registered in `src/slash/builtin.ts`.
- New sub-agents are JSON files in `~/.codingharness/agents/` (loaded by `SubAgentManager`).
- New skills are `SKILL.md` files in `~/.codingharness/skills/` (loaded by `SkillRegistry`).
- New CLI subcommands are registered with `registerSubcommand(name, desc, usage, run)` in `src/cli.ts`.

## Type system rules

- Discriminated union types: the **payload's** `kind` is the narrow discriminator. The entry-level `type` is a coarse label.
- Don't use `as any`. Use `as unknown as T` only when you've verified the shape.
- For tests that touch `paths.*`, set `process.env.CODINGHARNESS_HOME = tmp` AND `mkdirSync` subdirs BEFORE importing modules that read paths.

## Test rules

- All new behavior gets a test in `src/__tests__/`.
- Use `node:test` (NOT `bun:test`) — bun's nested `test()` is not implemented.
- Stub providers in agent-loop tests must be stateful: yield tool calls on call 1, then `done` on call 2+.
- For bash-tool tests, instantiate a `ToolContext` with `services.getApproval` (and optionally `askApproval`).
- Test naming: `<thing>: <expected behavior>` in a sentence — no `<thing>.test.ts` for the file.
- The pre-existing "test() inside another test()" errors in `src/__tests__/new-systems.test.ts` are a `bun` quirk and NOT a regression. Don't try to fix them in a feature PR.

## Commit & release

- Conventional commits: `feat:` / `fix:` / `docs:` / `refactor:` / `chore:` / `test:`.
- The version in `package.json` and the `VERSION` constants in `src/cli.ts` + `src/ui/tui.ts` + `src/ui/tui-app.ts` are bumped together in the same commit.
- The CHANGELOG entry goes under a new versioned section; if the change is post-release, it goes under a new "Added" subsection in the unreleased version.
- For desktop distributables: `npm run dist:publish` cuts a GitHub release, which `electron-updater` picks up.

## Security

- API keys come from env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, etc.) or `settings.json` (gitignored). Never hardcoded.
- The bash tool requires user approval under `on-mutation` mode for any command matching `MUTATION_PATTERNS`.
- `ch export --format share` redacts `sk-*` / `sk-ant-*` / `xai-*` / `ghp_*` / `AKIA*` / `AIza*` / PEM blocks before writing JSONL.
- Electron renderer: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. Don't relax any of these.
- Off-site links in the desktop app open in the system browser, not in-app.
