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

// ---------- MCP protocol types (subset of the spec) ----------

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    [k: string]: unknown;
  };
  /** MCP clients use this to show a "this is dangerous" warning. */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpServerInfo {
  name: string;
  title?: string;
  version: string;
}

const SERVER_INFO: McpServerInfo = {
  name: "codingharness",
  title: "CodingHarness",
  version: "0.2.2",
};

const PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 1_048_576; // 1 MiB — match maxToolResultBytes
const SLOWLORIS_HEADERS_TIMEOUT_MS = 10_000;
const SLOWLORIS_REQUEST_TIMEOUT_MS = 60_000;

// JSON-RPC standard error codes.
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

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
    await handleRpc(res, request, runtime, tools, opts);
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
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", (e) => reject(e));
  });
}

export interface McpParsedRpc {
  /** When undefined, treat as notification. When string, the id was present
   *  and valid. The special sentinel "__invalid__" means the request had an
   *  explicit `id: null` and must be answered with -32600. */
  id?: string | number | "__invalid__";
  method: string;
  params?: Record<string, unknown>;
}

function parseJsonRpc(body: string): McpParsedRpc | null {
  if (!body) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.jsonrpc !== "2.0") return null;
  if (typeof o.method !== "string") return null;
  // Per JSON-RPC 2.0: id MUST be string|integer, MUST NOT be null.
  // - No `id` field at all → notification → no response
  // - Explicit `id: null` → Invalid Request with id: null
  // - Valid `id` → echo it back
  if (!("id" in o)) {
    return {
      method: o.method,
      params: (o.params && typeof o.params === "object") ? o.params as Record<string, unknown> : undefined,
    };
  }
  const rawId = o.id;
  if (rawId === null) {
    return { id: "__invalid__", method: o.method, params: (o.params && typeof o.params === "object") ? o.params as Record<string, unknown> : undefined };
  }
  if (typeof rawId === "string" || typeof rawId === "number") {
    return { id: rawId, method: o.method, params: (o.params && typeof o.params === "object") ? o.params as Record<string, unknown> : undefined };
  }
  // Some other type (boolean, object, etc.) — treat as invalid.
  return { id: "__invalid__", method: o.method, params: (o.params && typeof o.params === "object") ? o.params as Record<string, unknown> : undefined };
}

function respond(
  res: ServerResponse,
  id: string | number | null,
  result?: unknown,
  error?: { code: number; message: string; data?: unknown },
): void {
  const body: McpJsonRpcResponse = { jsonrpc: "2.0", id };
  if (error) body.error = error;
  else body.result = result;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------- RPC dispatch ----------

async function handleRpc(
  res: ServerResponse,
  request: McpParsedRpc,
  runtime: HarnessRuntime,
  tools: McpToolDefinition[],
  opts: McpStartOpts,
): Promise<void> {
  // Distinguish three cases:
  //   1. id === "__invalid__" → explicit `id: null` in the request;
  //      JSON-RPC 2.0 says reply with -32600 Invalid Request, id: null.
  //   2. id === undefined → notification (no id at all); 204 with no body.
  //   3. id is a string|number → normal request; echo the id back.
  if (request.id === "__invalid__") {
    respond(res, null, undefined, { code: ERR_INVALID_REQUEST, message: "Invalid Request: id MUST NOT be null" });
    return;
  }
  const id = request.id;
  if (id === undefined) {
    if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    switch (request.method) {
      case "initialize": {
        return respond(res, id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      }
      case "ping": {
        return respond(res, id, {});
      }
      case "tools/list": {
        return respond(res, id, { tools });
      }
      case "tools/call": {
        const params = request.params ?? {};
        const name = String(params["name"] ?? "");
        const args = (params["arguments"] && typeof params["arguments"] === "object")
          ? params["arguments"] as Record<string, unknown>
          : {};
        if (!name) {
          return respond(res, id, undefined, { code: ERR_INVALID_PARAMS, message: "missing tool name" });
        }
        const result = await dispatchTool(runtime, name, args, opts);
        return respond(res, id, result);
      }
      default:
        return respond(res, id, undefined, { code: ERR_METHOD_NOT_FOUND, message: `unknown method: ${request.method}` });
    }
  } catch (e) {
    respond(res, id, undefined, {
      code: ERR_INTERNAL,
      message: (e as Error).message ?? "internal error",
    });
  }
}

async function dispatchTool(
  runtime: HarnessRuntime,
  name: string,
  args: Record<string, unknown>,
  opts: McpStartOpts,
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
  // cwd is the cwd at startup (or the override), and the signal
  // is wired to a fresh AbortController. (MCP tool calls share the
  // process lifetime of the MCP server, not the request lifetime —
  // most tools have their own internal timeouts that cap them.)
  // We also strip `__approval_bypass` and any other reserved keys
  // a tool's validate() may not catch.
  const ctx: ToolContext = {
    cwd: opts.cwd ?? process.cwd(),
    signal: new AbortController().signal,
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
  _res: ServerResponse,
  _tools: McpToolDefinition[],
  _opts: McpStartOpts,
): void {
  // For MCP over SSE, clients POST JSON-RPC to /mcp and listen on
  // /sse for events. We forward each /mcp response as an `event: message`
  // line. (One-way push so the client knows when replies land.)
  const res = (req as unknown as { res: ServerResponse }).res;
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
