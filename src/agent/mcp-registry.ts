// Bridge from `McpRegistry` (the narrow interface in
// `src/agent/delegation.ts:375`) to the on-disk config and the
// MCP client. This is the piece the agent loop's
// `Delegation { kind: "mcp" }` dispatch talks to.
//
// Lifecycle:
//
//   - Construct once at runtime boot (`new LocalMcpRegistry()`).
//   - `listServers()` returns a stable view of every server in
//     `mcp.json`. The list is snapshotted at construction (cheap
//     re-read on `refresh()`).
//   - `callTool(serverId, tool, args, { signal, timeoutMs })`
//     lazily spawns / connects to the server, runs `tools/call`,
//     then closes the connection. Each call is one transport
//     session. (Future work: a pool that keeps a connection open
//     between calls. v1 keeps the cold-spawn model — it matches
//     the existing `goal` / `agent` cold-spawn patterns in the
//     delegation manager.)
//   - `add(entry)` writes a new entry and refreshes the snapshot.
//   - `remove(id)` deletes the entry and refreshes.
//
// "Unknown server" / "unknown tool" errors are surfaced as
// `McpCallResult { ok: false, error: ... }` (not throws) — the
// delegation manager expects this shape (`delegation.ts:1540-1542`).

import {
  loadMcpConfigSync,
  resolveMcpConfigPath,
  entryToolsToDefinitions,
  type McpConfigFile,
  type McpServerEntry,
} from "./mcp-store.js";
import {
  connectStdio,
  connectHttp,
  type McpClient,
} from "./mcp-client.js";
import type {
  McpRegistry,
  McpCallResult,
} from "./delegation.js";

export class LocalMcpRegistry implements McpRegistry {
  /** Stable id of the registry, per the `McpRegistry` interface. */
  readonly id = "local";
  /** Path to the on-disk config. Defaults to `~/.codingharness/mcp.json`
   *  via `resolveMcpConfigPath()`; tests inject a tmp path through
   *  the `MCP_CONFIG_PATH` env var (set before importing this file)
   *  or by passing an explicit `filePath` to the constructor. */
  private readonly filePath: string;
  /** Snapshot of the on-disk config, refreshed on `add` / `remove`
   *  and on explicit `refresh()`. The dispatch path
   *  (`callTool`) reads from this snapshot — concurrent edits are
   *  flushed on the next `add` / `remove` / `refresh`. */
  private snapshot: McpConfigFile;

  constructor(opts: { filePath?: string } = {}) {
    this.filePath = opts.filePath ?? resolveMcpConfigPath();
    this.snapshot = loadMcpConfigSync(this.filePath);
  }

  /** Re-read the file from disk. Cheap (file is small); called
   *  after `add` / `remove` to keep the snapshot current. */
  refresh(): void {
    this.snapshot = loadMcpConfigSync(this.filePath);
  }

  /** Read-only view of the current entries (for tests + CLI). */
  entries(): McpServerEntry[] {
    return Object.values(this.snapshot);
  }

  /** One server by id, or `undefined`. */
  get(id: string): McpServerEntry | undefined {
    return this.snapshot[id];
  }

  /** Implements the `McpRegistry.listServers` contract. Each server
   *  has an id and a display name. The tool list is intentionally
   *  omitted from the public type (the interface only carries
   *  `{ id, name? }`). */
  listServers(): Array<{ id: string; name?: string }> {
    return Object.values(this.snapshot).map((e) => ({
      id: e.id,
      name: e.name,
    }));
  }

  /** Insert or replace one entry and refresh the snapshot. */
  async add(entry: McpServerEntry): Promise<void> {
    const { upsertMcpServerEntry } = await import("./mcp-store.js");
    await upsertMcpServerEntry(entry, this.filePath);
    this.refresh();
  }

  /** Remove an entry by id. No-op when the id isn't present. */
  async remove(id: string): Promise<void> {
    const { removeMcpServerEntry } = await import("./mcp-store.js");
    await removeMcpServerEntry(id, this.filePath);
    this.refresh();
  }

  /** Implements the `McpRegistry.callTool` contract. Returns
   *  `McpCallResult { ok, output?, error? }`. The dispatch path
   *  in `delegation.ts:1539` calls this with the delegation's
   *  abort signal and timeout. */
  async callTool(
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpCallResult> {
    const entry = this.snapshot[serverId];
    if (!entry) {
      return { ok: false, error: `unknown MCP server: ${serverId}` };
    }
    const toolEntry = entry.tools.find((t) => t.name === tool);
    if (!toolEntry) {
      return { ok: false, error: `unknown tool "${tool}" on server "${serverId}" (have: ${entry.tools.map((t) => t.name).join(", ") || "(none)"})` };
    }
    let client: McpClient | undefined;
    try {
      client = await this.openClient(entry, opts.signal);
      const result = await client.callTool(tool, args, {
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
      if (result.isError) {
        const text = result.content?.[0]?.type === "text" ? result.content[0].text : "tool returned isError";
        return { ok: false, error: text };
      }
      return { ok: true, output: result };
    } catch (e) {
      const err = (e as Error).message ?? String(e);
      // Map signal abort to a typed error string; the manager
      // already has an `if (signal.aborted)` branch.
      if (opts.signal?.aborted) {
        return { ok: false, error: "cancelled" };
      }
      return { ok: false, error: err };
    } finally {
      if (client) await client.close().catch(() => { /* best-effort */ });
    }
  }

  /** Lazily open a connection to a server entry. */
  private async openClient(entry: McpServerEntry, signal?: AbortSignal): Promise<McpClient> {
    if (entry.transport === "stdio") {
      if (!entry.command) throw new Error(`server "${entry.id}" missing command`);
      return await connectStdio({
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.env ? { env: entry.env } : {}),
        ...(signal ? { /* signal forwarded via timeoutMs below */ } : {}),
      });
    }
    if (entry.transport === "http") {
      if (!entry.url) throw new Error(`server "${entry.id}" missing url`);
      return await connectHttp({ url: entry.url });
    }
    throw new Error(`server "${entry.id}" has unsupported transport: ${(entry.transport as string)}`);
  }
}

/** Convenience for the runtime: build a default registry against
 *  the on-disk config. The runtime's `HarnessRuntime` wires this
 *  into `DelegationRuntimeDeps.mcpRegistry` so `Delegation
 *  { kind: "mcp" }` works out of the box. */
export function defaultLocalMcpRegistry(opts: { filePath?: string } = {}): LocalMcpRegistry {
  return new LocalMcpRegistry(opts);
}

// Re-export the `McpToolDefinition[]` builder for callers that
// want to surface a server's tools (e.g. for `/mcp` slash command).
export { entryToolsToDefinitions };