// CodingHarness web UI — pure helpers for the first-run onboarding wizard.
//
// Browser side: attaches helpers to `window.OnboardHelpers` so
// `app.js` (a classic script) can reach them. Test side: this
// file is a normal ESM module, so `npm run test:node` can import
// the helpers and exercise the data-shaping logic without a DOM
// library. The DOM-rendering half (building <optgroup>s) lives in
// `app.js` and is exercised end-to-end through the existing
// `fillProviderSelect` flow.
//
// The whole file is wrapped in an IIFE so the const declarations
// don't collide with same-named bindings in `app.js` when both
// are loaded as classic scripts. We register the helpers on
// `globalThis` so the file works as both a classic script and an
// ESM module. Earlier revisions used a `export { ... }` block at
// the bottom, which broke classic-script load with a SyntaxError
// and meant the wizard's tiered optgroups never rendered.
//
// @ts-check
// JSDoc types below let `tsc --noEmit` type-check the imports in
// `src/__tests__/web-onboard-helpers.test.ts` without a separate
// `.d.ts` shim.

/** @typedef {"primary" | "hosted" | "local"} ProviderTier */
/** @typedef {{ id: string, label?: string, tier?: string, [k: string]: unknown }} ProviderPreset */
/** @typedef {{ primary: ProviderPreset[], hosted: ProviderPreset[], local: ProviderPreset[] }} ProvidersByTier */

(function () {
  /** @type {readonly ProviderTier[]} */
  const PROVIDER_TIER_ORDER = ["primary", "hosted", "local"];

  /** @type {Record<ProviderTier, string>} */
  const PROVIDER_GROUP_LABELS = {
    primary: "Default (local)",
    hosted: "Hosted (OpenAI, Grok, MiniMax, Codex, \u2026)",
    local: "Local alternatives",
  };

  /**
   * Group provider presets by their `tier` field. Returns a stable
   * object with three keys (`primary`, `hosted`, `local`) in the
   * same order, so callers can iterate deterministically. Unknown
   * tiers fall back to `hosted` so an unrecognised preset still
   * shows up rather than vanishing.
   *
   * @param {ProviderPreset[] | null | undefined} presets
   * @returns {ProvidersByTier}
   */
  function groupProvidersByTier(presets) {
    const byTier = { primary: [], hosted: [], local: [] };
    if (!Array.isArray(presets)) return byTier;
    for (const preset of presets) {
      const tier = preset && preset.tier && byTier[preset.tier] ? preset.tier : "hosted";
      byTier[tier].push(preset);
    }
    return byTier;
  }

  /**
   * Case-insensitive substring filter for model id lists.
   *
   * @param {string[]} models
   * @param {string | null | undefined} query
   * @returns {string[]}
   */
  function filterModelList(models, query) {
    if (!Array.isArray(models)) return [];
    const q = (query || "").trim().toLowerCase();
    if (!q) return models.slice();
    return models.filter((model) => String(model).toLowerCase().includes(q));
  }

  const api = {
    PROVIDER_TIER_ORDER,
    PROVIDER_GROUP_LABELS,
    groupProvidersByTier,
    filterModelList,
  };

  if (typeof globalThis !== "undefined") {
    globalThis.OnboardHelpers = api;
  }

  // CommonJS export for the unit tests that import this file via
  // `import { ... } from "../web/onboard-helpers.js"`. The tests
  // are run by Node, which goes through tsx's CJS interop and
  // needs `module.exports` rather than the `export` keyword.
  // Wrapped in try/catch so a strict classic-script context (no
  // module shim) doesn't blow up.
  try {
    if (typeof module !== "undefined" && module.exports) {
      module.exports = api;
    }
  } catch (_) { /* classic script context — ignore */ }
})();
