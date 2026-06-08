export interface ProviderPreset {
  id: string;
  label: string;
  protocol: "openai" | "anthropic";
  defaultBaseUrl?: string;
  defaultModel: string;
  apiKeyEnv: string[];
  baseUrlEnv?: string[];
  modelEnv?: string[];
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
    description: "Hosted Anthropic API.",
  },
  xai: {
    id: "xai",
    label: "xAI",
    protocol: "openai",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4.3",
    apiKeyEnv: ["XAI_API_KEY"],
    baseUrlEnv: ["XAI_BASE_URL"],
    modelEnv: ["XAI_MODEL"],
    description: "xAI Grok API via OpenAI-compatible endpoints.",
  },
  grok: {
    id: "grok",
    label: "Grok",
    protocol: "openai",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4.3",
    apiKeyEnv: ["GROK_API_KEY", "XAI_API_KEY"],
    baseUrlEnv: ["GROK_BASE_URL", "XAI_BASE_URL"],
    modelEnv: ["GROK_MODEL", "XAI_MODEL"],
    description: "Friendly alias for the xAI Grok API.",
  },
  minimax: {
    id: "minimax",
    label: "MiniMax",
    protocol: "openai",
    defaultBaseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M2.7",
    apiKeyEnv: ["MINIMAX_API_KEY"],
    baseUrlEnv: ["MINIMAX_BASE_URL"],
    modelEnv: ["MINIMAX_MODEL"],
    description: "MiniMax OpenAI-compatible API. Default model M2.7 — override with MINIMAX_MODEL (e.g. MiniMax-M3).",
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
