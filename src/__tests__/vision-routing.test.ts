// Tests for the pure vision-routing helpers (src/agent/vision-routing.ts).
//
// Provider capability facts come from the real preset map in
// `src/providers/presets.ts`. The ProviderRegistry itself is never
// instantiated — we only need its `.get(id)` lookup shape, so a
// minimal stub is built per test.

import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { promptNeedsVision, pickVisionCapableModel } from "../agent/vision-routing.js";
import { PRIMARY_PROVIDER_ID } from "../providers/presets.js";
import type { Provider, ProviderCapabilities } from "../types.js";
import type { Settings } from "../config/settings.js";
import type { ProviderRegistry } from "../providers/registry.js";

/** Build a minimal Settings object with the defaults these tests need. */
function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultProvider: PRIMARY_PROVIDER_ID,
    defaultModel: "openai/gpt-oss-20b",
    providers: {
      [PRIMARY_PROVIDER_ID]: {
        id: PRIMARY_PROVIDER_ID,
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "openai/gpt-oss-20b",
        default: true,
      },
    },
    ...overrides,
  } as Settings;
}

/** Build a stub ProviderRegistry that knows the providers we registered. */
function makeRegistry(
  providers: Array<{ id: string; caps?: ProviderCapabilities }>,
): ProviderRegistry {
  const byId = new Map<string, Provider>();
  for (const p of providers) {
    byId.set(p.id, {
      id: p.id,
      displayName: p.id,
      capabilities: p.caps,
    } as Provider);
  }
  return {
    get(id: string) {
      return byId.get(id);
    },
    list() {
      return [...byId.values()];
    },
    default() {
      return byId.get(PRIMARY_PROVIDER_ID);
    },
  } as unknown as ProviderRegistry;
}

describe("promptNeedsVision", () => {
  test("text-only prompt returns false", () => {
    assert.equal(promptNeedsVision("summarize this code"), false);
  });

  test("prompt that mentions the word 'image' but has no file token returns false", () => {
    assert.equal(
      promptNeedsVision("look at the image section of the docs and summarize it"),
      false,
    );
  });

  test("@image.png token triggers", () => {
    assert.equal(promptNeedsVision("what is in @image.png ?"), true);
  });

  test("@image.JPG (uppercase ext) triggers", () => {
    assert.equal(promptNeedsVision("describe @photo.JPG"), true);
  });

  test("@something.txt does NOT trigger", () => {
    assert.equal(promptNeedsVision("open @notes.txt please"), false);
  });

  test("chat history with image_url part triggers", () => {
    const history = [
      {
        role: "user" as const,
        content: "see attached",
        contentParts: [
          { type: "image_url" as const, image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ];
    assert.equal(promptNeedsVision("what is it?", history), true);
  });

  test("chat history with image/ mime part triggers", () => {
    const history = [
      {
        role: "user" as const,
        content: "see attached",
        contentParts: [
          { type: "text" as const, text: "caption", mimeType: "image/jpeg" },
        ],
      },
    ];
    assert.equal(promptNeedsVision("describe it", history), true);
  });
});

describe("pickVisionCapableModel", () => {
  test("returns override source when preferred provider+model is imageInput-capable", () => {
    const settings = makeSettings();
    const registry = makeRegistry([{ id: "openai", caps: { imageInput: true } }]);
    const route = pickVisionCapableModel(registry, "openai", "gpt-4o", settings);
    assert.equal(route.source, "override");
    assert.equal(route.providerId, "openai");
    assert.equal(route.model, "gpt-4o");
  });

  test("falls back within same provider when preferred model is non-vision", () => {
    const settings = makeSettings();
    const registry = makeRegistry([{ id: "openai", caps: { imageInput: true } }]);
    // Caller asked for a non-vision model on a vision provider → we route
    // to the provider's default model (gpt-5.1 for openai per presets.ts).
    const route = pickVisionCapableModel(registry, "openai", "gpt-3.5-turbo", settings);
    assert.equal(route.source, "provider-fallback");
    assert.equal(route.providerId, "openai");
    assert.equal(route.model, "gpt-5.1");
  });

  test("falls back to default provider when preferred provider is non-vision", () => {
    const settings = makeSettings({
      defaultProvider: "lmstudio",
      defaultModel: "qwen-vl-7b",
      providers: {
        lmstudio: {
          id: "lmstudio",
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "qwen-vl-7b",
          default: true,
        },
      },
    });
    const registry = makeRegistry([
      { id: "vllm", caps: { reasoning: true } }, // non-vision
      { id: "lmstudio", caps: { imageInput: true } },
    ]);
    const route = pickVisionCapableModel(registry, "vllm", "llama-8b", settings);
    assert.equal(route.source, "default-fallback");
    assert.equal(route.providerId, "lmstudio");
    assert.equal(route.model, "qwen-vl-7b");
  });

  test("returns 'unavailable' when no provider in the registry is vision-capable", () => {
    const settings = makeSettings();
    const registry = makeRegistry([
      { id: "vllm", caps: { reasoning: true } },
      { id: "minimax", caps: { reasoning: true } },
    ]);
    const route = pickVisionCapableModel(registry, "vllm", "llama-8b", settings);
    assert.equal(route.source, "unavailable");
  });
});
