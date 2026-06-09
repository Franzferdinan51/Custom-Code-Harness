import type { ProviderCapabilities } from "../types.js";

export type ProviderAuthMode = "apiKey" | "oauth" | "optional";

/** Primary local provider — preferred default when no hosted credentials are set. */
export const PRIMARY_PROVIDER_ID = "lmstudio";

/** First-class hosted providers (always surfaced prominently in UI/catalog). */
export const HOSTED_PROVIDER_ORDER = ["openai", "grok", "minimax", "codex", "anthropic", "xai", "openrouter"] as const;

/** Additional local inference backends. */
export const LOCAL_PROVIDER_ORDER = ["vllm", "vllm-omni"] as const;

export type ProviderTier = "primary" | "hosted" | "local";

export interface ProviderPreset {
  id: string;
  label: string;
  /** Catalog tier: primary default, first-class hosted, or local alt. */
  tier: ProviderTier;
  protocol: "openai" | "anthropic";
  defaultBaseUrl?: string;
  defaultModel: string;
  apiKeyEnv: string[];
  oauthTokenEnv?: string[];
  baseUrlEnv?: string[];
  modelEnv?: string[];
  authModes: ProviderAuthMode[];
  defaultAuthMode: ProviderAuthMode;
  authDocsUrl?: string;
  authLaunchUrl?: string;
  description?: string;
  /** Declared multimodal / tooling capabilities for this preset. */
  capabilities?: ProviderCapabilities;
}

const PRESETS: Record<string, ProviderPreset> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    tier: "hosted",
    protocol: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    baseUrlEnv: ["OPENAI_BASE_URL"],
    modelEnv: ["OPENAI_MODEL"],
    authModes: ["apiKey"],
    defaultAuthMode: "apiKey",
    authDocsUrl: "https://developers.openai.com/api-reference/authentication",
    description: "First-class hosted provider. OpenAI API via API key.",
    capabilities: { imageInput: true, reasoning: true },
  },
  codex: {
    id: "codex",
    label: "OpenAI / Codex",
    tier: "hosted",
    protocol: "openai",
    defaultBaseUrl: "https://chatgpt.com/backend-api/codex",
    defaultModel: "gpt-5.1",
    apiKeyEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
    oauthTokenEnv: ["CODEX_OAUTH_TOKEN", "OPENAI_OAUTH_TOKEN", "CODEX_TOKEN"],
    baseUrlEnv: ["CODEX_BASE_URL", "OPENAI_BASE_URL"],
    modelEnv: ["CODEX_MODEL", "OPENAI_MODEL"],
    authModes: ["oauth", "apiKey"],
    defaultAuthMode: "oauth",
    authDocsUrl: "https://developers.openai.com/codex/auth",
    authLaunchUrl: "https://auth.openai.com/codex/device",
    description:
      "OpenAI Codex via ChatGPT OAuth (device code) or API key. OAuth uses the Responses API; API keys use OpenAI-compatible chat completions.",
    capabilities: { omni: true, imageInput: true, reasoning: true, responsesApi: true },
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    tier: "hosted",
    protocol: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-5",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    baseUrlEnv: ["ANTHROPIC_BASE_URL"],
    modelEnv: ["ANTHROPIC_MODEL"],
    authModes: ["apiKey"],
    defaultAuthMode: "apiKey",
    description: "First-class hosted provider. Anthropic Claude API.",
    capabilities: { imageInput: true, reasoning: true },
  },
  xai: {
    id: "xai",
    label: "xAI",
    tier: "hosted",
    protocol: "openai",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4.3",
    apiKeyEnv: ["XAI_API_KEY"],
    oauthTokenEnv: ["XAI_OAUTH_TOKEN"],
    baseUrlEnv: ["XAI_BASE_URL"],
    modelEnv: ["XAI_MODEL"],
    authModes: ["oauth", "apiKey"],
    defaultAuthMode: "oauth",
    authDocsUrl: "https://docs.x.ai/build/overview",
    authLaunchUrl: "https://x.ai",
    description: "xAI Grok API. Supports vendor auth flows or direct API keys.",
  },
  grok: {
    id: "grok",
    label: "Grok",
    tier: "hosted",
    protocol: "openai",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4.3",
    apiKeyEnv: ["GROK_API_KEY", "XAI_API_KEY", "GROK_CODE_XAI_API_KEY"],
    oauthTokenEnv: ["GROK_OAUTH_TOKEN", "XAI_OAUTH_TOKEN"],
    baseUrlEnv: ["GROK_BASE_URL", "XAI_BASE_URL"],
    modelEnv: ["GROK_MODEL", "XAI_MODEL"],
    authModes: ["oauth", "apiKey"],
    defaultAuthMode: "oauth",
    authDocsUrl: "https://docs.x.ai/build/overview",
    authLaunchUrl: "https://x.ai",
    description: "First-class hosted provider. Grok via OAuth or xAI API key.",
    capabilities: { imageInput: true, reasoning: true },
  },
  minimax: {
    id: "minimax",
    label: "MiniMax",
    tier: "hosted",
    protocol: "openai",
    defaultBaseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M2.7",
    apiKeyEnv: ["MINIMAX_API_KEY"],
    oauthTokenEnv: ["MINIMAX_OAUTH_TOKEN", "MINIMAX_AUTH_TOKEN"],
    baseUrlEnv: ["MINIMAX_BASE_URL"],
    modelEnv: ["MINIMAX_MODEL"],
    authModes: ["oauth", "apiKey"],
    defaultAuthMode: "oauth",
    authDocsUrl: "https://platform.minimax.io/docs/token-plan/openclaw",
    authLaunchUrl: "https://platform.minimax.io/docs/token-plan/openclaw",
    description: "First-class hosted provider. MiniMax via OAuth or API key.",
    capabilities: { reasoning: true },
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio",
    tier: "primary",
    protocol: "openai",
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    defaultModel: "openai/gpt-oss-20b",
    apiKeyEnv: ["LMSTUDIO_API_KEY", "LM_API_TOKEN"],
    baseUrlEnv: ["LMSTUDIO_BASE_URL"],
    modelEnv: ["LMSTUDIO_MODEL"],
    authModes: ["optional", "apiKey"],
    defaultAuthMode: "optional",
    authDocsUrl: "https://lmstudio.ai/docs/developer/rest/quickstart",
    authLaunchUrl: "https://lmstudio.ai/",
    description:
      "Default local provider (:1234). OpenAI, Grok, MiniMax, and Codex remain first-class — switch with /provider <id>.",
    capabilities: { imageInput: true, reasoning: true },
  },
  vllm: {
    id: "vllm",
    label: "vLLM",
    tier: "local",
    protocol: "openai",
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    defaultModel: "meta-llama/Llama-3.1-8B-Instruct",
    apiKeyEnv: ["VLLM_API_KEY"],
    baseUrlEnv: ["VLLM_BASE_URL"],
    modelEnv: ["VLLM_MODEL"],
    authModes: ["optional", "apiKey"],
    defaultAuthMode: "optional",
    authDocsUrl: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html",
    description:
      "Local vLLM OpenAI-compatible server. Speaks /v1/chat/completions and /v1/models. API key is optional unless --api-key is enabled on the server.",
    capabilities: { reasoning: true },
  },
  "vllm-omni": {
    id: "vllm-omni",
    label: "vLLM-Omni",
    tier: "local",
    protocol: "openai",
    defaultBaseUrl: "http://127.0.0.1:8090/v1",
    defaultModel: "Qwen/Qwen3-Omni-30B-A3B-Instruct",
    apiKeyEnv: ["VLLM_OMNI_API_KEY", "VLLM_API_KEY"],
    baseUrlEnv: ["VLLM_OMNI_BASE_URL", "VLLM_OMNI_URL"],
    modelEnv: ["VLLM_OMNI_MODEL"],
    authModes: ["optional", "apiKey"],
    defaultAuthMode: "optional",
    authDocsUrl: "https://vllm-omni.readthedocs.io/en/latest/getting_started/quickstart/",
    description:
      "Local vLLM-Omni server. Omni-modality (text/image/audio/video) inference via an OpenAI-compatible /v1 surface, plus expanded /v1/image/, /v1/audio/, /v1/video/ endpoints for diffusion + TTS. API key is optional unless --api-key is enabled.",
    capabilities: { omni: true, imageOutput: true, imageInput: true, reasoning: true },
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    tier: "hosted",
    protocol: "openai",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-3.5-sonnet",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    baseUrlEnv: ["OPENROUTER_BASE_URL"],
    modelEnv: ["OPENROUTER_MODEL"],
    authModes: ["apiKey"],
    defaultAuthMode: "apiKey",
    authDocsUrl: "https://openrouter.ai/docs/api-reference/authentication",
    authLaunchUrl: "https://openrouter.ai/keys",
    description:
      "First-class hosted provider. OpenRouter routes a single API key to 100+ models across OpenAI, Anthropic, Google, Meta, Mistral, and others. Use any of the model ids from https://openrouter.ai/models (e.g. 'anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'meta-llama/llama-3.1-405b-instruct'). The 'reasoning' capability is set so the harness forwards extended thinking tokens where the upstream model supports it.",
    capabilities: { imageInput: true, reasoning: true },
  },
};

function tierRank(tier: ProviderTier): number {
  if (tier === "primary") return 0;
  if (tier === "hosted") return 1;
  return 2;
}

function orderInTier(id: string, tier: ProviderTier): number {
  if (tier === "hosted") {
    const i = (HOSTED_PROVIDER_ORDER as readonly string[]).indexOf(id);
    return i === -1 ? 999 : i;
  }
  if (tier === "local") {
    const i = (LOCAL_PROVIDER_ORDER as readonly string[]).indexOf(id);
    return i === -1 ? 999 : i;
  }
  return 0;
}

export function listProviderPresets(): ProviderPreset[] {
  return Object.values(PRESETS).sort((a, b) => {
    const tr = tierRank(a.tier) - tierRank(b.tier);
    if (tr !== 0) return tr;
    const oa = orderInTier(a.id, a.tier);
    const ob = orderInTier(b.id, b.tier);
    if (oa !== ob) return oa - ob;
    return a.label.localeCompare(b.label);
  });
}

export function providerCatalogGroups(): { primary: ProviderPreset[]; hosted: ProviderPreset[]; local: ProviderPreset[] } {
  const all = listProviderPresets();
  return {
    primary: all.filter((p) => p.tier === "primary"),
    hosted: all.filter((p) => p.tier === "hosted"),
    local: all.filter((p) => p.tier === "local"),
  };
}

export function presetToCatalogEntry(p: ProviderPreset): Record<string, unknown> {
  return {
    id: p.id,
    label: p.label,
    tier: p.tier,
    description: p.description ?? "",
    protocol: p.protocol,
    defaultBaseUrl: p.defaultBaseUrl,
    defaultModel: p.defaultModel,
    authModes: p.authModes,
    defaultAuthMode: p.defaultAuthMode,
    apiKeyEnv: p.apiKeyEnv,
    oauthTokenEnv: p.oauthTokenEnv ?? [],
    authDocsUrl: p.authDocsUrl,
    authLaunchUrl: p.authLaunchUrl,
    capabilities: p.capabilities,
  };
}

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return PRESETS[id];
}

export function firstEnvValue(keys: string[] | undefined): string | undefined {
  if (!keys) return undefined;
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}
