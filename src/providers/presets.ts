export type ProviderAuthMode = "apiKey" | "oauth" | "optional";

export interface ProviderPreset {
  id: string;
  label: string;
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
}

const PRESETS: Record<string, ProviderPreset> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    baseUrlEnv: ["OPENAI_BASE_URL"],
    modelEnv: ["OPENAI_MODEL"],
    authModes: ["apiKey"],
    defaultAuthMode: "apiKey",
    authDocsUrl: "https://developers.openai.com/api-reference/authentication",
    description: "Hosted OpenAI API. Uses Bearer API keys.",
  },
  codex: {
    id: "codex",
    label: "OpenAI / Codex",
    protocol: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.1",
    apiKeyEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
    baseUrlEnv: ["CODEX_BASE_URL", "OPENAI_BASE_URL"],
    modelEnv: ["CODEX_MODEL", "OPENAI_MODEL"],
    authModes: ["apiKey"],
    defaultAuthMode: "apiKey",
    authDocsUrl: "https://developers.openai.com/api-reference/authentication",
    description: "OpenAI-backed coding profile for Codex-style use.",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-5",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    baseUrlEnv: ["ANTHROPIC_BASE_URL"],
    modelEnv: ["ANTHROPIC_MODEL"],
    authModes: ["apiKey"],
    defaultAuthMode: "apiKey",
    description: "Hosted Anthropic API.",
  },
  xai: {
    id: "xai",
    label: "xAI",
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
    description: "Friendly Grok profile. Supports xAI browser auth or direct API keys.",
  },
  minimax: {
    id: "minimax",
    label: "MiniMax",
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
    description: "MiniMax OpenAI-compatible API. Supports Token Plan OAuth-style flows or direct API keys.",
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio",
    protocol: "openai",
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    defaultModel: "openai/gpt-oss-20b",
    apiKeyEnv: ["LMSTUDIO_API_KEY", "LM_API_TOKEN"],
    baseUrlEnv: ["LMSTUDIO_BASE_URL"],
    modelEnv: ["LMSTUDIO_MODEL"],
    authModes: ["optional", "apiKey"],
    defaultAuthMode: "optional",
    authDocsUrl: "https://lmstudio.ai/docs/developer/rest/quickstart",
    description: "Local LM Studio server. API key is optional unless auth is enabled.",
  },
};

export function listProviderPresets(): ProviderPreset[] {
  return Object.values(PRESETS);
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
