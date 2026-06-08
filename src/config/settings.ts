// Settings.json loader. Settings live at $CH_HOME/settings.json.
// Order of precedence: CLI flag > settings.json > env var > default.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "./paths.js";
import { firstEnvValue, getProviderPreset, listProviderPresets, PRIMARY_PROVIDER_ID, type ProviderAuthMode } from "../providers/presets.js";

export interface ProviderProfile {
  id: string;
  /** For openai-compat providers: the base URL. */
  baseUrl?: string;
  /** API key. Optional; usually picked up from env. */
  apiKey?: string;
  /** OAuth/session token for providers with vendor auth flows. */
  oauthToken?: string;
  /** Which stored credential the runtime should prefer. */
  authMode?: ProviderAuthMode;
  /** Default model for this profile. */
  model?: string;
  /** Mark a profile as the default. Only one should have this. */
  default?: boolean;
  /** Free-form provider-specific options. */
  options?: Record<string, unknown>;
}

export interface Settings {
  $schema?: string;
  defaultProvider?: string;
  defaultModel?: string;
  providers: Record<string, ProviderProfile>;
  /** Tool-level configuration. */
  tools?: {
    /** Bash: max command runtime in ms. Default 30_000. */
    bashTimeoutMs?: number;
    /** Read: max bytes returned. Default 200_000. */
    readMaxBytes?: number;
    /** Write: require explicit --force? Default false. */
    writeConfirm?: boolean;
    /** Per-tool allowlist. If empty/undefined, all tools are available. */
    allowlist?: string[];
  };
  /** Provider routing per agent role (per-agent provider + model).
   *  Keys are sub-agent names from the AgentRegistry (explore, plan, etc)
   *  or arbitrary role names you set in custom agent files. */
  agentRouting?: Record<string, { provider?: string; model?: string }>;
  /** Per-agent routing as a flat model string. Shorthand for {model: "..."}. */
  agentModels?: Record<string, string>;
  /** Soft context cap. Compaction triggers when usage exceeds this fraction. */
  contextCompactionThreshold?: number;
  /** UI preferences. */
  ui?: {
    showTokenUsage?: boolean;
    color?: "auto" | "always" | "never";
    /** Show reasoning blocks separately. Default true. */
    showReasoning?: boolean;
    /** Show verbose agent/runtime logs. */
    verbose?: boolean;
    /** Show trace output like tool call names. */
    trace?: boolean;
  };
  /** Slash command customizations. */
  slash?: {
    /** Show the /help menu on startup. */
    showHelpOnStart?: boolean;
  };
  /** Sandbox mode. Default "host" (run on the local machine).
   *  Future: "docker" with image config, "ssh" with a remote host. */
  sandbox?: {
    mode: "host" | "docker";
    image?: string;
    /** Bind mounts into the sandbox. */
    mounts?: Array<{ host: string; container: string; mode?: "ro" | "rw" }>;
    /** Memory limit in MB. */
    memoryMb?: number;
    /** CPU limit (1.0 = 1 core). */
    cpus?: number;
    /** Network mode. Default "none" for security. */
    network?: "none" | "bridge";
  };
  /** Model failover. List of fallback models used when the primary fails. */
  failover?: Array<{ provider: string; model: string }>;
  /** Auto-load context files. Default true. */
  loadContextFiles?: boolean;
  /** Default thinking level. Affects system-prompt hint, not all providers support it. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Cron jobs. */
  cron?: {
    enabled?: boolean;
  };
  /** Hermes-style "personality" — a SOUL.md file to load. */
  personality?: string;
  /** Hooks — see hooks.ts. */
  hooks?: {
    /** Commands to run before each user turn. */
    preTurn?: string[];
    /** Commands to run after each user turn. */
    postTurn?: string[];
  };
  /** Bash approval flow. */
  approval?: {
    /** Mode. Default: "on-mutation". */
    mode?: "off" | "allowlist" | "blocklist" | "on-mutation" | "ask";
    /** Regex patterns the command must match to be auto-approved (mode=allowlist). */
    allowlist?: string[];
    /** Regex patterns that always require confirmation. */
    blocklist?: string[];
    /** Override all decisions. */
    override?: "always-allow" | "always-ask";
  };
  /** Per-model cost rates. Override the defaults. */
  cost?: {
    rates?: Array<{ match: string; input: number; output: number }>;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  defaultProvider: PRIMARY_PROVIDER_ID,
  defaultModel: "openai/gpt-oss-20b",
  providers: {
    [PRIMARY_PROVIDER_ID]: {
      id: PRIMARY_PROVIDER_ID,
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "openai/gpt-oss-20b",
      authMode: "optional",
      default: true,
    },
  },
  tools: {
    bashTimeoutMs: 30_000,
    readMaxBytes: 200_000,
    writeConfirm: false,
  },
  contextCompactionThreshold: 0.85,
  ui: {
    showTokenUsage: true,
    color: "auto",
  },
  slash: {
    showHelpOnStart: false,
  },
};

let cached: Settings | null = null;

export function loadSettings(): Settings {
  if (cached) return cached;
  let onDisk: Partial<Settings> = {};
  if (existsSync(paths.settings)) {
    try {
      onDisk = JSON.parse(readFileSync(paths.settings, "utf-8"));
    } catch (err) {
      // Bad JSON should not crash the harness. Log and proceed with defaults.
      console.error(`[settings] could not parse ${paths.settings}: ${(err as Error).message}`);
    }
  }
  cached = mergeWithEnv(merge(DEFAULT_SETTINGS, onDisk));
  return cached;
}

export function saveSettings(s: Settings): void {
  cached = s;
  writeFileSync(paths.settings, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

export function resetSettingsCache(): void {
  cached = null;
}

function merge<T>(base: T, override: Partial<T> | undefined): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (!override) return out as T;
  for (const [k, v] of Object.entries(override)) {
    const existing = out[k];
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      out[k] = merge(existing, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/** Apply env-var fallbacks for the most common settings. */
function mergeWithEnv(s: Settings): Settings {
  const out: Settings = structuredClone(s);
  const hostedOrder = ["anthropic", "openai", "codex", "xai", "grok", "minimax"];
  // Hosted credentials override the LM Studio factory default. User-picked
  // defaults from settings.json are kept when no hosted env vars are set.
  let hostedDefault: string | undefined;
  for (const id of hostedOrder) {
    const preset = getProviderPreset(id);
    const apiKey = firstEnvValue(preset?.apiKeyEnv);
    const oauthToken = firstEnvValue(preset?.oauthTokenEnv);
    if (apiKey || oauthToken) {
      hostedDefault = id;
      break;
    }
  }
  if (hostedDefault) {
    out.defaultProvider = hostedDefault;
  } else if (!out.defaultProvider || out.defaultProvider === PRIMARY_PROVIDER_ID) {
    out.defaultProvider = PRIMARY_PROVIDER_ID;
  }

  // LM Studio is always available with local defaults.
  const lmPreset = getProviderPreset(PRIMARY_PROVIDER_ID);
  if (lmPreset) {
    const existing = out.providers[PRIMARY_PROVIDER_ID];
    out.providers[PRIMARY_PROVIDER_ID] = {
      id: PRIMARY_PROVIDER_ID,
      baseUrl: existing?.baseUrl ?? firstEnvValue(lmPreset.baseUrlEnv) ?? lmPreset.defaultBaseUrl,
      apiKey: existing?.apiKey ?? firstEnvValue(lmPreset.apiKeyEnv),
      authMode: existing?.authMode ?? lmPreset.defaultAuthMode,
      model: existing?.model ?? firstEnvValue(lmPreset.modelEnv) ?? lmPreset.defaultModel,
      default: out.defaultProvider === PRIMARY_PROVIDER_ID,
      ...(existing?.options ? { options: existing.options } : {}),
    };
  }

  // Inject env-backed provider profiles when the user has none for them.
  for (const preset of listProviderPresets()) {
    if (preset.id === PRIMARY_PROVIDER_ID) continue;
    if (out.providers[preset.id]) continue;
    const apiKey = firstEnvValue(preset.apiKeyEnv);
    const oauthToken = firstEnvValue(preset.oauthTokenEnv);
    const baseUrl = firstEnvValue(preset.baseUrlEnv) ?? preset.defaultBaseUrl;
    const model = firstEnvValue(preset.modelEnv) ?? preset.defaultModel;
    const aliasRequested =
      preset.id === "codex" ? Boolean(process.env.CODEX_API_KEY || process.env.CODEX_BASE_URL || process.env.CODEX_MODEL || process.env.CODEX_OAUTH_TOKEN || process.env.OPENAI_OAUTH_TOKEN) :
      preset.id === "grok" ? Boolean(process.env.GROK_API_KEY || process.env.GROK_CODE_XAI_API_KEY || process.env.GROK_BASE_URL || process.env.GROK_MODEL || process.env.GROK_OAUTH_TOKEN) :
      preset.id === "vllm" ? Boolean(firstEnvValue(preset.baseUrlEnv)) :
      preset.id === "vllm-omni" ? Boolean(firstEnvValue(preset.baseUrlEnv)) :
      true;
    const isCoreHosted = preset.id === "openai" || preset.id === "anthropic";
    const shouldInject = isCoreHosted
      ? Boolean(apiKey)
      : aliasRequested && (Boolean(apiKey) || Boolean(oauthToken));
    if (!shouldInject) continue;
    out.providers[preset.id] = {
      id: preset.id,
      baseUrl,
      apiKey,
      oauthToken,
      authMode: oauthToken ? "oauth" : preset.defaultAuthMode,
      model,
      default: out.defaultProvider === preset.id,
    };
  }
  // Refresh env-backed credentials on profiles that already exist (e.g. from
  // settings.json) so oauth tokens and keys picked up from the shell win.
  for (const id of hostedOrder) {
    const preset = getProviderPreset(id);
    const profile = out.providers[id];
    if (!preset || !profile) continue;
    const aliasRequested =
      id === "codex" ? Boolean(process.env.CODEX_API_KEY || process.env.CODEX_BASE_URL || process.env.CODEX_MODEL || process.env.CODEX_OAUTH_TOKEN || process.env.OPENAI_OAUTH_TOKEN) :
      id === "grok" ? Boolean(process.env.GROK_API_KEY || process.env.GROK_CODE_XAI_API_KEY || process.env.GROK_BASE_URL || process.env.GROK_MODEL || process.env.GROK_OAUTH_TOKEN) :
      true;
    if (id !== "openai" && id !== "anthropic" && !aliasRequested) continue;
    const apiKey = firstEnvValue(preset.apiKeyEnv);
    const oauthToken = firstEnvValue(preset.oauthTokenEnv);
    if (apiKey) profile.apiKey = apiKey;
    if (oauthToken) {
      profile.oauthToken = oauthToken;
      profile.authMode = "oauth";
    }
    profile.default = out.defaultProvider === id;
  }
  if (out.defaultProvider && !out.defaultModel) {
    const def = out.providers[out.defaultProvider];
    out.defaultModel = def?.model;
  }
  return out;
}
