// Provider registry. Looks up provider instances by id, builds them
// from settings.json on demand, and caches them for the session.

import type { Provider } from "../types.js";
import type { Settings } from "../config/settings.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { AnthropicProvider } from "./anthropic.js";
import { log } from "../util/logger.js";

export class ProviderRegistry {
  private cache = new Map<string, Provider>();
  /** Externally registered providers (e.g. test stubs). */
  private external = new Map<string, Provider>();
  constructor(private readonly settings: Settings) {}

  list(): Provider[] {
    return [...this.cache.values(), ...this.external.values()];
  }

  /** Register a provider directly (bypasses settings.json lookup). */
  register(id: string, p: Provider): void {
    this.external.set(id, p);
  }

  /** Get the default provider, or undefined if none configured. */
  default(): Provider | undefined {
    const id = this.settings.defaultProvider;
    if (!id) return undefined;
    return this.get(id);
  }

  /** Get a provider by id; build it from settings if not yet cached. */
  get(id: string): Provider | undefined {
    if (this.external.has(id)) return this.external.get(id);
    if (this.cache.has(id)) return this.cache.get(id);
    const profile = this.settings.providers[id];
    if (!profile) return undefined;
    const p = buildProvider(id, profile, this.settings);
    if (p) this.cache.set(id, p);
    return p;
  }

  /** List the configured provider ids (in settings.json), even if not built. */
  configuredIds(): string[] {
    return [...new Set([...Object.keys(this.settings.providers), ...this.external.keys()])];
  }
}

function buildProvider(id: string, profile: Settings["providers"][string], settings: Settings): Provider | undefined {
  // Anthropic is the only non-OpenAI-compat provider we ship.
  if (id === "anthropic" || id.startsWith("anthropic-")) {
    const apiKey = profile.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      log.warn(`provider ${id}: missing apiKey (set ANTHROPIC_API_KEY or settings.json)`);
      return undefined;
    }
    return new AnthropicProvider({
      apiKey,
      defaultModel: profile.model ?? settings.defaultModel ?? "claude-sonnet-4-5",
      baseUrl: profile.baseUrl,
    });
  }
  // Everything else: openai-compat.
  const apiKey = profile.apiKey ?? process.env.OPENAI_API_KEY ?? process.env[envKeyFor(id)];
  const baseUrl =
    profile.baseUrl ??
    (id === "openai" ? "https://api.openai.com/v1" : process.env.OPENAI_BASE_URL);
  if (!baseUrl) {
    log.warn(`provider ${id}: missing baseUrl`);
    return undefined;
  }
  return new OpenAICompatProvider({
    id,
    baseUrl,
    apiKey,
    defaultModel: profile.model ?? settings.defaultModel ?? "gpt-4o",
  });
}

function envKeyFor(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}
