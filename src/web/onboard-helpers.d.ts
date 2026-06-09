// Type declarations for src/web/onboard-helpers.js. Mirrors the
// JSDoc types in that file so TypeScript can check the test
// imports in src/__tests__/web-onboard-helpers.test.ts.

export type ProviderTier = "primary" | "hosted" | "local";

export interface ProviderPreset {
  id: string;
  label?: string;
  tier?: string;
  [key: string]: unknown;
}

export interface ProvidersByTier {
  primary: ProviderPreset[];
  hosted: ProviderPreset[];
  local: ProviderPreset[];
}

export const PROVIDER_TIER_ORDER: readonly ProviderTier[];

export const PROVIDER_GROUP_LABELS: Record<ProviderTier, string>;

export function groupProvidersByTier(
  presets: ProviderPreset[] | null | undefined,
): ProvidersByTier;

export function filterModelList(
  models: string[] | null | undefined,
  query: string | null | undefined,
): string[];
