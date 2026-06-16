// On-disk persistence for installed MCP servers.
//
// The MCP client (`src/agent/mcp-client.ts`) discovers MCP servers
// (Claude Code's `~/.claude/mcp_servers.json`, Cursor's, npm
// packages via `npx -y`) and writes one entry per server into
// `~/.codingharness/mcp.json`. The `McpRegistry` that backs the
// `Delegation { kind: "mcp" }` dispatch reads from the same file
// to find which servers are installed and how to spawn / connect
// to them.
//
// File shape (single JSON object keyed by server id):
//
//   {
//     "<serverId>": {
//       "id": "<serverId>",
//       "name": "<display name>",
//       "transport": "stdio" | "http",
//       "command": "<argv[0]>",          // stdio only
//       "args": ["<argv>", ...],         // stdio only
//       "url": "https://...",            // http only
//       "version": "<advertised at install>",
//       "installedAt": <epoch ms>,
//       "tools": [{ "name": "...", "description": "...", "parameters": {...} }, ...]
//     },
//     ...
//   }
//
// Writes are atomic (write to a sibling `.tmp` file, then rename)
// so concurrent `mcp add` calls never corrupt the file. Concurrent
// adds serialize on an in-process mutex; cross-process safety
// depends on the rename being atomic on the platform (POSIX
// guarantees it; Windows is best-effort — see
// `saveMcpConfigAtomic` for the rationale).
//
// Reading is lazy and cheap: the file is tiny (a few KB even at
// 100 installed servers), so we re-read it on every dispatch
// rather than caching. The `McpRegistry` holds a `McpConfigFile`
// snapshot at construction time — the CLI subcommands call
// `loadMcpConfig()` to refresh it after every add / remove.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../config/paths.js";
import type { McpToolDefinition } from "../mcp-transport.js";

// ---------- Public types ----------

/** Transport kinds the harness supports for outbound MCP calls.
 *  Mirrors the inbound transports in `src/mcp-server.ts`. */
export type McpTransport = "stdio" | "http";

/** One installed MCP server. The transport-specific fields are
 *  optional in the TS type but the validation in `parseEntry`
 *  rejects entries that don't have the right ones for their
 *  transport (stdio needs `command`; http needs `url`). */
export interface McpServerEntry {
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio: command to spawn (resolved argv[0]). */
  command?: string;
  /** stdio: extra argv tail. */
  args?: string[];
  /** stdio: working directory for the child. Optional. */
  cwd?: string;
  /** http: full URL (http or https). */
  url?: string;
  /** Server version string from the `initialize` handshake. */
  version: string;
  /** Epoch ms. */
  installedAt: number;
  /** Tools the server advertised in `tools/list`. Each entry is
   *  stored in the `McpToolDefinition` shape so the registry can
   *  hand it back through `listServers()`. */
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  /** Optional env vars to pass to a stdio subprocess (key=value).
   *  Stored as an array of strings; the client re-parses them
   *  into the spawn() env. Useful for API keys the user wants
   *  pinned to one server. */
  env?: string[];
}

/** The whole config file is one object keyed by server id. */
export type McpConfigFile = Record<string, McpServerEntry>;

// ---------- Validation ----------

/** Best-effort validator for a single entry. Returns the entry
 *  when valid, `null` when a field is missing / wrong-typed. Used
 *  on every read so a hand-edited file (or a stale file from a
 *  future version) doesn't crash the harness. */
export function parseEntry(o: unknown): McpServerEntry | null {
  if (!o || typeof o !== "object") return null;
  const e = o as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id) return null;
  if (typeof e.name !== "string" || !e.name) return null;
  if (e.transport !== "stdio" && e.transport !== "http") return null;
  if (typeof e.version !== "string") return null;
  if (typeof e.installedAt !== "number" || !Number.isFinite(e.installedAt)) return null;
  if (!Array.isArray(e.tools)) return null;
  const tools: McpServerEntry["tools"] = [];
  for (const t of e.tools) {
    if (!t || typeof t !== "object") return null;
    const tt = t as Record<string, unknown>;
    if (typeof tt.name !== "string" || !tt.name) return null;
    const desc = typeof tt.description === "string" ? tt.description : "";
    const params = (tt.parameters && typeof tt.parameters === "object")
      ? tt.parameters as Record<string, unknown>
      : {};
    tools.push({ name: tt.name, description: desc, parameters: params });
  }
  let command: string | undefined;
  let args: string[] | undefined;
  let cwd: string | undefined;
  if (e.transport === "stdio") {
    if (typeof e.command !== "string" || !e.command) return null;
    command = e.command;
    if (e.args !== undefined) {
      if (!Array.isArray(e.args)) return null;
      const a: string[] = [];
      for (const x of e.args) if (typeof x === "string") a.push(x);
      args = a;
    }
    if (e.cwd !== undefined) {
      if (typeof e.cwd !== "string") return null;
      cwd = e.cwd;
    }
  }
  let url: string | undefined;
  if (e.transport === "http") {
    if (typeof e.url !== "string" || !e.url) return null;
    try { new URL(e.url); } catch { return null; }
    url = e.url;
  }
  let env: string[] | undefined;
  if (e.env !== undefined) {
    if (!Array.isArray(e.env)) return null;
    const v: string[] = [];
    for (const x of e.env) if (typeof x === "string") v.push(x);
    env = v;
  }
  const out: McpServerEntry = {
    id: e.id,
    name: e.name,
    transport: e.transport,
    version: e.version,
    installedAt: e.installedAt,
    tools,
  };
  if (command !== undefined) out.command = command;
  if (args !== undefined) out.args = args;
  if (cwd !== undefined) out.cwd = cwd;
  if (url !== undefined) out.url = url;
  if (env !== undefined) out.env = env;
  return out;
}

/** Parse a full config file. Skips invalid entries instead of
 *  throwing — a partially-corrupt file shouldn't brick the CLI. */
export function parseConfig(o: unknown): McpConfigFile {
  if (!o || typeof o !== "object" || Array.isArray(o)) return {};
  const out: McpConfigFile = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const e = parseEntry(v);
    if (e && e.id === k) out[k] = e;
  }
  return out;
}

// ---------- File path resolver ----------

/** Resolve the path to `mcp.json`. Tests inject a tmp dir via the
 *  `MCP_CONFIG_PATH` env var (set before importing this module);
 *  production uses `~/.codingharness/mcp.json`. The factory
 *  pattern lets `McpRegistry` swap the path without monkey-patching
 *  `paths.mcpJson` (which is module-cached). */
export function resolveMcpConfigPath(): string {
  if (process.env.MCP_CONFIG_PATH) return process.env.MCP_CONFIG_PATH;
  return paths.mcpJson;
}

// ---------- Atomic write ----------

/** Serialize a config to disk atomically. Write to `<path>.tmp`,
 *  fsync (best-effort), then rename. Concurrent writes serialize
 *  on `writeLock` (in-process); cross-process writers see the
 *  rename-atomic guarantee from POSIX (`rename(2)` is atomic on
 *  the same filesystem). */
let writeLock: Promise<void> = Promise.resolve();

export async function saveMcpConfigAtomic(
  config: McpConfigFile,
  filePath: string = resolveMcpConfigPath(),
): Promise<void> {
  const prev = writeLock;
  let release: () => void = () => {};
  writeLock = new Promise<void>((r) => { release = r; });
  try {
    await prev;
    await writeMcpConfigUnlocked(config, filePath);
  } finally {
    release();
  }
}

async function writeMcpConfigUnlocked(config: McpConfigFile, filePath: string): Promise<void> {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp." + process.pid + "." + Date.now().toString(36);
  const json = JSON.stringify(config, null, 2) + "\n";
  writeFileSync(tmp, json, "utf-8");
  // Best-effort fsync — Node's writeFileSync doesn't expose
  // fsync(2), so we open + write + sync through fd for stronger
  // durability. The fsync failure path leaves the tmp file
  // around; rename failure below cleans it up.
  try {
    const { openSync, fsyncSync, closeSync } = await import("node:fs");
    const fd = openSync(tmp, "r+");
    try { fsyncSync(fd); } catch { /* fsync not supported on some FS */ }
    try { closeSync(fd); } catch { /* ignore */ }
  } catch { /* ignore */ }
  renameSync(tmp, filePath);
}

// ---------- Read ----------

/** Read and parse the config file. Returns an empty object when
 *  the file doesn't exist (first-run) or is unreadable. Skips
 *  invalid entries via `parseConfig` (which itself is forgiving). */
export async function loadMcpConfig(
  filePath: string = resolveMcpConfigPath(),
): Promise<McpConfigFile> {
  if (!existsSync(filePath)) return {};
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return {}; }
  return parseConfig(parsed);
}

/** Synchronous read for the in-process registry. The file is tiny
 *  so blocking on it is fine. Returns `{}` on any failure. */
export function loadMcpConfigSync(
  filePath: string = resolveMcpConfigPath(),
): McpConfigFile {
  if (!existsSync(filePath)) return {};
  let text: string;
  try { text = readFileSync(filePath, "utf-8"); } catch { return {}; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return {}; }
  return parseConfig(parsed);
}

// ---------- Mutators ----------

/** Insert or replace one entry. Returns the new config. */
export async function upsertMcpServerEntry(
  entry: McpServerEntry,
  filePath?: string,
): Promise<McpConfigFile> {
  const current = await loadMcpConfig(filePath);
  current[entry.id] = entry;
  await saveMcpConfigAtomic(current, filePath);
  return current;
}

/** Remove one entry by id. Returns the new config (which may be
 *  empty after a successful remove). A no-op when the id isn't
 *  present. */
export async function removeMcpServerEntry(
  id: string,
  filePath?: string,
): Promise<McpConfigFile> {
  const current = await loadMcpConfig(filePath);
  if (id in current) {
    delete current[id];
    await saveMcpConfigAtomic(current, filePath);
  }
  return current;
}

/** Convert a `McpServerEntry.tools[]` to the `McpToolDefinition[]`
 *  shape the registry hands back to the agent loop. */
export function entryToolsToDefinitions(entry: McpServerEntry): McpToolDefinition[] {
  return entry.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: "object",
      ...t.parameters,
    },
  }));
}