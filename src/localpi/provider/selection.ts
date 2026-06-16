// TTY-aware selection policy. Borrowed from dutifuldev/localpi (MIT).
// https://github.com/dutifuldev/localpi/blob/main/src/localpi/runtime-selection.ts
//
// The rule that prevents automation from silently picking a random model.

import {
  formatCatalogWarning,
  type CatalogModel,
  type CatalogWarning,
  type ModelCatalog
} from "./catalog.js";

export type SelectionResult =
  | { kind: "ok"; model: CatalogModel }
  | { kind: "needs-picker"; candidates: readonly CatalogModel[]; reason: "tty-multiple" }
  | { kind: "error"; message: string };

export function selectAutomaticModel(
  catalog: ModelCatalog,
  options: { isTty: boolean; explicitModel?: string; explicitProvider?: string }
): SelectionResult {
  const scoped = options.explicitProvider
    ? catalog.models.filter((m) => m.providerId === options.explicitProvider)
    : catalog.models;

  if (scoped.length === 0) {
    return {
      kind: "error",
      message: `no models available for provider ${options.explicitProvider}; choices:\n${formatEngineSections(catalog)}`
    };
  }

  if (options.explicitModel && options.explicitModel !== "auto") {
    return selectExplicit(scoped, options.explicitModel);
  }

  return selectAutomatic(scoped, catalog.warnings, options.isTty);
}

function selectExplicit(
  models: readonly CatalogModel[],
  requested: string
): SelectionResult {
  const matches = models.filter(
    (m) => m.modelId === requested || m.aliases.includes(requested)
  );
  if (matches.length === 1) return { kind: "ok", model: matches[0]! };
  if (matches.length > 1) {
    return {
      kind: "error",
      message: `model ${requested} is available from multiple providers; pass --provider explicitly:\n${formatModelList(matches)}`
    };
  }
  return {
    kind: "error",
    message: `model ${requested} not found; choices:\n${formatModelList(models)}`
  };
}

function selectAutomatic(
  models: readonly CatalogModel[],
  warnings: readonly CatalogWarning[],
  isTty: boolean
): SelectionResult {
  const loaded = models.filter((m) => m.availability === "loaded");
  if (loaded.length === 1) return { kind: "ok", model: loaded[0]! };
  if (loaded.length === 0) {
    const startable = models.filter((m) => m.availability === "startable");
    if (startable.length > 0) return { kind: "ok", model: startable[0]! };
    return {
      kind: "error",
      message: `no loaded or startable models available\n\n${formatEngineSections({ models, warnings })}`
    };
  }
  // loaded.length > 1
  if (!isTty) {
    return {
      kind: "error",
      message:
        `multiple loaded models; pass --provider and --model explicitly:\n` +
        formatModelList(loaded)
    };
  }
  return { kind: "needs-picker", candidates: loaded, reason: "tty-multiple" };
}

export function formatModelList(models: readonly CatalogModel[]): string {
  return models.map((m) => `  ${m.providerId}/${m.modelId} (${m.displayName})`).join("\n");
}

function formatEngineSections(catalog: ModelCatalog | { models: readonly CatalogModel[]; warnings: readonly CatalogWarning[] }): string {
  const sections = new Map<string, { title: string; loaded: string[]; startable: string[]; warnings: string[] }>();
  for (const m of catalog.models) {
    const existing = sections.get(m.providerId) ?? { title: m.providerName, loaded: [], startable: [], warnings: [] };
    const entry = `${m.providerId}/${m.modelId}`;
    sections.set(m.providerId, {
      ...existing,
      loaded: m.availability === "loaded" ? [...existing.loaded, entry] : existing.loaded,
      startable: m.availability === "startable" ? [...existing.startable, entry] : existing.startable
    });
  }
  if ("warnings" in catalog) {
    for (const w of catalog.warnings) {
      const existing = sections.get(w.providerId) ?? { title: w.providerName, loaded: [], startable: [], warnings: [] };
      sections.set(w.providerId, { ...existing, warnings: [...existing.warnings, formatCatalogWarning(w)] });
    }
  }
  const blocks: string[] = [];
  for (const s of sections.values()) {
    const lines = [`${s.title}:`];
    lines.push(s.loaded.length === 0 ? "  - loaded: none" : `  - loaded: ${s.loaded.join(", ")}`);
    if (s.startable.length > 0) lines.push(`  - startable: ${s.startable.join(", ")}`);
    for (const w of s.warnings) lines.push(`  - ${w}`);
    blocks.push(lines.join("\n"));
  }
  return blocks.length === 0 ? "  - no engines reported usable models" : blocks.join("\n\n");
}

// Memory-safety rule: refuse to start a managed runtime if another heavyweight
// local model is already loaded. The user must unload first.
export function assertNoLoadedExternalModels(catalog: ModelCatalog): void {
  const external = catalog.models.filter(
    (m) => m.runtime !== "managed-runtime" && m.availability === "loaded"
  );
  if (external.length === 0) return;
  throw new Error(
    `external local models are already loaded; unload them first:\n${formatModelList(external)}`
  );
}
