// Tests for the MCP **client** (`src/agent/mcp-client.ts`),
// the on-disk persistence (`src/agent/mcp-store.ts`), the registry
// bridge (`src/agent/mcp-registry.ts`), and the shared JSON-RPC
// framing extracted to `src/mcp-transport.ts`.
//
// Strategy: spawn a tiny Node subprocess (`mcp-fixture-server.js`
// lives next to this file) that echoes JSON-RPC responses for
// `initialize` / `tools/list` / `tools/call`. That gives us a real
// stdio end-to-end test without hitting the network or depending
// on `npx` working in CI. The HTTP transport gets the same fixture
// shape over a local `http.createServer`.
//
// All tests use a per-test tempdir + `MCP_CONFIG_PATH` so they
// don't touch `~/.codingharness/mcp.json`.
//
// Hard requirements pinned by these tests (mirrors `phase4.md` §T3):
//   - Package name validation rejects `..`, `-foo`, empty, etc.
//   - Stdio transport spawns the subprocess, completes the
//     handshake, lists tools, calls a tool, closes cleanly.
//   - HTTP transport POSTs JSON-RPC, parses responses, dispatches
//     `tools/call`.
//   - `mcpAdd` writes the entry to `mcp.json`; `LocalMcpRegistry`
//     reads it back and dispatches via `callTool`.
//   - Persistence is atomic (tmp + rename); concurrent `add`
//     calls don't corrupt the file.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";

import {
  validatePackageName,
  resolveNpmPackage,
  deriveServerId,
  buildEntry,
  mcpGet,
  mcpAdd,
  __test,
} from "../agent/mcp-client.js";
import {
  parseConfig,
  parseEntry,
  loadMcpConfigSync,
  loadMcpConfig,
  saveMcpConfigAtomic,
  upsertMcpServerEntry,
  removeMcpServerEntry,
  resolveMcpConfigPath,
  type McpServerEntry,
} from "../agent/mcp-store.js";
import { LocalMcpRegistry, defaultLocalMcpRegistry } from "../agent/mcp-registry.js";
import {
  parseJsonRpc,
  formatJsonRpcRequest,
  formatJsonRpcResponse,
  tryInferId,
  okResponse,
  errResponse,
  ERR_PARSE,
  ERR_INVALID_REQUEST,
  MCP_PROTOCOL_VERSION,
} from "../mcp-transport.js";

// ---------- Per-test tempdir ----------
//
// Tests must not touch the real `~/.codingharness/mcp.json`. We
// set `MCP_CONFIG_PATH` to a per-test tmp file before any
// module that calls `resolveMcpConfigPath()` is imported.

const tmp = mkdtempSync(join(tmpdir(), "ch-mcp-client-"));
process.env.MCP_CONFIG_PATH = join(tmp, "mcp.json");
mkdirSync(join(tmp, "sessions"), { recursive: true });
mkdirSync(join(tmp, "logs"), { recursive: true });

// ---------- Test fixture: a fake MCP stdio server ----------
//
// The fixture reads JSON-RPC requests from stdin (newline-
// delimited) and writes responses for `initialize`, `tools/list`,
// and a single `tools/call` named "echo". The script lives next
// to this test file so we can spawn it via `node fixture.js`.

const fixturePath = join(fileURLToPath(import.meta.url.replace(/\/[^/]+$/, "")), "mcp-fixture-server.mjs");
writeFileSync(fixturePath, `
// Minimal MCP stdio server for testing the client. Reads
// newline-delimited JSON-RPC from stdin, writes responses.
// Supports: initialize, tools/list, tools/call ("echo"), ping.

let buf = "";

function send(res) {
  process.stdout.write(JSON.stringify(res) + "\\n");
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.id === undefined) continue; // notification
    const id = req.id;
    if (req.method === "initialize") {
      send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fixture", version: "0.0.1", title: "Test Fixture" },
        },
      });
    } else if (req.method === "tools/list") {
      send({
        jsonrpc: "2.0", id,
        result: { tools: [
          {
            name: "echo",
            description: "Echo the input back",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
          {
            name: "add",
            description: "Add two numbers",
            inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
          },
        ] },
      });
    } else if (req.method === "tools/call") {
      const { name, arguments: args } = req.params || {};
      if (name === "echo") {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "echo: " + (args?.text ?? "") }] } });
      } else if (name === "add") {
        const sum = (args?.a ?? 0) + (args?.b ?? 0);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(sum) }] } });
      } else {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "unknown tool" }], isError: true } });
      }
    } else if (req.method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method: " + req.method } });
    }
  }
});
`, "utf-8");

// ---------- package-name validation ----------

test("validatePackageName: accepts npm-style names", () => {
  for (const ok of ["foo", "foo-bar", "foo_bar", "foo.bar", "@scope/bar", "@scope/foo-bar_baz.qux"]) {
    assert.doesNotThrow(() => validatePackageName(ok), "should accept " + ok);
  }
});

test("validatePackageName: rejects bad names", () => {
  for (const bad of ["", "  ", "..", "-foo", "FOO", "foo bar", "foo*", "foo$", "foo/bar/baz", "x".repeat(220)]) {
    assert.throws(() => validatePackageName(bad), "should reject " + JSON.stringify(bad));
  }
});

test("validatePackageName: rejects path traversal", () => {
  assert.throws(() => validatePackageName("../etc/passwd"));
  assert.throws(() => validatePackageName("foo/../bar"));
});

// ---------- package resolution ----------

test("resolveNpmPackage: returns npx -y <name>", () => {
  const r = resolveNpmPackage("@modelcontextprotocol/server-filesystem");
  assert.equal(r.command, "npx");
  assert.deepEqual(r.args, ["-y", "@modelcontextprotocol/server-filesystem"]);
  assert.equal(r.displayName, "@modelcontextprotocol/server-filesystem");
});

test("deriveServerId: collapses scoped-name slash", () => {
  assert.equal(deriveServerId("@scope/foo"), "scope_foo");
  assert.equal(deriveServerId("@modelcontextprotocol/server-filesystem"), "modelcontextprotocol_server-filesystem");
  assert.equal(deriveServerId("foo-bar"), "foo-bar");
  assert.equal(deriveServerId("plain"), "plain");
});

// ---------- store: parseConfig / parseEntry ----------

test("parseEntry: rejects missing fields", () => {
  for (const bad of [null, undefined, {}, { id: "x" }, { id: "x", name: "n", transport: "stdio", version: "v", installedAt: 0 }, { id: "x", name: "n", transport: "stdio", version: "v", installedAt: 0 }]) {
    assert.equal(parseEntry(bad), null, "should reject " + JSON.stringify(bad));
  }
});

test("parseEntry: accepts valid stdio entry", () => {
  const e = parseEntry({
    id: "x", name: "X", transport: "stdio", command: "node", args: ["a.js"],
    version: "1", installedAt: 100, tools: [{ name: "t", description: "d", parameters: {} }],
  });
  assert.ok(e);
  assert.equal(e!.id, "x");
  assert.equal(e!.command, "node");
  assert.deepEqual(e!.args, ["a.js"]);
});

test("parseEntry: rejects http without valid url", () => {
  const e = parseEntry({
    id: "x", name: "X", transport: "http", url: "not-a-url",
    version: "1", installedAt: 100, tools: [],
  });
  assert.equal(e, null);
});

test("parseConfig: skips invalid entries; preserves valid ones", () => {
  const cfg = parseConfig({
    good: {
      id: "good", name: "G", transport: "stdio", command: "node",
      version: "1", installedAt: 1, tools: [],
    },
    bad: null,
    "id-mismatch": {
      id: "different", name: "X", transport: "stdio", command: "node",
      version: "1", installedAt: 1, tools: [],
    },
  });
  assert.ok("good" in cfg);
  assert.ok(!("bad" in cfg));
  assert.ok(!("id-mismatch" in cfg));
});

// ---------- store: atomic save / load ----------

test("saveMcpConfigAtomic: writes JSON to disk", async () => {
  const filePath = join(tmp, "save-1.json");
  const cfg = {
    a: {
      id: "a", name: "A", transport: "stdio" as const, command: "node",
      version: "1", installedAt: 1, tools: [],
    },
  };
  await saveMcpConfigAtomic(cfg, filePath);
  assert.ok(existsSync(filePath));
  const back = JSON.parse(readFileSync(filePath, "utf-8"));
  assert.deepEqual(back.a.id, "a");
});

test("saveMcpConfigAtomic: overwrites cleanly", async () => {
  const filePath = join(tmp, "save-2.json");
  await saveMcpConfigAtomic({
    a: { id: "a", name: "A", transport: "stdio", command: "node", version: "1", installedAt: 1, tools: [] },
  }, filePath);
  await saveMcpConfigAtomic({
    b: { id: "b", name: "B", transport: "http", url: "https://x", version: "1", installedAt: 2, tools: [] },
  }, filePath);
  const back = JSON.parse(readFileSync(filePath, "utf-8"));
  assert.ok(!("a" in back), "old entry should be gone");
  assert.ok("b" in back, "new entry should be present");
});

test("saveMcpConfigAtomic: serializes concurrent writes", async () => {
  // Hammer the save function with 5 concurrent calls and assert
  // the final file is one of the five candidate states (not a
  // corrupt partial write).
  const filePath = join(tmp, "save-3.json");
  const writes = [];
  for (let i = 0; i < 5; i++) {
    writes.push(saveMcpConfigAtomic({
      ["k" + i]: { id: "k" + i, name: "k" + i, transport: "stdio", command: "node", version: "1", installedAt: i, tools: [] },
    }, filePath));
  }
  await Promise.all(writes);
  const text = readFileSync(filePath, "utf-8");
  // No partial content: the file is one of the five states, not a
  // concat of two.
  const back = JSON.parse(text);
  assert.equal(typeof back, "object");
  // The file must have exactly one key — that's the guarantee
  // each save is a full rewrite, not an append.
  assert.equal(Object.keys(back).length, 1);
});

test("loadMcpConfigSync: returns {} for missing file", () => {
  const filePath = join(tmp, "does-not-exist.json");
  assert.deepEqual(loadMcpConfigSync(filePath), {});
});

test("loadMcpConfigSync: returns {} for malformed JSON", () => {
  const filePath = join(tmp, "bad.json");
  writeFileSync(filePath, "not json", "utf-8");
  assert.deepEqual(loadMcpConfigSync(filePath), {});
});

test("upsertMcpServerEntry + removeMcpServerEntry: round-trip", async () => {
  const filePath = join(tmp, "upsert.json");
  const entry: McpServerEntry = {
    id: "x", name: "X", transport: "stdio", command: "node",
    version: "1", installedAt: 1,
    tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
  };
  await upsertMcpServerEntry(entry, filePath);
  let cfg = await loadMcpConfig(filePath);
  assert.ok("x" in cfg);
  // Re-upsert with a different version — should overwrite, not duplicate.
  await upsertMcpServerEntry({ ...entry, version: "2" }, filePath);
  cfg = await loadMcpConfig(filePath);
  assert.equal(Object.keys(cfg).length, 1);
  assert.equal(cfg.x!.version, "2");
  // Remove.
  await removeMcpServerEntry("x", filePath);
  cfg = await loadMcpConfig(filePath);
  assert.deepEqual(cfg, {});
});

test("resolveMcpConfigPath: honors MCP_CONFIG_PATH env var", () => {
  // Set by the module-level setup; the resolved path should match.
  assert.equal(resolveMcpConfigPath(), process.env.MCP_CONFIG_PATH);
});

// ---------- JSON-RPC framing ----------

test("parseJsonRpc: accepts valid request and response envelopes", () => {
  const req = parseJsonRpc('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
  assert.ok(req);
  assert.equal(req!.id, 1);
  assert.equal(req!.method, "tools/list");
});

test("parseJsonRpc: notification has no id field", () => {
  const n = parseJsonRpc('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  assert.ok(n);
  assert.equal(n!.id, undefined);
});

test("parseJsonRpc: explicit id:null is invalid sentinel", () => {
  const n = parseJsonRpc('{"jsonrpc":"2.0","id":null,"method":"foo"}');
  assert.ok(n);
  assert.equal(n!.id, "__invalid__");
});

test("parseJsonRpc: rejects non-JSON, non-object, missing jsonrpc, missing method", () => {
  assert.equal(parseJsonRpc(""), null);
  assert.equal(parseJsonRpc("not json"), null);
  assert.equal(parseJsonRpc('{"jsonrpc":"1.0","id":1,"method":"x"}'), null);
  assert.equal(parseJsonRpc('{"jsonrpc":"2.0","id":1}'), null);
});

test("tryInferId: best-effort id from a malformed line", () => {
  assert.equal(tryInferId('{"id":"a","jsonrpc":"2.0"}'), "a");
  assert.equal(tryInferId('{"id":42,"jsonrpc":"2.0"}'), 42);
  assert.equal(tryInferId('{"id":null}'), null);
  assert.equal(tryInferId("not json"), null);
});

test("formatJsonRpcRequest + formatJsonRpcResponse round-trip via parseJsonRpc", () => {
  const reqStr = formatJsonRpcRequest({ jsonrpc: "2.0", id: 7, method: "ping" });
  const parsed = parseJsonRpc(reqStr);
  assert.ok(parsed);
  assert.equal(parsed!.id, 7);
  assert.equal(parsed!.method, "ping");
});

test("okResponse / errResponse produce well-formed envelopes", () => {
  const ok = okResponse(1, { tools: [] });
  assert.equal(ok.jsonrpc, "2.0");
  assert.equal(ok.id, 1);
  assert.deepEqual(ok.result, { tools: [] });
  const err = errResponse(2, ERR_INVALID_REQUEST, "bad");
  assert.equal(err.jsonrpc, "2.0");
  assert.equal(err.error?.code, ERR_INVALID_REQUEST);
});

// ---------- Stdio transport against the fixture ----------

test("connectStdio (via mcpGet): handshake + tools/list + tools/call", async () => {
  const result = await mcpGet("fixture", {
    transport: "stdio",
    command: process.execPath, // node
    args: [fixturePath],
    timeoutMs: 5000,
  });
  try {
    assert.equal(result.serverInfo.name, "fixture");
    assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(result.tools.length, 2);
    assert.ok(result.tools.find((t) => t.name === "echo"));
    assert.ok(result.tools.find((t) => t.name === "add"));
    // tools/call via the client.
    const callResult = await (await import("../agent/mcp-client.js")).connectStdio({
      command: process.execPath,
      args: [fixturePath],
      timeoutMs: 5000,
    });
    try {
      const r = await callResult.callTool("echo", { text: "hello" });
      assert.equal(r.isError, undefined);
      const first = r.content[0]!;
      assert.equal(first.type, "text");
      if (first.type === "text") {
        assert.match(first.text, /hello/);
      }
    } finally {
      await callResult.close();
    }
  } finally {
    await result.close();
  }
});

test("mcpGet: detects transport from http(s):// prefix", async () => {
  // Spawn a local HTTP server that mimics the fixture.
  const port = await new Promise<number>((resolve) => {
    const s = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => body += c.toString("utf-8"));
      req.on("end", () => {
        const req2 = JSON.parse(body);
        if (req2.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0", id: req2.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "http-fixture", version: "0.0.1" },
            },
          }));
        } else if (req2.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0", id: req2.id,
            result: { tools: [{ name: "httpEcho", description: "HTTP echo", inputSchema: { type: "object" } }] },
          }));
        } else if (req2.method === "tools/call") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0", id: req2.id,
            result: { content: [{ type: "text", text: "httpEcho: ok" }] },
          }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: req2.id, result: {} }));
        }
      });
    });
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  try {
    const url = "http://127.0.0.1:" + port;
    const result = await mcpGet(url, { timeoutMs: 5000 });
    try {
      assert.equal(result.resolved.transport, "http");
      assert.equal(result.serverInfo.name, "http-fixture");
      assert.equal(result.tools.length, 1);
      assert.equal(result.tools[0]!.name, "httpEcho");
      const r = await (await import("../agent/mcp-client.js")).connectHttp({ url, timeoutMs: 5000 });
      try {
        const c = await r.callTool("httpEcho", {});
        const first = c.content[0]!;
        if (first.type === "text") {
          assert.match(first.text, /httpEcho: ok/);
        }
      } finally {
        await r.close();
      }
    } finally {
      await result.close();
    }
  } finally {
    // server ref captured in port promise — close via a tiny delay.
    await new Promise((r) => setTimeout(r, 50));
    // Best-effort: the server is closed when its response ends.
    void once; // keep import
    void spawn; // keep import
  }
});

test("mcpGet: surfaces server-side initialize error", async () => {
  // Build a one-off fixture script that returns an error from
  // initialize.
  const failFixture = join(tmp, "fail-init.mjs");
  writeFileSync(failFixture, `
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "deliberate" } }) + "\\n");
    }
  }
});
`, "utf-8");
  await assert.rejects(
    () => mcpGet("fail-init", {
      transport: "stdio",
      command: process.execPath,
      args: [failFixture],
      timeoutMs: 3000,
    }),
    /deliberate/,
  );
});

// ---------- mcpAdd + LocalMcpRegistry ----------

test("mcpAdd: persists entry + LocalMcpRegistry.callTool round-trips through the file", async () => {
  // Clean state for this test.
  const filePath = join(tmp, "registry-roundtrip.json");
  process.env.MCP_CONFIG_PATH = filePath;
  const { result, entry } = await mcpAdd("fixture", {
    transport: "stdio",
    command: process.execPath,
    args: [fixturePath],
    timeoutMs: 5000,
  });
  try {
    assert.equal(entry.transport, "stdio");
    assert.equal(entry.tools.length, 2);
    // The file should now have one entry.
    const onDisk = loadMcpConfigSync(filePath);
    assert.ok(entry.id in onDisk);
    // Build the registry and dispatch through it.
    const reg = new LocalMcpRegistry({ filePath });
    assert.deepEqual(reg.listServers(), [{ id: entry.id, name: entry.name }]);
    const r = await reg.callTool(entry.id, "echo", { text: "via registry" });
    assert.equal(r.ok, true);
    const out = r.output as { content: Array<{ type: string; text?: string }> };
    const first = out.content[0];
    if (first && first.type === "text" && typeof first.text === "string") {
      assert.match(first.text, /via registry/);
    } else {
      assert.fail("expected a text block in the response");
    }
  } finally {
    await result.close();
  }
});

test("LocalMcpRegistry: unknown server returns typed error", async () => {
  const filePath = join(tmp, "unknown-server.json");
  const reg = new LocalMcpRegistry({ filePath });
  const r = await reg.callTool("nope", "tool", {});
  assert.equal(r.ok, false);
  assert.match(r.error!, /unknown MCP server: nope/);
});

test("LocalMcpRegistry: unknown tool returns typed error", async () => {
  const filePath = join(tmp, "unknown-tool.json");
  process.env.MCP_CONFIG_PATH = filePath;
  const { result, entry } = await mcpAdd("fixture", {
    transport: "stdio",
    command: process.execPath,
    args: [fixturePath],
    timeoutMs: 5000,
  });
  await result.close();
  const reg = new LocalMcpRegistry({ filePath });
  const r = await reg.callTool(entry.id, "nope", {});
  assert.equal(r.ok, false);
  assert.match(r.error!, /unknown tool "nope"/);
});

test("LocalMcpRegistry: add() and remove() refresh the snapshot", async () => {
  const filePath = join(tmp, "registry-mutate.json");
  const reg = new LocalMcpRegistry({ filePath });
  assert.deepEqual(reg.listServers(), []);
  await reg.add({
    id: "x", name: "X", transport: "stdio", command: "node",
    version: "1", installedAt: 1, tools: [],
  });
  assert.equal(reg.listServers().length, 1);
  await reg.remove("x");
  assert.equal(reg.listServers().length, 0);
});

test("defaultLocalMcpRegistry: uses MCP_CONFIG_PATH", () => {
  process.env.MCP_CONFIG_PATH = join(tmp, "default.json");
  const reg = defaultLocalMcpRegistry();
  assert.ok(reg);
  assert.equal(reg.id, "local");
});

// ---------- buildEntry / round-trip via store ----------

test("buildEntry: produces a persistable entry from an McpGetResult", () => {
  const r = {
    resolved: { command: "npx", args: ["-y", "foo"], transport: "stdio" as const, displayName: "foo", id: "foo" },
    serverInfo: { name: "foo", version: "1.0.0" },
    tools: [{ name: "t", description: "d", inputSchema: { type: "object", properties: {} } }] as ReadonlyArray<{ name: string; description: string; inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] } }>,
    protocolVersion: "2025-06-18",
    close: async () => {},
  };
  const e = buildEntry(r);
  assert.equal(e.id, "foo");
  assert.equal(e.transport, "stdio");
  assert.equal(e.command, "npx");
  assert.deepEqual(e.args, ["-y", "foo"]);
  assert.equal(e.tools.length, 1);
  assert.equal(e.tools[0]!.name, "t");
});

test("buildEntry: persists stdio cwd and env from opts (regression for dropped-spawn-options bug)", () => {
  // Bug: `buildEntry(result)` previously ignored `opts.cwd` and
  // `opts.env`, so `mcpAdd` would write an entry without them. The
  // handshake used the user's cwd/env correctly, but the next
  // `LocalMcpRegistry.callTool` re-spawned the subprocess with the
  // runtime's cwd + parent env — silently breaking any user-supplied
  // `--cwd` / `--env`. The fix is to pass `opts` through and persist
  // both fields on stdio entries.
  const r = {
    resolved: { command: "npx", args: ["-y", "foo"], transport: "stdio" as const, displayName: "foo", id: "foo" },
    serverInfo: { name: "foo", version: "1.0.0" },
    tools: [{ name: "t", description: "d", inputSchema: { type: "object", properties: {} } }] as ReadonlyArray<{ name: string; description: string; inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] } }>,
    protocolVersion: "2025-06-18",
    close: async () => {},
  };
  // Without opts: cwd / env are undefined (the legacy single-arg call
  // site still works and stores no cwd/env).
  const e0 = buildEntry(r);
  assert.equal(e0.cwd, undefined);
  assert.equal(e0.env, undefined);
  // With opts: cwd + env are persisted on stdio entries.
  const e1 = buildEntry(r, { cwd: "/tmp", env: ["FOO=bar", "BAZ=qux"] });
  assert.equal(e1.cwd, "/tmp");
  assert.deepEqual(e1.env, ["FOO=bar", "BAZ=qux"]);
  // Empty env array is treated as "no env override" — no key written.
  const e2 = buildEntry(r, { cwd: "/tmp", env: [] });
  assert.equal(e2.cwd, "/tmp");
  assert.equal(e2.env, undefined);
  // Defensive copy: caller mutating the original opts array must not
  // mutate the persisted entry.
  const originalEnv = ["A=1"];
  const e3 = buildEntry(r, { env: originalEnv });
  originalEnv.push("B=2");
  assert.deepEqual(e3.env, ["A=1"]);
});

test("buildEntry: http entries do NOT persist cwd / env (transport-specific fields)", () => {
  const r = {
    resolved: { url: "https://x.example/mcp", transport: "http" as const, displayName: "x", id: "x" },
    serverInfo: { name: "x", version: "1.0.0" },
    tools: [] as ReadonlyArray<{ name: string; description: string; inputSchema: { type: "object" } }>,
    protocolVersion: "2025-06-18",
    close: async () => {},
  };
  const e = buildEntry(r, { cwd: "/tmp", env: ["X=1"] });
  assert.equal(e.cwd, undefined, "http entries must not carry stdio-only fields");
  assert.equal(e.env, undefined);
  assert.equal(e.url, "https://x.example/mcp");
});

// ---------- cleanup ----------

test("ALL OK", () => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});