// Vision-aware sub-agent routing.
//
// Pure helpers that detect whether a sub-agent prompt carries image
// content and, if so, pick a vision-capable provider/model from the
// registry. No I/O — all filesystem and network side-effects live
// outside this module. The capability source of truth is
// `ProviderCapabilities.imageInput` declared on each preset
// (see `src/providers/presets.ts`).

import type { ChatMessage, ContentPart, Provider, ProviderCapabilities } from "../types.js";
import type { Settings } from "../config/settings.js";
import { getProviderPreset } from "../providers/presets.js";
import type { ProviderRegistry } from "../providers/registry.js";

/** File extensions that count as image attachments for `@<path>` tokens. */
const IMAGE_EXT_PATTERN = "(?:png|jpg|jpeg|webp|gif|bmp)";

/**
 * Heuristic regex: an `@` token optionally quoted, ending in a recognized
 * image extension. Matches `@foo.png`, `@/abs/path/photo.JPG`,
 * `@"./cat image.jpeg"`, etc.
 */
const IMAGE_AT_TOKEN = new RegExp(
  [
    String.raw`@(?:`,
    String.raw`"([^"]+\.` + IMAGE_EXT_PATTERN + `)"`,
    String.raw`|'([^']+\.` + IMAGE_EXT_PATTERN + `)'`,
    String.raw`|(\S+\.` + IMAGE_EXT_PATTERN + `)`,
    String.raw`)`,
  ].join(""),
  "i",
);

/**
 * Detect whether a sub-agent prompt references image content, either via
 * `@<path>` file tokens or via image parts inside a caller-supplied
 * message history. Pure — does not touch the filesystem.
 */
export function promptNeedsVision(prompt: string, history?: ChatMessage[]): boolean {
  if (typeof prompt === "string" && IMAGE_AT_TOKEN.test(prompt)) {
    return true;
  }
  if (history && history.length > 0) {
    for (const m of history) {
      if (messageHasImage(m)) return true;
    }
  }
  return false;
}

function messageHasImage(m: ChatMessage): boolean {
  const parts = m.contentParts;
  if (!parts || parts.length === 0) return false;
  for (const p of parts) {
    if (partIsImage(p)) return true;
  }
  return false;
}

function partIsImage(p: ContentPart): boolean {
  if (p.type === "image_url") return true;
  // Some senders use a raw "type: image" part with a mimeType. Treat that
  // as an image trigger even though our ContentPart union doesn't formally
  // include it — the spec is permissive and image-mime is the source of truth.
  const loose = p as { type?: string; mimeType?: string };
  if (loose.type === "image") return true;
  if (typeof loose.mimeType === "string" && loose.mimeType.toLowerCase().startsWith("image/")) {
    return true;
  }
  return false;
}

export type VisionRoutingSource =
  | "override"
  | "provider-fallback"
  | "default-fallback"
  | "unavailable";

export interface VisionRoute {
  providerId: string;
  model: string;
  source: VisionRoutingSource;
}

/**
 * Pick a vision-capable route. The function never throws — when nothing
 * in the registry can serve images, it returns
 * `{ source: "unavailable", ... }` with the original preferred ids (or
 * empty strings if none were provided), letting the caller decide how to
 * surface the failure.
 *
 * Resolution order:
 *   1. `override`           — preferred provider+model already imageInput.
 *   2. `provider-fallback`  — same provider, swap to its default model.
 *   3. `default-fallback`   — settings.defaultProvider's default model.
 *   4. `unavailable`        — no vision-capable provider found.
 *
 * The capability map is read from each preset's `capabilities` field; we
 * never duplicate the map.
 */
/**
 * Heuristic: a small allow-list of model-name patterns that we KNOW are
 * non-vision (or at least predate vision support). The real Phase 1 work
 * is a per-model capability registry; this is the stopgap so that callers
 * who explicitly pick e.g. `gpt-3.5-turbo` get re-routed to the provider's
 * vision-capable default instead of crashing on image input downstream.
 */
const KNOWN_NON_VISION_MODEL_PATTERNS: RegExp[] = [
  /^gpt-3\.5/,
  /^gpt-3-/,
  /^gpt-3$/,
  /^davinci/,
  /^curie/,
  /^babbage/,
  /^ada/,
  /^text-embedding/,
  /^text-davinci/,
  /^claude-(?:instant|2)/,
  /^llama-2/,
  /^mistral-(?:7b|8b)(?:-|$)/,
];

function isLikelyNonVisionModel(model: string): boolean {
  return KNOWN_NON_VISION_MODEL_PATTERNS.some((p) => p.test(model));
}

export function pickVisionCapableModel(
  providers: ProviderRegistry,
  preferredProviderId: string | undefined,
  preferredModel: string | undefined,
  settings: Settings,
): VisionRoute {
  // 1. Preferred provider+model, provider is imageInput-capable AND ready
  // in the registry, AND the model isn't in the known-non-vision stopgap
  // list. (Override does not bypass the capability check — see deliverable.)
  if (
    preferredProviderId &&
    preferredModel &&
    providerIsVisionReady(providers, preferredProviderId) &&
    !isLikelyNonVisionModel(preferredModel)
  ) {
    return {
      providerId: preferredProviderId,
      model: preferredModel,
      source: "override",
    };
  }

  // 2. Same provider, swap to its declared default model. Provider-fallback
  // means "this provider has a vision-capable model — use its preset default."
  // We prefer the preset's defaultModel (the canonical vision model for the
  // provider) over settings.defaultModel, which is the user's global default
  // and may belong to a different provider.
  if (preferredProviderId && providerIsVisionReady(providers, preferredProviderId)) {
    const preset = getProviderPreset(preferredProviderId);
    const fallbackModel = preset?.defaultModel ?? settings.defaultModel ?? "";
    if (fallbackModel) {
      return {
        providerId: preferredProviderId,
        model: fallbackModel,
        source: "provider-fallback",
      };
    }
  }

  // 3. Default provider.
  const defaultId = settings.defaultProvider;
  if (defaultId && providerIsVisionReady(providers, defaultId)) {
    const preset = getProviderPreset(defaultId);
    const fallbackModel = settings.defaultModel ?? preset?.defaultModel ?? "";
    if (fallbackModel) {
      return {
        providerId: defaultId,
        model: fallbackModel,
        source: "default-fallback",
      };
    }
  }

  return {
    providerId: preferredProviderId ?? defaultId ?? "",
    model: preferredModel ?? settings.defaultModel ?? "",
    source: "unavailable",
  };
}

function providerIsVisionReady(providers: ProviderRegistry, providerId: string): boolean {
  // Provider must be present in the registry and imageInput-capable.
  const provider: Provider | undefined = providers.get(providerId);
  if (!provider) return false;
  const preset = getProviderPreset(providerId);
  const caps: ProviderCapabilities = provider.capabilities ?? preset?.capabilities ?? {};
  return Boolean(caps.imageInput);
}
