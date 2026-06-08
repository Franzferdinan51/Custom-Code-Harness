// HTTP endpoint tests for the new first-run support surface:
//   GET  /v1/info
//   GET  /v1/provider/catalog
//   POST /v1/provider/set-key
//
// These are the HTTP analogues of `ch info`, `ch provider list`,
// and `ch provider set-key` — same shape, same validation rules.
// We spawn the actual server in a child process so the tests
// exercise the real wire, not a mock.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Find a free TCP port by opening a listen socket and immediately
 *  closing it. There's a small race window where another process
 *  could grab the port before our server binds, but for these
 *  short-lived test runs that's not a problem in practice. */
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

function startServer(home: string): Promise<{ port: number; proc: ChildProcess; kill: () => void }> {
  return new Promise(async (resolve, reject) => {
    let port = 0;
    try {
      port = await pickFreePort();
    } catch (e) {
      reject(e as Error);
      return;
    }
    const proc = spawn("bun", ["src/cli.ts", "serve", "--no-open", "--port", String(port)], {
      env: { ...process.env, CODINGHARNESS_HOME: home, NO_COLOR: "1" },
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
        resolve({ port, proc, kill: () => proc.kill("SIGTERM") });
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

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  const body = await res.json() as T;
  return { status: res.status, body };
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json() as T;
  return { status: res.status, body: j };
}

test("/v1/info returns a runtime snapshot with version, paths, provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-info-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ version: string; node: string; home: string; paths: { settings: string }; defaultProvider: string | null; defaultModel: string | null }>(`http://127.0.0.1:${port}/v1/info`);
      assert.equal(r.status, 200);
      assert.match(r.body.version, /^\d+\.\d+\.\d+$/);
      assert.match(r.body.node, /^v\d+\.\d+\.\d+$/);
      assert.equal(r.body.home, home);
      assert.match(r.body.paths.settings, /settings\.json$/);
      assert.ok(r.body.defaultProvider !== undefined);
      assert.ok(r.body.defaultModel !== undefined);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/v1/provider/catalog lists all built-in providers with auth modes", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-cat-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{
        providers: Array<{ id: string; tier: string; label: string; authModes: string[]; defaultAuthMode: string; defaultModel: string; apiKeyEnv: string[] }>;
        groups: { primary: string[]; hosted: string[]; local: string[] };
      }>(`http://127.0.0.1:${port}/v1/provider/catalog`);
      assert.equal(r.status, 200);
      assert.equal(r.body.providers[0]?.id, "lmstudio");
      assert.equal(r.body.providers[0]?.tier, "primary");
      assert.deepEqual(r.body.groups.primary, ["lmstudio"]);
      assert.deepEqual(r.body.groups.hosted, ["openai", "grok", "minimax", "codex", "anthropic", "xai"]);
      assert.deepEqual(r.body.groups.local, ["vllm", "vllm-omni"]);
      const ids = r.body.providers.map((p) => p.id);
      for (const want of ["openai", "grok", "minimax", "anthropic", "xai", "lmstudio", "vllm", "vllm-omni", "codex"]) {
        assert.ok(ids.includes(want), "catalog missing " + want);
      }
      const openai = r.body.providers.find((p) => p.id === "openai");
      assert.ok(openai);
      assert.ok(openai.authModes.includes("apiKey"));
      assert.ok(openai.apiKeyEnv.includes("OPENAI_API_KEY"));
      // codex now also supports oauth (token-paste) and vllm/vllm-omni
      // use optional auth (no key required for local servers).
      const codex = r.body.providers.find((p) => p.id === "codex");
      assert.ok(codex);
      assert.ok(codex.authModes.includes("oauth"));
      const omni = r.body.providers.find((p) => p.id === "vllm-omni");
      assert.ok(omni);
      assert.ok(omni.authModes.includes("optional"));
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/v1/provider/models returns an empty list when the server is unreachable", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-models-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      // No provider configured; default provider is undefined.
      const r = await getJson<{ id: string; models: string[]; error?: string }>(
        `http://127.0.0.1:${port}/v1/provider/models`
      );
      assert.equal(r.status, 200);
      // Either no default provider (id="") or an error string — never a
      // thrown 500. The listModels path swallows network errors.
      assert.ok(Array.isArray(r.body.models));
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/v1/provider/set-key rejects empty / too-short keys with 400", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-setkey-bad-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await postJson<{ error?: string }>(`http://127.0.0.1:${port}/v1/provider/set-key`, {
        provider: "openai",
        apiKey: "abc", // way too short
      });
      assert.equal(r.status, 400);
      assert.match(r.body.error ?? "", /too short/);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/v1/provider/set-key rejects missing fields with 400", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-setkey-missing-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await postJson<{ error?: string }>(`http://127.0.0.1:${port}/v1/provider/set-key`, {
        provider: "openai",
        // no apiKey
      });
      assert.equal(r.status, 400);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/v1/provider/set-key saves the key and reports provider/model", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-setkey-ok-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      // We don't have a real API key, but saveProviderApiKey only
      // checks length — it does NOT call the provider. The diag
      // call is best-effort and will fail (no network), but the
      // save itself should succeed and the response should report
      // the chosen default model.
      const r = await postJson<{ ok: boolean; provider: string; model: string | null; diag: { ok: boolean; error?: string } }>(`http://127.0.0.1:${port}/v1/provider/set-key`, {
        provider: "openai",
        apiKey: "sk-fake-test-key-12345678",
        model: "gpt-4o",
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.provider, "openai");
      assert.equal(r.body.model, "gpt-4o");
      // The diag call will fail (no key) but the response should
      // still be 200 because the save succeeded.
      assert.equal(r.body.diag.ok, false);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/v1/provider/set-key is unknown-provider safe", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-setkey-unknown-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await postJson<{ error?: string }>(`http://127.0.0.1:${port}/v1/provider/set-key`, {
        provider: "no-such-provider-12345",
        apiKey: "sk-fake-test-key-12345678",
      });
      assert.equal(r.status, 400);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/v1/todo GET returns an empty list on a fresh runtime", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-todo-get-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ items: string[] }>(`http://127.0.0.1:${port}/v1/todo`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.items, []);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/v1/todo POST with { items } replaces the list", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-todo-set-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await postJson<{ ok: boolean; items: string[] }>(`http://127.0.0.1:${port}/v1/todo`, {
        items: ["alpha", "beta two", "gamma"],
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.items, ["alpha", "beta two", "gamma"]);
      // GET should return the same list.
      const r2 = await getJson<{ items: string[] }>(`http://127.0.0.1:${port}/v1/todo`);
      assert.deepEqual(r2.body.items, ["alpha", "beta two", "gamma"]);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/v1/todo POST with { action: add, item } appends", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-todo-add-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      await postJson(`http://127.0.0.1:${port}/v1/todo`, { items: ["first"] });
      const r = await postJson<{ ok: boolean; items: string[] }>(`http://127.0.0.1:${port}/v1/todo`, {
        action: "add", item: "second",
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.items, ["first", "second"]);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/v1/todo POST with { action: clear } empties the list", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-todo-clear-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      await postJson(`http://127.0.0.1:${port}/v1/todo`, { items: ["a", "b", "c"] });
      const r = await postJson<{ ok: boolean; items: string[] }>(`http://127.0.0.1:${port}/v1/todo`, { action: "clear" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.items, []);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("/v1/todo POST rejects missing fields with 400", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-todo-bad-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await postJson<{ error?: string }>(`http://127.0.0.1:${port}/v1/todo`, {});
      assert.equal(r.status, 400);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
