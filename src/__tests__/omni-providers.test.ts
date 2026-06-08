import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  attachmentToContentPart,
  buildUserContentParts,
  capabilitiesForPreset,
  contentPartsToOpenAI,
  supportsImageOutput,
} from "../providers/omni.js";
import { CodexProvider } from "../providers/codex.js";
import {
  buildCodexBrowserAuthUrl,
  exchangeCodexAuthorizationCode,
  pollCodexDeviceAuthorization,
  refreshCodexOAuthToken,
  requestCodexDeviceCode,
  applyCodexOAuthTokens,
  saveCodexOAuthTokens,
} from "../providers/oauth/codex.js";
import { ProviderRegistry, shouldUseCodexProvider } from "../providers/registry.js";
import { getProviderPreset } from "../providers/presets.js";
import { loadSettings, resetSettingsCache, saveSettings } from "../config/settings.js";
import type { Settings } from "../config/settings.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function mockFetch(handlers: Record<string, (init?: RequestInit) => { status: number; body: unknown }>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) {
      return new Response(JSON.stringify({ error: "unexpected url", url }), { status: 500 });
    }
    const result = handlers[key]!(init);
    return new Response(typeof result.body === "string" ? result.body : JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("capabilitiesForPreset exposes omni flags for vllm-omni and codex", () => {
  const omni = capabilitiesForPreset("vllm-omni");
  assert.equal(omni.omni, true);
  assert.equal(omni.imageOutput, true);
  const codex = capabilitiesForPreset("codex");
  assert.equal(codex.responsesApi, true);
  assert.equal(codex.reasoning, true);
});

test("buildUserContentParts merges text and image attachments", () => {
  const parts = buildUserContentParts("hello", [
    { type: "image", url: "data:image/png;base64,abc", mimeType: "image/png" },
  ]);
  assert.ok(parts);
  assert.equal(parts!.length, 2);
  assert.equal(parts![0]!.type, "text");
  assert.equal(parts![1]!.type, "image_url");
});

test("contentPartsToOpenAI returns multimodal array", () => {
  const out = contentPartsToOpenAI(
    [
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ],
    "fallback",
  );
  assert.ok(Array.isArray(out));
  assert.equal((out as unknown[]).length, 2);
});

test("supportsImageOutput respects capabilities", () => {
  assert.equal(supportsImageOutput({ imageOutput: true }), true);
  assert.equal(supportsImageOutput({ omni: true }), true);
  assert.equal(supportsImageOutput({}), false);
});

test("attachmentToContentPart maps image mime types", () => {
  const part = attachmentToContentPart({ url: "data:image/jpeg;base64,xyz", mimeType: "image/jpeg" });
  assert.ok(part);
  assert.equal(part!.type, "image_url");
});

test("codex preset declares oauth default and capabilities", () => {
  const codex = getProviderPreset("codex");
  assert.ok(codex);
  assert.equal(codex!.defaultAuthMode, "oauth");
  assert.ok(codex!.capabilities?.responsesApi);
  assert.ok(codex!.authModes.includes("oauth"));
});

test("shouldUseCodexProvider routes oauth codex profiles to CodexProvider", () => {
  const profile = {
    id: "codex",
    authMode: "oauth" as const,
    oauthToken: "access-token",
  };
  assert.equal(shouldUseCodexProvider("codex", profile), true);
  assert.equal(shouldUseCodexProvider("codex", { ...profile, authMode: "apiKey", apiKey: "sk-test" }), false);
});

test("provider registry builds CodexProvider for oauth codex profile", async () => {
  const settings: Settings = {
    defaultProvider: "codex",
    defaultModel: "gpt-5.1",
    providers: {
      codex: {
        id: "codex",
        authMode: "oauth",
        oauthToken: "oauth-access-token",
        model: "gpt-5.1",
      },
    },
  };
  const reg = new ProviderRegistry(settings);
  const provider = reg.get("codex");
  assert.ok(provider);
  assert.equal(provider!.constructor.name, "CodexProvider");
  const check = await provider!.isConfigured();
  assert.equal(check.ok, true);
});

test("requestCodexDeviceCode parses user code response", async () => {
  const fetchFn = mockFetch({
    "/api/accounts/deviceauth/usercode": () => ({
      status: 200,
      body: {
        device_auth_id: "dev-1",
        user_code: "ABCD-1234",
        interval: "5",
      },
    }),
  });
  const prompt = await requestCodexDeviceCode(fetchFn);
  assert.equal(prompt.deviceAuthId, "dev-1");
  assert.equal(prompt.userCode, "ABCD-1234");
  assert.match(buildCodexBrowserAuthUrl(prompt), /user_code=ABCD-1234/);
});

test("pollCodexDeviceAuthorization waits then returns exchange code", async () => {
  let calls = 0;
  const fetchFn = mockFetch({
    "/api/accounts/deviceauth/token": () => {
      calls += 1;
      if (calls < 2) return { status: 403, body: { error: "authorization_pending" } };
      return {
        status: 200,
        body: {
          authorization_code: "auth-code",
          code_verifier: "verifier",
        },
      };
    },
  });
  const auth = await pollCodexDeviceAuthorization(
    {
      deviceAuthId: "dev-1",
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
      intervalMs: 1,
      expiresInMs: 5_000,
    },
    fetchFn,
  );
  assert.equal(auth.authorizationCode, "auth-code");
  assert.equal(auth.codeVerifier, "verifier");
  assert.ok(calls >= 2);
});

test("exchangeCodexAuthorizationCode and refreshCodexOAuthToken parse tokens", async () => {
  const fetchFn = mockFetch({
    "/oauth/token": (_init) => {
      const body = String(_init?.body ?? "");
      const grant = body.includes("refresh_token") ? "refresh" : "code";
      return {
        status: 200,
        body: {
          access_token: grant + "-access",
          refresh_token: grant + "-refresh",
          expires_in: 3600,
        },
      };
    },
  });
  const exchanged = await exchangeCodexAuthorizationCode("auth-code", "verifier", fetchFn);
  assert.equal(exchanged.accessToken, "code-access");
  assert.equal(exchanged.refreshToken, "code-refresh");
  const refreshed = await refreshCodexOAuthToken("old-refresh", fetchFn);
  assert.equal(refreshed.accessToken, "refresh-access");
  assert.equal(refreshed.refreshToken, "refresh-refresh");
});

test("applyCodexOAuthTokens and saveCodexOAuthTokens persist oauth profile", () => {
  const settings: Settings = { providers: {} };
  applyCodexOAuthTokens(settings, {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3_600_000,
  }, { makeDefault: false });
  assert.equal(settings.providers.codex?.oauthToken, "access");
  assert.equal(settings.providers.codex?.authMode, "oauth");
  const meta = settings.providers.codex?.options?.codexOAuth as { refreshToken?: string };
  assert.equal(meta.refreshToken, "refresh");

  const prevHome = process.env.CH_HOME;
  const prevCodingHarnessHome = process.env.CODINGHARNESS_HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "ch-omni-test-"));
  process.env.CH_HOME = tempHome;
  process.env.CODINGHARNESS_HOME = tempHome;
  resetSettingsCache();
  try {
    const disk = loadSettings();
    saveCodexOAuthTokens(disk, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3_600_000,
    }, { makeDefault: false });
    resetSettingsCache();
    const reloaded = loadSettings();
    assert.equal(reloaded.providers.codex?.oauthToken, "access");
  } finally {
    if (prevHome === undefined) delete process.env.CH_HOME;
    else process.env.CH_HOME = prevHome;
    if (prevCodingHarnessHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = prevCodingHarnessHome;
    resetSettingsCache();
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("CodexProvider parses responses SSE text and reasoning deltas", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        "event: response.output_text.delta\ndata: {\"delta\":\"hi\"}\n\n" +
        "event: response.reasoning_summary_text.delta\ndata: {\"delta\":\"think\"}\n\n" +
        "event: response.completed\ndata: {\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}\n\n",
      ));
      controller.close();
    },
  });
  const provider = new CodexProvider({
    id: "codex",
    accessToken: "token",
    defaultModel: "gpt-5.1",
  });
  const events: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  try {
    for await (const ev of provider.stream({
      model: "gpt-5.1",
      messages: [{ role: "user", content: "ping" }],
      signal: new AbortController().signal,
    })) {
      events.push(ev.type + (ev.text ? ":" + ev.text : "") + (ev.reasoning ? ":r" + ev.reasoning : ""));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(events.some((e) => e.startsWith("text:hi")));
  assert.ok(events.some((e) => e.startsWith("reasoning:rthink")));
  assert.ok(events.includes("usage"));
  assert.ok(events.includes("done"));
});