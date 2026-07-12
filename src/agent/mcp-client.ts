// MCP (Model Context Protocol) **client** for CodingHarness.
//
// Symmetric to `src/mcp-server.ts` (the server side). The server
// exposes CodingHarness's tools to MCP-aware clients; this client
// lets CodingHarness consume *external* MCP servers (Claude Code's
// `~/.claude/mcp_servers.json`, Cursor's, third-party servers from
// `npm install -g <pkg>` or `npx -y <pkg>`).
//
// Two transports are supported, mirroring the server side:
//
//   - **stdio**: spawn the server as a subprocess, send newline-
//     delimited JSON-RPC 2.0 on stdin, read responses from stdout.
//     Used for local servers (npm packages, local scripts).
//   - **http**: POST JSON-RPC to the server's `/mcp` endpoint.
//     Used for remote servers (HTTP+SSE).
//
// The flow for `ch mcp add <package>`:
//
//   1. **Resolve the package** — for npm-style names, the client
//      returns `npx -y <name>` (so the user's local npm cache
//      hosts the package). pip/pypi is a follow-up.
//   2. **Spawn / connect** — stdio uses `child_process.spawn`
//      with explicit `stdio: ['pipe', 'pipe', 'pipe']` and a
//      timeout (10s for the handshake).
//   3. **Negotiate `initialize`** — both sides exchange their
//      protocol version, capabilities, and `serverInfo` /
//      `clientInfo`.
//   4. **`tools/list`** — discover what the server provides.
//   5. **Persist** — write an `McpServerEntry` to
//      `~/.codingharness/mcp.json`.
//   6. **Return** the connection handle so the caller (CLI or
//      test) can inspect the result before the registry takes
//      over.
//
// The returned `McpClient` is *one-shot*: after `close()` the
// subprocess is gone and the client can't dispatch anymore. The
// `LocalMcpRegistry` (`src/agent/mcp-registry.ts`) handles the
// "lazy spawn per call" pattern that the agent loop needs.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  MCP_CLIENT_INFO,
  MCP_HANDSHAKE_TIMEOUT_MS,
  MCP_MAX_BODY_BYTES,
  MCP_PROTOCOL_VERSION,
  ERR_INTERNAL,
  formatJsonRpcRequest,
  formatJsonRpcResponse,
  parseJsonRpc,
  tryInferId,
  okResponse,
  errResponse,
  type McpToolDefinition,
  type McpJsonRpcResponse,
  type McpParsedRpc,
  type McpInitializeResult,
  type McpListToolsResult,
  type McpToolCallResult,
} from "../mcp-transport.js";
import {
  upsertMcpServerEntry,
  type McpServerEntry,
} from "./mcp-store.js";

// ---------- Package name validation ----------

/** Regex matching the npm-style names we accept: scoped (`@foo/bar`),
 *  unscoped (`foo`), and the typical separators (`.`, `_`, `-`, `/`).
 *  The leading character is constrained to lowercase alphanumeric so
 *  we don't accept anything weird like `..` or `-foo` (which could
 *  confuse `npx`). */
const PACKAGE_NAME_RE = /^@?[a-z0-9][a-z0-9._/-]*$/;

/** Validate a package name. Throws on rejection with a clear message
 *  so the CLI can print it directly. */
export function validatePackageName(name: string): void {
  if (!name || typeof name !== "string") {
    throw new Error("package name must be a non-empty string");
  }
  if (name.length > 214) {
    throw new Error("package name too long (max 214 chars per npm spec)");
  }
  if (!PACKAGE_NAME_RE.test(name)) {
    throw new Error(
      "invalid package name: " + JSON.stringify(name) +
      " (must match " + PACKAGE_NAME_RE.source + ")",
    );
  }
  // Disallow names that could be confused for flags when passed to
  // `npx`. `--foo`, `-foo`, etc. all fail the regex above, but
  // belt-and-suspenders.
  if (name.startsWith("-")) throw new Error("invalid package name: starts with '-'");
  // npm scoped names have exactly one slash (`@scope/name`).
  // Unscoped names have zero slashes. Anything with more than
  // one slash — or path-traversal segments — is rejected even
  // though the regex above would let it through. The stdio
  // transport spawns `npx -y <name>` so a hostile name could
  // otherwise resolve to a different package or get interpreted
  // as a path by an over-eager shell.
  if (name.includes("..")) throw new Error("invalid package name: contains '..'");
  const slashCount = (name.match(/\//g) ?? []).length;
  if (name.startsWith("@")) {
    if (slashCount !== 1) throw new Error("invalid package name: scoped names must be @scope/name");
  } else {
    if (slashCount !== 0) throw new Error("invalid package name: unscoped names cannot contain '/'");
  }
}

// ---------- Package resolution (npm-style for v1) ----------

export interface ResolvedPackage {
  /** Command to spawn (argv[0]). */
  command: string;
  /** Args to spawn (argv tail). */
  args: string[];
  /** Display name for the registry entry. */
  displayName: string;
  /** A stable id derived from the package name. Lowercased + the
   *  scope separator collapsed to a single underscore so the id is
   *  safe to use as a JSON key and a CLI argument. */
  id: string;
}

/** Resolve an npm-style package name to a `npx -y <name>` invocation.
 *  v1 only supports npm; pip/pypi follows when user demand surfaces.
 *  The `-y` flag tells `npx` to auto-install missing packages without
 *  prompting — needed because the harness's stdio transport runs
 *  without a TTY. */
export function resolveNpmPackage(name: string): ResolvedPackage {
  validatePackageName(name);
  const id = deriveServerId(name);
  return {
    command: "npx",
    args: ["-y", name],
    displayName: name,
    id,
  };
}

/** Derive a stable id from a package name. `@modelcontextprotocol/server-filesystem`
 *  becomes `mcp_server-filesystem`; scoped packages collapse the slash
 *  to an underscore so the id is one safe token (no special chars). */
export function deriveServerId(name: string): string {
  // @scope/name → scope_name
  let id = name;
  if (id.startsWith("@")) {
    const slash = id.indexOf("/");
    if (slash > 1) {
      id = id.slice(1, slash) + "_" + id.slice(slash + 1);
    }
  }
  // Replace any remaining separators with `_` (shouldn't happen
  // after the slash collapse, but defensive).
  return id.replace(/[\\/]+/g, "_").toLowerCase();
}

// ---------- Stdio transport ----------

export interface StdioConnectOpts {
  /** Command to spawn (argv[0]). */
  command: string;
  /** Args tail. */
  args?: string[];
  /** Working directory for the child. */
  cwd?: string;
  /** Extra env vars in KEY=VALUE form. */
  env?: string[];
  /** Handshake timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Override the client's advertised name/version. */
  clientInfo?: { name: string; version: string };
  /** Override the protocol version. Default `2025-06-18`. */
  protocolVersion?: string;
  /** When true, route the child's stderr through a buffered
   *  callback (useful for tests; production lets it inherit). */
  onStderr?: (chunk: string) => void;
}

export interface McpClient {
  /** Tools the server advertised in `tools/list`. Frozen so a
   *  caller can't accidentally mutate the registry's view. */
  readonly tools: ReadonlyArray<McpToolDefinition>;
  /** Server's `serverInfo` from the `initialize` handshake. */
  readonly serverInfo: { name: string; version: string; title?: string };
  /** The protocol version the server replied with. May differ
   *  from what we requested — MCP says "use the server's". */
  readonly protocolVersion: string;
  /** Invoke a tool. Throws on transport error; returns the raw
   *  `McpToolCallResult` so the caller can surface `isError`. */
  callTool(name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<McpToolCallResult>;
  /** Stop the client (kill the subprocess, drop the readline). */
  close(): Promise<void>;
  /** The transport kind. */
  readonly transport: "stdio" | "http";
}

/** Connect to a stdio MCP server. Spawns the subprocess, runs the
 *  `initialize` handshake, then runs `tools/list`. Returns a live
 *  `McpClient` ready for `tools/call`. */
export async function connectStdio(opts: StdioConnectOpts): Promise<McpClient> {
  const command = opts.command;
  const args = opts.args ?? [];
  if (!command) throw new Error("stdio: missing command");
  if (!existsSync(command) && command.indexOf("/") === -1 && command.indexOf("\\") === -1) {
    // Don't fail outright — `spawn` with `shell: false` looks up the
    // command on $PATH. We just warn via the timeout path if it
    // turns out not to be there.
  }
  const child: ChildProcess = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env
      ? { ...process.env, ...parseEnvArray(opts.env) }
      : process.env,
    // shell:false is the default; explicitly set for clarity.
    shell: false,
    // detached:false so the child dies when we kill it.
    detached: false,
  });

  // Wire stderr early so we don't miss the "command not found" prompt.
  let stderrBuf = "";
  if (child.stderr) {
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > MCP_MAX_BODY_BYTES) {
        stderrBuf = stderrBuf.slice(-MCP_MAX_BODY_BYTES);
      }
      if (opts.onStderr) opts.onStderr(chunk);
    });
  }
  // Surface spawn errors (e.g. ENOENT on the command).
  const spawnError = await new Promise<Error | null>((resolve) => {
    let settled = false;
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      // Clear the race timer and the exit listener so a
      // process that exits cleanly before the 50ms timer
      // fires doesn't leave a dangling timer (each pending
      // MCP call would otherwise leave a live timer alive
      // for the full 50ms).
      clearTimeout(exitTimer);
      child.off("exit", onExit);
      resolve(err);
    };
    child.once("error", (e) => settle(e as Error));
    // If the spawn "succeeds" (process object created), we get
    // an `exit` event later if the command isn't found. We use a
    // short timer to detect ENOENT-style errors that fire as
    // exit events with non-zero codes.
    const onExit = (code: number | null) => {
      if (code !== 0 && code !== null) {
        settle(new Error(
          command + " exited with code " + code +
          " before handshake (stderr: " + stderrBuf.trim().slice(0, 500) + ")",
        ));
      }
    };
    child.once("exit", onExit);
    // Race: if the process emits an `error` event we resolve with
    // that; if it exits non-zero before the handshake starts we
    // also resolve. Tracked as `exitTimer` so the settle() path
    // can cancel it.
    const exitTimer = setTimeout(() => settle(null), 50);
  });
  if (spawnError) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    throw spawnError;
  }

  // ----- Wire protocol -----
  //
  // We use a simple line-buffered reader on stdout. Each
  // request has a monotonic id; responses are matched by id.
  // The reader accumulates stdout until a full line is available,
  // then dispatches the line to the matching pending promise.

  let nextId = 1;
  const pending = new Map<string | number, {
    resolve: (r: McpJsonRpcResponse) => void;
    reject: (e: Error) => void;
  }>();
  let lineBuf = "";
  const reader = child.stdout;
  if (!reader) throw new Error("stdio: no stdout pipe");
  reader.setEncoding("utf-8");

  function sendLine(res: McpJsonRpcResponse): void {
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.write(formatJsonRpcResponse(res) + "\n");
    }
  }

  function send(req: { method: string; params?: Record<string, unknown> }): Promise<McpJsonRpcResponse> {
    const id = nextId++;
    return new Promise<McpJsonRpcResponse>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("stdio: timeout after " + timeoutMs + "ms on " + req.method));
      }, timeoutMs);
      pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      if (!child.stdin || child.stdin.destroyed) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error("stdio: stdin closed before send"));
        return;
      }
      child.stdin.write(formatJsonRpcRequest({ jsonrpc: "2.0", id, method: req.method, params: req.params }) + "\n");
    });
  }

  // Single line-buffered reader. Defined AFTER `send` so the
  // handler can resolve/reject entries in `pending` directly.
  reader.on("data", (chunk: string) => {
    lineBuf += chunk;
    let idx: number;
    while ((idx = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      // Hard cap on a single line — match the server's behavior.
      if (line.length > MCP_MAX_BODY_BYTES) continue;
      // First decide: is this a request (has `method`) or a
      // response (has `result` / `error`)? `parseJsonRpc`
      // rejects responses because they have no `method`, so
      // we route by envelope shape before calling either
      // parser. This was the stdio hang: the old code fed
      // responses into `parseJsonRpc`, which returned null,
      // then sent an errResponse back to the server — every
      // response was treated as a parse error and the
      // matching pending promise was never resolved.
      const isResponse = looksLikeResponse(line);
      if (!isResponse) {
        // Server-sent request (rare in v1; MCP servers
        // shouldn't call us). Drop.
        continue;
      }
      const full = parseServerResponse(line);
      if (!full) {
        // Malformed response line — best-effort id for
        // bookkeeping but don't echo a parse-error back at
        // a server that's not expecting one.
        const infId = tryInferId(line);
        const p = pending.get(infId as never);
        if (p) {
          pending.delete(infId as never);
          p.reject(new Error("malformed response: " + line));
        }
        continue;
      }
      if (full.id === null || full.id === undefined) {
        // Response with no id — drop.
        continue;
      }
      const p = pending.get(full.id);
      if (!p) continue;
      pending.delete(full.id);
      p.resolve(full);
    }
  });

  // ----- Handshake -----
  const initResult = await send({
    method: "initialize",
    params: {
      protocolVersion: opts.protocolVersion ?? MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: opts.clientInfo ?? MCP_CLIENT_INFO,
    },
  });
  if (initResult.error) {
    throw new Error("initialize failed: " + (initResult.error.message ?? "unknown"));
  }
  const init = initResult.result as McpInitializeResult;

  // MCP says clients SHOULD send `notifications/initialized` after
  // they finish their own initialization. Servers that don't
  // recognize it just no-op (per spec).
  await send({ method: "notifications/initialized" }).catch(() => { /* notification */ });

  const listResult = await send({ method: "tools/list" });
  if (listResult.error) {
    throw new Error("tools/list failed: " + (listResult.error.message ?? "unknown"));
  }
  const list = listResult.result as McpListToolsResult;

  // ----- Client handle -----
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Reject all pending calls so they don't hang.
    for (const [, p] of pending) {
      p.reject(new Error("stdio: client closed"));
    }
    pending.clear();
    try { child.stdin?.end(); } catch { /* ignore */ }
    if (!child.killed) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      // Give the child a moment to exit cleanly before SIGKILL.
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
          resolve();
        }, 1000);
        child.once("exit", () => { clearTimeout(t); resolve(); });
      });
    }
  };

  return {
    tools: Object.freeze(list.tools.slice()),
    serverInfo: init.serverInfo,
    protocolVersion: init.protocolVersion,
    transport: "stdio",
    async callTool(name: string, args: Record<string, unknown>, callOpts?: { timeoutMs?: number }) {
      if (closed) throw new Error("client closed");
      const r = await send({
        method: "tools/call",
        params: { name, arguments: args ?? {} },
      });
      if (r.error) {
        return {
          content: [{ type: "text" as const, text: "tool error: " + (r.error.message ?? "unknown") }],
          isError: true,
        };
      }
      return r.result as McpToolCallResult;
    },
    close,
  };
}

/** Best-effort parse of a server's response. The shared `parseJsonRpc`
 *  only validates id/method/params shape — for responses we also need
 *  to capture the `result` / `error` fields which are not in the
 *  request shape. Returns the full envelope or `null`. */
function parseServerResponse(line: string): McpJsonRpcResponse | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.jsonrpc !== "2.0") return null;
  if (typeof o.id !== "string" && typeof o.id !== "number" && o.id !== null) return null;
  const out: McpJsonRpcResponse = { jsonrpc: "2.0", id: o.id as string | number | null };
  if ("result" in o) out.result = o.result;
  if ("error" in o) out.error = o.error as McpJsonRpcResponse["error"];
  return out;
}

/** Cheap shape check: a line is a response envelope if it's a
 *  JSON object with `jsonrpc: "2.0"` and either `result` or
 *  `error` (requests have `method`; notifications have neither
 *  id nor result/error). Used to route dispatch into
 *  `parseServerResponse` instead of `parseJsonRpc`, which
 *  rejects responses because they have no `method`. */
function looksLikeResponse(line: string): boolean {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return false; }
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  if (r.jsonrpc !== "2.0") return false;
  return "result" in r || "error" in r;
}

/** Parse `KEY=VALUE` strings into an env dict. Used by `spawn`
 *  so users can pin per-server keys (`ch mcp add <pkg> --env
 *  MY_KEY=secret`). */
function parseEnvArray(arr: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of arr) {
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    const key = kv.slice(0, eq).trim();
    if (!key) continue;
    out[key] = kv.slice(eq + 1);
  }
  return out;
}

// ---------- HTTP transport ----------

export interface HttpConnectOpts {
  url: string;
  /** Bearer token. Sent as `Authorization: Bearer <token>`. */
  apiKey?: string;
  timeoutMs?: number;
  clientInfo?: { name: string; version: string };
  protocolVersion?: string;
  /** Headers to send on every request. */
  extraHeaders?: Record<string, string>;
}

interface HttpConnectionState {
  nextId: number;
  initResult: McpInitializeResult;
  tools: McpToolDefinition[];
}

/** Connect to an HTTP MCP server. POSTs `initialize` and
 *  `tools/list` to `<url>/mcp`. Returns a live `McpClient` whose
 *  `callTool` does one POST per call (no keep-alive socket — the
 *  harness only needs the result, not streaming). */
export async function connectHttp(opts: HttpConnectOpts): Promise<McpClient> {
  const baseUrl = opts.url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error("http: url must start with http:// or https://");
  }
  const state: HttpConnectionState = {
    nextId: 1,
    initResult: undefined as unknown as McpInitializeResult,
    tools: [],
  };

  async function post(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<McpJsonRpcResponse> {
    const id = state.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(opts.extraHeaders ?? {}),
    };
    if (opts.apiKey) headers["Authorization"] = "Bearer " + opts.apiKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(baseUrl + "/mcp", {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = (e as Error).message || String(e);
      throw new Error("http: " + method + " failed: " + err);
    }
    clearTimeout(timer);
    if (!res.ok) {
      // Stream-read with a cap so a hostile / runaway MCP HTTP
      // response can't OOM the harness. Pre-fix: `await
      // res.text()` materialized the full error body before
      // slicing to 200 chars. Same pattern as the Anthropic /
      // openai-compat / codex / omni providers and the
      // DelegationManager.runApiKind.
      const ERROR_BODY_CAP = 1_000_000;
      const chunks: Uint8Array[] = [];
      let received = 0;
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            if (received + value.byteLength > ERROR_BODY_CAP) {
              const allowed = Math.max(0, ERROR_BODY_CAP - received);
              if (allowed > 0) {
                chunks.push(value.subarray(0, allowed));
                received += allowed;
              }
              try { await reader.cancel(); } catch { /* best-effort */ }
              break;
            }
            chunks.push(value);
            received += value.byteLength;
          }
        }
      }
      const bytes = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
      const text = new TextDecoder("utf-8").decode(bytes);
      throw new Error("http: " + method + " returned " + res.status + " " + text.slice(0, 200));
    }
    let payload: unknown;
    try { payload = await res.json(); } catch {
      throw new Error("http: " + method + " returned non-JSON response");
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("http: " + method + " returned invalid envelope");
    }
    const o = payload as Record<string, unknown>;
    if (o.jsonrpc !== "2.0") throw new Error("http: " + method + " missing jsonrpc:2.0");
    return {
      jsonrpc: "2.0",
      id: o.id as string | number | null,
      ...("result" in o ? { result: o.result } : {}),
      ...("error" in o ? { error: o.error as McpJsonRpcResponse["error"] } : {}),
    };
  }

  // ----- Handshake -----
  const initResp = await post("initialize", {
    protocolVersion: opts.protocolVersion ?? MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: opts.clientInfo ?? MCP_CLIENT_INFO,
  }, opts.timeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS);
  if (initResp.error) {
    throw new Error("initialize failed: " + (initResp.error.message ?? "unknown"));
  }
  state.initResult = initResp.result as McpInitializeResult;

  // `notifications/initialized` is a fire-and-forget — servers
  // SHOULD reply with 204 No Content. We treat any non-error as
  // success.
  try {
    await post("notifications/initialized" as string, {}, opts.timeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS);
  } catch { /* swallow */ }

  const listResp = await post("tools/list", {}, opts.timeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS);
  if (listResp.error) {
    throw new Error("tools/list failed: " + (listResp.error.message ?? "unknown"));
  }
  state.tools = (listResp.result as McpListToolsResult).tools.slice();

  let closed = false;
  return {
    tools: Object.freeze(state.tools),
    serverInfo: state.initResult.serverInfo,
    protocolVersion: state.initResult.protocolVersion,
    transport: "http",
    async callTool(name: string, args: Record<string, unknown>, callOpts?: { timeoutMs?: number }) {
      if (closed) throw new Error("client closed");
      const r = await post("tools/call", { name, arguments: args ?? {} }, callOpts?.timeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS);
      if (r.error) {
        return {
          content: [{ type: "text" as const, text: "tool error: " + (r.error.message ?? "unknown") }],
          isError: true,
        };
      }
      return r.result as McpToolCallResult;
    },
    async close() {
      closed = true;
      // No persistent socket; nothing to close.
    },
  };
}

// ---------- High-level: `mcpGet` and `mcpAdd` ----------

export interface McpGetOpts {
  /** Transport override. Auto-detected from the resolved package
   *  (npm = stdio, `http://` or `https://` prefix = http). */
  transport?: "stdio" | "http";
  /** Timeout for the handshake in ms. Default 10s. */
  timeoutMs?: number;
  /** CWD for the spawned subprocess (stdio only). */
  cwd?: string;
  /** Env vars (KEY=VALUE) to pass to the subprocess (stdio only). */
  env?: string[];
  /** Override the URL (http only). Used by `ch mcp add <url>` so
   *  the user can pre-resolve the server's transport. */
  url?: string;
  /** API key for http transport. */
  apiKey?: string;
  /** Capture the spawned child's stderr (stdio only). */
  onStderr?: (chunk: string) => void;
  /** Override the spawn command (stdio only). Tests pass the path
   *  to a fixture script; production always uses the resolved
   *  `npx` command. When unset, the package name is resolved via
   *  `resolveNpmPackage`. */
  command?: string;
  /** Override the spawn args (stdio only). Tests pass fixture
   *  script paths; production uses `["-y", <package>]`. */
  args?: string[];
}

export interface McpGetResult {
  /** Resolved package / URL — the `command` + `args` we'll spawn
   *  for stdio, or the URL for http. Includes the spawn
   *  `cwd` / `env` when the caller supplied them (stdio only)
   *  so `mcpAdd` can persist them via `buildEntry` and so a
   *  preview caller can see what would be installed. */
  resolved: {
    command?: string;
    args?: string[];
    url?: string;
    transport: "stdio" | "http";
    displayName: string;
    id: string;
    /** stdio only — passed to `spawn` for the handshake. */
    cwd?: string;
    /** stdio only — passed to `spawn` for the handshake. */
    env?: readonly string[];
  };
  /** The negotiated server info. */
  serverInfo: { name: string; version: string; title?: string };
  /** Discovered tools (frozen). */
  tools: ReadonlyArray<McpToolDefinition>;
  /** The negotiated protocol version. */
  protocolVersion: string;
  /** Handle to close the connection. */
  close: () => Promise<void>;
}

/** "Get" an MCP server: resolve the package, connect, handshake,
 *  list tools. Returns the result without persisting. Used by
 *  `ch mcp get <pkg>` to preview, and by `mcpAdd` (which calls
 *  this and then writes the entry to disk). */
export async function mcpGet(packageOrUrl: string, opts: McpGetOpts = {}): Promise<McpGetResult> {
  // Decide transport: explicit, http:// prefix, or default stdio (npm).
  const isHttp = opts.transport === "http" || /^https?:\/\//.test(packageOrUrl);
  let client: McpClient;
  if (isHttp) {
    client = await connectHttp({
      url: opts.url ?? packageOrUrl,
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } else {
    const resolved = resolveNpmPackage(packageOrUrl);
    client = await connectStdio({
      command: opts.command ?? resolved.command,
      ...(opts.args ? { args: opts.args } : { args: resolved.args }),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
    });
  }
  // Build the resolved descriptor from the actual connect.
  const resolved = isHttp
    ? { url: opts.url ?? packageOrUrl, transport: "http" as const, displayName: packageOrUrl, id: deriveServerId(packageOrUrl.replace(/^https?:\/\//, "")) }
    : (() => {
        const r = resolveNpmPackage(packageOrUrl);
        return {
          command: opts.command ?? r.command,
          args: opts.args ?? r.args,
          transport: "stdio" as const,
          displayName: r.displayName,
          id: r.id,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.env && opts.env.length > 0 ? { env: opts.env.slice() } : {}),
        };
      })();
  return {
    resolved,
    serverInfo: client.serverInfo,
    tools: client.tools,
    protocolVersion: client.protocolVersion,
    close: () => client.close(),
  };
}

/** "Add" an MCP server: get it (which connects + lists tools),
 *  then persist an entry to `~/.codingharness/mcp.json`. The
 *  connection is closed after the entry is written — the registry
 *  re-opens on every tool call. */
export async function mcpAdd(
  packageOrUrl: string,
  opts: McpGetOpts = {},
): Promise<{ entry: McpServerEntry; result: McpGetResult }> {
  const result = await mcpGet(packageOrUrl, opts);
  try {
    const entry = buildEntry(result, opts);
    await upsertMcpServerEntry(entry);
    return { entry, result };
  } finally {
    await result.close();
  }
}

/** Build a persistence entry from an `McpGetResult`. The id and
 *  transport come from `result.resolved`; the version and tools
 *  come from the handshake. When `opts` is supplied, the stdio
 *  `cwd` and `env` are persisted too — `LocalMcpRegistry.callTool`
 *  re-spawns the subprocess on every call and needs them to find
 *  the same working directory / env the original `mcpGet` used
 *  during the handshake. (Bug fix: previously these were dropped
 *  and the registry silently fell back to the runtime's cwd +
 *  parent process env, breaking any user-supplied `--cwd` /
 *  `--env` from `ch mcp add`.) */
export function buildEntry(result: McpGetResult, opts?: McpGetOpts): McpServerEntry {
  const out: McpServerEntry = {
    id: result.resolved.id,
    name: result.resolved.displayName,
    transport: result.resolved.transport,
    version: result.serverInfo.version ?? "unknown",
    installedAt: Date.now(),
    tools: result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    })),
  };
  if (result.resolved.transport === "stdio" && result.resolved.command) {
    out.command = result.resolved.command;
    if (result.resolved.args) out.args = result.resolved.args;
    if (opts?.cwd) out.cwd = opts.cwd;
    if (opts?.env && opts.env.length > 0) out.env = opts.env.slice();
  }
  if (result.resolved.transport === "http" && result.resolved.url) {
    out.url = result.resolved.url;
  }
  return out;
}

// ---------- Misc helpers re-exported for tests ----------

export const __test = {
  parseEnvArray,
  parseServerResponse,
  deriveServerId,
};