// Endpoint expansion for the HTTP API exposed by `ch serve`.
//
// Pinned contract for external programs (MCP clients, dashboards,
// scripts) so the new endpoints can be relied on:
//   1. GET  /v1/                 — discovery index generated from a
//                                  single ROUTES table; every actual
//                                  handler in src/server.ts appears
//                                  in the index.
//   2. POST /v1/delegations      — submit a delegation (kind =
//                                  agent | goal | async-tool | mcp |
//                                  plugin | api | human-approval |
//                                  workflow). Returns the first 4
//                                  fields of the handle; for
//                                  `human-approval`, awaits the
//                                  decision and returns
//                                  `{ approved: boolean }`.
//   3. GET  /v1/delegations/:id  — single delegation metadata
//                                  (404 if unknown).
//   4. GET  /v1/agents/:id       — single agent definition (404 if
//                                  unknown).
//   5. GET  /v1/skills/:id       — single skill incl. full SKILL.md
//                                  body (404 if unknown).
//   6. GET  /v1/sessions/:id     — session metadata (404 if unknown).
//   7. GET  /v1/sessions/:id/messages
//                                — { messages: { role, content,
//                                  timestamp? }[] } from the
//                                  transcript (404 if unknown).
//   8. GET  /v1/loops            — list active + recent loops
//                                  (delegations + sub-agents).
//   9. GET  /v1/loops/:id        — single loop metadata; goal kind
//                                  includes the GoalRecord summary.
//  10. DELETE /v1/chat/stream/:id — aborts an in-flight SSE stream
//                                  (404 if id unknown).
//  11. Auth — every new endpoint honors the bearer-token gate
//      (CH_HTTP_TOKEN); 401 paths are covered for at least 3 of
//      the new endpoints.
//
// Each test spawns the real `ch serve` subprocess on a free port and
// drives it with `fetch` + raw `http.request` — same wire the external
// programs use. Test isolation: every test gets its own tmpdir under
// CODINGHARNESS_HOME so settings / sessions / goals / logs don't
// bleed.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { readFileSync } from "node:fs";

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
 *  CODINGHARNESS_HOME. Mirrors the AGENTS.md pattern + the
 *  `server-hardening.test.ts` setup. */
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

async function delJson<T>(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { method: "DELETE", headers });
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

/** Spin up a local HTTP server that accepts any POST and never
 *  responds. We point the harness's default provider at it so the
 *  LLM call hangs waiting for the response — that's what gives the
 *  test time to fire `DELETE /v1/chat/stream/:id` against the
 *  server and assert the abort propagates. */
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

/** Build a settings.json that points the harness at the supplied
 *  (hanging) provider. Used by the abort test. */
function writeHangingProviderSettings(home: string, port: number): void {
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      providers: {
        openai: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "sk-fake-key-for-test-12345678",
        },
      },
    }, null, 2),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// GET /v1/ — discovery index
// ---------------------------------------------------------------------------

test("index: GET /v1/ returns the ROUTES table with name, version, and endpoints[]", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-index-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ name: string; version: string; endpoints: Array<{ method: string; path: string; description: string; auth: string }> }>(
        `http://127.0.0.1:${port}/v1/`,
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.name, "codingharness");
      assert.equal(r.body.version, "0.2.2");
      assert.ok(Array.isArray(r.body.endpoints));
      assert.ok(r.body.endpoints.length > 10, "index should list many endpoints");
      // Every entry has the 4 documented fields.
      for (const ep of r.body.endpoints) {
        assert.ok(typeof ep.method === "string" && ep.method.length > 0, "method missing on " + JSON.stringify(ep));
        assert.ok(typeof ep.path === "string" && ep.path.length > 0, "path missing on " + JSON.stringify(ep));
        assert.ok(typeof ep.description === "string", "description missing on " + JSON.stringify(ep));
        assert.ok(ep.auth === "required" || ep.auth === "none", "auth must be 'required' or 'none' on " + JSON.stringify(ep));
      }
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("index: /v1/ lists every handler in src/server.ts (no drift)", async () => {
  // Cross-check: read the source file, extract every
  // `if (req.method === "X" && path === "Y")` and the path-matcher
  // variants (`agentIdPath(path)` etc.), and assert each appears
  // in the index's endpoints[]. This is the contract test: a new
  // handler added without a ROUTES entry fails the build.
  const home = mkdtempSync(join(tmpdir(), "ch-index-drift-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ endpoints: Array<{ method: string; path: string }> }>(`http://127.0.0.1:${port}/v1/`);
      assert.equal(r.status, 200);
      // Build a fast lookup of "method path" pairs from the index.
      const indexed = new Set(r.body.endpoints.map((e) => e.method + " " + e.path));

      // Read the server source.
      const src = readFileSync(join(import.meta.dirname, "..", "server.ts"), "utf-8");
      // 1. Literal `if (req.method === "X" && path === "Y")` handlers.
      const literalRe = /if \(req\.method === "(GET|POST|DELETE|PUT|PATCH)" && path === "([^"]+)"\)/g;
      const literalEntries: Array<{ method: string; path: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = literalRe.exec(src))) {
        literalEntries.push({ method: m[1]!, path: m[2]! });
      }
      // 2. Path-matcher handlers — `agentIdPath(path)`, `skillIdPath`,
      // `sessionIdPath`, `sessionsMessagesPath`, `delegationIdPath`,
      // `loopIdPath`, `streamIdPath`. The route they map to is the
      // corresponding `/v1/...` literal, which is also listed in
      // ROUTES with the `:id` placeholder.
      const matcherEntries: Array<{ method: string; path: string; matcher: string }> = [
        { method: "GET",    path: "/v1/agents/:id",            matcher: "agentIdPath" },
        { method: "GET",    path: "/v1/skills/:id",            matcher: "skillIdPath" },
        { method: "GET",    path: "/v1/sessions/:id",          matcher: "sessionIdPath" },
        { method: "GET",    path: "/v1/sessions/:id/messages", matcher: "sessionsMessagesPath" },
        { method: "GET",    path: "/v1/delegations/:id",       matcher: "delegationIdPath" },
        { method: "GET",    path: "/v1/loops/:id",             matcher: "loopIdPath" },
        { method: "DELETE", path: "/v1/chat/stream/:id",       matcher: "streamIdPath" },
      ];
      const foundMatchers = new Set<string>();
      for (const entry of matcherEntries) {
        if (src.includes(entry.matcher + "(path)")) foundMatchers.add(entry.path);
      }

      // 3. The special-cased `path === "/v1/"` and `path === "/v1/health"`
      // handlers bypass the literal regex (they use a literal check
      // before the auth gate). They MUST still be in the index.
      const specialRoutes = [
        { method: "GET", path: "/v1/" },
        { method: "GET", path: "/v1/health" },
      ];

      // Assert every literal entry appears in the index.
      for (const entry of literalEntries) {
        // Some paths are wildcards in the routes table (e.g.
        // OPTIONS /* is in the table as /*; the index lists it
        // with the wildcard path). Match the literal source path
        // against the indexed path, allowing the table to use
        // wildcards.
        const ok = indexed.has(entry.method + " " + entry.path)
          || [...indexed].some((k) => k === entry.method + " " + entry.path);
        assert.ok(ok, "literal handler " + entry.method + " " + entry.path + " missing from /v1/ index; index has " + [...indexed].slice(0, 30).join(", ") + " …");
      }
      // Every matcher handler must have a corresponding route in
      // the index (the path uses `:id` in the table, the matcher
      // resolves to a real id at runtime).
      for (const entry of matcherEntries) {
        if (foundMatchers.has(entry.path)) {
          assert.ok(indexed.has(entry.method + " " + entry.path),
            "matcher handler " + entry.method + " " + entry.path + " (" + entry.matcher + ") is wired in server.ts but missing from /v1/ index");
        }
      }
      // Special-cased routes are also asserted.
      for (const s of specialRoutes) {
        assert.ok(indexed.has(s.method + " " + s.path), "special handler " + s.method + " " + s.path + " missing from /v1/ index");
      }
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("index: /v1/ marks the new discovery endpoint as auth: none", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-index-auth-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ endpoints: Array<{ method: string; path: string; auth: string }> }>(`http://127.0.0.1:${port}/v1/`);
      const index = r.body.endpoints.find((e) => e.method === "GET" && e.path === "/v1/");
      assert.ok(index, "index endpoint must list itself");
      assert.equal(index!.auth, "none");
      const health = r.body.endpoints.find((e) => e.method === "GET" && e.path === "/v1/health");
      assert.ok(health, "health endpoint must be in the index");
      assert.equal(health!.auth, "none");
      const opts = r.body.endpoints.find((e) => e.method === "OPTIONS");
      assert.ok(opts, "OPTIONS preflight must be in the index");
      assert.equal(opts!.auth, "none");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// POST /v1/delegations
// ---------------------------------------------------------------------------

test("delegations: POST /v1/delegations with kind: goal creates a goal in the store", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-deleg-goal-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await postJson<{ id: string; status: string; kind: string; parentId?: string }>(
        `http://127.0.0.1:${port}/v1/delegations`,
        { kind: "goal", objective: "demo objective for the test" },
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.kind, "goal");
      assert.ok(typeof r.body.id === "string" && r.body.id.length > 0, "id must be a non-empty string");
      assert.ok(["queued", "running", "completed", "failed", "cancelled"].includes(r.body.status), "status must be a valid DelegationStatus");

      // The goal should be observable in /v1/goals. The runtime
      // adds it synchronously to the store before the state
      // machine runs, so it's visible almost immediately. Poll
      // briefly to absorb the microtask scheduling delay.
      let goalFound = false;
      for (let i = 0; i < 20; i++) {
        const goals = await getJson<{ goals: Array<{ id: string; objective: string }> }>(`http://127.0.0.1:${port}/v1/goals`);
        if (goals.body.goals.some((g) => g.objective === "demo objective for the test")) {
          goalFound = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(goalFound, "goal with the submitted objective should be visible via /v1/goals after POST");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("delegations: POST /v1/delegations with kind: agent returns the handle shape", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-deleg-agent-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      // We use a known built-in agent name. The sub-agent will
      // fail to spawn (no provider configured), but the handle
      // is returned synchronously and that's all we assert here.
      const r = await postJson<{ id: string; status: string; kind: string; parentId?: string }>(
        `http://127.0.0.1:${port}/v1/delegations`,
        { kind: "agent", agent: "explore", prompt: "demo prompt" },
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.kind, "agent");
      assert.ok(typeof r.body.id === "string" && r.body.id.length > 0);
      assert.ok(["queued", "running", "completed", "failed", "cancelled"].includes(r.body.status));
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("delegations: POST /v1/delegations with missing kind returns 400", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-deleg-bad-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await postJson<{ error: string }>(
        `http://127.0.0.1:${port}/v1/delegations`,
        { objective: "no kind here" },
      );
      assert.equal(r.status, 400);
      assert.match(r.body.error, /kind/);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// GET /v1/delegations/:id
// ---------------------------------------------------------------------------

test("delegations: GET /v1/delegations/:id returns metadata for a known id", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-deleg-show-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const submit = await postJson<{ id: string; kind: string }>(
        `http://127.0.0.1:${port}/v1/delegations`,
        { kind: "agent", agent: "explore", prompt: "show me later" },
      );
      assert.equal(submit.status, 200);
      const id = submit.body.id;
      const show = await getJson<{ id: string; kind: string; status: string; parentId?: string; parentChain: Array<unknown> }>(
        `http://127.0.0.1:${port}/v1/delegations/${encodeURIComponent(id)}`,
      );
      assert.equal(show.status, 200);
      assert.equal(show.body.id, id);
      assert.equal(show.body.kind, "agent");
      assert.ok(Array.isArray(show.body.parentChain));
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("delegations: GET /v1/delegations/:id returns 404 for an unknown id", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-deleg-404-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ error: string }>(`http://127.0.0.1:${port}/v1/delegations/del-nonexistent-xyz`);
      assert.equal(r.status, 404);
      assert.match(r.body.error, /not found/i);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// GET /v1/agents/:id and /v1/skills/:id
// ---------------------------------------------------------------------------

test("agents: GET /v1/agents/:id returns the built-in agent definition", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-agents-show-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ name: string; description: string; tools?: string[] }>(
        `http://127.0.0.1:${port}/v1/agents/explore`,
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.name, "explore");
      assert.ok(typeof r.body.description === "string" && r.body.description.length > 0, "description must be non-empty");
      assert.ok(Array.isArray(r.body.tools), "tools should be an array");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("agents: GET /v1/agents/:id returns 404 for an unknown agent", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-agents-404-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ error: string }>(`http://127.0.0.1:${port}/v1/agents/no-such-agent-xyz`);
      assert.equal(r.status, 404);
      assert.match(r.body.error, /not found/i);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("skills: GET /v1/skills/:id returns 404 for an unknown skill", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-skills-404-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ error: string }>(`http://127.0.0.1:${port}/v1/skills/no-such-skill-xyz`);
      assert.equal(r.status, 404);
      assert.match(r.body.error, /not found/i);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// GET /v1/sessions/:id and /v1/sessions/:id/messages
// ---------------------------------------------------------------------------

/** Plant a session file on disk in the test's $CH_HOME so the server
 *  can open it via `Session.open(id)`. The session has empty entries
 *  but a valid meta sidecar (the format `Session.persistMeta` writes).
 *  Returns the session id. */
function plantSession(home: string, id: string): void {
  const sessionsDir = join(home, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  // Empty JSONL transcript.
  writeFileSync(join(sessionsDir, `${id}.jsonl`), "", "utf-8");
  // Meta sidecar.
  const now = Date.now();
  writeFileSync(
    join(sessionsDir, `${id}.jsonl.meta.json`),
    JSON.stringify({
      id,
      createdAt: now,
      updatedAt: now,
      entryCount: 0,
      head: null,
    }, null, 2),
    "utf-8",
  );
}

test("sessions: GET /v1/sessions/:id round-trips a planted session", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-sessions-show-"));
  prepHome(home);
  const sid = "test-session-" + Math.random().toString(36).slice(2, 8);
  plantSession(home, sid);
  try {
    const { port, kill } = await startServer(home);
    try {
      const show = await getJson<{ session: { id: string; createdAt: number; entryCount: number } }>(
        `http://127.0.0.1:${port}/v1/sessions/${encodeURIComponent(sid)}`,
      );
      assert.equal(show.status, 200);
      assert.equal(show.body.session.id, sid);
      assert.ok(typeof show.body.session.createdAt === "number");
      assert.equal(show.body.session.entryCount, 0);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("sessions: GET /v1/sessions/:id/messages returns { messages: [] } for an empty session", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-sessions-msgs-"));
  prepHome(home);
  const sid = "test-session-msgs-" + Math.random().toString(36).slice(2, 8);
  plantSession(home, sid);
  try {
    const { port, kill } = await startServer(home);
    try {
      const msgs = await getJson<{ messages: Array<{ role: string; content: string; timestamp?: number }> }>(
        `http://127.0.0.1:${port}/v1/sessions/${encodeURIComponent(sid)}/messages`,
      );
      assert.equal(msgs.status, 200);
      assert.ok(Array.isArray(msgs.body.messages));
      // Empty session — no messages.
      assert.equal(msgs.body.messages.length, 0);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("sessions: GET /v1/sessions/:id returns 404 for an unknown id", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-sessions-404-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ error: string }>(`http://127.0.0.1:${port}/v1/sessions/no-such-session-xyz`);
      assert.equal(r.status, 404);
      assert.match(r.body.error, /not found/i);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// GET /v1/loops and /v1/loops/:id
// ---------------------------------------------------------------------------

test("loops: GET /v1/loops returns a list including a freshly-submitted delegation", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-loops-list-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      // Submit a delegation so there's at least one loop in the
      // list. (The handle is in the manager's runs map
      // synchronously after submit() returns.)
      const submit = await postJson<{ id: string }>(
        `http://127.0.0.1:${port}/v1/delegations`,
        { kind: "agent", agent: "explore", prompt: "for the loops list" },
      );
      const submittedId = submit.body.id;

      const list = await getJson<{ loops: Array<{ id: string; source: string; kind: string; status: string }> }>(
        `http://127.0.0.1:${port}/v1/loops`,
      );
      assert.equal(list.status, 200);
      assert.ok(Array.isArray(list.body.loops));
      const found = list.body.loops.find((l) => l.id === submittedId);
      assert.ok(found, "submitted delegation should appear in /v1/loops");
      assert.equal(found!.source, "delegation");
      assert.equal(found!.kind, "agent");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("loops: GET /v1/loops/:id returns the delegation's metadata", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-loops-show-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const submit = await postJson<{ id: string }>(
        `http://127.0.0.1:${port}/v1/delegations`,
        { kind: "agent", agent: "explore", prompt: "show me via loops" },
      );
      const id = submit.body.id;
      const show = await getJson<{ id: string; source: string; kind: string; status: string }>(
        `http://127.0.0.1:${port}/v1/loops/${encodeURIComponent(id)}`,
      );
      assert.equal(show.status, 200);
      assert.equal(show.body.id, id);
      assert.equal(show.body.source, "delegation");
      assert.equal(show.body.kind, "agent");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("loops: GET /v1/loops/:id returns 404 for an unknown id", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-loops-404-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ error: string }>(`http://127.0.0.1:${port}/v1/loops/no-such-loop-xyz`);
      assert.equal(r.status, 404);
      assert.match(r.body.error, /not found/i);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// DELETE /v1/chat/stream/:id — cancellation
// ---------------------------------------------------------------------------

test("stream: DELETE /v1/chat/stream/:id aborts a running stream cleanly", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-stream-cancel-"));
  prepHome(home);

  const provider = await startHangingProvider();
  writeHangingProviderSettings(home, provider.port);

  const { port, kill } = await startServer(home);
  try {
    // Use raw http.request so we can read SSE events line-by-line
    // and detect the `stream_id` event.
    let streamId: string | null = null;
    const sseData: string[] = [];
    let doneResolve: (v: void) => void = () => {};
    const donePromise = new Promise<void>((resolve) => { doneResolve = resolve; });

    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/v1/chat/stream",
      method: "POST",
      headers: { "content-type": "application/json" },
    }, (res: IncomingMessage) => {
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        sseData.push(chunk);
        // SSE event blocks are separated by blank lines. Look for
        // the `event: stream_id` block in the buffer.
        const buf = sseData.join("");
        const m = buf.match(/event: stream_id\ndata: (\{[^\n]*\})/);
        if (m && !streamId) {
          try {
            const payload = JSON.parse(m[1]!);
            if (typeof payload.id === "string") streamId = payload.id;
          } catch { /* ignore parse error */ }
        }
        // Once we see the `done` event, the stream has ended.
        if (buf.includes("event: done")) doneResolve();
      });
      res.on("end", () => doneResolve());
      res.on("close", () => doneResolve());
    });
    req.on("error", () => { /* expected when we destroy or when the server closes */ });
    req.write(JSON.stringify({ prompt: "this hangs the LLM" }));
    req.end();

    // Wait until the server has emitted the stream_id event.
    for (let i = 0; i < 50 && !streamId; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(streamId, "server should emit a stream_id event before the model produces text");

    // Fire the DELETE. The server should abort the stream and
    // return 200.
    const del = await delJson<{ ok: boolean; id: string; aborted: boolean }>(
      `http://127.0.0.1:${port}/v1/chat/stream/${encodeURIComponent(streamId!)}`,
    );
    assert.equal(del.status, 200);
    assert.equal(del.body.ok, true);
    assert.equal(del.body.aborted, true);
    assert.equal(del.body.id, streamId);

    // The server should write event: error {"text":"aborted"} and
    // event: done, then close the stream. Wait for the done event
    // (or a small timeout).
    await Promise.race([
      donePromise,
      new Promise<void>((r) => setTimeout(r, 2000)),
    ]);

    // The provider received at least one request — proves we
    // exercised the in-flight code path.
    assert.ok(provider.accepted.count >= 1, "hanging provider should have received the LLM request");

    // Server is still up: a follow-up /v1/health returns 200.
    const health = await getJson<{ ok: boolean }>(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    // The unknown-id DELETE returns 404 (the id was cleaned up
    // when the stream ended).
    const notFound = await delJson<{ error: string }>(
      `http://127.0.0.1:${port}/v1/chat/stream/${encodeURIComponent(streamId!)}`,
    );
    assert.equal(notFound.status, 404);
    assert.match(notFound.body.error, /not found/i);
  } finally {
    kill();
    provider.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Auth — 401 paths for the new endpoints
// ---------------------------------------------------------------------------

test("auth: 401 on POST /v1/delegations when CH_HTTP_TOKEN is set and no token is sent", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-auth-deleg-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home, { CH_HTTP_TOKEN: "secret-token-deleg" });
    try {
      const r = await postJson<{ error: string }>(
        `http://127.0.0.1:${port}/v1/delegations`,
        { kind: "agent", agent: "explore", prompt: "x" },
      );
      assert.equal(r.status, 401);
      assert.equal(r.body.error, "unauthorized");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("auth: 401 on GET /v1/agents/:id when CH_HTTP_TOKEN is set and no token is sent", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-auth-agents-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home, { CH_HTTP_TOKEN: "secret-token-agents" });
    try {
      const r = await getJson<{ error: string }>(`http://127.0.0.1:${port}/v1/agents/explore`);
      assert.equal(r.status, 401);
      assert.equal(r.body.error, "unauthorized");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("auth: 401 on GET /v1/loops when CH_HTTP_TOKEN is set and no token is sent", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-auth-loops-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home, { CH_HTTP_TOKEN: "secret-token-loops" });
    try {
      const r = await getJson<{ error: string }>(`http://127.0.0.1:${port}/v1/loops`);
      assert.equal(r.status, 401);
      assert.equal(r.body.error, "unauthorized");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("auth: 401 on DELETE /v1/chat/stream/:id when CH_HTTP_TOKEN is set and no token is sent", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-auth-stream-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home, { CH_HTTP_TOKEN: "secret-token-stream" });
    try {
      const r = await delJson<{ error: string }>(`http://127.0.0.1:${port}/v1/chat/stream/any-id`);
      assert.equal(r.status, 401);
      assert.equal(r.body.error, "unauthorized");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Error shape consistency — all JSON endpoints use { error: string }
// ---------------------------------------------------------------------------

test("error shape: 404 from a non-existent route returns { error: string }", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-err-404-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ error: string }>(`http://127.0.0.1:${port}/v1/no-such-route`);
      assert.equal(r.status, 404);
      assert.equal(typeof r.body.error, "string");
      assert.ok(r.body.error.length > 0);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("error shape: 401 from auth gate returns { error: 'unauthorized' } on the new endpoints", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-err-401-"));
  prepHome(home);
  try {
    const { port, kill } = await startServer(home, { CH_HTTP_TOKEN: "secret-token-err" });
    try {
      // /v1/delegations/<id> — should be 404 unauth + 401 with auth
      // required and no token. 401 takes precedence.
      const r = await getJson<{ error: string }>(`http://127.0.0.1:${port}/v1/delegations/some-id`);
      assert.equal(r.status, 401);
      assert.equal(typeof r.body.error, "string");
      assert.equal(r.body.error, "unauthorized");
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
