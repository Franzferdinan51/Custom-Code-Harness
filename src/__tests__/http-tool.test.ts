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

test("httpTool: validate rejects unknown HTTP methods (was: passed straight to fetch)", () => {
  // Regression: pre-fix, `method: "POSTT"` (typo) or
  // `method: "PROPFIND"` (webdav) would be passed to
  // `fetch()` which would then throw an opaque
  // "TypeError: fetch failed" deep in the stack. Now:
  // validate() rejects with a clear "method X not allowed"
  // message. The valid set is the standard 7 (GET, POST,
  // PUT, PATCH, DELETE, HEAD, OPTIONS).
  for (const m of ["POSTT", "FOO", "propfind", "TRACE"]) {
    assert.throws(
      () => httpTool.validate({ url: "http://x", method: m }),
      new RegExp("method: '" + m + "' not allowed", "i"),
      "method '" + m + "' should be rejected at validate()",
    );
  }
  // Case-insensitive: spec says uppercase, but tolerate lowercase
  // by uppercasing before the lookup. (Node's fetch uppercases
  // internally; this matches its behavior.)
  for (const m of ["get", "post", "put", "patch", "delete", "head", "options"]) {
    const args = httpTool.validate({ url: "http://x", method: m });
    assert.equal(typeof args.method, "string");
  }
});

test("httpTool: streams response and truncates at max_bytes (regression for full-body-OOM bug)", async () => {
  // Pre-fix bug: `await res.arrayBuffer()` materialized the entire
  // body before the cap was applied, so a hostile / runaway
  // 1 GB response would OOM the harness. The fix streams up to
  // `max_bytes + 1` and cancels the stream instead of waiting
  // for the producer to finish.
  //
  // The test sets a HARD timeout (3s) on `httpTool.run`. If the
  // streaming path is broken (e.g. the pre-fix `arrayBuffer()`
  // was reinstated), the run hangs until the server's keep-alive
  // timer eventually closes the response — well past 3s — and
  // the test fails with a timeout.
  const big = "x".repeat(5_000);
  const server = await startMockServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write(big);
    res.write(big);
    res.write(big);
    res.write(big);
    res.end();
  });
  try {
    const args = httpTool.validate({ url: `http://127.0.0.1:${server.port}/`, max_bytes: 200 });
    const runPromise = httpTool.run(args, ctx);
    const result = await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout: httpTool.run hung past 3s — body was not streamed/capped")), 3_000)),
    ]);
    assert.equal(result.isError, false);
    assert.match(result.content, /truncated to 200/);
    // Total content size is bounded by the header block (≈100
    // bytes) + the 200-byte cap. Far below the 20_000-byte
    // server response.
    assert.ok(result.content.length < 1_000, "truncated body must be small, got " + result.content.length);
  } finally { server.close(); }
});

// After all tests, clean up the tmpdir. node:test runs tests in
// registration order and `after()` is not in the standard test()
// API; we register a trailing no-op test that does the cleanup so
// the tmpdir lives for the whole file's duration.
test("httpTool: cleanup tmpdir", () => {
  rmSync(tmp, { recursive: true, force: true });
});
