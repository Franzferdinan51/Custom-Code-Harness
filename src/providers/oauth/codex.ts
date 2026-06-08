// Codex (ChatGPT) OAuth device-code login flow.
// Mirrors the OpenCode / OpenClaw device auth sequence against auth.openai.com.

import { saveSettings, type Settings } from "../../config/settings.js";
import { getProviderPreset } from "../presets.js";

const AUTH_BASE = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CALLBACK_URL = `${AUTH_BASE}/deviceauth/callback`;
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_MS = 5_000;
const MIN_POLL_MS = 1_000;

export interface CodexOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface CodexDeviceCodePrompt {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalMs: number;
  expiresInMs: number;
}

export interface CodexOAuthLoginHooks {
  onProgress?: (message: string) => void;
  onDeviceCode?: (prompt: CodexDeviceCodePrompt) => void | Promise<void>;
  openBrowser?: (url: string) => void | Promise<void>;
  fetchFn?: typeof fetch;
}

function authHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    originator: "codingharness",
    "User-Agent": "codingharness/0.2.2",
  };
}

function trim(s: unknown): string | undefined {
  return typeof s === "string" && s.trim() ? s.trim() : undefined;
}

function parseIntervalMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.max(MIN_POLL_MS, Math.floor(value * 1000));
  }
  if (typeof value === "string") {
    const n = parseInt(value.trim(), 10);
    if (Number.isFinite(n) && n > 0) return Math.max(MIN_POLL_MS, n * 1000);
  }
  return DEFAULT_POLL_MS;
}

function formatOAuthError(prefix: string, status: number, bodyText: string): string {
  try {
    const j = JSON.parse(bodyText) as { error?: string; error_description?: string };
    if (j.error && j.error_description) return `${prefix}: ${j.error} (${j.error_description})`;
    if (j.error) return `${prefix}: ${j.error}`;
  } catch { /* ignore */ }
  const snippet = bodyText.replace(/\s+/g, " ").trim().slice(0, 200);
  return snippet ? `${prefix}: HTTP ${status} ${snippet}` : `${prefix}: HTTP ${status}`;
}

/** Build the browser verification URL (fallback when auto-open fails). */
export function buildCodexBrowserAuthUrl(prompt: CodexDeviceCodePrompt): string {
  const base = prompt.verificationUrl || `${AUTH_BASE}/codex/device`;
  const u = new URL(base);
  if (!u.searchParams.has("user_code")) u.searchParams.set("user_code", prompt.userCode);
  return u.toString();
}

/** Step 1: request a device user code. */
export async function requestCodexDeviceCode(fetchFn: typeof fetch = fetch): Promise<CodexDeviceCodePrompt> {
  const res = await fetchFn(`${AUTH_BASE}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("Codex device login is not enabled. Try opening the browser auth URL instead.");
    }
    throw new Error(formatOAuthError("device code request failed", res.status, bodyText));
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error("device code response was not valid JSON");
  }
  const deviceAuthId = trim(body.device_auth_id);
  const userCode = trim(body.user_code) ?? trim(body.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error("device code response missing device_auth_id or user_code");
  }
  return {
    deviceAuthId,
    userCode,
    verificationUrl: `${AUTH_BASE}/codex/device`,
    intervalMs: parseIntervalMs(body.interval),
    expiresInMs: DEVICE_TIMEOUT_MS,
  };
}

/** Step 2: poll until the user completes browser auth. */
export async function pollCodexDeviceAuthorization(
  prompt: CodexDeviceCodePrompt,
  fetchFn: typeof fetch = fetch,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  const deadline = Date.now() + DEVICE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetchFn(`${AUTH_BASE}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: authHeaders("application/json"),
      body: JSON.stringify({
        device_auth_id: prompt.deviceAuthId,
        user_code: prompt.userCode,
      }),
    });
    const bodyText = await res.text();
    if (res.ok) {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        throw new Error("device authorization response was not valid JSON");
      }
      const authorizationCode = trim(body.authorization_code);
      const codeVerifier = trim(body.code_verifier);
      if (!authorizationCode || !codeVerifier) {
        throw new Error("device authorization response missing exchange code");
      }
      return { authorizationCode, codeVerifier };
    }
    if (res.status === 403 || res.status === 404) {
      const remaining = Math.max(0, deadline - Date.now());
      const delay = Math.min(Math.max(prompt.intervalMs, MIN_POLL_MS), remaining);
      await sleep(delay);
      continue;
    }
    throw new Error(formatOAuthError("device authorization failed", res.status, bodyText));
  }
  throw new Error("device authorization timed out after 15 minutes");
}

/** Step 3: exchange authorization code for OAuth tokens. */
export async function exchangeCodexAuthorizationCode(
  authorizationCode: string,
  codeVerifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<CodexOAuthTokens> {
  const res = await fetchFn(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: authHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: DEVICE_CALLBACK_URL,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(formatOAuthError("OAuth token exchange failed", res.status, bodyText));
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error("OAuth token response was not valid JSON");
  }
  const accessToken = trim(body.access_token);
  const refreshToken = trim(body.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new Error("OAuth token exchange succeeded but tokens were missing");
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/** Refresh an expired Codex OAuth access token. */
export async function refreshCodexOAuthToken(
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<CodexOAuthTokens> {
  const res = await fetchFn(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: authHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(formatOAuthError("OAuth token refresh failed", res.status, bodyText));
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error("OAuth refresh response was not valid JSON");
  }
  const accessToken = trim(body.access_token);
  const nextRefresh = trim(body.refresh_token) ?? refreshToken;
  if (!accessToken) throw new Error("OAuth refresh succeeded but access_token was missing");
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken,
    refreshToken: nextRefresh,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/** Full interactive device-code login. */
export async function loginCodexOAuth(hooks: CodexOAuthLoginHooks = {}): Promise<CodexOAuthTokens> {
  const fetchFn = hooks.fetchFn ?? fetch;
  hooks.onProgress?.("Requesting device code…");
  const prompt = await requestCodexDeviceCode(fetchFn);
  await hooks.onDeviceCode?.(prompt);
  const browserUrl = buildCodexBrowserAuthUrl(prompt);
  if (hooks.openBrowser) {
    await hooks.openBrowser(browserUrl);
  }
  hooks.onProgress?.(`Visit ${browserUrl} and enter code ${prompt.userCode}`);
  hooks.onProgress?.("Waiting for device authorization…");
  const auth = await pollCodexDeviceAuthorization(prompt, fetchFn);
  hooks.onProgress?.("Exchanging device code for OAuth tokens…");
  return exchangeCodexAuthorizationCode(auth.authorizationCode, auth.codeVerifier, fetchFn);
}

/** Apply Codex OAuth tokens to an in-memory settings object (no disk write). */
export function applyCodexOAuthTokens(
  settings: Settings,
  tokens: CodexOAuthTokens,
  opts?: { makeDefault?: boolean; model?: string },
): Settings {
  const preset = getProviderPreset("codex");
  const profile = settings.providers.codex ?? {
    id: "codex",
    baseUrl: preset?.defaultBaseUrl,
    model: preset?.defaultModel,
  };
  profile.oauthToken = tokens.accessToken;
  profile.authMode = "oauth";
  profile.options = {
    ...(profile.options ?? {}),
    codexOAuth: {
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    },
  };
  if (opts?.model) profile.model = opts.model;
  settings.providers.codex = profile;
  if (opts?.makeDefault !== false) {
    settings.defaultProvider = "codex";
    settings.defaultModel = profile.model ?? settings.defaultModel;
  }
  return settings;
}

/** Persist Codex OAuth tokens into settings.json. */
export function saveCodexOAuthTokens(
  settings: Settings,
  tokens: CodexOAuthTokens,
  opts?: { makeDefault?: boolean; model?: string },
): Settings {
  applyCodexOAuthTokens(settings, tokens, opts);
  saveSettings(settings);
  return settings;
}

/** Load stored refresh token from a provider profile. */
export function loadCodexRefreshToken(profile: Settings["providers"][string] | undefined): string | undefined {
  const fromOptions = profile?.options?.codexOAuth as { refreshToken?: string } | undefined;
  return trim(fromOptions?.refreshToken);
}

/** Refresh tokens in settings when access token is near expiry. */
export async function ensureFreshCodexTokens(
  settings: Settings,
  fetchFn: typeof fetch = fetch,
): Promise<Settings> {
  const profile = settings.providers.codex;
  if (!profile || profile.authMode !== "oauth") return settings;
  const meta = profile.options?.codexOAuth as { refreshToken?: string; expiresAt?: number } | undefined;
  const refreshToken = trim(meta?.refreshToken);
  const expiresAt = typeof meta?.expiresAt === "number" ? meta.expiresAt : 0;
  if (!refreshToken) return settings;
  if (expiresAt > Date.now() + 60_000) return settings;
  const tokens = await refreshCodexOAuthToken(refreshToken, fetchFn);
  saveCodexOAuthTokens(settings, tokens, { makeDefault: settings.defaultProvider === "codex" });
  return settings;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}