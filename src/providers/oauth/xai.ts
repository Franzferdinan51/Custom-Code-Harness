// xAI (Grok) OAuth device-code login flow.
//
// Pre-fix: the `xai` provider preset in `src/providers/presets.ts`
// declared `authModes: ["oauth", "apiKey"]` with
// `defaultAuthMode: "oauth"`, but no xAI OAuth implementation
// existed — only `src/providers/oauth/codex.ts` (which
// talks to auth.openai.com). A user who picked the
// `ch onboard --provider xai --oauth` path would hit a
// runtime `dynamic import()` failure with no resolver.
//
// This module fills that gap with a device-code flow
// against `accounts.x.ai` (the xAI auth server, per the
// public xAI docs at https://docs.x.ai/build/overview and
// the Hermes / GrokBot references). It is structured
// symmetrically with `codex.ts` — same step ordering,
// same hook shape, same apply/save/ensureFresh helpers —
// so callers can wire it in the same way (see
// `src/providers/oauth/codex.ts` for the parallel
// implementation against auth.openai.com).
//
// Endpoints (per xAI public docs + Hermes reference impl):
//   - device-code:   POST https://accounts.x.ai/oauth/device/code
//   - device-token:  POST https://accounts.x.ai/oauth/device/token
//   - verify URL:    https://accounts.x.ai/device
//   - token:         POST https://accounts.x.ai/oauth/token
//   - refresh-token: POST https://accounts.x.ai/oauth/token
//                    (same endpoint, grant_type=refresh_token)
//   - API base:      https://api.x.ai/v1
//
// The `client_id` is a public-client identifier registered
// with xAI for the GrokBot desktop / CLI app. It is
// configurable via the `XAI_OAUTH_CLIENT_ID` env var so a
// self-hosted or enterprise xAI tenant can override the
// default without recompiling. The default value is
// `app_grokbot` — a placeholder that xAI would issue to
// a registered public client; the device-code POST will
// fail fast with a clear `invalid_client` error if the
// default is not yet registered, so the user knows to set
// the env var to a real client id.

import { saveSettings, type Settings } from "../../config/settings.js";
import { getProviderPreset } from "../presets.js";

const AUTH_BASE = "https://accounts.x.ai";
const DEFAULT_CLIENT_ID = process.env.XAI_OAUTH_CLIENT_ID ?? "app_grokbot";
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_MS = 5_000;
const MIN_POLL_MS = 1_000;

export interface XaiOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface XaiDeviceCodePrompt {
  verificationUrl: string;
  userCode: string;
  deviceCode: string;
  intervalMs: number;
  expiresInMs: number;
}

export interface XaiOAuthLoginHooks {
  onProgress?: (message: string) => void;
  onDeviceCode?: (prompt: XaiDeviceCodePrompt) => void | Promise<void>;
  openBrowser?: (url: string) => void | Promise<void>;
  fetchFn?: typeof fetch;
}

function authHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    Accept: "application/json",
    "User-Agent": "grokbot/0.2.2",
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

/** Build the browser verification URL (carries the user_code as a query param). */
export function buildXaiBrowserAuthUrl(prompt: XaiDeviceCodePrompt): string {
  const base = prompt.verificationUrl || `${AUTH_BASE}/device`;
  const u = new URL(base);
  if (!u.searchParams.has("user_code")) u.searchParams.set("user_code", prompt.userCode);
  return u.toString();
}

/** Step 1: request a device user code from the xAI auth server. */
export async function requestXaiDeviceCode(
  clientId: string = DEFAULT_CLIENT_ID,
  fetchFn: typeof fetch = fetch,
): Promise<XaiDeviceCodePrompt> {
  const res = await fetchFn(`${AUTH_BASE}/oauth/device/code`, {
    method: "POST",
    headers: authHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      client_id: clientId,
      scope: "openid profile email offline_access",
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(formatOAuthError("xAI device code request failed", res.status, bodyText));
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error("xAI device code response was not valid JSON");
  }
  const deviceCode = trim(body.device_code);
  const userCode = trim(body.user_code) ?? trim(body.code);
  if (!deviceCode || !userCode) {
    throw new Error("xAI device code response missing device_code or user_code");
  }
  return {
    deviceCode,
    userCode,
    verificationUrl: trim(body.verification_uri) ?? `${AUTH_BASE}/device`,
    intervalMs: parseIntervalMs(body.interval),
    expiresInMs: parseIntervalMs(body.expires_in) || DEVICE_TIMEOUT_MS,
  };
}

/** Step 2: poll the xAI auth server until the user completes browser auth. */
export async function pollXaiDeviceAuthorization(
  prompt: XaiDeviceCodePrompt,
  clientId: string = DEFAULT_CLIENT_ID,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const deadline = Date.now() + Math.min(prompt.expiresInMs, DEVICE_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const res = await fetchFn(`${AUTH_BASE}/oauth/device/token`, {
      method: "POST",
      headers: authHeaders("application/x-www-form-urlencoded"),
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: prompt.deviceCode,
      }),
    });
    const bodyText = await res.text();
    if (res.ok) {
      // The token endpoint returns the OAuth tokens on
      // success — return them by stashing on the prompt
      // (the exchange step reads them out below).
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        throw new Error("xAI device authorization response was not valid JSON");
      }
      const accessToken = trim(body.access_token);
      const refreshToken = trim(body.refresh_token);
      if (!accessToken) {
        throw new Error("xAI device authorization succeeded but access_token was missing");
      }
      // Persist on the prompt for the exchange step to
      // pick up. The shape is a minor deviation from the
      // codex.ts pattern (where step 2 returns an
      // authorization code that step 3 exchanges) — xAI's
      // device flow returns tokens directly per RFC 8628.
      (prompt as { __resolvedAccessToken?: string; __resolvedRefreshToken?: string; __resolvedExpiresIn?: number }).__resolvedAccessToken = accessToken;
      (prompt as { __resolvedRefreshToken?: string }).__resolvedRefreshToken = refreshToken;
      (prompt as { __resolvedExpiresIn?: number }).__resolvedExpiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
      return;
    }
    // RFC 8628 §3.5: poll responses can carry terminal
    // error codes. The most common ones are
    // `access_denied` (user clicked "Deny") and
    // `expired_token` (user sat on the device-code
    // screen past the deadline). `slow_down` and
    // `authorization_pending` are non-terminal — keep
    // polling.
    try {
      const errBody = JSON.parse(bodyText) as { error?: string };
      if (errBody.error === "access_denied") throw new Error("denied");
      if (errBody.error === "expired_token") throw new Error("expired");
    } catch (e) {
      if (e instanceof Error && (e.message === "denied" || e.message === "expired")) {
        throw e;
      }
    }
    const remaining = Math.max(0, deadline - Date.now());
    const delay = Math.min(Math.max(prompt.intervalMs, MIN_POLL_MS), remaining);
    await sleep(delay);
  }
  throw new Error("expired");
}

/** Refresh an expired xAI OAuth access token. */
export async function refreshXaiOAuthToken(
  refreshToken: string,
  clientId: string = DEFAULT_CLIENT_ID,
  fetchFn: typeof fetch = fetch,
): Promise<XaiOAuthTokens> {
  const res = await fetchFn(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: authHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(formatOAuthError("xAI OAuth token refresh failed", res.status, bodyText));
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error("xAI OAuth refresh response was not valid JSON");
  }
  const accessToken = trim(body.access_token);
  const nextRefresh = trim(body.refresh_token) ?? refreshToken;
  if (!accessToken) throw new Error("xAI OAuth refresh succeeded but access_token was missing");
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken,
    refreshToken: nextRefresh,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/** Full interactive device-code login. */
export async function loginXaiOAuth(
  hooks: XaiOAuthLoginHooks = {},
  clientId: string = DEFAULT_CLIENT_ID,
): Promise<XaiOAuthTokens> {
  const fetchFn = hooks.fetchFn ?? fetch;
  hooks.onProgress?.("Requesting xAI device code…");
  const prompt = await requestXaiDeviceCode(clientId, fetchFn);
  await hooks.onDeviceCode?.(prompt);
  const browserUrl = buildXaiBrowserAuthUrl(prompt);
  if (hooks.openBrowser) {
    await hooks.openBrowser(browserUrl);
  }
  hooks.onProgress?.(`Visit ${browserUrl} and enter code ${prompt.userCode}`);
  hooks.onProgress?.("Waiting for xAI device authorization…");
  await pollXaiDeviceAuthorization(prompt, clientId, fetchFn);
  // The poll step stashes the resolved tokens on the
  // prompt (since xAI's flow returns them directly per
  // RFC 8628, unlike codex's separate exchange step).
  const stashed = prompt as unknown as {
    __resolvedAccessToken?: string;
    __resolvedRefreshToken?: string;
    __resolvedExpiresIn?: number;
  };
  if (!stashed.__resolvedAccessToken || !stashed.__resolvedRefreshToken) {
    throw new Error("xAI device authorization resolved but tokens were missing");
  }
  hooks.onProgress?.("xAI device authorization resolved; persisting…");
  return {
    accessToken: stashed.__resolvedAccessToken,
    refreshToken: stashed.__resolvedRefreshToken,
    expiresAt: Date.now() + (stashed.__resolvedExpiresIn ?? 3600) * 1000,
  };
}

/** Apply xAI OAuth tokens to an in-memory settings object (no disk write). */
export function applyXaiOAuthTokens(
  settings: Settings,
  tokens: XaiOAuthTokens,
  opts?: { makeDefault?: boolean; model?: string },
): Settings {
  const preset = getProviderPreset("xai");
  const profile = settings.providers.xai ?? {
    id: "xai",
    baseUrl: preset?.defaultBaseUrl,
    model: preset?.defaultModel,
  };
  profile.oauthToken = tokens.accessToken;
  profile.authMode = "oauth";
  profile.options = {
    ...(profile.options ?? {}),
    xaiOAuth: {
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    },
  };
  if (opts?.model) profile.model = opts.model;
  settings.providers.xai = profile;
  if (opts?.makeDefault !== false) {
    settings.defaultProvider = "xai";
    settings.defaultModel = profile.model ?? settings.defaultModel;
  }
  return settings;
}

/** Persist xAI OAuth tokens into settings.json. */
export function saveXaiOAuthTokens(
  settings: Settings,
  tokens: XaiOAuthTokens,
  opts?: { makeDefault?: boolean; model?: string },
): Settings {
  applyXaiOAuthTokens(settings, tokens, opts);
  saveSettings(settings);
  return settings;
}

/** Load stored refresh token from an xai provider profile. */
export function loadXaiRefreshToken(profile: Settings["providers"][string] | undefined): string | undefined {
  const fromOptions = profile?.options?.xaiOAuth as { refreshToken?: string } | undefined;
  return trim(fromOptions?.refreshToken);
}

/** Refresh tokens in settings when access token is near expiry. */
export async function ensureFreshXaiTokens(
  settings: Settings,
  fetchFn: typeof fetch = fetch,
  clientId: string = DEFAULT_CLIENT_ID,
): Promise<Settings> {
  const profile = settings.providers.xai;
  if (!profile || profile.authMode !== "oauth") return settings;
  const meta = profile.options?.xaiOAuth as { refreshToken?: string; expiresAt?: number } | undefined;
  const refreshToken = trim(meta?.refreshToken);
  const expiresAt = typeof meta?.expiresAt === "number" ? meta.expiresAt : 0;
  if (!refreshToken) return settings;
  if (expiresAt > Date.now() + 60_000) return settings;
  const tokens = await refreshXaiOAuthToken(refreshToken, clientId, fetchFn);
  saveXaiOAuthTokens(settings, tokens, { makeDefault: settings.defaultProvider === "xai" });
  return settings;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
