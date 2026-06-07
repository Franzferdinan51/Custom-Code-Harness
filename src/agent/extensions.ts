// Extension loader. Two flavors:
//
// 1. JSON manifests in ~/.codingharness/extensions/<name>.json or
//    .codingharness/extensions/. They can add tools, slash commands,
//    and a system-prompt append. Loaded as plain data, no eval.
//
// 2. TypeScript modules (documented for v2, not implemented in v1).
//    The plan: drop a .ts file in extensions/, we tsx-import it on
//    startup, it exports a default function that gets the runtime
//    and can register things on it.

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
  /** Lines to append to the system prompt. */
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
