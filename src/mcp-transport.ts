// Shared JSON-RPC 2.0 wire-format helpers for MCP.
//
// Both the MCP **server** (`src/mcp-server.ts`) and the MCP **client**
// (`src/agent/mcp-client.ts`) speak the same protocol — newline-
// delimited JSON over stdio for the IPC transport, and HTTP POST +
// optional SSE for the network transport. This file holds the parts
// that don't depend on which side we're on:
//
//   - The protocol types (`McpToolDefinition`, `McpJsonRpcRequest`,
//     `McpJsonRpcResponse`, `McpParsedRpc`).
//   - The JSON-RPC parse / format helpers (`parseJsonRpc`,
//     `formatJsonRpc`, `tryInferId`).
//   - The standard error codes (`ERR_PARSE`, `ERR_INVALID_REQUEST`,
//     `ERR_METHOD_NOT_FOUND`, `ERR_INVALID_PARAMS`, `ERR_INTERNAL`).
//   - The protocol version + body cap constants.
//
// Keeping these in one file means a spec bump (e.g. when the MCP
// working group publishes `2025-11-xx`) is a single edit instead of
// a synchronized pair. The server's `toolToMcpDefinition` lives in
// `mcp-server.ts` because it depends on the harness tool spec; the
// client's `McpClient` lives in `mcp-client.ts` because it depends
// on `child_process.spawn`. This file is the wire-format core.
//
// References:
//   - JSON-RPC 2.0 spec: https://www.jsonrpc.org/specification
//   - MCP basic spec:    https://modelcontextprotocol.io/specification/2025-06-18/basic

// ---------- Protocol types (subset of the spec) ----------

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

export interface McpClientInfo {
  name: string;
  title?: string;
  version: string;
}

/** Parsed RPC payload shared by client and server. The discriminator
 *  for notifications vs requests is `id`:
 *   - `id === undefined` → notification (no response expected).
 *   - `id === "__invalid__"` → explicit `id: null` (Invalid Request).
 *   - `id: string | number` → normal request, echo the id back. */
export interface McpParsedRpc {
  /** When undefined, treat as notification. When "__invalid__",
   *  the request had an explicit `id: null` and must be answered
   *  with -32600. */
  id?: string | number | "__invalid__";
  method: string;
  params?: Record<string, unknown>;
}

/** Result of `initialize`. Used by both sides of the handshake —
 *  the server builds one in its `initialize` handler, the client
 *  reads it back from the server's first reply. */
export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean };
    prompts?: { listChanged?: boolean };
    [k: string]: unknown;
  };
  serverInfo: McpServerInfo;
}

/** One entry in the `tools/list` response. */
export interface McpListToolsResult {
  tools: McpToolDefinition[];
}

/** One entry in the `tools/call` response. MCP servers return an
 *  array of content blocks — for v1 the only block kind the spec
 *  requires is `text`. */
export interface McpToolCallResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  >;
  isError?: boolean;
}

// ---------- Constants ----------

/** Current MCP protocol version. Both sides advertise this string
 *  in their `initialize` handshake. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Default identify string used by `McpClient` in its `initialize`
 *  handshake. Mirrors the `McpServerInfo` shape on the server side. */
export const MCP_CLIENT_INFO: McpClientInfo = {
  name: "codingharness-mcp-client",
  title: "CodingHarness MCP Client",
  version: "0.2.2",
};

/** Max single-message size on both transports. Matches the
 *  `maxToolResultBytes` cap used elsewhere. */
export const MCP_MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** Default initialize-handshake timeout (ms). The server has 10s to
 *  reply to the client's first `initialize` before the client gives
 *  up and surfaces a transport error. */
export const MCP_HANDSHAKE_TIMEOUT_MS = 10_000;

// JSON-RPC 2.0 standard error codes.
export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;

// ---------- Parser / formatter ----------

/** Parse one JSON-RPC 2.0 message. Returns `null` for invalid
 *  envelopes (parse error, non-JSON, missing `jsonrpc` field,
 *  missing/non-string `method`). The id discrimination is described
 *  on `McpParsedRpc`. */
export function parseJsonRpc(body: string): McpParsedRpc | null {
  if (!body) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.jsonrpc !== "2.0") return null;
  if (typeof o.method !== "string") return null;
  const params = (o.params && typeof o.params === "object")
    ? o.params as Record<string, unknown>
    : undefined;
  if (!("id" in o)) {
    return { method: o.method, params };
  }
  const rawId = o.id;
  if (rawId === null) {
    return { id: "__invalid__", method: o.method, params };
  }
  if (typeof rawId === "string" || typeof rawId === "number") {
    return { id: rawId, method: o.method, params };
  }
  // Some other type (boolean, object, etc.) — treat as invalid.
  return { id: "__invalid__", method: o.method, params };
}

/** Best-effort id inference so a malformed line with an explicit
 *  `id` still gets a parse error back. Returns `null` when we can't
 *  safely extract one (e.g. the line isn't even valid JSON). */
export function tryInferId(line: string): string | number | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o.id === "string" || typeof o.id === "number") return o.id;
    if (o.id === null) return null;
  } catch { /* ignore */ }
  return null;
}

/** Serialize a JSON-RPC response. The id is echoed back exactly
 *  (or `null` for the `__invalid__` case). */
export function formatJsonRpcResponse(res: McpJsonRpcResponse): string {
  return JSON.stringify(res);
}

/** Serialize a JSON-RPC request with a numeric id. Convenience used
 *  by the client to keep request ids monotonic per-connection. */
export function formatJsonRpcRequest(req: McpJsonRpcRequest): string {
  return JSON.stringify(req);
}

/** Build a successful response payload. The id is echoed back from
 *  the parsed request; callers pass `null` for explicit `id: null`
 *  on the wire (per JSON-RPC 2.0). */
export function okResponse(id: string | number | null, result: unknown): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/** Build a JSON-RPC error response. The id is echoed back the same
 *  way as `okResponse`. */
export function errResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): McpJsonRpcResponse {
  const e: McpJsonRpcResponse["error"] = { code, message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: "2.0", id, error: e };
}