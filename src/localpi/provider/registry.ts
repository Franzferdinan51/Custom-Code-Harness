// ProviderConfig + built-in adapters. Borrowed from dutifuldev/localpi (MIT).
// https://github.com/dutifuldev/localpi/blob/main/src/localpi/provider-registry.ts

export type ProviderConfig = {
  readonly id: string;
  readonly name: string;
  readonly type: "openai-compatible" | "managed-runtime";
  readonly baseUrl?: string;
  readonly discover: boolean;
};

export function lmStudioProvider(baseUrl = "http://127.0.0.1:1234/v1"): ProviderConfig {
  return {
    id: "lmstudio",
    name: "LM Studio",
    type: "openai-compatible",
    baseUrl: normalizeBaseUrl(baseUrl),
    discover: true
  };
}

export function vllmProvider(baseUrl = "http://127.0.0.1:8000/v1"): ProviderConfig {
  return {
    id: "vllm",
    name: "vLLM",
    type: "openai-compatible",
    baseUrl: normalizeBaseUrl(baseUrl),
    discover: true
  };
}

export function openAiCompatibleProvider(
  id: string,
  name: string,
  baseUrl: string
): ProviderConfig {
  return {
    id,
    name,
    type: "openai-compatible",
    baseUrl: normalizeBaseUrl(baseUrl),
    discover: true
  };
}

export function managedProvider(id: string, name: string): ProviderConfig {
  return { id, name, type: "managed-runtime", discover: true };
}

export function dedupeProviders(
  configs: readonly ProviderConfig[]
): readonly ProviderConfig[] {
  const byId = new Map<string, ProviderConfig>();
  for (const c of configs) byId.set(c.id, c);
  return [...byId.values()];
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}
