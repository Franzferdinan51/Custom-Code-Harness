// Tests for the http tool. Each test spins up a local HTTP
// server with a known handler, then exercises the tool's
// `validate()` and `run()` paths to pin the contract that
// external programs can rely on.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpTool } from "../agent/tools/http.js";
import type { ToolContext } from "../agent/tools/registry.js";

const tmp = mkdtempSync(join(tmpdir(), "ch-http-tool-"));
const ctx: ToolContext = {
  cwd: tmp,
  signal: new AbortController().signal,
  limits: { bashTimeoutMs: 1, readMaxBytes: 1_000_000 },
  log: () => {},
};

interface StartedServer {
  port: number;
  close: () => void;
}

/** Start a local HTTP server on a free port with a caller-supplied
 *  handler. Used as the target for the http tool's `fetch` so the
 *  test is fully self-contained (no network egress). */
function startMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<StartedServer> {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        resolve({ port: addr.port, close: () => srv.close() });
      } else {
        reject(new Error("no port"));
      }
    });
  });
}

test("httpTool: GET happy path", async () => {
  const server = await startMockServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello world");
  });
  try {
    const args = httpTool.validate({ url: `http://127.0.0.1:${server.port}/` });
    const r = await httpTool.run(args, ctx);
    assert.equal(r.isError, false);
    assert.match(r.content, /HTTP 200/);
    assert.match(r.content, /hello world/);
  } finally { server.close(); }
});

test("httpTool: GET request does NOT send a body (regression: fetch happily attaches body to GET)", async () => {
  // The fix at the call site sets `body` to undefined for GET/DELETE/HEAD,
  // even if the caller passed a body. Without that guard, fetch sends the
  // body anyway, and strict servers reject with 411.
  let observedMethod = "";
  let observedBodyLength = -1;
  const server = await startMockServer((req, res) => {
    observedMethod = req.method ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      observedBodyLength = chunks.reduce((a, b) => a + b.length, 0);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  try {
    const args = httpTool.validate({
      url: `http://127.0.0.1:${server.port}/`,
      method: "GET",
      body: "this body should be dropped because method=GET",
    });
    await httpTool.run(args, ctx);
    assert.equal(observedMethod, "GET");
    assert.equal(observedBodyLength, 0, "GET must not transmit a body even when the caller passed one");
  } finally { server.close(); }
});

test("httpTool: DELETE request does NOT send a body either", async () => {
  let observedMethod = "";
  let observedBodyLength = -1;
  const server = await startMockServer((req, res) => {
    observedMethod = req.method ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      observedBodyLength = chunks.reduce((a, b) => a + b.length, 0);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  try {
    const args = httpTool.validate({
      url: `http://127.0.0.1:${server.port}/resource`,
      method: "DELETE",
      body: "ignored",
    });
    await httpTool.run(args, ctx);
    assert.equal(observedMethod, "DELETE");
    assert.equal(observedBodyLength, 0);
  } finally { server.close(); }
});

test("httpTool: POST DOES send a body (positive control for the GET/DELETE guard)", async () => {
  let observedMethod = "";
  let observedBody = "";
  const server = await startMockServer((req, res) => {
    observedMethod = req.method ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      observedBody = Buffer.concat(chunks).toString("utf-8");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  try {
    const args = httpTool.validate({
      url: `http://127.0.0.1:${server.port}/`,
      method: "POST",
      body: "hello server",
    });
    await httpTool.run(args, ctx);
    assert.equal(observedMethod, "POST");
    assert.equal(observedBody, "hello server");
  } finally { server.close(); }
});

test("httpTool: timeout_ms=1 aborts the request when the server hangs", async () => {
  // Server never responds. The tool's 1ms timeout must abort and
  // surface a clean failure, not hang forever.
  const server = await startMockServer((_req, res) => {
    // Never call res.end() — keep the connection open until the
    // client gives up.
    void res;
  });
  try {
    const args = httpTool.validate({
      url: `http://127.0.0.1:${server.port}/`,
      timeout_ms: 50,
    });
    const start = Date.now();
    const r = await httpTool.run(args, ctx);
    const elapsed = Date.now() - start;
    // 50ms is the floor; allow 1s of slack for slow CI.
    assert.ok(elapsed < 1_000, `should have aborted near 50ms, took ${elapsed}ms`);
    assert.equal(r.isError, true);
    assert.match(r.display, /http failed/);
  } finally { server.close(); }
});

test("httpTool: validate rejects timeout_ms > 300000 (5 minute cap)", () => {
  assert.throws(
    () => httpTool.validate({ url: "http://x", timeout_ms: 1_000_000 }),
    /timeout_ms/i,
  );
});

test("httpTool: validate rejects timeout_ms <= 0", () => {
  assert.throws(
    () => httpTool.validate({ url: "http://x", timeout_ms: 0 }),
    /timeout_ms/i,
  );
});

// After all tests, clean up the tmpdir. node:test runs tests in
// registration order and `after()` is not in the standard test()
// API; we register a trailing no-op test that does the cleanup so
// the tmpdir lives for the whole file's duration.
test("httpTool: cleanup tmpdir", () => {
  rmSync(tmp, { recursive: true, force: true });
});
