# localpi patterns — borrowed from dutifuldev/localpi (MIT)

Reference module: `src/localpi/`. Eight files, all TypeScript-strict, all
covered by `src/__tests__/localpi.test.ts` (28 tests, `node:test`).

## What this is

A self-contained port of the highest-value patterns from
[`dutifuldev/localpi`](https://github.com/dutifuldev/localpi) (Bob /
dutifuldev, MIT). Kept as a `src/localpi/` subdirectory so the rest of the
codebase is not disturbed — pick whichever pieces you want to integrate.

## What's here

```
src/localpi/
├── common/
│   ├── json.ts         # JSON-at-boundary: asObject / optionalString / requiredString / asArray
│   └── result.ts       # CommandResult + ok/fail helpers
├── provider/
│   ├── registry.ts     # ProviderConfig + lmStudioProvider / vllmProvider / dedupe
│   ├── catalog.ts      # CatalogModel + discoverOpenAiCompatibleModels + findContextWindow
│   └── selection.ts    # TTY-aware selection policy + assertNoLoadedExternalModels
├── runtime/
│   └── supervisor.ts   # Managed-process lifecycle (pid + JSON metadata + alive check)
└── extensions/
    ├── approval-gate.ts  # "Do not claim blocked tools ran" extension
    └── token-status.ts   # Live tok/s | out N | in N | cache N | ctx% status line
```

## The six rules this encodes

1. **JSON-at-boundary.** All `unknown` JSON enters through
   `src/localpi/common/json.ts`. Throws with a `context` string on bad
   input. After the boundary, everything is typed. **No `any`, no
   `as any`** in this module — strict mode passes with
   `noUncheckedIndexedAccess: true`.
2. **Single normalized type.** Provider adapters return `CatalogModel[]`.
   Selection, UI, and launch planning operate only on `CatalogModel`.
   No provider-specific types leak past the adapter.
3. **TTY-aware selection.** Multiple loaded + TTY → return `needs-picker`.
   Multiple loaded + non-TTY → fail with the choices listed.
   `--provider` without `--model` only scopes the filter.
4. **Memory safety.** `assertNoLoadedExternalModels()` throws before
   starting a managed runtime if another heavyweight provider is
   already loaded. The user must unload first.
5. **Process ownership.** Pid + JSON metadata + `process.kill(pid, 0)`
   + cross-check `/proc/<pid>/cmdline` (Linux) or `ps -p` (macOS).
   SIGTERM with 5s grace, then SIGKILL with 2s grace, then delete
   metadata. Reuse when the spec matches.
6. **Approval honesty.** Inject the system-prompt rule on
   `before_agent_start`. Block + reason on `tool_call` when the user
   denies. The model must not claim blocked tools ran.

## How to integrate

| Pattern | Where to land it |
| --- | --- |
| `common/json.ts` | `src/util/json.ts` — drop in next to `errors.ts` / `retry.ts` |
| `common/result.ts` | `src/util/result.ts` (or inline into the CLI) |
| `provider/registry.ts` | alongside `src/providers/registry.ts` + `presets.ts` |
| `provider/catalog.ts` | new `src/providers/catalog.ts` (extends the existing `registry.ts`) |
| `provider/selection.ts` | new `src/providers/selection.ts` (call from `ch agent` / `ch run`) |
| `runtime/supervisor.ts` | `src/util/process-supervisor.ts` (used by anything that spawns a local server) |
| `extensions/approval-gate.ts` | `src/agent/extensions/approval-gate.ts` (registers with `ExtensionRegistry`) |
| `extensions/token-status.ts` | `src/agent/extensions/token-status.ts` (status line for the TUI / web) |

Don't merge the module wholesale. The patterns are designed to be picked.

## Origin & license

`dutifuldev/localpi` — MIT. Original files:

| Port | Source |
| --- | --- |
| `src/localpi/common/json.ts` | [`src/common/json.ts`](https://github.com/dutifuldev/localpi/blob/main/src/common/json.ts) |
| `src/localpi/common/result.ts` | [`src/common/result.ts`](https://github.com/dutifuldev/localpi/blob/main/src/common/result.ts) |
| `src/localpi/provider/registry.ts` | [`src/localpi/provider-registry.ts`](https://github.com/dutifuldev/localpi/blob/main/src/localpi/provider-registry.ts) |
| `src/localpi/provider/catalog.ts` | [`src/localpi/catalog.ts`](https://github.com/dutifuldev/localpi/blob/main/src/localpi/catalog.ts) |
| `src/localpi/provider/selection.ts` | [`src/localpi/runtime-selection.ts`](https://github.com/dutifuldev/localpi/blob/main/src/localpi/runtime-selection.ts) |
| `src/localpi/runtime/supervisor.ts` | [`src/localpi/llama-server.ts`](https://github.com/dutifuldev/localpi/blob/main/src/localpi/llama-server.ts) |
| `src/localpi/extensions/approval-gate.ts` | [`src/pi/extensions.ts:approvalExtensionSource`](https://github.com/dutifuldev/localpi/blob/main/src/pi/extensions.ts) |
| `src/localpi/extensions/token-status.ts` | [`src/pi/extensions.ts:tokenStatusExtensionSource`](https://github.com/dutifuldev/localpi/blob/main/src/pi/extensions.ts) |

## Tests

`npx tsx --test src/__tests__/localpi.test.ts` — 28/28 pass.

## What NOT to copy

- The `gemma-*` built-in aliases in `localpi/src/localpi/models.ts` —
  those are local dev paths under `~/scratch/`. Build your own.
- The "external provider, never start/stop" rule for LM Studio / vLLM.
  CodingHarness wants to be able to launch LM Studio too, so that
  constraint doesn't apply here.
- The `localagent → localpi` rename history. Not relevant.
