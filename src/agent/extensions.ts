// Extension loader. Two flavors:
//
// 1. JSON manifests in ~/.codingharness/extensions/<name>.json or
//    .codingharness/extensions/. They can add tools, slash commands,
//    and a system-prompt append. Loaded as plain data, no eval.
//
// 2. TypeScript modules (Phase 4 T2 — pi-style). Drop a
//    `extensions/<name>/index.ts` file; the loader
//    dynamic-imports it, validates a `manifest` export, calls
//    `default(activateContext)`, and the extension registers
//    hook handlers on the shared `ExtensionRegistry` via
//    `ctx.on(...)`.
//
// The new `loadExtensionsIntoRegistry()` function loads BOTH
// flavors into a single `ExtensionRegistry` so the agent loop
// has a uniform hook surface. The v1 `loadExtensions()` + JSON
// `manifestTools()` path is preserved verbatim — the v1 public
// surface must not break. JSON extensions can also participate
// in the hook system by declaring `systemPromptAppend`, which
// is registered as a `preSystemPrompt` handler for parity with
// the TS path.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { paths } from "../config/paths.js";
import type { ToolSpec, ToolResult, ChatMessage } from "../types.js";
import type { ToolContext } from "./tools/registry.js";

export interface ExtensionManifest {
  name: string;
  description?: string;
  /** Extra slash commands to register. */
  commands?: Array<{
    name: string;
    description: string;
    usage?: string;
    /** A simple templated response. Vars: {{input}}. */
    response?: string;
  }>;
  /** Extra tools to make available to the agent. */
  tools?: Array<{
    name: string;
    description: string;
    /** Inline JSON-schema-ish for parameters. We accept loose shape. */
    parameters: { type: "object"; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
    /** A shell command to run. Vars: {{input}}. */
    command?: string;
  }>;
  /** Lines to append to the system prompt. Registered as a
   *  `preSystemPrompt` hook by the new TS loader so JSON
   *  extensions and TS extensions see identical behavior. */
  systemPromptAppend?: string;
  /** A regex list of bash commands that, if matched, are auto-allowed. */
  bashAllowlist?: string[];
}

export interface LoadedExtension {
  manifest: ExtensionManifest;
  path: string;
  source: "user" | "project";
}

export function loadExtensions(cwd: string): LoadedExtension[] {
  const out: LoadedExtension[] = [];
  const dirs: Array<{ dir: string; source: LoadedExtension["source"] }> = [
    { dir: join(cwd, ".codingharness", "extensions"), source: "project" },
    { dir: paths.extensions, source: "user" },
  ];
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      const p = join(dir, f);
      try {
        const m = JSON.parse(readFileSync(p, "utf-8")) as ExtensionManifest;
        if (!m.name) m.name = basename(f, ".json");
        out.push({ manifest: m, path: p, source });
      } catch { /* skip bad json */ }
    }
  }
  return out;
}

/** Materialize a manifest's tool entries as Tool objects. */
export function manifestTools(ext: LoadedExtension): Array<{ spec: ToolSpec; run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> }> {
  const out: Array<{ spec: ToolSpec; run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> }> = [];
  for (const t of ext.manifest.tools ?? []) {
    if (!t.command) continue; // no-op tools are skipped
    const cmd = t.command;
    out.push({
      spec: { name: t.name, description: t.description, parameters: t.parameters as ToolSpec["parameters"] },
      run: async (raw, ctx) => {
        try {
          const cmdline = substitute(cmd, stringifyAll(raw));
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const pe = promisify(execFile);
          const out = await pe("bash", ["-lc", cmdline], { cwd: ctx.cwd, timeout: 30_000, maxBuffer: 1_000_000 });
          return { toolCallId: "", display: t.name, content: (out.stdout ?? "") + (out.stderr ? "\n" + out.stderr : ""), isError: false };
        } catch (e) {
          return { toolCallId: "", display: t.name + " failed", content: (e as Error).message, isError: true };
        }
      },
    });
  }
  return out;
}

function substitute(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
}
function stringifyAll(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  return out;
}

// ---------- Phase 4 T2 re-exports ----------
//
// `src/agent/extensions/loader.ts` + `registry.ts` + `context.ts`
// hold the new TS extension loader. They're re-exported here
// (the canonical import surface) so callers don't need to know
// the on-disk split. The shape is:
//
//   import { loadExtensionsIntoRegistry, ExtensionRegistry,
//            type ExtensionContext, type TsExtensionManifest } from "./extensions.js";
//
// Existing JSON-only callers keep using `loadExtensions` /
// `manifestTools` and are unaffected.

export {
  ExtensionRegistry,
  isHookName,
  type ExtensionHookName,
  type ExtensionInfo,
  type PreSystemPromptPayload,
  type PostToolResultPayload,
  type OnErrorPayload,
  type OnCompactionPayload,
  type ExtensionHandler,
  type DispatchResult,
} from "./extensions/registry.js";

export {
  loadExtensionsIntoRegistry,
  loadTsExtension,
  validateManifest,
  type LoadResult,
  type LoadOptions,
  type LoadedExtension as TsLoadedExtension,
  type ExtensionManifestShim,
} from "./extensions/loader.js";

export type {
  ExtensionContext,
  ExtensionHandlerMap,
  ExtensionLogger,
  TsExtensionManifest,
  Dispose,
} from "./extensions/context.js";
