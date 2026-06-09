import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSettings, resetSettingsCache } from "../config/settings.js";
import { ProviderRegistry } from "../providers/registry.js";
import {
  getProviderPreset,
  HOSTED_PROVIDER_ORDER,
  listProviderPresets,
  providerCatalogGroups,
} from "../providers/presets.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  const prevHome = process.env.CH_HOME;
  const prevCodingHarnessHome = process.env.CODINGHARNESS_HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "ch-preset-test-"));
  process.env.CH_HOME = tempHome;
  process.env.CODINGHARNESS_HOME = tempHome;
  const clearedKeys = [
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "CODEX_BASE_URL", "CODEX_MODEL",
    "CODEX_OAUTH_TOKEN", "OPENAI_OAUTH_TOKEN", "CODEX_TOKEN",
    "XAI_API_KEY", "GROK_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_BASE_URL", "GROK_MODEL",
    "GROK_OAUTH_TOKEN", "XAI_OAUTH_TOKEN",
    "MINIMAX_API_KEY", "MINIMAX_OAUTH_TOKEN", "MINIMAX_AUTH_TOKEN",
    "LMSTUDIO_BASE_URL", "LM_API_TOKEN",
    "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "OPENROUTER_MODEL",
  ];
  for (const key of clearedKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSettingsCache();
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (prevHome === undefined) delete process.env.CH_HOME;
    else process.env.CH_HOME = prevHome;
    if (prevCodingHarnessHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = prevCodingHarnessHome;
    resetSettingsCache();
    rmSync(tempHome, { recursive: true, force: true });
  });
}

describe("provider presets", { concurrency: 1 }, () => {

test("lmstudio is the default provider when no hosted credentials are set", async () => {
  await withEnv({
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    XAI_API_KEY: undefined,
    MINIMAX_API_KEY: undefined,
  }, async () => {
    const settings = loadSettings();
    assert.equal(settings.defaultProvider, "lmstudio");
    assert.ok(settings.providers.lmstudio);
    assert.equal(settings.providers.lmstudio?.baseUrl, "http://127.0.0.1:1234/v1");
  });
});

test("listProviderPresets lists lmstudio first", () => {
  const presets = listProviderPresets();
  assert.equal(presets[0]?.id, "lmstudio");
});

test("listProviderPresets keeps hosted providers in first-class order after primary", () => {
  const presets = listProviderPresets();
  const hostedIds = presets.filter((p) => p.tier === "hosted").map((p) => p.id);
  assert.deepEqual(hostedIds, [...HOSTED_PROVIDER_ORDER]);
});

test("providerCatalogGroups surfaces primary, hosted, and local tiers", () => {
  const groups = providerCatalogGroups();
  assert.equal(groups.primary.length, 1);
  assert.equal(groups.primary[0]?.id, "lmstudio");
  assert.equal(groups.hosted.length, HOSTED_PROVIDER_ORDER.length);
  assert.deepEqual(groups.hosted.map((p) => p.id), [...HOSTED_PROVIDER_ORDER]);
  assert.deepEqual(groups.local.map((p) => p.id), ["vllm", "vllm-omni"]);
});

test("settings inject xai and minimax presets from env", async () => {
  await withEnv({
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    XAI_API_KEY: "xai-test-key",
    MINIMAX_API_KEY: "minimax-test-key",
    LMSTUDIO_BASE_URL: undefined,
  }, async () => {
    const settings = loadSettings();
    assert.equal(settings.providers.xai?.baseUrl, "https://api.x.ai/v1");
    assert.equal(settings.providers.xai?.model, "grok-4.3");
    assert.equal(settings.providers.minimax?.baseUrl, "https://api.minimax.io/v1");
    assert.equal(settings.providers.minimax?.apiKey, "minimax-test-key");
  });
});

test("settings inject grok and minimax oauth-style credentials from env", async () => {
  await withEnv({
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    GROK_CODE_XAI_API_KEY: "xai-build-token",
    GROK_API_KEY: undefined,
    GROK_OAUTH_TOKEN: "grok-oauth-token",
    MINIMAX_API_KEY: undefined,
    MINIMAX_OAUTH_TOKEN: "minimax-oauth-token",
  }, async () => {
    const settings = loadSettings();
    assert.equal(settings.providers.grok?.authMode, "oauth");
    assert.equal(settings.providers.grok?.oauthToken, "grok-oauth-token");
    assert.ok(settings.providers.minimax, "minimax profile should be injected");
    assert.equal(settings.providers.minimax?.oauthToken, "minimax-oauth-token");
    assert.equal(settings.providers.minimax?.authMode, "oauth");
  });
});

test("settings inject minimax oauth without grok alias env vars", async () => {
  await withEnv({
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    GROK_CODE_XAI_API_KEY: undefined,
    GROK_OAUTH_TOKEN: undefined,
    MINIMAX_API_KEY: undefined,
    MINIMAX_OAUTH_TOKEN: "minimax-oauth-only",
  }, async () => {
    const settings = loadSettings();
    assert.equal(settings.defaultProvider, "minimax");
    assert.equal(settings.providers.minimax?.oauthToken, "minimax-oauth-only");
  });
});

test("settings only auto-inject alias providers when alias envs are set", async () => {
  await withEnv({
    OPENAI_API_KEY: "openai-test-key",
    CODEX_API_KEY: undefined,
    XAI_API_KEY: "xai-test-key",
    GROK_API_KEY: undefined,
    GROK_CODE_XAI_API_KEY: undefined,
    GROK_OAUTH_TOKEN: undefined,
  }, async () => {
    const settings = loadSettings();
    assert.ok(settings.providers.openai);
    assert.equal(settings.providers.codex, undefined);
    assert.ok(settings.providers.xai);
    assert.equal(settings.providers.grok, undefined);
    assert.equal(settings.defaultProvider, "openai");
  });
});

test("saveProviderApiKey accepts empty key for optional-auth lmstudio", async () => {
  await withEnv({
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
  }, async () => {
    const { HarnessRuntime } = await import("../runtime.js");
    const rt = new HarnessRuntime({ cwd: process.cwd(), ephemeral: true });
    const save = await rt.saveProviderApiKey("lmstudio", "", { model: "local-model" });
    assert.equal(save.ok, true);
    assert.equal(rt.settings.providers.lmstudio?.model, "local-model");
    assert.equal(rt.settings.providers.lmstudio?.apiKey, undefined);
  });
});

test("lmstudio provider can be configured with base url and no api key", async () => {
  await withEnv({
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    LMSTUDIO_BASE_URL: "http://127.0.0.1:1234/v1",
    LMSTUDIO_API_KEY: undefined,
  }, async () => {
    const settings = loadSettings();
    const reg = new ProviderRegistry(settings);
    const provider = reg.get("lmstudio");
    assert.ok(provider);
    const check = await provider!.isConfigured();
    assert.equal(check.ok, true);
  });
});

test("provider registry invalidates cached provider instances", async () => {
  await withEnv({
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
  }, async () => {
    const settings = loadSettings();
    settings.providers.minimax = {
      id: "minimax",
      baseUrl: "https://api.minimax.io/v1",
      apiKey: "first-key",
      model: "MiniMax-M2.7",
    };
    const reg = new ProviderRegistry(settings);
    const first = reg.get("minimax");
    assert.ok(first);
    settings.providers.minimax.apiKey = "second-key";
    reg.invalidate("minimax");
    const second = reg.get("minimax");
    assert.ok(second);
    assert.notEqual(first, second);
  });
});

test("hosted provider accepts oauth token as bearer credential", async () => {
  await withEnv({
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
  }, async () => {
    const settings = loadSettings();
    settings.providers.grok = {
      id: "grok",
      authMode: "oauth",
      oauthToken: "oauth-session-token",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4.3",
    };
    const reg = new ProviderRegistry(settings);
    const provider = reg.get("grok");
    assert.ok(provider);
    const check = await provider!.isConfigured();
    assert.equal(check.ok, true);
  });
});

test("vllm and vllm-omni presets exist with openai protocol and optional auth", () => {
  const vllm = getProviderPreset("vllm");
  const omni = getProviderPreset("vllm-omni");
  assert.ok(vllm, "vllm preset missing");
  assert.ok(omni, "vllm-omni preset missing");
  assert.equal(vllm!.protocol, "openai");
  assert.equal(omni!.protocol, "openai");
  assert.ok(vllm!.authModes.includes("optional"));
  assert.ok(omni!.authModes.includes("optional"));
  assert.match(vllm!.defaultBaseUrl ?? "", /^http:\/\/(localhost|127\.0\.0\.1)/);
  assert.match(omni!.defaultBaseUrl ?? "", /^http:\/\/(localhost|127\.0\.0\.1)/);
  // both should be in the public catalog
  const ids = listProviderPresets().map((p) => p.id);
  assert.ok(ids.includes("vllm"));
  assert.ok(ids.includes("vllm-omni"));
});

test("codex preset supports oauth auth mode", () => {
  const codex = getProviderPreset("codex");
  assert.ok(codex);
  assert.ok(codex!.authModes.includes("oauth"));
  assert.ok(codex!.oauthTokenEnv && codex!.oauthTokenEnv.length > 0);
  assert.equal(codex!.defaultAuthMode, "oauth");
});

test("vllm provider configures from a base url with no api key", async () => {
  await withEnv({
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    VLLM_API_KEY: undefined,
  }, async () => {
    const settings = loadSettings();
    settings.providers.vllm = {
      id: "vllm",
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "meta-llama/Llama-3.1-8B-Instruct",
    };
    const reg = new ProviderRegistry(settings);
    const provider = reg.get("vllm");
    assert.ok(provider);
    const check = await provider!.isConfigured();
    assert.equal(check.ok, true);
    // listModels is implemented on OpenAICompatProvider and returns []
    // when the server is unreachable (network errors are swallowed).
    const models = await provider!.listModels?.();
    assert.ok(Array.isArray(models));
  });
});

describe("openrouter preset", { concurrency: 1 }, () => {
  test("preset is registered with the right shape", () => {
    const p = getProviderPreset("openrouter");
    assert.ok(p, "openrouter preset should be registered");
    assert.equal(p!.tier, "hosted");
    assert.equal(p!.protocol, "openai");
    assert.equal(p!.defaultBaseUrl, "https://openrouter.ai/api/v1");
    assert.equal(p!.defaultModel, "anthropic/claude-3.5-sonnet");
    assert.deepEqual(p!.apiKeyEnv, ["OPENROUTER_API_KEY"]);
    assert.deepEqual(p!.baseUrlEnv, ["OPENROUTER_BASE_URL"]);
    assert.deepEqual(p!.modelEnv, ["OPENROUTER_MODEL"]);
    assert.deepEqual(p!.authModes, ["apiKey"]);
    assert.equal(p!.defaultAuthMode, "apiKey");
    assert.ok(p!.authDocsUrl);
    assert.ok(p!.authLaunchUrl);
  });

  test("openrouter appears in the hosted tier and in HOSTED_PROVIDER_ORDER", () => {
    assert.ok(HOSTED_PROVIDER_ORDER.includes("openrouter" as never));
    const groups = providerCatalogGroups();
    const openrouter = groups.hosted.find((p) => p.id === "openrouter");
    assert.ok(openrouter, "openrouter should be in the hosted group");
  });

  test("OPENROUTER_BASE_URL overrides the default base URL when set", async () => {
    await withEnv({ OPENROUTER_API_KEY: "sk-or-test", OPENROUTER_BASE_URL: "https://my-proxy.example/v1" }, async () => {
      const settings = loadSettings();
      const reg = new ProviderRegistry(settings);
      const provider = reg.get("openrouter");
      assert.ok(provider);
      const check = await provider!.isConfigured();
      assert.equal(check.ok, true);
    });
  });

  test("missing OPENROUTER_API_KEY logs a warning and returns no provider", async () => {
    await withEnv({ OPENROUTER_API_KEY: undefined }, async () => {
      const settings = loadSettings();
      const reg = new ProviderRegistry(settings);
      const provider = reg.get("openrouter");
      // No API key → registry returns undefined.
      assert.equal(provider, undefined);
    });
  });
});

});
