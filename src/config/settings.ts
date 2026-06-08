// Settings.json loader. Settings live at $CH_HOME/settings.json.
// Order of precedence: CLI flag > settings.json > env var > default.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "./paths.js";
import { firstEnvValue, getProviderPreset, listProviderPresets } from "../providers/presets.js";

export interface ProviderProfile {
  id: string;
  /** For openai-compat providers: the base URL. */
  baseUrl?: string;
  /** API key. Optional; usually picked up from env. */
  apiKey?: string;
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
  providers: {},
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
  const out: Settings = { ...s };
  const presetOrder = ["anthropic", "openai", "codex", "xai", "grok", "minimax", "lmstudio"];
  // Default provider: prefer env-inferred if no settings.json entry.
  if (!out.defaultProvider) {
    for (const id of presetOrder) {
      const preset = getProviderPreset(id);
      const apiKey = firstEnvValue(preset?.apiKeyEnv);
      const baseUrl = firstEnvValue(preset?.baseUrlEnv);
      if (apiKey || (id === "lmstudio" && (baseUrl || process.env.LM_API_TOKEN || process.env.LMSTUDIO_BASE_URL))) {
        out.defaultProvider = id;
        break;
      }
    }
  }
  // Inject env-backed provider profiles when the user has none for them.
  for (const preset of listProviderPresets()) {
    if (out.providers[preset.id]) continue;
    const apiKey = firstEnvValue(preset.apiKeyEnv);
    const baseUrl = firstEnvValue(preset.baseUrlEnv) ?? preset.defaultBaseUrl;
    const model = firstEnvValue(preset.modelEnv) ?? preset.defaultModel;
    const aliasRequested =
      preset.id === "codex" ? Boolean(process.env.CODEX_API_KEY || process.env.CODEX_BASE_URL || process.env.CODEX_MODEL) :
      preset.id === "grok" ? Boolean(process.env.GROK_API_KEY || process.env.GROK_BASE_URL || process.env.GROK_MODEL) :
      true;
    const shouldInject = aliasRequested && (Boolean(apiKey) || (preset.id === "lmstudio" && Boolean(firstEnvValue(preset.baseUrlEnv) || process.env.LM_API_TOKEN)));
    if (!shouldInject && preset.id !== "openai" && preset.id !== "anthropic") continue;
    if ((preset.id === "openai" || preset.id === "anthropic") && !apiKey) continue;
    out.providers[preset.id] = {
      id: preset.id,
      baseUrl,
      apiKey,
      model,
      default: out.defaultProvider === preset.id,
    };
  }
  if (out.defaultProvider && !out.defaultModel) {
    const def = out.providers[out.defaultProvider];
    out.defaultModel = def?.model;
  }
  return out;
}
