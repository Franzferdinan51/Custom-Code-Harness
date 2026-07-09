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
import { OpenAICompatProvider } from "../providers/openai-compat.js";
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

// Regression: OpenAICompatProvider.stream() must flush in-progress tool
// calls when the SSE stream dies mid-flight. Pre-fix, the error catch
// path returned without emitting partialToolCalls, so any deltas seen
// before the break vanished — the caller observed only the {type:"error"}
// event and lost the call entirely.
test("OpenAICompatProvider flushes partial tool calls on stream error", async () => {
  const encoder = new TextEncoder();
  // First chunk starts a tool-call delta with deliberately unclosed
  // args JSON so `looksCompleteJson()` returns false (i.e. no normal
  // `tool_call` event would be emitted by the happy path). The second
  // chunk throws, which propagates into parseSSE's outer catch.
  const stream = new ReadableStream<Uint8Array>({
    // Pull-based: the first read returns the chunk; the second read
    // errors the stream. Using `start()` + `queueMicrotask(error)` would
    // error the stream *before* the consumer's first await resolved,
    // because `await fetch(...)` inside the provider suspends a tick
    // and lets the microtask fire — so the body would already be in
    // an errored state when parseSSE picks it up. Pull is the only
    // way to interleave success → error on separate reads deterministically.
    pull(controller) {
      const first = !stream_first;
      stream_first = true;
      if (first) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"lookup","arguments":"{\\"q\\":\\"o"}}]}}]}\n\n',
        ));
      } else {
        controller.error(new Error("connection reset"));
      }
    },
  });
  let stream_first = false;
  const provider = new OpenAICompatProvider({
    id: "openai",
    baseUrl: "http://127.0.0.1:0/v1",
    apiKey: "sk-test",
    defaultModel: "gpt-5.1",
  });
  const events: Array<{ type: string; toolCall?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  try {
    for await (const ev of provider.stream({
      model: "gpt-5.1",
      messages: [{ role: "user", content: "ping" }],
      signal: new AbortController().signal,
    })) {
      events.push({ type: ev.type, toolCall: ev.toolCall });
    }
  } catch {
    // The provider swallows errors into a {type:"error"} event; if it
    // re-throws here we still want to inspect the partial events below.
  } finally {
    globalThis.fetch = originalFetch;
  }
  const toolCallIdx = events.findIndex((e) => e.type === "tool_call");
  const errorIdx = events.findIndex((e) => e.type === "error");
  assert.notEqual(toolCallIdx, -1, "expected the partial tool call to be flushed before the error event");
  assert.notEqual(errorIdx, -1, "expected the stream to surface an error event");
  assert.ok(toolCallIdx < errorIdx, `tool_call (idx ${toolCallIdx}) must come before error (idx ${errorIdx})`);
  // No final "done" event — the stream died, so consumers must rely on
  // the error event to learn the call aborted.
  assert.equal(events.some((e) => e.type === "done"), false);
});

// Same regression as the OpenAICompat test above, but for the
// Anthropic SSE parser. Anthropic uses `content_block_start`
// (with type:"tool_use") to open a partial tool call and
// `content_block_stop` to flush it. Pre-fix, a stream that
// died mid-tool-call (broken pipe after content_block_start,
// before content_block_stop) silently dropped currentTool —
// the consumer saw only the error event and lost the call.
test("AnthropicProvider flushes in-progress tool calls on stream error", async () => {
  const encoder = new TextEncoder();
  // First read delivers a content_block_start + partial delta.
  // Second read errors the stream — no content_block_stop ever lands.
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled++ === 0) {
        controller.enqueue(encoder.encode(
          'event: content_block_start\n' +
          'data: {"index":0,"content_block":{"type":"tool_use","id":"toolu_test","name":"lookup","input":{}}}\n\n' +
          'event: content_block_delta\n' +
          'data: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"o"}}\n\n',
        ));
      } else {
        controller.error(new Error("connection reset"));
      }
    },
  });
  const { AnthropicProvider } = await import("../providers/anthropic.js");
  const provider = new AnthropicProvider({ apiKey: "sk-test", defaultModel: "claude-sonnet-4-5" });
  const events: Array<{ type: string; toolCall?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  try {
    for await (const ev of provider.stream({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "ping" }],
      signal: new AbortController().signal,
    })) {
      events.push({ type: ev.type, toolCall: ev.toolCall });
    }
  } catch {
    // Provider swallows errors into {type:"error"}; tolerate throws too.
  } finally {
    globalThis.fetch = originalFetch;
  }
  const toolCallIdx = events.findIndex((e) => e.type === "tool_call");
  const errorIdx = events.findIndex((e) => e.type === "error");
  assert.notEqual(toolCallIdx, -1, "expected the partial tool call to be flushed before the error event");
  assert.notEqual(errorIdx, -1, "expected the stream to surface an error event");
  assert.ok(toolCallIdx < errorIdx, `tool_call (idx ${toolCallIdx}) must come before error (idx ${errorIdx})`);
  assert.equal(events.some((e) => e.type === "done"), false);
});

// Same regression for the Codex Responses-API SSE parser.
test("CodexProvider flushes partial tool calls on stream error", async () => {
  const encoder = new TextEncoder();
  let pulled = 0;
  // Codex streams function_call deltas. We open a partial call
  // (name + partial args) and then error the stream before the
  // deltas complete into parseable JSON.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled++ === 0) {
        controller.enqueue(encoder.encode(
          'event: response.function_call_arguments.delta\n' +
          'data: {"item":{"call_id":"call_abc","name":"lookup","arguments":"{\\"q\\":\\"o"}}\n\n',
        ));
      } else {
        controller.error(new Error("connection reset"));
      }
    },
  });
  const provider = new CodexProvider({
    id: "codex",
    accessToken: "token",
    defaultModel: "gpt-5.1",
  });
  const events: Array<{ type: string; toolCall?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  try {
    for await (const ev of provider.stream({
      model: "gpt-5.1",
      messages: [{ role: "user", content: "ping" }],
      signal: new AbortController().signal,
    })) {
      events.push({ type: ev.type, toolCall: ev.toolCall });
    }
  } catch {
    // Provider swallows errors; tolerate throws too.
  } finally {
    globalThis.fetch = originalFetch;
  }
  const toolCallIdx = events.findIndex((e) => e.type === "tool_call");
  const errorIdx = events.findIndex((e) => e.type === "error");
  assert.notEqual(toolCallIdx, -1, "expected the partial tool call to be flushed before the error event");
  assert.notEqual(errorIdx, -1, "expected the stream to surface an error event");
  assert.ok(toolCallIdx < errorIdx, `tool_call (idx ${toolCallIdx}) must come before error (idx ${errorIdx})`);
  assert.equal(events.some((e) => e.type === "done"), false);
});
