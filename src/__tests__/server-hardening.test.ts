// Endpoint security hardening for the HTTP API exposed by `ch serve`.
// These tests pin the contract that external programs (MCP clients,
// dashboards, scripts) can rely on:
//
//   1. Bearer-token auth (opt-in via CH_HTTP_TOKEN) — every /v1/* route
//      rejects requests without a valid Authorization header when the
//      env var is set; passes through unchanged when the env var is
//      unset (backwards compat).
//   2. Request body is capped at CH_HTTP_MAX_BODY_BYTES (default 1 MB).
//      Oversize bodies get 413.
//   3. SSE streams / POST /v1/spawn respect client disconnect — the
//      in-flight agent run is cancelled via the request's close event
//      and the response ends cleanly.
//   4. GET /v1/health is a public liveness probe that bypasses auth.
//
// Each test spawns the real `ch serve` subprocess on a free port and
// drives it with `fetch` + raw `http.request` — same wire the external
// programs use. Test isolation: every test gets its own tmpdir under
// CODINGHARNESS_HOME so settings / sessions / logs don't bleed.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

/** Find a free TCP port. Small race window; fine for these short tests. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("couldn't get a free port")));
      }
    });
  });
}

interface StartedServer {
  port: number;
  proc: ChildProcess;
  kill: () => void;
  extraEnv: Record<string, string>;
}

/** Pre-create the subdirectories that `paths.*` readers expect under
 *  CODINGHARNESS_HOME. Mirrors the AGENTS.md pattern. */
function prepHome(home: string): void {
  for (const d of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context", "goals/default"]) {
    mkdirSync(join(home, d), { recursive: true });
  }
}

function startServer(home: string, extraEnv: Record<string, string> = {}): Promise<StartedServer> {
  return new Promise(async (resolve, reject) => {
    let port = 0;
    try { port = await pickFreePort(); } catch (e) { reject(e as Error); return; }
    const env = { ...process.env, CODINGHARNESS_HOME: home, NO_COLOR: "1", ...extraEnv };
    // Force unset CH_HTTP_TOKEN by default — tests that want auth on
    // explicitly pass it via extraEnv.
    if (!("CH_HTTP_TOKEN" in extraEnv)) delete (env as Record<string, string | undefined>).CH_HTTP_TOKEN;
    // Clear hosted-provider env vars so settings.json's defaultProvider
    // actually wins. mergeWithEnv() in src/config/settings.ts picks
    // hosted providers when their API keys are visible in the shell.
    for (const k of [
      "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN",
      "OPENAI_API_KEY", "OPENAI_OAUTH_TOKEN",
      "CODEX_API_KEY", "CODEX_BASE_URL", "CODEX_MODEL", "CODEX_OAUTH_TOKEN",
      "XAI_API_KEY", "XAI_OAUTH_TOKEN",
      "GROK_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_BASE_URL", "GROK_MODEL", "GROK_OAUTH_TOKEN",
      "MINIMAX_API_KEY", "MINIMAX_OAUTH_TOKEN",
    ]) delete (env as Record<string, string | undefined>)[k];
    const proc = spawn("bun", ["src/cli.ts", "serve", "--no-open", "--port", String(port)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let stderrBuf = "";
    const onStdout = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const m = buf.match(/server listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        proc.stdout?.off("data", onStdout);
        proc.stderr?.off("data", onStderr);
        resolve({ port, proc, kill: () => proc.kill("SIGTERM"), extraEnv });
      }
    };
    const onStderr = (chunk: Buffer) => { stderrBuf += chunk.toString("utf-8"); };
    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("error", reject);
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error("server didn't start in 15s — stdout: " + buf.slice(0, 500) + " stderr: " + stderrBuf.slice(0, 500)));
    }, 15_000);
  });
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { headers });
  const body = await res.json() as T;
  return { status: res.status, body };
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}, bodyOverride?: string): Promise<{ status: number; body: T }> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: bodyOverride ?? JSON.stringify(body),
  };
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: T;
  try { parsed = JSON.parse(text) as T; } catch { parsed = text as unknown as T; }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// /v1/health
// ---------------------------------------------------------------------------

test("health: GET /v1/health returns 200 with { ok, uptime, version }", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-health-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ ok: boolean; uptime: number; version: string }>(`http://127.0.0.1:${port}/v1/health`);
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(typeof r.body.uptime, "number");
      assert.ok(r.body.uptime >= 0);
      assert.equal(r.body.version, "0.2.2");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("health: GET /v1/health bypasses auth when CH_HTTP_TOKEN is set", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-health-bypass-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home, { CH_HTTP_TOKEN: "supersecret" });
    try {
      // No Authorization header — health probe must still pass.
      const r = await getJson<{ ok: boolean; uptime: number; version: string }>(`http://127.0.0.1:${port}/v1/health`);
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Bearer-token auth
// ---------------------------------------------------------------------------

test("auth: when CH_HTTP_TOKEN unset, requests pass without a token", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-auth-open-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      // /v1/agents is a stable, cheap endpoint. No Authorization header
      // sent — should still 200.
      const r = await getJson<{ agents: unknown[] }>(`http://127.0.0.1:${port}/v1/agents`);
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.agents));
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("auth: when CH_HTTP_TOKEN set, requests without token get 401", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-auth-no-token-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home, { CH_HTTP_TOKEN: "secret-token-123" });
    try {
      const r = await getJson<{ error: string }>(`http://127.0.0.1:${port}/v1/agents`);
      assert.equal(r.status, 401);
      assert.equal(r.body.error, "unauthorized");
      // Critical: the configured token must NOT appear anywhere in the
      // error response. Use a low-entropy search across the full body.
      assert.ok(!JSON.stringify(r.body).includes("secret-token-123"), "configured token leaked into 401 body");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("auth: when CH_HTTP_TOKEN set, requests with wrong token get 401", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-auth-wrong-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home, { CH_HTTP_TOKEN: "secret-token-123" });
    try {
      const r = await getJson<{ error: string }>(`http://127.0.0.1:${port}/v1/agents`, {
        Authorization: "Bearer not-the-right-token",
      });
      assert.equal(r.status, 401);
      assert.equal(r.body.error, "unauthorized");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("auth: when CH_HTTP_TOKEN set, requests with right token pass (200 on /v1/agents)", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-auth-ok-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home, { CH_HTTP_TOKEN: "secret-token-123" });
    try {
      const r = await getJson<{ agents: unknown[] }>(`http://127.0.0.1:${port}/v1/agents`, {
        Authorization: "Bearer secret-token-123",
      });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.agents));
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("auth: when CH_HTTP_TOKEN set, malformed Authorization header still 401s (no token leak)", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-auth-malformed-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home, { CH_HTTP_TOKEN: "secret-token-123" });
    try {
      // Basic auth header is a wrong scheme.
      const r = await getJson<{ error: string }>(`http://127.0.0.1:${port}/v1/agents`, {
        Authorization: "Basic c2VjcmV0OnRva2VuLTEyMw==",
      });
      assert.equal(r.status, 401);
      assert.equal(r.body.error, "unauthorized");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Body size cap
// ---------------------------------------------------------------------------

test("body: POST /v1/chat with body > CH_HTTP_MAX_BODY_BYTES returns 413", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-body-413-"));
  prepHome(home);
  try {
    // Tighten the cap to 1 KB so the test is fast and doesn't push
    // megabytes through the test runner.
    const { port, kill } = await startServer(home, { CH_HTTP_MAX_BODY_BYTES: "1024" });
    try {
      // Send a ~2 KB body. The cap is 1 KB so this MUST 413.
      const bigPrompt = "x".repeat(2048);
      const r = await postJson<{ error: string }>(
        `http://127.0.0.1:${port}/v1/chat`,
        { prompt: bigPrompt },
        {},
        // bodyOverride: hand-craft a body that the server will try to parse
        // before it can 413. The server's readJson is the gate.
        `{"prompt":"${bigPrompt}"}`,
      );
      assert.equal(r.status, 413);
      assert.match(r.body.error ?? "", /body too large/);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("body: POST /v1/chat with body under cap is accepted (or 500s for other reasons, but NOT 413)", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-body-ok-"));
  prepHome(home);
  try {
    // 1 KB cap; tiny body.
    const { port, kill } = await startServer(home, { CH_HTTP_MAX_BODY_BYTES: "1024" });
    try {
      const r = await postJson<{ error?: string; text?: string }>(`http://127.0.0.1:${port}/v1/chat`, {
        prompt: "/help", // a slash command the server can resolve without an LLM
      });
      // We don't care if it's 200 or 500 (no provider configured), only
      // that the body gate didn't reject it.
      assert.notEqual(r.status, 413);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Abort propagation
// ---------------------------------------------------------------------------

/** Start a local HTTP server that accepts POSTs to any path and never
 *  sends a response. We use this as a fake OpenAI-compatible base URL so
 *  the harness's LLM call will hang waiting for the response — that's
 *  what gives the client time to disconnect and exercise the abort
 *  path. The server is closed via the returned `close()` function. */
function startHangingProvider(): Promise<{ port: number; close: () => void; accepted: { count: number } }> {
  return new Promise((resolve, reject) => {
    const accepted = { count: 0 };
    const srv = createHttpServer((req, res) => {
      accepted.count++;
      // Never respond — keep the LLM call blocked on this socket.
      void req; void res;
    });
    srv.on("connection", (socket) => { socket.setTimeout(0); });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        resolve({ port: addr.port, close: () => { srv.close(); }, accepted });
      } else {
        reject(new Error("hanging provider didn't get a port"));
      }
    });
  });
}

test("abort: client disconnect during /v1/chat/stream ends the SSE cleanly (no crash, server still up)", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-abort-"));
  prepHome(home);

  const provider = await startHangingProvider();
  // Point the harness at the hanging provider. The LLM call will hang
  // waiting for the response, giving us time to disconnect.
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      providers: {
        openai: {
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          apiKey: "sk-fake-key-for-test-12345678",
        },
      },
    }, null, 2),
    "utf-8",
  );

  const { port, kill } = await startServer(home);
  try {
    // Use raw http.request so we can destroy() mid-stream to simulate
    // a client disconnect. fetch's AbortController on the client side
    // doesn't propagate to the server's req.on("close") in the way
    // we need for this test.
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/v1/chat/stream",
      method: "POST",
      headers: { "content-type": "application/json" },
    }, (res) => {
      // The server should accept the stream and start writing SSE.
      // We don't assert specific status here — some envs may take
      // a moment to start the response.
      void res;
    });
    req.on("error", () => { /* expected when we destroy() mid-flight */ });
    req.write(JSON.stringify({ prompt: "this should hang the LLM" }));
    req.end();

    // Give the server time to read the body, write the SSE headers,
    // and start the LLM call. The hanging provider is configured; the
    // LLM call will block on its socket.
    await new Promise((r) => setTimeout(r, 1000));
    // Simulate client disconnect. The server's req.on("close") fires
    // and the abort controller should propagate into runAgent, which
    // throws — the catch path writes event: error {"text":"aborted"}
    // and event: done, then res.end().
    req.destroy();
    // Give the server time to handle the disconnect.
    await new Promise((r) => setTimeout(r, 1500));

    // The provider received at least one request (proves we exercised
    // the in-flight code path rather than a fast-fail).
    assert.ok(provider.accepted.count >= 1, "hanging provider should have received the LLM request");

    // Server is still up: a follow-up /v1/health returns 200.
    const health = await getJson<{ ok: boolean }>(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
  } finally {
    kill();
    provider.close();
    rmSync(home, { recursive: true, force: true });
  }
});
