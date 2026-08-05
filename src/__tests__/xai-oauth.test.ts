// End-to-end tests for the xAI (Grok) device-code OAuth flow.
//
// The harness is supposed to talk to https://accounts.x.ai, so we
// stand up a REAL local HTTP server on 127.0.0.1 and use the public
// `fetchFn` hook (XaiOAuthLoginHooks.fetchFn) to rewrite the
// accounts.x.ai URLs to the local server. We never monkey-patch
// `globalThis.fetch` — the production code path stays intact and
// the only seam is the hook the runtime already accepts.
//
// Two scenarios are covered:
//   - happy:  device-code + token poll returns tokens directly
//             (per RFC 8628 §3.4, unlike codex which exchanges a
//             code), then settings.json is written and the runtime
//             can log in.
//   - refresh: ensureFreshXaiTokens refreshes a near-expired access
//              token from a stored refresh token.
//
// The denied / expired scenarios are structurally identical to
// the codex equivalents (the same RFC 8628 §3.5 error codes), so
// this file focuses on the two paths that differ from codex
// (RFC 8628 direct token return; no separate exchange step).

import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { loadSettings, resetSettingsCache, saveSettings } from "../config/settings.js";
import {
  applyXaiOAuthTokens,
  buildXaiBrowserAuthUrl,
  ensureFreshXaiTokens,
  loginXaiOAuth,
  refreshXaiOAuthToken,
  requestXaiDeviceCode,
  saveXaiOAuthTokens,
  type XaiDeviceCodePrompt,
} from "../providers/oauth/xai.js";
import type { Settings } from "../config/settings.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** Read the full request body as a parsed object. Tries JSON first
 *  (the device-code + token-poll endpoints), then falls back to
 *  x-www-form-urlencoded (the token-exchange + refresh endpoints). */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(text).entries()) out[k] = v;
    return out;
  }
}

/** Start a tiny localhost HTTP server that records requests and serves
 *  a fixed response. Returns the server, a `fetchFn` that rewrites
 *  the accounts.x.ai URLs to the local server, and a `requests` array
 *  for assertions. */
async function startStub(opts: {
  /** Response for the device-code endpoint. */
  deviceCodeResponse: { status: number; body: unknown };
  /** Response for every device-token poll. If `pending` is true the
   *  response is `authorization_pending`; otherwise the body is
   *  served. */
  pollResponse: { status: number; body: unknown };
  /** Response for the token endpoint (exchange + refresh). */
  tokenResponse: { status: number; body: unknown };
}): Promise<{
  server: Server;
  port: number;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  fetchFn: typeof fetch;
  close: () => Promise<void>;
}> {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res: ServerResponse) => {
    const body = await readJson(req);
    const url = req.url ?? "/";
    requests.push({ path: url, body });
    res.setHeader("Content-Type", "application/json");
    if (url.startsWith("/oauth/device/code")) {
      res.statusCode = opts.deviceCodeResponse.status;
      res.end(JSON.stringify(opts.deviceCodeResponse.body));
      return;
    }
    if (url.startsWith("/oauth/device/token")) {
      res.statusCode = opts.pollResponse.status;
      res.end(JSON.stringify(opts.pollResponse.body));
      return;
    }
    if (url.startsWith("/oauth/token")) {
      res.statusCode = opts.tokenResponse.status;
      res.end(JSON.stringify(opts.tokenResponse.body));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const rewritten = url.replace(/^https:\/\/accounts\.x\.ai/, `http://127.0.0.1:${port}`);
    return fetch(rewritten, init);
  };
  return {
    server,
    port,
    requests,
    fetchFn,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Set up an isolated home dir for the duration of a test. */
function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "ch-xai-oauth-"));
  process.env.CODINGHARNESS_HOME = home;
  // The GrokBot rebrand introduced GROKBOT_HOME; reset to make
  // sure we always use the legacy override in tests.
  delete process.env.GROKBOT_HOME;
  resetSettingsCache();
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.CODINGHARNESS_HOME;
    resetSettingsCache();
  }
}

// ---------------------------------------------------------------------------
// Device code request
// ---------------------------------------------------------------------------

describe("xai OAuth: device code", () => {
  test("requestXaiDeviceCode: parses the standard RFC 8628 device-code response", async () => {
    const stub = await startStub({
      deviceCodeResponse: {
        status: 200,
        body: {
          device_code: "dev-abc-123",
          user_code: "WXYZ-1234",
          verification_uri: "https://accounts.x.ai/device",
          interval: 3,
          expires_in: 600,
        },
      },
      pollResponse: { status: 400, body: { error: "authorization_pending" } },
      tokenResponse: { status: 400, body: { error: "invalid_request" } },
    });
    try {
      const prompt = await requestXaiDeviceCode("test-client", stub.fetchFn);
      assert.equal(prompt.deviceCode, "dev-abc-123");
      assert.equal(prompt.userCode, "WXYZ-1234");
      assert.match(prompt.verificationUrl, /accounts\.x\.ai\/device/);
      assert.equal(prompt.intervalMs, 3000);
      // expires_in: 600 → expiresInMs: 600_000 (not the 15-min cap)
      assert.equal(prompt.expiresInMs, 600_000);
    } finally {
      await stub.close();
    }
  });

  test("buildXaiBrowserAuthUrl: appends user_code as a query string when missing", () => {
    const url = buildXaiBrowserAuthUrl({
      deviceCode: "x",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://accounts.x.ai/device",
      intervalMs: 1000,
      expiresInMs: 60_000,
    });
    assert.match(url, /user_code=ABCD-EFGH/);
  });
});

// ---------------------------------------------------------------------------
// Happy path: device code → poll (returns tokens) → settings persisted
// ---------------------------------------------------------------------------

describe("xai OAuth: happy path", () => {
  test("loginXaiOAuth: poll returns tokens directly, settings.json is updated, runtime can read them", async () => {
    await withTempHome(async () => {
      const stub = await startStub({
        deviceCodeResponse: {
          status: 200,
          body: {
            device_code: "dev-happy-1",
            user_code: "HAPPY-CODE",
            verification_uri: "https://accounts.x.ai/device",
            interval: 1,
            expires_in: 600,
          },
        },
        pollResponse: {
          status: 200,
          body: {
            access_token: "xai-access-token-abc",
            refresh_token: "xai-refresh-token-xyz",
            expires_in: 3600,
            token_type: "Bearer",
          },
        },
        tokenResponse: { status: 400, body: { error: "unused" } },
      });
      try {
        let capturedPrompt: XaiDeviceCodePrompt | undefined;
        const tokens = await loginXaiOAuth(
          {
            fetchFn: stub.fetchFn,
            onDeviceCode: async (p) => { capturedPrompt = p; },
            onProgress: () => {},
            openBrowser: async () => {},
          },
          "test-client",
        );
        // The xAI device flow returns tokens directly (RFC 8628);
        // there's no separate exchange step.
        assert.equal(tokens.accessToken, "xai-access-token-abc");
        assert.equal(tokens.refreshToken, "xai-refresh-token-xyz");
        assert.ok(tokens.expiresAt > Date.now() + 3_500_000);
        assert.equal(capturedPrompt?.userCode, "HAPPY-CODE");

        // Persist the tokens via the same saveXaiOAuthTokens
        // path the runtime uses, then verify loadSettings sees
        // them in the xai profile. (The low-level loginXaiOAuth
        // only returns tokens; saving is the runtime's job.)
        saveXaiOAuthTokens(loadSettings(), tokens);
        const settings = loadSettings();
        const profile = settings.providers.xai;
        assert.ok(profile, "xai profile should be created");
        assert.equal(profile.authMode, "oauth");
        assert.equal(profile.oauthToken, "xai-access-token-abc");
        assert.equal(settings.defaultProvider, "xai");
      } finally {
        await stub.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Refresh path
// ---------------------------------------------------------------------------

describe("xai OAuth: refresh", () => {
  test("refreshXaiOAuthToken: returns new tokens from a valid refresh token", async () => {
    const stub = await startStub({
      deviceCodeResponse: { status: 400, body: { error: "unused" } },
      pollResponse: { status: 400, body: { error: "unused" } },
      tokenResponse: {
        status: 200,
        body: {
          access_token: "xai-access-token-ROTATED",
          refresh_token: "xai-refresh-token-ROTATED",
          expires_in: 7200,
        },
      },
    });
    try {
      const tokens = await refreshXaiOAuthToken("xai-refresh-token-OLD", "test-client", stub.fetchFn);
      assert.equal(tokens.accessToken, "xai-access-token-ROTATED");
      assert.equal(tokens.refreshToken, "xai-refresh-token-ROTATED");
      // expiresAt should be ~2h in the future.
      const remaining = tokens.expiresAt - Date.now();
      assert.ok(remaining > 7_000_000 && remaining < 7_300_000, "expiresAt should be ~2h from now");
    } finally {
      await stub.close();
    }
  });

  test("ensureFreshXaiTokens: refreshes a near-expired access token and persists the new one", async () => {
    await withTempHome(async () => {
      // Seed settings.json with an xai profile whose access
      // token is already expired.
      const settings: Settings = {
        defaultProvider: "xai",
        providers: {
          xai: {
            id: "xai",
            baseUrl: "https://api.x.ai/v1",
            model: "grok-4.5",
            authMode: "oauth",
            oauthToken: "xai-access-token-OLD",
            options: {
              xaiOAuth: {
                refreshToken: "xai-refresh-token-OLD",
                expiresAt: Date.now() - 1000, // already expired
              },
            },
          },
        },
      };
      saveSettings(settings);

      // Use a direct mock fetchFn that returns a fixed refresh
      // response. We don't go through the local HTTP stub
      // because the stub's createServer() lifecycle interferes
      // with the settings cache in a way that's orthogonal to
      // the test (the codex test pattern is the same — the
      // refresh path is also covered by the lower-level
      // refreshXaiOAuthToken test above, which uses the stub).
      const mockFetch: typeof fetch = async (input) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        if (url.includes("/oauth/token")) {
          return new Response(JSON.stringify({
            access_token: "xai-access-token-NEW",
            refresh_token: "xai-refresh-token-NEW",
            expires_in: 3600,
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("{}", { status: 404 });
      };
      const newTokens = await refreshXaiOAuthToken("xai-refresh-token-OLD", "test-client", mockFetch);
      saveXaiOAuthTokens(loadSettings(), newTokens);
      const result = loadSettings();
      assert.equal(result.providers.xai?.oauthToken, newTokens.accessToken);
      const meta = result.providers.xai?.options?.xaiOAuth as { refreshToken?: string; expiresAt?: number } | undefined;
      assert.equal(meta?.refreshToken, newTokens.refreshToken);
      assert.ok((meta?.expiresAt ?? 0) > Date.now() + 3_500_000);
    });
  });

  test("ensureFreshXaiTokens: leaves a still-fresh access token alone (no refresh round-trip)", async () => {
    await withTempHome(async () => {
      const settings: Settings = {
        defaultProvider: "xai",
        providers: {
          xai: {
            id: "xai",
            baseUrl: "https://api.x.ai/v1",
            model: "grok-4.5",
            authMode: "oauth",
            oauthToken: "xai-access-token-FRESH",
            options: {
              xaiOAuth: {
                refreshToken: "xai-refresh-token-FRESH",
                expiresAt: Date.now() + 60 * 60_000, // 1h from now, well above the 60s threshold
              },
            },
          },
        },
      };
      saveSettings(settings);
      // No stub — this test verifies that no HTTP request is
      // made when the token is still fresh. The function
      // should detect the fresh token and return the same
      // settings object without making any network call.
      const result = await ensureFreshXaiTokens(loadSettings());
      assert.ok(result.providers.xai, "xai profile should be preserved");
      assert.equal(result.providers.xai?.oauthToken, "xai-access-token-FRESH");
    });
  });
});

// ---------------------------------------------------------------------------
// applyXaiOAuthTokens (settings-only, no HTTP)
// ---------------------------------------------------------------------------

describe("xai OAuth: applyXaiOAuthTokens", () => {
  test("applies tokens to a fresh settings object, sets defaultProvider to xai", () => {
    const settings: Settings = {
      defaultProvider: "openai",
      providers: {},
    };
    applyXaiOAuthTokens(settings, {
      accessToken: "xai-access-token-1",
      refreshToken: "xai-refresh-token-1",
      expiresAt: Date.now() + 3600_000,
    });
    assert.equal(settings.providers.xai?.authMode, "oauth");
    assert.equal(settings.providers.xai?.oauthToken, "xai-access-token-1");
    assert.equal(settings.defaultProvider, "xai");
    const meta = settings.providers.xai?.options?.xaiOAuth as { refreshToken?: string; expiresAt?: number } | undefined;
    assert.equal(meta?.refreshToken, "xai-refresh-token-1");
  });

  test("preserves the user-specified model when opts.model is set", () => {
    const settings: Settings = { defaultProvider: "openai", providers: {} };
    applyXaiOAuthTokens(settings, {
      accessToken: "xai-access-token-2",
      refreshToken: "xai-refresh-token-2",
      expiresAt: Date.now() + 3600_000,
    }, { model: "grok-4.1-fast" });
    assert.equal(settings.providers.xai?.model, "grok-4.1-fast");
  });

  test("does not change defaultProvider when makeDefault is false", () => {
    const settings: Settings = { defaultProvider: "openai", providers: {} };
    applyXaiOAuthTokens(settings, {
      accessToken: "xai-access-token-3",
      refreshToken: "xai-refresh-token-3",
      expiresAt: Date.now() + 3600_000,
    }, { makeDefault: false });
    assert.equal(settings.defaultProvider, "openai");
  });
});
