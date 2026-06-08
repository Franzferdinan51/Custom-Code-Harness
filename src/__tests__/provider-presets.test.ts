import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loadSettings, resetSettingsCache } from "../config/settings.js";
import { ProviderRegistry } from "../providers/registry.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
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
    resetSettingsCache();
  });
}

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

test("settings only auto-inject alias providers when alias envs are set", async () => {
  await withEnv({
    OPENAI_API_KEY: "openai-test-key",
    CODEX_API_KEY: undefined,
    XAI_API_KEY: "xai-test-key",
    GROK_API_KEY: undefined,
  }, async () => {
    const settings = loadSettings();
    assert.ok(settings.providers.openai);
    assert.equal(settings.providers.codex, undefined);
    assert.ok(settings.providers.xai);
    assert.equal(settings.providers.grok, undefined);
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
