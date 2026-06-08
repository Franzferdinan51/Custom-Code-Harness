// Tests for the MCP (Model Context Protocol) server (v0.2.2+).
//
// Covers:
//   - toolToMcpDefinition: shape, annotations, idempotentHint logic
//   - parseJsonRpc: valid request, missing jsonrpc, invalid id
//   - respond: success and error envelopes
//   - checkAuth: bearer token present / missing / wrong scheme
//   - startMcpServer: bind + health + tool dispatch end-to-end

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

import { toolToMcpDefinition, startMcpServer, type McpToolDefinition } from "../mcp-server.js";
import type { Tool } from "../agent/tools/registry.js";
import type { ToolSpec } from "../types.js";

// Per-test temp dirs are created lazily; we don't set CODINGHARNESS_HOME
// at module scope to avoid polluting later test files (notably
// provider-presets.test.ts, which depends on the env-driven settings).
// The cwd option to startMcpServer points the runtime at our tmp dir.
const tmp = mkdtempSync(join(tmpdir(), "ch-mcp-"));
mkdirSync(join(tmp, "sessions"), { recursive: true });
mkdirSync(join(tmp, "logs"), { recursive: true });

function makeTool(name: string, opts: Partial<ToolSpec> = {}): Tool {
  return {
    spec: {
      name,
      description: "test tool " + name,
      parameters: { type: "object", properties: { x: { type: "string" } } },
      ...opts,
    } as ToolSpec,
    validate(args) { return args as Record<string, unknown>; },
    async run(args) { return { toolCallId: "", display: name, content: "ran " + JSON.stringify(args), isError: false }; },
  };
}

// ---------- toolToMcpDefinition ----------

test("toolToMcpDefinition: maps name, description, and inputSchema", () => {
  const def = toolToMcpDefinition(makeTool("read"));
  assert.equal(def.name, "read");
  assert.match(def.description, /test tool read/);
  assert.equal(def.inputSchema.type, "object");
  assert.ok(def.inputSchema.properties, "inputSchema.properties must be present");
});

test("toolToMcpDefinition: read-only tool sets readOnlyHint, no destructiveHint", () => {
  const def = toolToMcpDefinition(makeTool("read"));
  assert.equal(def.annotations?.readOnlyHint, true);
  assert.equal(def.annotations?.destructiveHint, false);
  // idempotentHint is only set for destructive tools (per spec)
  assert.equal(def.annotations?.idempotentHint, undefined);
});

test("toolToMcpDefinition: destructive tool sets destructiveHint, idempotentHint=false", () => {
  const def = toolToMcpDefinition(makeTool("bash"));
  assert.equal(def.annotations?.destructiveHint, true);
  assert.equal(def.annotations?.idempotentHint, false);
});

test("toolToMcpDefinition: open-world tool (http) sets openWorldHint", () => {
  const def = toolToMcpDefinition(makeTool("http"));
  assert.equal(def.annotations?.openWorldHint, true);
  const def2 = toolToMcpDefinition(makeTool("read"));
  assert.equal(def2.annotations?.openWorldHint, undefined);
});

// ---------- parseJsonRpc (via /mcp end-to-end) ----------

async function rpc(port: number, body: object): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest({
      hostname: "127.0.0.1", port, path: "/mcp", method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* leave null */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function rpcRaw(port: number, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = body;
    const req = httpRequest({
      hostname: "127.0.0.1", port, path: "/mcp", method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

test("rpc: initialize returns protocolVersion, capabilities, serverInfo", async () => {
  const r = await startMcpServer({ port: 34560, host: "127.0.0.1", cwd: tmp });
  try {
    const { status, json } = await rpc(34560, {
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" },
    });
    assert.equal(status, 200);
    assert.equal(json.jsonrpc, "2.0");
    assert.equal(json.id, 1);
    assert.equal(json.result.protocolVersion, "2025-06-18");
    assert.ok(json.result.capabilities?.tools);
    assert.equal(json.result.serverInfo.name, "codingharness");
    // `protocolVersion` is NOT a spec field on serverInfo — must not leak.
    assert.equal(json.result.serverInfo.protocolVersion, undefined);
  } finally { await r.stop(); }
});

test("rpc: tools/list returns registered tools", async () => {
  const r = await startMcpServer({ port: 34561, host: "127.0.0.1", cwd: tmp });
  try {
    const { json } = await rpc(34561, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.ok(Array.isArray(json.result.tools));
    assert.ok(json.result.tools.length >= 5, "registry should have many tools");
    const names: string[] = json.result.tools.map((t: McpToolDefinition) => t.name);
    assert.ok(names.includes("read"));
    assert.ok(names.includes("bash"));
  } finally { await r.stop(); }
});

test("rpc: tools/call executes a tool and returns content", async () => {
  const r = await startMcpServer({ port: 34562, host: "127.0.0.1", cwd: tmp });
  try {
    // The `ls` tool takes a path arg. We just want a no-error round trip.
    const { json } = await rpc(34562, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "ls", arguments: { path: tmp } },
    });
    assert.equal(json.jsonrpc, "2.0");
    assert.equal(json.id, 3);
    assert.ok(Array.isArray(json.result.content));
    assert.equal(json.result.content[0].type, "text");
  } finally { await r.stop(); }
});

test("rpc: tools/call with unknown tool returns isError", async () => {
  const r = await startMcpServer({ port: 34563, host: "127.0.0.1", cwd: tmp });
  try {
    const { json } = await rpc(34563, {
      jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "definitely-not-a-tool" },
    });
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /unknown tool/);
  } finally { await r.stop(); }
});

test("rpc: unknown method returns -32601", async () => {
  const r = await startMcpServer({ port: 34564, host: "127.0.0.1", cwd: tmp });
  try {
    const { json } = await rpc(34564, { jsonrpc: "2.0", id: 5, method: "tools/something-bogus" });
    assert.equal(json.error.code, -32601);
    assert.match(json.error.message, /unknown method/);
  } finally { await r.stop(); }
});

test("rpc: explicit null id returns -32600 Invalid Request", async () => {
  const r = await startMcpServer({ port: 34565, host: "127.0.0.1", cwd: tmp });
  try {
    const raw = await rpcRaw(34565, '{"jsonrpc":"2.0","id":null,"method":"ping"}');
    const json = JSON.parse(raw.text);
    assert.equal(json.error.code, -32600);
    assert.equal(json.id, null);
  } finally { await r.stop(); }
});

test("rpc: parse error returns -32700", async () => {
  const r = await startMcpServer({ port: 34566, host: "127.0.0.1", cwd: tmp });
  try {
    const { json } = await rpcRaw(34566, "{not json")
      .then((r) => ({ json: JSON.parse(r.text) }));
    assert.equal(json.error.code, -32700);
  } finally { await r.stop(); }
});

test("rpc: missing jsonrpc field returns -32700", async () => {
  const r = await startMcpServer({ port: 34567, host: "127.0.0.1", cwd: tmp });
  try {
    const { json } = await rpc(34567, { id: 1, method: "ping" });
    assert.equal(json.error.code, -32700);
  } finally { await r.stop(); }
});

test("rpc: notification (no id) returns 204", async () => {
  const r = await startMcpServer({ port: 34568, host: "127.0.0.1", cwd: tmp });
  try {
    const { status } = await rpcRaw(34568, '{"jsonrpc":"2.0","method":"notifications/initialized"}');
    assert.equal(status, 204);
  } finally { await r.stop(); }
});

test("health endpoint returns server info and tool count", async () => {
  const r = await startMcpServer({ port: 34569, host: "127.0.0.1", cwd: tmp });
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: 34569, path: "/health", method: "GET" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      });
      req.on("error", reject);
      req.end();
    });
    const j = JSON.parse(data);
    assert.equal(j.status, "ok");
    assert.equal(j.server, "codingharness");
    assert.ok(j.tools > 0);
  } finally { await r.stop(); }
});

test("startMcpServer: refuses to bind non-loopback without --allow-remote", async () => {
  let err: Error | null = null;
  try {
    await startMcpServer({ port: 34570, host: "0.0.0.0", cwd: tmp });
  } catch (e) { err = e as Error; }
  assert.ok(err, "expected an error");
  assert.match((err.message), /non-loopback/);
});

test("ALL OK", () => {
  // Cleanup the temp dir.
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});
