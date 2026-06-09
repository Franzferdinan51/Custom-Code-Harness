// Unit tests for the pure helpers in src/web/onboard-helpers.js.
//
// The helpers are plain ESM (no DOM) so we can exercise them in
// Node without a jsdom dependency. The DOM-rendering half of the
// onboard flow (the <optgroup> assembly, the click handlers, the
// success state) lives in src/web/app.js and is covered by the
// existing e2e / integration tests in this repo.

import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  groupProvidersByTier,
  filterModelList,
  PROVIDER_TIER_ORDER,
  PROVIDER_GROUP_LABELS,
} from "../web/onboard-helpers.js";

describe("groupProvidersByTier", () => {
  test("returns the three canonical tiers, even when empty", () => {
    const result = groupProvidersByTier([]);
    assert.deepEqual(Object.keys(result).sort(), ["hosted", "local", "primary"]);
    assert.equal(result.primary.length, 0);
    assert.equal(result.hosted.length, 0);
    assert.equal(result.local.length, 0);
  });

  test("buckets each preset into its declared tier", () => {
    const presets = [
      { id: "lmstudio", tier: "primary" },
      { id: "openai", tier: "hosted" },
      { id: "anthropic", tier: "hosted" },
      { id: "vllm", tier: "local" },
    ];
    const result = groupProvidersByTier(presets);
    assert.deepEqual(result.primary.map((p) => p.id), ["lmstudio"]);
    assert.deepEqual(result.hosted.map((p) => p.id), ["openai", "anthropic"]);
    assert.deepEqual(result.local.map((p) => p.id), ["vllm"]);
  });

  test("falls back to 'hosted' for presets with unknown or missing tier", () => {
    const presets: Array<{ id: string; tier?: string | null }> = [
      { id: "no-tier" },
      { id: "weird-tier", tier: "imaginary" },
      { id: "null-tier", tier: null },
      { id: "real-hosted", tier: "hosted" },
    ];
    const result = groupProvidersByTier(presets as any);
    // The three unknown-tier presets must end up in 'hosted' so they
    // still appear in the wizard instead of vanishing silently.
    assert.deepEqual(
      result.hosted.map((p) => p.id),
      ["no-tier", "weird-tier", "null-tier", "real-hosted"],
    );
    assert.equal(result.primary.length, 0);
    assert.equal(result.local.length, 0);
  });

  test("preserves insertion order inside each tier", () => {
    const presets = [
      { id: "a", tier: "hosted" },
      { id: "b", tier: "hosted" },
      { id: "c", tier: "hosted" },
    ];
    const result = groupProvidersByTier(presets);
    assert.deepEqual(result.hosted.map((p) => p.id), ["a", "b", "c"]);
  });

  test("does not mutate the input array", () => {
    const presets = [
      { id: "a", tier: "hosted" },
      { id: "b", tier: "primary" },
    ];
    const snapshot = JSON.parse(JSON.stringify(presets));
    groupProvidersByTier(presets);
    assert.deepEqual(presets, snapshot);
  });

  test("handles null / undefined / non-array inputs gracefully", () => {
    // The wizard code calls us on possibly-undefined data while
    // the catalog is loading. Make sure we never throw and never
    // return a tier we don't own.
    for (const input of [null, undefined, 42, "string", { id: "x" }]) {
      const result = groupProvidersByTier(input as any);
      assert.deepEqual(Object.keys(result).sort(), ["hosted", "local", "primary"]);
      // Non-array inputs (other than null/undefined) get an empty
      // pass — the caller will re-fetch the catalog and the wizard
      // re-renders from a proper array on the next pass. The point
      // is that we never throw, never return a key we don't own.
      assert.equal(result.primary.length, 0);
      assert.equal(result.local.length, 0);
      assert.ok(Array.isArray(result.hosted));
    }
  });
});

describe("filterModelList", () => {
  test("returns all models when query is empty", () => {
    const models = ["gpt-4.1", "claude-sonnet-4-5", "grok-3"];
    assert.deepEqual(filterModelList(models, ""), models);
    assert.deepEqual(filterModelList(models, "   "), models);
  });

  test("filters case-insensitively by substring", () => {
    const models = ["gpt-4.1-mini", "gpt-5.1", "claude-sonnet-4-5"];
    assert.deepEqual(filterModelList(models, "GPT"), ["gpt-4.1-mini", "gpt-5.1"]);
    assert.deepEqual(filterModelList(models, "sonnet"), ["claude-sonnet-4-5"]);
  });

  test("handles null / undefined inputs gracefully", () => {
    assert.deepEqual(filterModelList(null, "gpt"), []);
    assert.deepEqual(filterModelList(undefined, "gpt"), []);
  });
});

describe("tier metadata constants", () => {
  test("PROVIDER_TIER_ORDER is primary, hosted, local", () => {
    assert.deepEqual(PROVIDER_TIER_ORDER, ["primary", "hosted", "local"]);
  });

  test("PROVIDER_GROUP_LABELS has a label for every tier in the order", () => {
    for (const tier of PROVIDER_TIER_ORDER) {
      assert.ok(typeof PROVIDER_GROUP_LABELS[tier] === "string" && PROVIDER_GROUP_LABELS[tier].length > 0,
        `expected a non-empty label for tier '${tier}'`);
    }
  });
});
