// Headless server. Exposes the harness over HTTP + serves the web UI.
//
// Endpoints (all under /v1/ unless noted; the table near the top of
// this file is the source of truth that `GET /v1/` returns):
//   GET  /                         — Web UI (index.html)
//   GET  /styles.css, /app.js      — Web UI assets
//   GET  /v1/                      — { name, version, endpoints[] } discovery index
//   GET  /v1/health                — { ok, uptime, version } liveness probe (no auth)
//   GET  /v1/status                 — { version, model, provider }
//   GET  /v1/diag                   — connectivity / latency check
//   GET  /v1/info                   — runtime snapshot (version, paths, provider, model)
//   GET  /v1/tokens                 — rough token count of active session
//   GET  /v1/agents                 — list of sub-agents
//   GET  /v1/agents/:id             — single agent definition (404 if unknown)
//   GET  /v1/skills                 — list of skills
//   GET  /v1/skills/:id             — single skill incl. full SKILL.md body (404 if unknown)
//   GET  /v1/todo                   — in-session todo list
//   POST /v1/todo                   — { items | action: add|clear, item? } update the list
//   GET  /v1/sessions               — list of sessions
//   GET  /v1/sessions/:id           — session metadata (404 if unknown)
//   GET  /v1/sessions/:id/messages  — { messages[] } from the session transcript (404 if unknown)
//   POST /v1/session                — { id? } start or resume
//   GET  /v1/usage                  — { inputTokens, outputTokens, cost, topModel }
//   GET  /v1/commands               — list of slash commands
//   GET  /v1/goals                  — list of goals (?id=<id> for one + children, ?active=1 for active)
//   GET  /v1/delegations            — list of active + recent delegation runs
//   POST /v1/delegations            — submit a new delegation (discriminated by `kind`)
//   GET  /v1/delegations/:id        — single delegation run metadata (404 if unknown)
//   GET  /v1/loops                  — list of active + recent loops (delegations + sub-agents)
//   GET  /v1/loops/:id              — single loop metadata; goal kind includes GoalRecord summary
//   GET  /v1/settings               — current settings
//   POST /v1/settings               — { provider, model, baseUrl, apiKey, approval, thinking } update
//   GET  /v1/provider/catalog       — provider catalog with auth modes (mirrors /provider list)
//   GET  /v1/provider/models        — { id, models[] } live /v1/models for a provider (?id=<id>)
//   POST /v1/provider/set-key       — { provider, apiKey, model? } non-interactive save + diag
//   POST /v1/provider/login/codex   — start Codex device-code OAuth (returns prompt or completes)
//   POST /v1/chat                   — { prompt, agent? } one-shot JSON
//   POST /v1/chat/stream            — SSE: stream_id, text, tool_start, tool_end, info, error, approval_required, usage, done
//   DELETE /v1/chat/stream/:id       — abort an in-flight SSE stream (404 if id unknown / already finished)
//   POST /v1/spawn                  — { agent, prompt } — synchronous sub-agent run
//   POST /v1/approval/respond      — { id, decision } — resume a paused approval
//   GET  /v1/memory                 — read MEMORY.md
//   POST /v1/memory/append          — { text } — append to MEMORY.md
//   POST /v1/memory/search          — { query } — search
//
// Auth (opt-in via env):
//   When `CH_HTTP_TOKEN` is set, every /v1/* request (except OPTIONS preflight,
//   GET /v1/, and GET /v1/health) must include `Authorization: Bearer <CH_HTTP_TOKEN>`.
//   Mismatched / missing tokens get 401 `{ error: "unauthorized" }`. When the
//   env var is unset, the server is open — same as before this hardening pass.
//
// Body size:
//   POST bodies are capped at 1 MB by default; override with the positive
//   integer env `CH_HTTP_MAX_BODY_BYTES`. Oversize bodies get 413.
//
// Error shape:
//   Every JSON-returning endpoint uses `{ error: string, code?: string }`
//   for failures. The /v1/memory and /v1/memory/search endpoints return
//   `text/plain` on success (external programs that consume the raw
//   MEMORY.md want the text) but use the JSON shape for errors.
//
// SSE event shapes:
//   stream_id:         { id: string }   — first event; used by DELETE /v1/chat/stream/:id
//   text:               { text: string }
//   tool_start:         { name: string, args: string }
//   tool_end:           { name: string, isError: boolean, display: string }
//   info:               { text: string }
//   error:              { text: string }
//   approval_required:  { id, command, reason }
//   usage:              { inputTokens, outputTokens }
//   done:               { text, usage, steps }
//
// Route table:
//   ROUTES (declared just below the imports) is the single source of truth
//   that `GET /v1/` returns and that tests cross-check against the actual
//   `if (req.method === ...)` handlers. If you add a new handler, add an
//   entry to ROUTES in the same patch — otherwise the index drifts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Session, sessionToMessages } from "./agent/session.js";
import { loadSettings, saveSettings, type Settings } from "./config/settings.js";
import { getProviderPreset, listProviderPresets, presetToCatalogEntry, providerCatalogGroups } from "./providers/presets.js";
import { BUILTIN_REGISTRY, tryParseSlash } from "./slash/index.js";
import { runAgent, DEFAULT_LIMITS } from "./agent/loop.js";
import { log } from "./util/logger.js";
import type { HarnessRuntime } from "./runtime.js";
import type { Delegation, DelegationKind } from "./agent/delegation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** The `auth` field on a route entry. `"required"` means the route is
 *  behind the bearer-token gate (every /v1/* except OPTIONS, /v1/, and
 *  /v1/health). `"none"` means the route is public (preflight, the
 *  discovery index, the liveness probe, and the static web UI assets). */
export type RouteAuth = "required" | "none";

/** Source-of-truth route table. The `GET /v1/` discovery endpoint
 *  returns this list verbatim, and the `server-expansion` test suite
 *  cross-checks that every actual `if (req.method === ...)` handler in
 *  this file has a matching entry here. Keeping the two in sync prevents
 *  the index from drifting behind reality. */
export interface RouteEntry {
  method: "GET" | "POST" | "PUT" | "DELETE" | "OPTIONS" | "PATCH";
  /** Path literal. `*` segments are documented as `:param`. */
  path: string;
  description: string;
  auth: RouteAuth;
}

/** All routes this server implements. Order is the order the index
 *  endpoint lists them in — keep it grouped by family (discovery,
 *  health, sessions, providers, etc.) so external docs can read it
 *  top-to-bottom. */
export const ROUTES: RouteEntry[] = [
  // ---- Static web UI (public) ----
  { method: "GET",    path: "/",                          description: "Web UI shell (index.html)", auth: "none" },
  { method: "GET",    path: "/styles.css",                description: "Web UI stylesheet",          auth: "none" },
  { method: "GET",    path: "/app.js",                    description: "Web UI app script",          auth: "none" },
  { method: "GET",    path: "/onboard-helpers.js",        description: "Onboarding helper script",   auth: "none" },
  { method: "GET",    path: "/favicon.ico",               description: "Browser favicon",            auth: "none" },
  { method: "GET",    path: "/favicon.svg",               description: "Browser favicon (svg)",      auth: "none" },
  { method: "OPTIONS",path: "/*",                         description: "CORS preflight (every path)",auth: "none" },

  // ---- Discovery + health (public) ----
  { method: "GET",    path: "/v1/",                       description: "Discovery index of /v1/ endpoints", auth: "none" },
  { method: "GET",    path: "/v1/health",                 description: "Liveness probe (ok, uptime, version)", auth: "none" },

  // ---- Status / runtime ----
  { method: "GET",    path: "/v1/status",                 description: "Active runtime: version, model, provider, session",  auth: "required" },
  { method: "GET",    path: "/v1/diag",                   description: "Connectivity / latency check against the default provider", auth: "required" },
  { method: "GET",    path: "/v1/info",                   description: "Runtime snapshot: paths, provider, model",          auth: "required" },
  { method: "GET",    path: "/v1/tokens",                 description: "Rough token count of the active session",            auth: "required" },
  { method: "GET",    path: "/v1/usage",                  description: "Cumulative token / cost usage",                       auth: "required" },
  { method: "GET",    path: "/v1/commands",               description: "Registered slash commands",                          auth: "required" },
  { method: "GET",    path: "/v1/todo",                   description: "In-session todo list",                               auth: "required" },
  { method: "POST",   path: "/v1/todo",                   description: "Replace the todo list (items | action: add|clear)",  auth: "required" },

  // ---- Sub-agents / skills ----
  { method: "GET",    path: "/v1/agents",                 description: "List of sub-agents (explore, plan, review, …)",       auth: "required" },
  { method: "GET",    path: "/v1/agents/:id",             description: "Single agent definition (404 if unknown)",           auth: "required" },
  { method: "GET",    path: "/v1/skills",                 description: "List of discovered skills",                           auth: "required" },
  { method: "GET",    path: "/v1/skills/:id",             description: "Single skill (name, description, full SKILL.md body)",auth: "required" },

  // ---- Sessions ----
  { method: "GET",    path: "/v1/sessions",               description: "List of sessions (most recent first)",                auth: "required" },
  { method: "GET",    path: "/v1/sessions/:id",           description: "Session metadata (404 if unknown)",                   auth: "required" },
  { method: "GET",    path: "/v1/sessions/:id/messages",  description: "Session transcript as { role, content, timestamp? }[]",auth: "required" },
  { method: "POST",   path: "/v1/session",                description: "Start or resume a session by id",                     auth: "required" },

  // ---- Goals / delegations / loops ----
  { method: "GET",    path: "/v1/goals",                  description: "List goals (?id=<id> for one + children, ?active=1 for active)", auth: "required" },
  { method: "GET",    path: "/v1/delegations",            description: "List active + recent delegation runs (kind, status, parent chain)", auth: "required" },
  { method: "POST",   path: "/v1/delegations",            description: "Submit a new delegation (kind: agent | goal | async-tool | mcp | plugin | api | human-approval | workflow)", auth: "required" },
  { method: "GET",    path: "/v1/delegations/:id",        description: "Single delegation run metadata (404 if unknown)",    auth: "required" },
  { method: "GET",    path: "/v1/loops",                  description: "List active + recent loops (delegations + spawned sub-agents)", auth: "required" },
  { method: "GET",    path: "/v1/loops/:id",              description: "Single loop metadata; goal kind includes GoalRecord summary", auth: "required" },

  // ---- Settings / providers ----
  { method: "GET",    path: "/v1/settings",               description: "Current settings snapshot",                           auth: "required" },
  { method: "POST",   path: "/v1/settings",               description: "Update settings (provider, model, baseUrl, apiKey, approval, thinking)", auth: "required" },
  { method: "GET",    path: "/v1/provider/catalog",       description: "Provider catalog with auth modes",                    auth: "required" },
  { method: "GET",    path: "/v1/provider/models",        description: "Live /v1/models for a provider (?id=<id>)",           auth: "required" },
  { method: "POST",   path: "/v1/provider/set-key",       description: "Save an API key for a provider (non-interactive)",    auth: "required" },
  { method: "POST",   path: "/v1/provider/login/codex",   description: "Start Codex device-code OAuth flow",                  auth: "required" },

  // ---- Chat / spawn / approval ----
  { method: "POST",   path: "/v1/chat",                   description: "One-shot chat: { prompt, agent? } → { text, usage, steps }", auth: "required" },
  { method: "POST",   path: "/v1/chat/stream",            description: "SSE: stream_id, text, tool_start, tool_end, info, error, approval_required, usage, done", auth: "required" },
  { method: "DELETE", path: "/v1/chat/stream/:id",        description: "Abort an in-flight SSE stream (404 if id unknown / already finished)", auth: "required" },
  { method: "POST",   path: "/v1/spawn",                  description: "Synchronous sub-agent run: { agent, prompt }",        auth: "required" },
  { method: "POST",   path: "/v1/approval/respond",       description: "Resume a paused approval with { id, decision }",      auth: "required" },

  // ---- Memory (text on success; JSON on error) ----
  { method: "GET",    path: "/v1/memory",                 description: "Read MEMORY.md (text/plain)",                         auth: "required" },
  { method: "POST",   path: "/v1/memory/append",          description: "Append to MEMORY.md: { text }",                       auth: "required" },
  { method: "POST",   path: "/v1/memory/search",          description: "Search MEMORY.md: { query } (text/plain)",            auth: "required" },
];

/** Server version. Bump on each release; the index endpoint surfaces
 *  it as `version` and `/v1/health` returns it too. */
const SERVER_VERSION = "0.2.2";

/** Locate the web/ directory. We check (in order):
 *   1. $CH_WEB_DIR  (env var override)
 *   2. <this>/web             (built: dist/web alongside dist/server.js)
 *   3. <this>/../web          (dev: src/web when running from src/server.ts)
 *   4. <this>/../../src/web   (built: src/web when running from dist/ via npm link)
 *   5. ./web (CWD)
 */
function findWebDir(): string {
  if (process.env.CH_WEB_DIR) return process.env.CH_WEB_DIR;
  const candidates = [
    join(__dirname, "web"),                                       // built: dist/web
    join(__dirname, "..", "web"),                                // dev: src/web
    join(__dirname, "..", "..", "src", "web"),                   // npm link into repo
    join(process.cwd(), "web"),                                  // CWD
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return candidates[0]!;
}
const WEB_DIR = findWebDir();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-approval-id");
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  setCors(res);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, code: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  setCors(res);
  res.writeHead(code, { "content-type": contentType });
  res.end(body);
}

function sendError(res: ServerResponse, code: number, error: string): void {
  sendJson(res, code, { error });
}

/** In-flight approval requests waiting for a user response. The
 *  value's `resolve` is what the bridge in `streamChat` calls when
 *  `POST /v1/approval/respond` lands — it's the matching end of the
 *  promise the bash tool is awaiting. The `stream` field on a fresh
 *  entry is set by the bridge so the cleanup can find entries that
 *  belong to a specific SSE stream (and deny-resolve them on abort
 *  so the agent loop doesn't hang). */
interface PendingApproval {
  resolve: (decision: string) => void;
  createdAt: number;
  /** Stream id this approval belongs to. Set by the bridge so the
   *  per-stream cleanup can deny-resolve orphans on abort. */
  stream?: string;
}
const pendingApprovals = new Map<string, PendingApproval>();

/** Active SSE stream controllers, keyed by the stream id returned in
 *  the `stream_id` SSE event. The `DELETE /v1/chat/stream/:id` handler
 *  looks the controller up and calls `.abort()`. Entries are removed
 *  when the stream ends naturally so the map doesn't grow without
 *  bound across the lifetime of the server. */
const activeStreams = new Map<string, AbortController>();

/** Generate a stream id. The format is `<sessionId>-<uuid>` so the
 *  client can correlate the stream with the active session and the
 *  id is also globally unique on its own. When there's no active
 *  session we still get a uuid. */
function newStreamId(runtime: HarnessRuntime): string {
  const sid = runtime.sessionId() ?? "anon";
  return sid + "-" + randomUUID();
}

// ---- Path matchers for the expansion endpoints ----
//
// Each matcher takes the request pathname and returns the captured
// `:id` segment, or `null` when the path doesn't match. We do this
// with simple string slicing (no path-to-regexp dep) because the
// routes are static prefixes. The matchers are used in the same
// chain as the `path === ...` literal checks above, so false
// positives are safe — the result is the same 404 we'd hit anyway.

/** `/v1/delegations/<id>` — but NOT `/v1/delegations` itself (no
 *  trailing id) and NOT `/v1/delegations/<id>/...` (sub-routes we
 *  don't define here). The trailing-slash guard is implicit: the
 *  literal `/v1/delegations` POST/GET handlers run first. */
function delegationIdPath(path: string): string | null {
  if (!path.startsWith("/v1/delegations/")) return null;
  const rest = path.slice("/v1/delegations/".length);
  if (!rest || rest.includes("/")) return null;
  return rest;
}

/** `/v1/agents/<id>` */
function agentIdPath(path: string): string | null {
  if (!path.startsWith("/v1/agents/")) return null;
  const rest = path.slice("/v1/agents/".length);
  if (!rest || rest.includes("/")) return null;
  return rest;
}

/** `/v1/skills/<id>` */
function skillIdPath(path: string): string | null {
  if (!path.startsWith("/v1/skills/")) return null;
  const rest = path.slice("/v1/skills/".length);
  if (!rest || rest.includes("/")) return null;
  return rest;
}

/** `/v1/sessions/<id>` */
function sessionIdPath(path: string): string | null {
  if (!path.startsWith("/v1/sessions/")) return null;
  const rest = path.slice("/v1/sessions/".length);
  if (!rest || rest.includes("/")) return null;
  return rest;
}

/** `/v1/sessions/<id>/messages` */
function sessionsMessagesPath(path: string): string | null {
  if (!path.startsWith("/v1/sessions/")) return null;
  const rest = path.slice("/v1/sessions/".length);
  if (!rest.endsWith("/messages")) return null;
  const id = rest.slice(0, -"/messages".length);
  if (!id || id.includes("/")) return null;
  return id;
}

/** `/v1/loops/<id>` */
function loopIdPath(path: string): string | null {
  if (!path.startsWith("/v1/loops/")) return null;
  const rest = path.slice("/v1/loops/".length);
  if (!rest || rest.includes("/")) return null;
  return rest;
}

/** `/v1/chat/stream/<id>` */
function streamIdPath(path: string): string | null {
  if (!path.startsWith("/v1/chat/stream/")) return null;
  const rest = path.slice("/v1/chat/stream/".length);
  if (!rest || rest.includes("/")) return null;
  return rest;
}

/** Default body cap. The runtime can tighten this via CH_HTTP_MAX_BODY_BYTES. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MB

/** Resolved at module load — the env value is fixed for the lifetime of
 *  the server process. Re-reading on every request would let a malicious
 *  client re-grow the cap, so we cache it. */
function resolveMaxBodyBytes(): number {
  const raw = process.env.CH_HTTP_MAX_BODY_BYTES;
  if (!raw) return DEFAULT_MAX_BODY_BYTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    log.warn("CH_HTTP_MAX_BODY_BYTES is not a positive integer; using default " + DEFAULT_MAX_BODY_BYTES);
    return DEFAULT_MAX_BODY_BYTES;
  }
  return n;
}
const MAX_BODY_BYTES = resolveMaxBodyBytes();

/** Distinct error class so the route handler can map "body too large"
 *  to a 413 instead of a generic 500. */
class BodyTooLargeError extends Error {
  constructor(public limit: number) {
    super(`body too large (limit: ${limit} bytes)`);
    this.name = "BodyTooLargeError";
  }
}

/** Read the request body as JSON, capped at `limit` bytes (default = the
 *  env-resolved max). Stops accumulating as soon as the cap is hit and
 *  throws a BodyTooLargeError so the caller can return 413. */
async function readJson<T>(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        // Stop accumulating. We can't reject yet because we're inside
        // the data callback; the 'end' / 'close' below will see the
        // oversize flag and reject.
        chunks.length = 0;
        chunks.push(Buffer.from("")); // placeholder, length not counted
        (req as IncomingMessage & { _chOversize?: boolean })._chOversize = true;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      settle(() => {
        if ((req as IncomingMessage & { _chOversize?: boolean })._chOversize) {
          reject(new BodyTooLargeError(limit));
          return;
        }
        const text = Buffer.concat(chunks).toString("utf-8");
        if (!text) { reject(new Error("empty body")); return; }
        try { resolve(JSON.parse(text) as T); } catch (e) { reject(e as Error); }
      });
    });
    req.on("error", (e) => settle(() => reject(e)));
    req.on("close", () => {
      // If the request socket closes before `end` fires — a
      // client disconnect mid-body is the most common cause —
      // we have to reject explicitly. Otherwise the promise
      // hangs forever (Node's default 2-minute server timeout
      // would eventually kill the socket, but the connection
      // would stay pinned in the meantime and every
      // mid-disconnect POST would waste a handler slot).
      // Reject with body-too-large if the flag is set, else
      // a generic AbortError so the route's catch sees a
      // structured failure rather than an unhandled rejection.
      settle(() => {
        if ((req as IncomingMessage & { _chOversize?: boolean })._chOversize) {
          reject(new BodyTooLargeError(limit));
        } else {
          const err = new Error("request aborted: client disconnected mid-body");
          err.name = "AbortError";
          reject(err);
        }
      });
    });
  });
}

/** Bearer-token check. Opt-in: when CH_HTTP_TOKEN is unset, returns
 *  `{ ok: true }` for every request (backwards compat). When set, only
 *  requests carrying `Authorization: Bearer <CH_HTTP_TOKEN>` pass.
 *  Never echoes the configured token in the error — the response is
 *  always `{ error: "unauthorized" }` so a misconfigured client can't
 *  use the error body to recover the secret. */
function authenticate(req: IncomingMessage): { ok: true } | { ok: false, reason: string } {
  const expected = process.env.CH_HTTP_TOKEN;
  if (!expected) return { ok: true };
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") {
    return { ok: false, reason: "missing Authorization header" };
  }
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return { ok: false, reason: "malformed Authorization header" };
  // Constant-time compare so a timing oracle can't be used to brute-force
  // the token. The lengths are likely different anyway but defense in depth.
  const got = match[1]!;
  if (got.length !== expected.length) return { ok: false, reason: "token mismatch" };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  }
  if (diff !== 0) return { ok: false, reason: "token mismatch" };
  return { ok: true };
}

/** Wire the IncomingMessage's TCP close / legacy "aborted" events into
 *  an AbortController. Returns the controller so the caller can pass
 *  `controller.signal` into the agent loop or sub-agent spawn.
 *
 *  Both listeners are `once` so they self-deregister on the first
 *  fire. The `IncomingMessage` is one of the longest-lived objects
 *  in the request lifecycle (an SSE stream can stay open for the
 *  whole chat turn), so persistent `on(...)` listeners would keep
 *  the controller + its `fire` closure alive until the message
 *  itself is GC'd. The two events fire in close succession (Node
 *  fires `aborted` first on TCP RST, then `close` once the socket
 *  is fully torn down) — `once` on each is enough to be reliable. */
function abortOnDisconnect(req: IncomingMessage): AbortController {
  const ac = new AbortController();
  const fire = () => { if (!ac.signal.aborted) ac.abort(); };
  req.once("close", fire);
  req.once("aborted", fire);
  return ac;
}

/** Format an SSE event. */
function sse(event: string, data: unknown): string {
  return "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
}

export interface StartServerOpts { port: number; host: string; }

export async function startServer(runtime: HarnessRuntime, opts: StartServerOpts): Promise<void> {
  const server = createServer(async (req, res) => {
    if (!req.url || !req.method) { sendError(res, 400, "bad request"); return; }
    if (req.method === "OPTIONS") { setCors(res); res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, "http://" + (req.headers.host ?? "localhost"));
    const path = url.pathname;

    // Liveness probe — always public. Runs before auth so health checks
    // (k8s, load balancers, smoke tests) don't need the bearer token.
    if (req.method === "GET" && path === "/v1/health") {
      sendJson(res, 200, { ok: true, uptime: process.uptime(), version: SERVER_VERSION });
      return;
    }

    // Discovery index — always public, like /v1/health. External
    // programs call this to learn what the server offers before they
    // attempt the auth-gated routes. The body is generated from the
    // ROUTES table near the top of this file, which is the same table
    // tests cross-check against the actual handler list.
    if (req.method === "GET" && path === "/v1/") {
      sendJson(res, 200, {
        name: "codingharness",
        version: SERVER_VERSION,
        endpoints: ROUTES.map((r) => ({
          method: r.method,
          path: r.path,
          description: r.description,
          auth: r.auth,
        })),
      });
      return;
    }

    // Bearer-token gate (opt-in via CH_HTTP_TOKEN). Applied to every
    // other /v1/* request; static assets (/, /styles.css, /app.js) are
    // public so the web UI works without a token. OPTIONS is already
    // handled above and never reaches this point.
    if (path.startsWith("/v1/")) {
      const auth = authenticate(req);
      if (!auth.ok) {
        // Generic 401 — never echo the configured token, the supplied
        // token, or any reason that would help an attacker probe.
        log.warn("rejected unauthorized request to " + path);
        sendError(res, 401, "unauthorized");
        return;
      }
    }

    try {
      // ---- Web UI ----
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        serveStatic(res, "index.html");
        return;
      }
      if (req.method === "GET" && (path === "/styles.css" || path === "/app.js" || path === "/onboard-helpers.js" || path === "/favicon.ico" || path === "/favicon.svg")) {
        serveStatic(res, path.slice(1));
        return;
      }

      // ---- JSON API ----
      if (req.method === "GET" && path === "/v1/status") {
        sendJson(res, 200, {
          ok: true,
          version: SERVER_VERSION,
          model: runtime.model(),
          provider: runtime.providerId(),
          session: runtime.sessionId(),
          goalActivity: runtime.getGoalActivity(),
        });
        return;
      }
      if (req.method === "GET" && path === "/v1/agents") {
        sendJson(res, 200, { agents: runtime.subagents.list() });
        return;
      }
      if (req.method === "GET" && path === "/v1/skills") {
        const all = await runtime.skills.list();
        sendJson(res, 200, { skills: all.map((s) => ({ name: s.name, description: s.description })) });
        return;
      }
      if (req.method === "GET" && path === "/v1/todo") {
        // In-session todo list. Same data the `todo` tool sees.
        const items = runtime.readTodo ? runtime.readTodo() : [];
        sendJson(res, 200, { items });
        return;
      }
      if (req.method === "POST" && path === "/v1/todo") {
        // Replace the in-session todo list. Body: { items: string[] }
        // or { action: "add"|"clear", item?: string }.
        // Persists to the session JSONL so reloads see it.
        if (!runtime.writeTodo) { sendError(res, 500, "runtime doesn't support todo"); return; }
        const body = await readJson<{ items?: string[]; action?: "add" | "set" | "clear"; item?: string }>(req);
        if (Array.isArray(body.items)) {
          await runtime.writeTodo(body.items.filter((x) => typeof x === "string"));
          sendJson(res, 200, { ok: true, items: body.items });
          return;
        }
        if (body.action === "clear") {
          await runtime.writeTodo([]);
          sendJson(res, 200, { ok: true, items: [] });
          return;
        }
        if (body.action === "add" && typeof body.item === "string") {
          const current = runtime.readTodo ? runtime.readTodo() : [];
          const next = [...current, body.item];
          await runtime.writeTodo(next);
          sendJson(res, 200, { ok: true, items: next });
          return;
        }
        sendError(res, 400, "missing items array, action=clear, or action=add + item");
        return;
      }
      if (req.method === "GET" && path === "/v1/sessions") {
        const query = url.searchParams.get("query")?.trim();
        const list = query ? await Session.search(query, 50) : await Session.list(50);
        sendJson(res, 200, { sessions: list });
        return;
      }
      if (req.method === "POST" && path === "/v1/session") {
        const body = await readJson<{ id?: string }>(req).catch(() => ({} as { id?: string }));
        if (body.id) {
          await runtime.setSession(body.id);
        } else {
          runtime.clearHistory();
        }
        sendJson(res, 200, { session: runtime.sessionId() });
        return;
      }
      if (req.method === "GET" && path === "/v1/usage") {
        const t = runtime.cost ? runtime.cost.total() : { inputTokens: 0, outputTokens: 0, cost: 0 };
        const perModel = runtime.cost ? runtime.cost.perModel().slice(0, 1) : [];
        sendJson(res, 200, { ...t, topModel: perModel[0] ?? null });
        return;
      }
      if (req.method === "GET" && path === "/v1/diag") {
        // Connectivity / latency probe. The same call the /diag slash
        // command and the `ch diag` CLI subcommand use.
        const r = await runtime.runDiag();
        sendJson(res, r.ok ? 200 : 503, r);
        return;
      }
      if (req.method === "GET" && path === "/v1/info") {
        // Runtime snapshot for HTTP consumers. Same shape as
        // `ch info --json` and the runtime.info module.
        const { collectRuntimeInfo } = await import("./runtime/info.js");
        sendJson(res, 200, collectRuntimeInfo(runtime.cwd));
        return;
      }
      if (req.method === "GET" && path === "/v1/provider/catalog") {
        // Provider catalog for HTTP consumers. Mirrors
        // `ch provider list` and `/provider list`. The web UI
        // uses this to populate the setup wizard dropdowns.
        const groups = providerCatalogGroups();
        sendJson(res, 200, {
          providers: listProviderPresets().map((p) => presetToCatalogEntry(p)),
          groups: {
            primary: groups.primary.map((p) => p.id),
            hosted: groups.hosted.map((p) => p.id),
            local: groups.local.map((p) => p.id),
          },
        });
        return;
      }
      if (req.method === "GET" && path === "/v1/provider/models") {
        // Live model discovery for a provider. Proxies the
        // provider's /v1/models endpoint and returns just the
        // id list. Defaults to the current defaultProvider.
        // Query string: ?id=<providerId>
        const urlObj = new URL(req.url ?? "", "http://localhost");
        const targetId = (urlObj.searchParams.get("id") ?? runtime.providerId() ?? "").trim();
        if (!targetId) {
          sendJson(res, 200, { id: "", models: [], error: "no provider id supplied" });
          return;
        }
        const provider = runtime.providerRegistry.get(targetId);
        if (!provider) {
          sendJson(res, 200, { id: targetId, models: [], error: "provider not configured" });
          return;
        }
        if (typeof provider.listModels !== "function") {
          sendJson(res, 200, { id: targetId, models: [], error: "provider does not support model discovery" });
          return;
        }
        try {
          const models = await provider.listModels();
          sendJson(res, 200, { id: targetId, models });
        } catch (e) {
          sendJson(res, 200, { id: targetId, models: [], error: (e as Error).message });
        }
        return;
      }
      if (req.method === "POST" && path === "/v1/provider/login/codex") {
        const body = await readJson<{ openBrowser?: boolean }>(req).catch(() => ({} as { openBrowser?: boolean }));
        const messages: string[] = [];
        const result = await runtime.loginCodexOAuth({
          onProgress: (m) => { messages.push(m); },
          onDeviceCode: async (prompt) => {
            messages.push(`Visit ${prompt.verificationUrl} and enter code ${prompt.userCode}`);
          },
          openBrowser: body.openBrowser === false
            ? undefined
            : async (url) => {
                const { execFile } = await import("node:child_process");
                const cmd = process.platform === "darwin" ? "open" :
                            process.platform === "win32" ? "start" : "xdg-open";
                const args = process.platform === "win32" ? ["", url] : [url];
                await new Promise<void>((resolve, reject) => {
                  execFile(cmd, args, (err) => err ? reject(err) : resolve());
                }).catch(() => { /* browser open is best-effort */ });
              },
        });
        if (!result.ok) {
          sendJson(res, 400, { ok: false, error: result.reason ?? "login failed", messages });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          provider: "codex",
          model: runtime.model(),
          messages,
        });
        return;
      }
      if (req.method === "POST" && path === "/v1/provider/set-key") {
        // Non-interactive save. Same as `ch provider set-key` and
        // `/provider setup <id> <key>`. The body is JSON:
        //   { provider: "openai", apiKey: "sk-...", model?: "gpt-4o" }
        // The key is validated (non-empty, ≥8 chars) and the
        // provider is invalidated so the new key is picked up
        // on the next call. Returns the diag result so the web
        // UI can show a green/red indicator without a follow-up
        // request.
        const body = await readJson<{ provider?: string; apiKey?: string; model?: string; baseUrl?: string }>(req);
        const provider = (body.provider ?? "").trim();
        const apiKey = (body.apiKey ?? "").trim();
        if (!provider) {
          sendError(res, 400, "missing provider");
          return;
        }
        const preset = getProviderPreset(provider);
        const optionalAuth = preset?.authModes.includes("optional") ?? false;
        if (!apiKey && !optionalAuth) {
          sendError(res, 400, "missing apiKey");
          return;
        }
        const save = await runtime.saveProviderApiKey(provider, apiKey, { model: body.model, baseUrl: body.baseUrl });
        if (!save.ok) {
          sendError(res, 400, save.reason ?? "could not save key");
          return;
        }
        // Best-effort diag so the UI gets instant feedback. Don't
        // block on it — a slow provider shouldn't make the save
        // request hang.
        let diagStatus: { ok: boolean; firstByteMs?: number; totalMs?: number; error?: string } = { ok: true };
        try {
          const d = await runtime.runDiag();
          diagStatus = d.ok
            ? { ok: true, firstByteMs: d.firstByteMs, totalMs: d.totalMs }
            : { ok: false, error: d.error ?? "no response" };
        } catch (e) {
          diagStatus = { ok: false, error: (e as Error).message };
        }
        sendJson(res, 200, { ok: true, provider, model: runtime.model(), diag: diagStatus });
        return;
      }
      if (req.method === "GET" && path === "/v1/tokens") {
        // Rough token count of the active session's model-visible
        // messages. Useful for dashboards and pre-compact checks.
        const id = runtime.sessionId();
        if (!id) { sendError(res, 400, "no active session"); return; }
        const s = await Session.open(id);
        const msgs = sessionToMessages(s);
        const { roughTokenCount } = await import("./agent/compaction.js");
        const total = roughTokenCount(msgs);
        sendJson(res, 200, {
          session: id,
          messages: msgs.length,
          tokens: total,
          breakdown: msgs.map((m) => ({ role: m.role, tokens: roughTokenCount([m]) })),
        });
        return;
      }
      if (req.method === "GET" && path === "/v1/commands") {
        const commandMeta = BUILTIN_REGISTRY.list().map((cmd) => ({
          name: cmd.name,
          description: cmd.description,
          usage: cmd.usage ?? "/" + cmd.name,
          group: cmd.group ?? "other",
        }));
        sendJson(res, 200, { commands: commandMeta.map((cmd) => cmd.name), items: commandMeta });
        return;
      }
      if (req.method === "GET" && path === "/v1/goals") {
        // GoalStore snapshot for the web UI panels.
        //   - default:                       list all goals (most recent first)
        //   - ?id=<goalId>                    single goal + its children + evaluations
        //   - ?active=1                       only pending + in_progress goals
        // Response envelope (matches the rest of /v1/*):
        //   { goals: GoalRecord[] } | { goal: GoalRecord, children: GoalRecord[] }
        const urlObj = new URL(req.url ?? "", "http://localhost");
        const id = urlObj.searchParams.get("id");
        const activeOnly = urlObj.searchParams.get("active") === "1";
        const all = activeOnly ? runtime.goalStore.listActive() : runtime.goalStore.list();
        if (id) {
          const goal = runtime.goalStore.get(id);
          if (!goal) {
            sendError(res, 404, "goal not found: " + id);
            return;
          }
          const children = runtime.goalStore.listChildren(id);
          sendJson(res, 200, { goal, children });
          return;
        }
        sendJson(res, 200, { goals: all });
        return;
      }
      if (req.method === "GET" && path === "/v1/delegations") {
        // DelegationManager snapshot for the web UI panels.
        // Lists active + recent delegation runs. The `DelegationRun`
        // handle has a `result()` Promise and an `events()`
        // AsyncIterable — neither is JSON-serializable — so we map
        // to a plain object that only carries the metadata the
        // web UI needs: id, kind, status, parentId, parentChain,
        // startedAt, completedAt, createdAt.
        const runs = runtime.delegations.list();
        // Pre-seed the goal store so we can walk goal parents.
        const goalById = new Map<string, { id: string; loopStatus: string }>();
        for (const g of runtime.goalStore.list()) goalById.set(g.id, { id: g.id, loopStatus: g.loopStatus });
        const out = runs.map((r) => {
          const chain: Array<{ id: string; kind: string; status: string }> = [];
          const seen = new Set<string>();
          let cur: string | undefined = r.parentId;
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            // Look up the current parent. Could be another delegation
            // run (find its parentId via the runs list), or a goal
            // in the goal store (the most common parent for
            // sub-goal delegations), or some external thing.
            const parentRun = runs.find((x) => x.id === cur);
            if (parentRun) {
              chain.push({ id: parentRun.id, kind: parentRun.kind, status: parentRun.status });
              cur = parentRun.parentId;
            } else {
              const asGoal = goalById.get(cur);
              if (asGoal) {
                chain.push({ id: asGoal.id, kind: "goal", status: asGoal.loopStatus });
              } else {
                chain.push({ id: cur, kind: "external", status: "unknown" });
              }
              cur = undefined;
            }
          }
          return {
            id: r.id,
            kind: r.kind,
            status: r.status,
            parentId: r.parentId,
            parentChain: chain,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
            createdAt: (r as { createdAt?: number }).createdAt,
          };
        });
        sendJson(res, 200, { delegations: out });
        return;
      }
      if (req.method === "GET" && path === "/v1/settings") {
        const s = loadSettings();
        sendJson(res, 200, {
          provider: s.defaultProvider,
          model: s.defaultModel,
          approval: runtime.approval?.mode ?? s.approval?.mode ?? "on-mutation",
          thinking: s.thinking ?? "medium",
          providers: Object.entries(s.providers).map(([id, p]) => ({
            id,
            model: p.model,
            baseUrl: p.baseUrl,
            authMode: p.authMode,
            hasApiKey: Boolean(p.apiKey),
            hasOauthToken: Boolean(p.oauthToken),
            label: getProviderPreset(id)?.label ?? id,
          })),
          presets: listProviderPresets().map((preset) => presetToCatalogEntry(preset)),
        });
        return;
      }
      if (req.method === "POST" && path === "/v1/settings") {
        const body = await readJson<{ provider?: string; model?: string; baseUrl?: string; apiKey?: string; oauthToken?: string; authMode?: string; persistSecret?: boolean; approval?: string; thinking?: string }>(req);
        const persistSecret = body.persistSecret !== false;
        const settings = runtime.settings;
        const providerId = body.provider?.trim() || settings.defaultProvider;
        if (providerId) {
          const preset = getProviderPreset(providerId);
          const profile = settings.providers[providerId] ?? {
            id: providerId,
            baseUrl: preset?.defaultBaseUrl,
            model: preset?.defaultModel,
            authMode: preset?.defaultAuthMode,
          };
          if (body.baseUrl !== undefined) {
            const value = body.baseUrl.trim();
            if (value) profile.baseUrl = value;
            else if (preset?.defaultBaseUrl) profile.baseUrl = preset.defaultBaseUrl;
            else delete profile.baseUrl;
          }
          if (body.apiKey !== undefined) {
            const value = body.apiKey.trim();
            if (value) profile.apiKey = value;
            else delete profile.apiKey;
          }
          if (body.oauthToken !== undefined) {
            const value = body.oauthToken.trim();
            if (value) profile.oauthToken = value;
            else delete profile.oauthToken;
          }
          if (body.authMode !== undefined) {
            const value = body.authMode.trim();
            if (value === "oauth" || value === "apiKey" || value === "optional") {
              profile.authMode = value;
            } else if (preset?.defaultAuthMode) {
              profile.authMode = preset.defaultAuthMode;
            } else {
              delete profile.authMode;
            }
          }
          if (body.model !== undefined) {
            const value = body.model.trim();
            if (value) profile.model = value;
            else if (preset?.defaultModel) profile.model = preset.defaultModel;
          }
          settings.providers[providerId] = profile;
          settings.defaultProvider = providerId;
          settings.defaultModel = profile.model ?? settings.defaultModel;
          runtime.providerRegistry.invalidate(providerId);
          await runtime.setProviderAndModel(providerId, settings.defaultModel, { persistSettings: persistSecret });
        } else if (body.model) {
          settings.defaultModel = body.model.trim();
        }
        if (body.approval) {
          settings.approval = { ...(settings.approval ?? {}), mode: body.approval as "off" };
          if (runtime.approval) runtime.approval.mode = body.approval as "off";
        }
        if (body.thinking) {
          settings.thinking = body.thinking as Settings["thinking"];
          runtime.setThinking(body.thinking);
        }
        if (!persistSecret) {
          const persisted = scrubSensitiveSettings(settings);
          saveSettings(persisted);
        } else {
          saveSettings(settings);
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && path === "/v1/chat") {
        const body = await readJson<{ prompt: string }>(req);
        if (!body.prompt) { sendError(res, 400, "missing prompt"); return; }
        const ac = abortOnDisconnect(req);
        const result = await runOneChat(runtime, body.prompt, ac.signal);
        if (ac.signal.aborted) { return; /* client gone, nothing to send */ }
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/stream") {
        const body = await readJson<{
          prompt: string;
          attachments?: Array<{ type?: string; url: string; mimeType?: string }>;
        }>(req);
        if (!body.prompt) { sendError(res, 400, "missing prompt"); return; }
        const ac = abortOnDisconnect(req);
        // Mint a stream id, register the controller so a later
        // DELETE /v1/chat/stream/:id can abort it, and pass the
        // id into the streamChat handler so it can emit the
        // `stream_id` SSE event on the very first write.
        const streamId = newStreamId(runtime);
        activeStreams.set(streamId, ac);
        try {
          await streamChat(runtime, body.prompt, res, { attachments: body.attachments, signal: ac.signal, streamId });
        } finally {
          // Always clean up — the stream is done in every terminal
          // state (success, error, abort). A racing DELETE that
          // aborts us will see `ac.signal.aborted === true` and
          // resolve with `aborted: true`; cleaning up here is
          // safe because the DELETE handler doesn't delete the
          // entry itself (it just calls `.abort()`).
          activeStreams.delete(streamId);
        }
        return;
      }
      if (req.method === "POST" && path === "/v1/spawn") {
        const body = await readJson<{ agent: string; prompt: string }>(req);
        if (!body.agent || !body.prompt) { sendError(res, 400, "agent and prompt required"); return; }
        const ac = abortOnDisconnect(req);
        const r = await runtime.subagents.spawn({ agent: body.agent, prompt: body.prompt, cwd: process.cwd(), signal: ac.signal });
        if (ac.signal.aborted) { return; /* client gone, nothing to send */ }
        sendJson(res, 200, r);
        return;
      }
      if (req.method === "POST" && path === "/v1/approval/respond") {
        const body = await readJson<{ id: string; decision: string }>(req);
        const p = pendingApprovals.get(body.id);
        if (!p) { sendError(res, 404, "approval not found"); return; }
        pendingApprovals.delete(body.id);
        p.resolve(body.decision);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && path === "/v1/memory") {
        sendText(res, 200, runtime.memory.read() || "(empty)");
        return;
      }
      if (req.method === "POST" && path === "/v1/memory/append") {
        const body = await readJson<{ text: string }>(req);
        if (!body.text) { sendError(res, 400, "text required"); return; }
        await runtime.memory.append(body.text);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && path === "/v1/memory/search") {
        const body = await readJson<{ query: string }>(req);
        if (!body.query) { sendError(res, 400, "query required"); return; }
        sendText(res, 200, await runtime.memory.search(body.query) || "(no matches)");
        return;
      }

      // ---- Expansion: POST /v1/delegations ----
      // Submit a new delegation. The body is a discriminated union
      // mirroring `Delegation` in src/agent/delegation.ts; the manager
      // validates the kind-specific fields and runs the work in the
      // background. The response is the handle's first 4 fields
      // (id, status, kind, parentId) so external programs can poll
      // `/v1/delegations/:id` (or `/v1/loops/:id`) for progress.
      if (req.method === "POST" && path === "/v1/delegations") {
        const body = await readJson<{ kind?: string; [k: string]: unknown }>(req);
        const kind = body.kind;
        const validKinds: DelegationKind[] = [
          "agent", "goal", "async_tool", "mcp", "plugin", "api", "human_approval", "workflow",
        ];
        if (!kind || !validKinds.includes(kind as DelegationKind)) {
          sendError(res, 400, "missing or unknown kind; expected one of: " + validKinds.join(", "));
          return;
        }
        // Per-kind minimal validation. The manager will also validate
        // when the runner fires; we surface 400 here for the common
        // shape errors (missing objective, missing prompt) so the
        // client gets a fast, typed error rather than a "failed"
        // delegation.
        if (kind === "goal") {
          const g = body as { objective?: string };
          if (typeof g.objective !== "string" || g.objective.trim().length === 0) {
            sendError(res, 400, "goal kind requires a non-empty 'objective' string");
            return;
          }
        } else if (kind === "agent") {
          const a = body as { agent?: string; prompt?: string };
          if (typeof a.agent !== "string" || a.agent.length === 0) {
            sendError(res, 400, "agent kind requires an 'agent' field (e.g. 'explore', 'plan', 'implement')");
            return;
          }
          if (typeof a.prompt !== "string" || a.prompt.length === 0) {
            sendError(res, 400, "agent kind requires a 'prompt' string");
            return;
          }
        } else if (kind === "async_tool") {
          const t = body as { toolName?: string };
          if (typeof t.toolName !== "string" || t.toolName.length === 0) {
            sendError(res, 400, "async_tool kind requires a 'toolName' string");
            return;
          }
        } else if (kind === "human_approval") {
          const h = body as { prompt?: string; context?: { reason?: string }; defaultDecision?: string };
          if (typeof h.prompt !== "string" || h.prompt.length === 0) {
            sendError(res, 400, "human_approval kind requires a 'prompt' string");
            return;
          }
          if (h.defaultDecision !== "allow" && h.defaultDecision !== "deny") {
            sendError(res, 400, "human_approval kind requires 'defaultDecision' to be 'allow' or 'deny'");
            return;
          }
        } else if (kind === "mcp") {
          const m = body as { serverId?: string; tool?: string };
          if (typeof m.serverId !== "string" || typeof m.tool !== "string") {
            sendError(res, 400, "mcp kind requires 'serverId' and 'tool' strings");
            return;
          }
        } else if (kind === "plugin") {
          const p = body as { pluginId?: string; tool?: string };
          if (typeof p.pluginId !== "string" || typeof p.tool !== "string") {
            sendError(res, 400, "plugin kind requires 'pluginId' and 'tool' strings");
            return;
          }
        } else if (kind === "api") {
          const a = body as { url?: string };
          if (typeof a.url !== "string" || a.url.length === 0) {
            sendError(res, 400, "api kind requires a 'url' string");
            return;
          }
        } else if (kind === "workflow") {
          const w = body as { workflowId?: string };
          if (typeof w.workflowId !== "string" || w.workflowId.length === 0) {
            sendError(res, 400, "workflow kind requires a 'workflowId' string");
            return;
          }
        }
        // Cast through `unknown` because we've validated `kind`
        // against the union and the manager will validate the
        // remaining fields. Body parsing returned a wide open
        // `{ kind?, [k: string]: unknown }` shape; the manager
        // does the rest.
        const work = body as unknown as Delegation;
        const handle = runtime.delegations.submit(work);
        // For human_approval, await the result synchronously so
        // the client gets `{ approved }` without polling. The
        // manager resolves the promise once the user responds
        // via `/v1/approval/respond` (or once it falls back to
        // `defaultDecision` if no askApproval is wired — which
        // is the case in tests, so awaiting won't hang).
        if (kind === "human_approval") {
          const result = await handle.result().catch((e: Error) => ({ kind: "human_approval", decision: "deny", reason: e.message }) as { kind: "human_approval"; decision: "allow" | "deny"; reason?: string });
          const r = result as { decision: "allow" | "deny" };
          sendJson(res, 200, { id: handle.id, status: handle.status, kind: handle.kind, parentId: handle.parentId, approved: r.decision === "allow" });
          return;
        }
        sendJson(res, 200, {
          id: handle.id,
          status: handle.status,
          kind: handle.kind,
          parentId: handle.parentId,
        });
        return;
      }

      // ---- Expansion: GET /v1/delegations/:id ----
      // Drill-down. Same shape as the entries in the existing
      // `/v1/delegations` list. 404 if the id is unknown (the
      // manager doesn't keep a public map keyed by id; we
      // iterate the current run list and bail if no match).
      if (req.method === "GET" && delegationIdPath(path)) {
        const id = delegationIdPath(path)!;
        const runs = runtime.delegations.list();
        const run = runs.find((r) => r.id === id);
        if (!run) {
          sendError(res, 404, "delegation not found: " + id);
          return;
        }
        // Build the same parentChain the list endpoint produces
        // so the drill-down matches the list view 1:1.
        const chain: Array<{ id: string; kind: string; status: string }> = [];
        const seen = new Set<string>();
        const goalById = new Map<string, { id: string; loopStatus: string }>();
        for (const g of runtime.goalStore.list()) goalById.set(g.id, { id: g.id, loopStatus: g.loopStatus });
        let cur: string | undefined = run.parentId;
        while (cur && !seen.has(cur)) {
          seen.add(cur);
          const parentRun = runs.find((x) => x.id === cur);
          if (parentRun) {
            chain.push({ id: parentRun.id, kind: parentRun.kind, status: parentRun.status });
            cur = parentRun.parentId;
          } else {
            const asGoal = goalById.get(cur);
            if (asGoal) {
              chain.push({ id: asGoal.id, kind: "goal", status: asGoal.loopStatus });
            } else {
              chain.push({ id: cur, kind: "external", status: "unknown" });
            }
            cur = undefined;
          }
        }
        sendJson(res, 200, {
          id: run.id,
          kind: run.kind,
          status: run.status,
          parentId: run.parentId,
          parentChain: chain,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          createdAt: (run as unknown as { createdAt?: number }).createdAt,
        });
        return;
      }

      // ---- Expansion: GET /v1/agents/:id and /v1/skills/:id ----
      if (req.method === "GET" && agentIdPath(path)) {
        const id = agentIdPath(path)!;
        const def = runtime.subagents.get(id);
        if (!def) {
          sendError(res, 404, "agent not found: " + id);
          return;
        }
        sendJson(res, 200, {
          name: def.name,
          description: def.description,
          systemPrompt: def.systemPrompt,
          systemPromptAppend: def.systemPromptAppend,
          tools: def.tools,
          model: def.model,
          providerId: def.providerId,
          maxSteps: def.maxSteps,
          tags: def.tags,
        });
        return;
      }
      if (req.method === "GET" && skillIdPath(path)) {
        const id = skillIdPath(path)!;
        const s = await runtime.skills.get(id);
        if (!s) {
          sendError(res, 404, "skill not found: " + id);
          return;
        }
        sendJson(res, 200, {
          name: s.name,
          description: s.description,
          body: s.content,
        });
        return;
      }

      // ---- Expansion: GET /v1/sessions/:id and /v1/sessions/:id/messages ----
      if (req.method === "GET" && sessionsMessagesPath(path)) {
        const id = sessionsMessagesPath(path)!;
        const s = await Session.open(id).catch((e: Error) => {
          sendError(res, 404, "session not found: " + id + " (" + e.message + ")");
          return null;
        });
        if (!s) return;
        const msgs = sessionToMessages(s);
        sendJson(res, 200, {
          session: { id: s.id, createdAt: s.meta.createdAt, updatedAt: s.meta.updatedAt, model: s.meta.model, provider: s.meta.provider, entryCount: s.meta.entryCount },
          messages: msgs.map((m) => {
            const base: { role: string; content: string; timestamp?: number } = { role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) };
            const ts = s.allEntries().find((e) => e.type === m.role)?.ts;
            if (ts !== undefined) base.timestamp = ts;
            return base;
          }),
        });
        return;
      }
      if (req.method === "GET" && sessionIdPath(path)) {
        const id = sessionIdPath(path)!;
        const s = await Session.open(id).catch((e: Error) => {
          sendError(res, 404, "session not found: " + id + " (" + e.message + ")");
          return null;
        });
        if (!s) return;
        sendJson(res, 200, { session: s.meta });
        return;
      }

      // ---- Expansion: GET /v1/loops and /v1/loops/:id ----
      // "Loops" in this codebase is the union of two long-running
      // execution surfaces: the `DelegationManager.runs` (covers
      // agent / goal / async-tool / mcp / plugin / api / human-approval
      // / workflow kinds) and the runtime's `activeSubagents` map
      // (covers synchronous `/v1/spawn` sub-agents that haven't been
      // cleaned up yet). Both are returned under a unified
      // `{ id, source, kind, status, startedAt, completedAt? }` shape.
      if (req.method === "GET" && path === "/v1/loops") {
        const delegationLoops = runtime.delegations.list().map((r) => ({
          id: r.id,
          source: "delegation" as const,
          kind: r.kind,
          status: r.status,
          parentId: r.parentId,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
        }));
        const subagentLoops = [...runtime.activeSubagents.entries()].map(([id, v]) => ({
          id,
          source: "subagent" as const,
          kind: "agent" as const,
          status: v.status === "running" ? "running" : v.status === "ok" ? "completed" : "failed",
          parentId: undefined,
          startedAt: v.startedAt,
          completedAt: v.status === "running" ? undefined : Date.now(),
        }));
        sendJson(res, 200, { loops: [...delegationLoops, ...subagentLoops] });
        return;
      }
      if (req.method === "GET" && loopIdPath(path)) {
        const id = loopIdPath(path)!;
        // DelegationManager first.
        const run = runtime.delegations.list().find((r) => r.id === id);
        if (run) {
          // For goal kind, also surface the resolved GoalRecord so
          // dashboards don't need a second round-trip to /v1/goals.
          let goal: unknown | undefined;
          if (run.kind === "goal") {
            const all = runtime.goalStore.list();
            // We don't have the goalId on the handle directly, so
            // we surface the most recent goal that matches the
            // run's parent chain. The simplest match: the goal
            // whose id equals the run's parentId.
            if (run.parentId) {
              goal = all.find((g) => g.id === run.parentId);
            }
            // Fall back to a `get` by the run id (test fixture
            // patterns: the goal delegation's parentId is the
            // goalId).
            if (!goal) {
              // Already covered by the parentId branch above;
              // keep the fallback comment for grep-ability.
            }
          }
          sendJson(res, 200, {
            id: run.id,
            source: "delegation",
            kind: run.kind,
            status: run.status,
            parentId: run.parentId,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            ...(goal !== undefined ? { goal } : {}),
          });
          return;
        }
        // activeSubagents second.
        const sub = runtime.activeSubagents.get(id);
        if (sub) {
          sendJson(res, 200, {
            id,
            source: "subagent",
            kind: "agent",
            status: sub.status === "running" ? "running" : sub.status === "ok" ? "completed" : "failed",
            parentId: undefined,
            startedAt: sub.startedAt,
          });
          return;
        }
        sendError(res, 404, "loop not found: " + id);
        return;
      }

      // ---- Expansion: DELETE /v1/chat/stream/:id ----
      // Abort an in-flight SSE stream. The stream handler registers
      // its AbortController under the id returned in the first
      // `stream_id` SSE event; this handler looks it up, calls
      // `.abort()`, and returns 200. 404 if the id isn't in the
      // active set (already finished, never started, or wrong id).
      if (req.method === "DELETE" && streamIdPath(path)) {
        const id = streamIdPath(path)!;
        const ac = activeStreams.get(id);
        if (!ac) {
          sendError(res, 404, "stream not found: " + id);
          return;
        }
        ac.abort();
        // Don't immediately delete the entry — the stream handler
        // is responsible for cleaning up when it sees the abort.
        // Deleting here would race with the stream's `finally`
        // block and could leak a dangling controller reference.
        sendJson(res, 200, { ok: true, id, aborted: true });
        return;
      }

      sendError(res, 404, "not found: " + path);
    } catch (e) {
      const err = e as Error;
      if (err instanceof BodyTooLargeError) {
        sendError(res, 413, err.message);
        return;
      }
      log.error("server error", err);
      sendError(res, 500, err.message ?? "internal error");
    }
  });

  server.listen(opts.port, opts.host, () => {
    const uiUrl = `http://${opts.host}:${opts.port}/`;
    const apiUrl = `http://${opts.host}:${opts.port}/v1/`;
    process.stdout.write("CodingHarness server listening on " + uiUrl + "\n");
    process.stdout.write("  web UI:    " + uiUrl + "\n");
    process.stdout.write("  JSON API:  " + apiUrl + "\n");
    process.stdout.write("  SSE chat:  POST " + apiUrl + "chat/stream\n");
    process.stdout.write("  sub-agent: POST " + apiUrl + "spawn\n");
    process.stdout.write("  attach:    ch attach " + uiUrl.replace(/\/$/, "") + "\n");
  });
  await new Promise(() => { /* run until killed */ });
}

function scrubSensitiveSettings(settings: Settings): Settings {
  const clone = JSON.parse(JSON.stringify(settings)) as Settings;
  for (const profile of Object.values(clone.providers ?? {})) {
    delete profile.apiKey;
    delete profile.oauthToken;
  }
  return clone;
}

/**
 * Bridge `runtime.askApprovalHandler` to the server's
 * `pendingApprovals` map + SSE `approval_required` event for the
 * lifetime of a single stream. Returns a cleanup function that:
 *   1. Restores the prior `askApprovalHandler` (so the next stream
 *      on the same runtime — e.g. when the TUI attach client
 *      reuses a session — starts fresh).
 *   2. Deny-resolves any pending approval entries that belong to
 *      this stream so an aborted client can't leave the bash tool
 *      hung forever waiting for a user response that will never
 *      arrive.
 *
 * Pre-bridge, the chat/stream endpoint ran the model without any
 * approval hook — the runtime's `askApprovalHandler` was null, so
 * the bash tool's `askFn` short-circuited to its static "approval
 * required" error and the user had to run commands in the CLI to
 * drive the agent. Wiring the bridge makes the web UI's approval
 * modal functional end-to-end.
 */
function bridgeApprovalForStream(
  runtime: HarnessRuntime,
  res: ServerResponse,
  streamId: string,
): () => void {
  const prev = runtime.askApprovalHandler;
  // Sub-map of entries this bridge owns. The cleanup iterates it to
  // deny-resolve orphans; entries created by other streams (e.g.
  // concurrent TUI sessions) are untouched.
  const owned = new Set<string>();
  runtime.askApprovalHandler = async (command: string, reason: string) => {
    const id = streamId + "-ap-" + randomUUID();
    const promise = new Promise<"allow-once" | "allow-always" | "deny">((resolve) => {
      pendingApprovals.set(id, { resolve: (d) => resolve(coerceDecision(d)), createdAt: Date.now(), stream: streamId });
    });
    owned.add(id);
    // Emit the SSE event so the client can pop the approval modal.
    // If the stream was already aborted (client gone) we skip the
    // event — there's nobody to receive it — and deny-resolve
    // immediately so the bash tool gets a clean "deny" instead of
    // hanging on a promise that will never resolve.
    if (res.writableEnded) {
      pendingApprovals.delete(id);
      owned.delete(id);
      return "deny";
    }
    res.write(sse("approval_required", { id, command, reason }));
    const decision = await promise;
    pendingApprovals.delete(id);
    owned.delete(id);
    return decision;
  };
  return () => {
    runtime.askApprovalHandler = prev;
    // Deny-resolve any entries still in flight for this stream.
    // The bash tool's `askFn` awaiter will see "deny" and return
    // the structured "bash: denied by user" error, the agent loop
    // will surface that to the model, and the runAgent call will
    // exit on the next `opts.signal.aborted` check.
    for (const id of owned) {
      const entry = pendingApprovals.get(id);
      if (entry) {
        entry.resolve("deny");
        pendingApprovals.delete(id);
      }
    }
    owned.clear();
  };
}

/** Coerce a free-form client decision string into the strict union
 *  the runtime's `askApprovalHandler` is typed to return. Anything
 *  unrecognised falls back to "deny" — fail-safe, since the worst
 *  case is the user has to confirm again. The `coerceDecision`
 *  helper is also the central place to record a structured
 *  "denied by server: unknown decision <x>" log if a misbehaving
 *  client ever sends a non-allowed value. Exported for unit tests
 *  in `__tests__/server-approval-bridge.test.ts` — the rest of the
 *  bridge's behavior is exercised by the integration test in
 *  `server-expansion.test.ts`. */
export function coerceDecision(s: string): "allow-once" | "allow-always" | "deny" {
  if (s === "allow-once" || s === "allow-always" || s === "deny") return s;
  log.warn("approval: unknown decision " + JSON.stringify(s) + " — defaulting to deny");
  return "deny";
}

function serveStatic(res: ServerResponse, file: string): void {
  const path = join(WEB_DIR, file);
  if (!existsSync(path)) { sendError(res, 404, "not found: " + file); return; }
  const content = readFileSync(path);
  const ext = extname(file);
  const ct = MIME[ext] ?? "application/octet-stream";
  setCors(res);
  res.writeHead(200, { "content-type": ct, "cache-control": "no-cache" });
  res.end(content);
}

async function runOneChat(runtime: HarnessRuntime, prompt: string, signal?: AbortSignal) {
  const slash = tryParseSlash(prompt);
  if (slash) {
    const cmd = BUILTIN_REGISTRY.get(slash.name);
    if (cmd) {
      const out = await cmd.run(slash.args, { cwd: process.cwd(), runtime: () => runtime });
      return { text: typeof out === "string" ? out : "(no output)", usage: { inputTokens: 0, outputTokens: 0 }, steps: 0 };
    }
  }
  // LLM call
  const provider = runtime.providerRegistry.default();
  if (!provider) return { text: "no provider configured", usage: { inputTokens: 0, outputTokens: 0 }, steps: 0 };
  const model = runtime.model() ?? "default";
  const session = await runtime.ensureSession();
  await session.append({ kind: "message", message: { role: "user", content: prompt } });
  const messages = sessionToMessages(session);
  const result = await runAgent({
    provider, model,
    system: await runtime.buildSystemPrompt(),
    messages, tools: runtime.tools, cwd: process.cwd(),
    signal: signal ?? new AbortController().signal,
    limits: { ...DEFAULT_LIMITS },
  });
  // Don't append the assistant turn if the client has already gone away —
  // the response is dropped on the floor anyway, and an empty "user + orphan
  // assistant" pair pollutes the session for the next run.
  if (signal?.aborted) return { text: result.final.content, usage: result.usage, steps: result.steps };
  await session.append({ kind: "message", message: result.final });
  return { text: result.final.content, usage: result.usage, steps: result.steps };
}

async function streamChat(
  runtime: HarnessRuntime,
  prompt: string,
  res: ServerResponse,
  opts: { attachments?: Array<{ type?: string; url: string; mimeType?: string }>; signal?: AbortSignal; streamId?: string } = {},
) {
  setCors(res);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  res.write(": stream start\n\n");
  // Emit the stream id FIRST so a client that wants to cancel can
  // fire DELETE /v1/chat/stream/:id as soon as it has the id, even
  // before the model starts producing text. The handler in
  // `startServer` already registered the controller under this id.
  if (opts.streamId) res.write(sse("stream_id", { id: opts.streamId }));

  const { expandInputPrefixes } = await import("./util/input-prefixes.js");
  const expanded = await expandInputPrefixes(prompt, runtime.cwd);
  prompt = expanded.prompt;

  // Slash command?
  const slash = tryParseSlash(prompt);
  if (slash) {
    const cmd = BUILTIN_REGISTRY.get(slash.name);
    if (cmd) {
      const clearOutput = runtime.setOutputHandler({
        onTextDelta: (text) => { res.write(sse("text", { text })); },
        onReasoningDelta: (text) => { res.write(sse("reasoning", { text })); },
        onImageDelta: (image) => { res.write(sse("image", image)); },
        onToolCallStart: (tc) => { res.write(sse("tool_start", { name: tc.name, args: tc.argsJson })); },
        onToolCallEnd: (tc, r) => { res.write(sse("tool_end", { name: tc.name, isError: r.isError, display: r.display, detail: r.display })); },
        onUsage: (u) => { res.write(sse("usage", u)); },
        onInfo: (text) => { res.write(sse("info", { text })); },
        onError: (error) => { res.write(sse("error", { text: error.message })); },
      });
      try {
        const out = await cmd.run(slash.args, { cwd: process.cwd(), runtime: () => runtime });
        if (typeof out === "string" && out.length > 0) res.write(sse("info", { text: out }));
      } catch (e) {
        res.write(sse("error", { text: (e as Error).message }));
      } finally {
        clearOutput();
      }
      res.write(sse("done", { text: "" }));
      res.end();
      return;
    }
  }
  // (fall through to LLM)

  // LLM call with streaming.
  const provider = runtime.providerRegistry.default();
  if (!provider) {
    res.write(sse("error", { text: "no provider configured" }));
    res.write(sse("done", { text: "" }));
    res.end();
    return;
  }
  const model = runtime.model() ?? "default";
  const { buildUserContentParts } = await import("./providers/omni.js");
  const contentParts = buildUserContentParts(prompt, opts.attachments);
  const session = await runtime.ensureSession();
  await session.append({
    kind: "message",
    message: {
      role: "user",
      content: prompt,
      ...(contentParts ? { contentParts } : {}),
    },
  });
  const messages = sessionToMessages(session);

  let lastText = "";
  let usage = { inputTokens: 0, outputTokens: 0 };
  let steps = 0;

  // Bridge the runtime's askApprovalHandler to the SSE
  // approval_required event + /v1/approval/respond for the
  // lifetime of this stream. The bridge cleanup is guaranteed
  // to run (even on abort/throw) so the handler is restored
  // and any in-flight approval entries are deny-resolved —
  // otherwise the bash tool would hang on a promise the
  // client will never resolve.
  const streamIdForApproval = opts.streamId ?? "anon";
  const restoreApproval = bridgeApprovalForStream(runtime, res, streamIdForApproval);

  try {
    const result = await runAgent({
      provider, model,
      system: await runtime.buildSystemPrompt(),
      messages, tools: runtime.tools, cwd: process.cwd(),
      signal: opts.signal ?? new AbortController().signal,
      limits: { ...DEFAULT_LIMITS },
      failoverChain: runtime.buildFailoverChain(),
      hooks: {
        onTextDelta: (t: string) => { lastText += t; res.write(sse("text", { text: t })); },
        onReasoningDelta: (t: string) => { res.write(sse("reasoning", { text: t })); },
        onToolCallStart: (tc: { name: string; argsJson: string }) => { res.write(sse("tool_start", { name: tc.name, args: tc.argsJson })); },
        onToolCallEnd: (tc: { name: string }, r: { isError: boolean; display: string }) => { res.write(sse("tool_end", { name: tc.name, isError: r.isError, display: r.display, detail: r.display })); },
        onUsage: (u: { inputTokens: number; outputTokens: number }) => { usage = u; res.write(sse("usage", u)); },
        onInfo: (m: string) => { res.write(sse("info", { text: m })); },
        onError: (e: Error) => { res.write(sse("error", { text: e.message })); },
      },
    });
    lastText = result.final.content;
    steps = result.steps;
    if (result.usage) usage = result.usage;
    // Don't append the assistant turn if the client disconnected mid-run —
    // the response is already abandoned, and writing an orphan entry
    // would poison the next reload's session.
    if (!opts.signal?.aborted) {
      await session.append({ kind: "message", message: result.final });
    }
  } catch (e) {
    if (opts.signal?.aborted) {
      res.write(sse("error", { text: "aborted" }));
    } else {
      res.write(sse("error", { text: (e as Error).message }));
    }
  } finally {
    // Always restore the prior handler and deny-resolve any
    // in-flight approvals — the finally fires on success, error,
    // and abort, which is exactly the invariant we need.
    restoreApproval();
  }

  res.write(sse("done", { text: lastText, usage, steps }));
  res.end();
}
