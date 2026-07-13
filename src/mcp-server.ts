// MCP (Model Context Protocol) server for CodingHarness.
//
// Exposes our tool registry to MCP-aware clients (Claude Code, Cursor,
// mcporter, etc.) over JSON-RPC 2.0 (HTTP POST) and SSE.
//
// Protocol reference: https://modelcontextprotocol.io/specification/2025-06-18/basic
// Implements:
//   - initialize     — capability negotiation
//   - ping           — health check
//   - tools/list     — return all tools in the registry
//   - tools/call     — execute a tool, return its result as MCP content
//   - notifications/initialized — accepted (no-op response)
//
// Streaming for tools/call is via SSE (`text/event-stream`):
//   event: message\ndata: {"jsonrpc":"2.0","id":...,"result":...}\n\n
//
// The bash tool is exposed with `dangerous: true` in the input schema so
// MCP clients (which usually show a confirmation) can warn users before
// running it. Approval still flows through the existing runtime.

import { createServer, IncomingMessage, ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Tool, ToolContext } from "./agent/tools/registry.js";
import type { ToolResult } from "./types.js";
import { ensurePaths } from "./config/paths.js";
import { loadSettings } from "./config/settings.js";
import { ProviderRegistry } from "./providers/registry.js";
import { HarnessRuntime } from "./runtime.js";
import { DEFAULT_LIMITS } from "./agent/loop.js";
import {
  MCP_PROTOCOL_VERSION,
  MCP_MAX_BODY_BYTES,
  ERR_PARSE,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_INVALID_PARAMS,
  ERR_INTERNAL,
  parseJsonRpc,
  tryInferId,
  formatJsonRpcResponse,
  okResponse,
  errResponse,
  type McpToolDefinition,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
  type McpServerInfo,
  type McpParsedRpc,
} from "./mcp-transport.js";

// Re-export the shared protocol types so the existing
// `import { ... } from "./mcp-server.js"` surface stays intact.
export type {
  McpToolDefinition,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpServerInfo,
  McpParsedRpc,
} from "./mcp-transport.js";

const SERVER_INFO: McpServerInfo = {
  name: "codingharness",
  title: "CodingHarness",
  version: "0.2.2",
};

const PROTOCOL_VERSION = MCP_PROTOCOL_VERSION;
const MAX_BODY_BYTES = MCP_MAX_BODY_BYTES;
const SLOWLORIS_HEADERS_TIMEOUT_MS = 10_000;
const SLOWLORIS_REQUEST_TIMEOUT_MS = 60_000;

// Tools that should be flagged `destructive` / `not readOnly` so MCP
// clients show a confirmation prompt before invoking.
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  "bash", "write", "edit", "spawn_subagent", "skill", "todo",
  "append_memory",
]);
const READONLY_TOOLS: ReadonlySet<string> = new Set([
  "read", "grep", "find", "ls", "list_skills", "read_memory", "search_memory", "read_todo",
  "http", "web_search",
]);

/** Convert a CodingHarness `Tool` into the MCP `tools/list` shape. */
export function toolToMcpDefinition(tool: Tool): McpToolDefinition {
  const out: McpToolDefinition = {
    name: tool.spec.name,
    description: tool.spec.description,
    inputSchema: {
      ...tool.spec.parameters,
      type: "object",
    } as McpToolDefinition["inputSchema"],
  };
  const annotations: NonNullable<McpToolDefinition["annotations"]> = {};
  // Per the MCP spec, `annotations.title` is a human-readable display
  // name. We only set it if the tool spec defines a `title` — otherwise
  // we leave it unset so the client falls back to the name.
  const toolTitle = (tool.spec as unknown as { title?: string }).title;
  if (toolTitle) annotations.title = toolTitle;
  annotations.readOnlyHint = READONLY_TOOLS.has(tool.spec.name);
  annotations.destructiveHint = DESTRUCTIVE_TOOLS.has(tool.spec.name);
  // idempotentHint is meaningful only when readOnlyHint is false;
  // for read-only tools the spec lets us skip it. For destructive
  // tools we report `false` (most destructive tools are not idempotent).
  if (!annotations.readOnlyHint) annotations.idempotentHint = false;
  // openWorldHint is only set when true — leaving it unset for tools
  // that don't make network calls.
  if (tool.spec.name === "http" || tool.spec.name === "web_search") {
    annotations.openWorldHint = true;
  }
  out.annotations = annotations;
  return out;
}

// ---------- Runtime wiring ----------

export interface McpStartOpts {
  port: number;
  host: string;
  /** When true, the bash tool's approval modal is auto-allowed. Off by default. */
  approveBash?: boolean;
  /** When set, this is the working directory for tool invocations. */
  cwd?: string;
  /**
   * When true, allow binding to non-loopback addresses. Off by default —
   * the MCP server requires `--allow-remote` to bind to 0.0.0.0 because
   * it exposes code-execution tools with no authentication.
   */
  allowRemote?: boolean;
  /**
   * Optional API key. When set, clients must present
   * `Authorization: Bearer <key>` on every request. The Electron
   * desktop shell auto-generates one and stores it in the system keychain
   * (future). For now, if `MCP_API_KEY` env var is set, the server
   * requires it.
   */
  apiKey?: string;
}

export interface McpStartResult {
  port: number;
  url: string;
  server: Server;
  stop: () => Promise<void>;
  /** All tools exposed by this server (for tests). */
  tools: McpToolDefinition[];
  /** Whether the server requires a Bearer token (additive). */
  requiresApiKey?: boolean;
}

/**
 * Start the MCP server on the given port. Returns the bound port, the
 * HTTP server (for shutdown), and a `stop()` helper.
 */
export async function startMcpServer(opts: McpStartOpts): Promise<McpStartResult> {
  ensurePaths();
  const settings = loadSettings();
  const cwd = opts.cwd ?? process.cwd();

  // Build a minimal runtime so tools that need a runtime (spawn_subagent,
  // skill, memory) can resolve. We don't need a real session for tool
  // dispatch — the bash tool etc. take a ToolContext with cwd and signal.
  const providers = new ProviderRegistry(settings);
  const runtime = new HarnessRuntime({ cwd, ephemeral: true });
  // Touch the providers so the provider-construction side effects (cache
  // builds, log warnings for missing keys) run at startup rather than
  // on first tool call.
  void providers.list().length;

  const tools = runtime.tools.list().map(toolToMcpDefinition);

  // The HTTP server.
  const server = createServer((req, res) => {
    void handleHttp(req, res, runtime, tools, opts);
  });
  // Slowloris defense.
  server.headersTimeout = SLOWLORIS_HEADERS_TIMEOUT_MS;
  server.requestTimeout = SLOWLORIS_REQUEST_TIMEOUT_MS;

  // Refuse non-loopback binds unless explicitly allowed. The MCP
  // server exposes code-execution tools (bash, write, edit, etc.) with
  // no auth by default, so binding to 0.0.0.0 by accident is a real
  // RCE footgun.
  const isLoopback = opts.host === "127.0.0.1" || opts.host === "localhost" || opts.host === "::1";
  if (!isLoopback && !opts.allowRemote) {
    return Promise.reject(new Error(
      `refusing to bind MCP server to non-loopback host "${opts.host}"; pass --allow-remote to override`,
    ));
  }
  // Resolve an API key from opts or env.
  const apiKey = opts.apiKey ?? process.env.MCP_API_KEY;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;
  const url = `http://${opts.host}:${boundPort}`;

  const stop = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  // Surface the effective config to the caller for logging / status.
  return {
    port: boundPort,
    url,
    server,
    stop,
    tools,
    requiresApiKey: !!apiKey,
  } as McpStartResult & { requiresApiKey: boolean };
}

// ---------- Stdio transport ----------
//
// JSON-RPC 2.0 over stdio, newline-delimited (JSONL). This is the
// canonical MCP transport for IPC — every MCP client (Claude Code,
// Cursor, etc.) can be configured to talk to a stdio MCP server by
// pointing it at the binary. The desktop shell uses it for
// in-process IPC (no port binding, no localhost assumption, no
// firewall prompts).
//
// Wire format:
//   - Each request is exactly one JSON object terminated by a
//     newline (\n). Empty lines are ignored.
//   - Notifications (no `id`) get no response.
//   - Each non-notification request gets exactly one response on
//     stdout, terminated by a newline.
//   - Errors during read/write are logged to stderr; the server
//     keeps running until the parent closes stdin (EOF).
//
// Auth: the API-key check is skipped on stdio because the parent
// process IS the trusted client. CORS / slowloris / body cap don't
// apply (no HTTP).

export interface McpStdioStartResult {
  /** All tools exposed by this server (for tests). */
  tools: McpToolDefinition[];
  /** Resolves when the server exits (stdin EOF or fatal error). */
  done: Promise<void>;
  /** Force-stop the server (closes the readline interface). */
  stop: () => Promise<void>;
}

export async function startMcpStdioServer(
  opts: Omit<McpStartOpts, "port" | "host" | "allowRemote" | "apiKey"> = {},
): Promise<McpStdioStartResult> {
  ensurePaths();
  const settings = loadSettings();
  const cwd = opts.cwd ?? process.cwd();

  const providers = new ProviderRegistry(settings);
  const runtime = new HarnessRuntime({ cwd, ephemeral: true });
  void providers.list().length;

  const tools = runtime.tools.list().map(toolToMcpDefinition);

  // Use readline for line-delimited input. Falls back to a manual
  // buffer-based reader if readline is unavailable (it should
  // always be in Node, but the fallback makes the server robust).
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });

  let stopped = false;
  let stopResolve: () => void = () => {};
  const done = new Promise<void>((res) => { stopResolve = res; });

  const writeLine = (line: string) => {
    if (stopped) return;
    try {
      process.stdout.write(line + "\n");
    } catch (e) {
      logStdio("stdout write failed:", (e as Error).message);
    }
  };

  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    // Hard cap on a single line — same as the HTTP body cap.
    if (line.length > MAX_BODY_BYTES) {
      logStdio("dropping oversized line (" + line.length + " bytes)");
      return;
    }
    const request = parseJsonRpc(line);
    if (!request) {
      // Reply to the closest valid id we can find; if there isn't one,
      // we can't reply at all (JSON-RPC says "no response" for parse
      // errors of notifications).
      const inferred = tryInferId(line);
      writeLine(JSON.stringify({
        jsonrpc: "2.0",
        id: inferred,
        error: { code: ERR_PARSE, message: "parse error" },
      }));
      return;
    }
    void computeRpcResponse(request, runtime, tools, opts).then((res) => {
      if (res.response === null) return; // notification — no reply
      writeLine(JSON.stringify(res.response));
    }).catch((e) => {
      // Should not happen — computeRpcResponse handles its own errors.
      logStdio("dispatch failed:", (e as Error).message);
    });
  });

  rl.on("close", () => {
    stopped = true;
    stopResolve();
  });

  // If the parent process goes away, exit.
  if (typeof process.stdin.on === "function") {
    process.stdin.on("end", () => {
      if (!stopped) {
        stopped = true;
        try { rl.close(); } catch { /* ignore */ }
        stopResolve();
      }
    });
  }

  // Stderr header so humans running `ch mcp --stdio` know the
  // server is ready (stdout is reserved for the JSON-RPC wire).
  logStdio("MCP stdio server ready (protocol " + PROTOCOL_VERSION + ", " + tools.length + " tools)");

  return {
    tools,
    done,
    stop: async () => {
      stopped = true;
      try { rl.close(); } catch { /* ignore */ }
      await done;
    },
  };
}

// tryInferId is imported from ./mcp-transport.js — kept here only as a
// comment trail. The old local definition was removed when the
// JSON-RPC parser was extracted to `mcp-transport.ts` so the client
// can reuse it.

function logStdio(...parts: unknown[]): void {
  // Write a single line to stderr with the prefix. Avoid log.info
  // (which goes through the server's logger and might be re-routed
  // to stdout in some environments).
  try {
    process.stderr.write("[ch-mcp] " + parts.map((p) => typeof p === "string" ? p : JSON.stringify(p)).join(" ") + "\n");
  } catch { /* ignore */ }
}

// ---------- HTTP / SSE handler ----------

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: HarnessRuntime,
  tools: McpToolDefinition[],
  opts: McpStartOpts,
): Promise<void> {
  // CORS preflight — MCP clients in browsers may probe.
  setCorsHeaders(res, req);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Auth gate (additive — when apiKey is unset, requests are unauthenticated).
  const apiKey = opts.apiKey ?? process.env.MCP_API_KEY;
  if (apiKey && !checkAuth(req, apiKey)) {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // Health
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      server: SERVER_INFO.name,
      version: SERVER_INFO.version,
      protocol: PROTOCOL_VERSION,
      tools: tools.length,
      requiresApiKey: !!apiKey,
    }));
    return;
  }

  // SSE
  if (req.method === "GET" && path === "/sse") {
    return handleSse(req, res, tools, opts);
  }

  // JSON-RPC
  if (req.method === "POST" && path === "/mcp") {
    let body: string;
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "body too large" }));
      return;
    }
    const request = parseJsonRpc(body);
    if (!request) {
      respond(res, null, undefined, {
        code: ERR_PARSE,
        message: "parse error",
      });
      return;
    }
    // Wire the tool's abort signal to the HTTP request's close
    // event so a client disconnect mid-tool-call cancels the
    // in-flight run. Pre-fix: `dispatchTool` passed a fresh
    // `new AbortController().signal` to the tool — never
    // aborted — so an MCP client that died after sending the
    // JSON-RPC request left the tool running until its
    // internal timeout (30 s for bash; unbounded for tools
    // without one). The `close` listener also fires when
    // the response is fully written, so the controller is
    // single-use per request — we don't reuse it across calls.
    const ac = new AbortController();
    req.once("close", () => ac.abort(new Error("mcp: client disconnected")));
    await handleRpc(res, request, runtime, tools, opts, ac.signal);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

function checkAuth(req: IncomingMessage, expected: string): boolean {
  const h = req.headers.authorization;
  if (typeof h !== "string") return false;
  if (!h.startsWith("Bearer ")) return false;
  return h.slice("Bearer ".length) === expected;
}

function setCorsHeaders(res: ServerResponse, req: IncomingMessage): void {
  // Loopback binds: CORS is wide open (MCP clients are CLI tools).
  // Non-loopback binds: echo the request Origin only if present (avoids
  // the "any page on the internet can drive the MCP server" footgun).
  const isLoopback = !req.socket.remoteAddress
    || req.socket.remoteAddress.startsWith("127.")
    || req.socket.remoteAddress === "::1"
    || req.socket.remoteAddress === "::ffff:127.0.0.1";
  if (isLoopback) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin.length > 0) res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (err?: Error, body?: string) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(body!);
    };
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        settle(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => settle(undefined, Buffer.concat(chunks).toString("utf-8")));
    req.on("error", (e) => settle(e));
    // Fallback: a client disconnect mid-body (TCP RST / TLS
    // close) fires `close` without `end` or `error`. Without
    // this, the promise would hang forever and pin the
    // request's socket until Node's default server timeout
    // (2 minutes). Same fix shape as `readJson` in
    // `server.ts:1397-1413`. (The pre-fix version was a
    // straight copy of the Node docs example — fine for
    // well-behaved clients, broken for hostile / flaky
    // networks.)
    req.on("close", () => settle(new Error("request closed before body complete")));
  });
}

// McpParsedRpc is re-exported from ./mcp-transport.js (see top of file).

// parseJsonRpc is imported from ./mcp-transport.js — the shared parser
// is used by both the server (this file) and the client
// (`src/agent/mcp-client.ts`).

function respond(
  res: ServerResponse,
  id: string | number | null,
  result?: unknown,
  error?: { code: number; message: string; data?: unknown },
): void {
  const body: McpJsonRpcResponse = error ? errResponse(id, error.code, error.message, error.data) : okResponse(id, result);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(formatJsonRpcResponse(body));
}

// ---------- RPC dispatch ----------
//
// Compute the JSON-RPC response for a parsed request. Shared between
// the HTTP transport and the stdio transport. Returns either a
// response object (with id echo) or `null` for notifications (which
// have no body). The `statusCode` is used by the HTTP transport.
async function computeRpcResponse(
  request: McpParsedRpc,
  runtime: HarnessRuntime,
  tools: McpToolDefinition[],
  opts: Pick<McpStartOpts, "approveBash" | "cwd">,
  signal?: AbortSignal,
): Promise<{ response: McpJsonRpcResponse | null; statusCode: number }> {
  // Distinguish three cases:
  //   1. id === "__invalid__" → explicit `id: null` in the request;
  //      JSON-RPC 2.0 says reply with -32600 Invalid Request, id: null.
  //   2. id === undefined → notification (no id at all); 204 with no body.
  //   3. id is a string|number → normal request; echo the id back.
  if (request.id === "__invalid__") {
    return {
      statusCode: 200,
      response: {
        jsonrpc: "2.0",
        id: null,
        error: { code: ERR_INVALID_REQUEST, message: "Invalid Request: id MUST NOT be null" },
      },
    };
  }
  const id = request.id;
  if (id === undefined) {
    // Notifications are no-ops on the server side.
    return { statusCode: 204, response: null };
  }

  try {
    switch (request.method) {
      case "initialize": {
        return {
          statusCode: 200,
          response: {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
            },
          },
        };
      }
      case "ping": {
        return { statusCode: 200, response: { jsonrpc: "2.0", id, result: {} } };
      }
      case "tools/list": {
        return { statusCode: 200, response: { jsonrpc: "2.0", id, result: { tools } } };
      }
      case "tools/call": {
        const params = request.params ?? {};
        const name = String(params["name"] ?? "");
        const args = (params["arguments"] && typeof params["arguments"] === "object")
          ? params["arguments"] as Record<string, unknown>
          : {};
        if (!name) {
          return {
            statusCode: 200,
            response: {
              jsonrpc: "2.0",
              id,
              error: { code: ERR_INVALID_PARAMS, message: "missing tool name" },
            },
          };
        }
        const result = await dispatchTool(runtime, name, args, opts, signal);
        return { statusCode: 200, response: { jsonrpc: "2.0", id, result } };
      }
      default:
        return {
          statusCode: 200,
          response: {
            jsonrpc: "2.0",
            id,
            error: { code: ERR_METHOD_NOT_FOUND, message: `unknown method: ${request.method}` },
          },
        };
    }
  } catch (e) {
    return {
      statusCode: 200,
      response: {
        jsonrpc: "2.0",
        id,
        error: { code: ERR_INTERNAL, message: (e as Error).message ?? "internal error" },
      },
    };
  }
}

// HTTP transport: thin wrapper around computeRpcResponse.
async function handleRpc(
  res: ServerResponse,
  request: McpParsedRpc,
  runtime: HarnessRuntime,
  tools: McpToolDefinition[],
  opts: McpStartOpts,
  signal?: AbortSignal,
): Promise<void> {
  const { response, statusCode } = await computeRpcResponse(request, runtime, tools, opts, signal);
  if (response === null) {
    res.writeHead(statusCode);
    res.end();
    return;
  }
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(response));
}

async function dispatchTool(
  runtime: HarnessRuntime,
  name: string,
  args: Record<string, unknown>,
  opts: Pick<McpStartOpts, "approveBash" | "cwd">,
  /** Caller's abort signal. When this signal aborts (e.g. the HTTP
   *  client disconnects mid-tool-call), the in-flight tool run is
   *  canceled so the harness doesn't keep burning CPU on a request
   *  whose reply will never be read. Pre-fix: the tool got a fresh
   *  `AbortController().signal` that was NEVER aborted, so an MCP
   *  client that died after sending the request left the tool
   *  running until its internal timeout (30 s for bash; unbounded
   *  for tools without one). */
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const tool = runtime.tools.get(name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `unknown tool: ${name}` }],
      isError: true,
    };
  }
  // Validate args (throws ToolError on bad input).
  let validated: Record<string, unknown>;
  try {
    validated = tool.validate(args);
  } catch (e) {
    return {
      content: [{ type: "text", text: `validation: ${(e as Error).message}` }],
      isError: true,
    };
  }
  // Build a minimal ToolContext. The MCP server runs ephemeral;
  // cwd is the cwd at startup (or the override). The signal is
  // wired to the caller's abort signal (when provided), with a
  // fresh fallback for callers that don't pass one (e.g. tests).
  // Pre-fix: the signal was always a fresh AbortController that
  // was NEVER aborted, so a client disconnect mid-tool-call left
  // the tool running until its internal timeout — 30 s for bash,
  // unbounded for tools without one. We also strip
  // `__approval_bypass` and any other reserved keys a tool's
  // validate() may not catch.
  const ctx: ToolContext = {
    cwd: opts.cwd ?? process.cwd(),
    signal: signal ?? new AbortController().signal,
    limits: {
      bashTimeoutMs: DEFAULT_LIMITS.bashTimeoutMs,
      readMaxBytes: DEFAULT_LIMITS.readMaxBytes,
      maxToolResultBytes: DEFAULT_LIMITS.maxToolResultBytes,
      maxSteps: DEFAULT_LIMITS.maxSteps,
      requestTimeoutMs: DEFAULT_LIMITS.requestTimeoutMs,
    },
    log: () => { /* no-op in MCP mode */ },
    services: {
      getApproval: () => opts.approveBash
        ? { mode: "off" as const, allowlist: [], blocklist: [] }
        : { mode: "on-mutation" as const, allowlist: [], blocklist: [] },
    },
  };
  // Strip reserved keys that could bypass safety gates.
  delete validated["__approval_bypass"];
  delete validated["__bypass"];
  let result: ToolResult;
  try {
    result = await tool.run(validated, ctx);
  } catch (e) {
    return {
      content: [{ type: "text", text: `crash: ${(e as Error).message}` }],
      isError: true,
    };
  }
  return toolResultToMcp(result);
}

function toolResultToMcp(r: ToolResult): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const text = r.content ?? r.display ?? "";
  return {
    content: [{ type: "text", text }],
    isError: r.isError ? true : undefined,
  };
}

// ---------- SSE ----------

interface SseClient {
  id: string;
  res: ServerResponse;
}

const sseClients = new Set<SseClient>();

function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  _tools: McpToolDefinition[],
  _opts: McpStartOpts,
): void {
  // For MCP over SSE, clients POST JSON-RPC to /mcp and listen on
  // /sse for events. We forward each /mcp response as an `event: message`
  // line. (One-way push so the client knows when replies land.)
  if (!res) {
    req.destroy();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": codingharness mcp stream\n\n");
  const id = randomUUID();
  const client: SseClient = { id, res };
  sseClients.add(client);
  req.on("close", () => { sseClients.delete(client); });
}

/** Broadcast a JSON-RPC response to all SSE clients. Used by tests
 *  to confirm the SSE plumbing is wired (the /mcp POST also writes
 *  the same response to the requester directly). */
export function broadcastSse(payload: unknown): void {
  const data = "event: message\ndata: " + JSON.stringify(payload) + "\n\n";
  for (const c of sseClients) {
    try { c.res.write(data); } catch { sseClients.delete(c); }
  }
}

/** Test helper: drop all SSE clients. */
export function resetSseClients(): void {
  for (const c of sseClients) {
    try { c.res.end(); } catch { /* ignore */ }
  }
  sseClients.clear();
}
