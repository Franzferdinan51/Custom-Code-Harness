// CatalogModel + /v1/models discoverer. Borrowed from dutifuldev/localpi (MIT).
// https://github.com/dutifuldev/localpi/blob/main/src/localpi/catalog.ts
//
// The single normalized type that flows from discovery -> selection ->
// launch / model-switch UI. No provider-specific types leak past the
// adapter layer.

import {
  asArray,
  asObject,
  optionalPositiveInteger,
  optionalString
} from "../common/json.js";

export type ModelAvailability = "loaded" | "startable";
export type ModelCapability = "text" | "vision" | "tools" | "image-gen" | "audio";
export type CatalogRuntime = "openai-compatible" | "managed-runtime";
export type CatalogThinkingFormat =
  | "deepseek"
  | "qwen-chat-template"
  | "anthropic"
  | "openai";

export type CatalogModel = {
  readonly providerId: string;
  readonly providerName: string;
  readonly runtime: CatalogRuntime;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly aliases: readonly string[];
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  readonly thinkingFormat?: CatalogThinkingFormat;
  readonly capabilities: readonly ModelCapability[];
  readonly availability: ModelAvailability;
};

export type ModelCatalog = {
  readonly models: readonly CatalogModel[];
  readonly warnings: readonly CatalogWarning[];
};

export type CatalogWarningCode =
  | "provider-not-responding"
  | "managed-command-unavailable"
  | "runtime-warning";

export type CatalogWarning = {
  readonly providerId: string;
  readonly providerName: string;
  readonly code: CatalogWarningCode;
  readonly message: string;
};

// OpenAI-compatible /v1/models probe -> CatalogModel[]
export async function discoverOpenAiCompatibleModels(args: {
  providerId: string;
  providerName: string;
  baseUrl: string;
  timeoutMs?: number;
  defaultMaxTokens?: number;
}): Promise<readonly CatalogModel[]> {
  const { providerId, providerName, baseUrl, timeoutMs = 3000, defaultMaxTokens } = args;
  const response = await fetch(`${baseUrl}/models`, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`model list failed with HTTP ${String(response.status)}`);
  }
  const payload: unknown = await response.json();
  const root = asObject(payload, "models response");
  const data = asArray(root["data"], "models response data");
  return data
    .map((entry) =>
      openAiCatalogModel(
        { providerId, providerName, baseUrl, ...(defaultMaxTokens === undefined ? {} : { defaultMaxTokens }) },
        asObject(entry, "model entry")
      )
    )
    .filter((m): m is CatalogModel => m !== undefined);
}

function openAiCatalogModel(
  args: {
    providerId: string;
    providerName: string;
    baseUrl: string;
    defaultMaxTokens?: number;
  },
  entry: Record<string, unknown>
): CatalogModel | undefined {
  const id = optionalString(entry["id"]);
  if (id === undefined) return undefined;
  const contextWindow = findContextWindow(entry);
  return {
    providerId: args.providerId,
    providerName: args.providerName,
    runtime: "openai-compatible",
    baseUrl: args.baseUrl,
    modelId: id,
    aliases: [],
    displayName: `${args.providerName} / ${id}`,
    ...(args.defaultMaxTokens === undefined ? {} : { maxTokens: args.defaultMaxTokens }),
    ...externalReasoningConfig(id),
    capabilities: ["text"],
    availability: "loaded",
    ...(contextWindow === undefined ? {} : { contextWindow })
  };
}

// Walks the well-known context-window field names and recurses into `metadata`.
// Returns `number | undefined`; no string-key-typos downstream.
export function findContextWindow(entry: Record<string, unknown>): number | undefined {
  for (const key of [
    "context_window",
    "contextWindow",
    "context_length",
    "contextLength",
    "max_context_length",
    "maxContextLength",
    "n_ctx",
    "max_input_tokens",
    "maxInputTokens"
  ]) {
    const v = optionalPositiveInteger(entry[key]);
    if (v !== undefined) return v;
  }
  const meta = entry["metadata"];
  if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
    return findContextWindow(meta as Record<string, unknown>);
  }
  return undefined;
}

function externalReasoningConfig(modelId: string): {
  readonly reasoning?: true;
  readonly thinkingFormat?: CatalogThinkingFormat;
} {
  const n = modelId.toLowerCase();
  if (isDeepSeekThinkingModel(n)) return { reasoning: true, thinkingFormat: "deepseek" };
  if (isQwenThinkingModel(n))
    return { reasoning: true, thinkingFormat: "qwen-chat-template" };
  return {};
}

function isDeepSeekThinkingModel(n: string): boolean {
  return (
    n.includes("deepseek") &&
    (n.split(/[^a-z0-9]+/).includes("r1") ||
      n.split(/[^a-z0-9]+/).includes("v4") ||
      n.split(/[^a-z0-9]+/).includes("4") ||
      n.includes("reason") ||
      n.includes("thinking"))
  );
}

function isQwenThinkingModel(n: string): boolean {
  const markers = [
    "qwq",
    "qwen3",
    "qwen-3",
    "qwen_3",
    "qwen 3",
    "qwen4",
    "qwen-4",
    "qwen_4",
    "qwen 4"
  ];
  return (
    markers.some((m) => n.includes(m)) ||
    (n.includes("qwen") && (n.includes("reason") || n.includes("thinking")))
  );
}

export function managedModelSupportsReasoning(modelId: string): boolean {
  const n = modelId.toLowerCase();
  return (
    n.includes("reason") ||
    n.includes("thinking") ||
    isDeepSeekThinkingModel(n) ||
    isQwenThinkingModel(n) ||
    n.includes("gpt-oss") ||
    n.includes("gemma-4")
  );
}

export function formatCatalogWarning(warning: CatalogWarning): string {
  switch (warning.code) {
    case "provider-not-responding":
      return `${warning.providerName} is ${warning.message}`;
    case "managed-command-unavailable":
    case "runtime-warning":
      return warning.message;
  }
}
