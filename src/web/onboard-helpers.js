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
// @ts-check
// JSDoc types below let `tsc --noEmit` type-check the imports in
// `src/__tests__/web-onboard-helpers.test.ts` without a separate
// `.d.ts` shim.

/** @typedef {"primary" | "hosted" | "local"} ProviderTier */
/** @typedef {{ id: string, label?: string, tier?: string, [k: string]: unknown }} ProviderPreset */
/** @typedef {{ primary: ProviderPreset[], hosted: ProviderPreset[], local: ProviderPreset[] }} ProvidersByTier */

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

if (typeof window !== "undefined") {
  window.OnboardHelpers = api;
}

export { PROVIDER_TIER_ORDER, PROVIDER_GROUP_LABELS, groupProvidersByTier, filterModelList };
