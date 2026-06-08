// Headless server. Exposes the harness over HTTP + serves the web UI.
//
// Endpoints:
//   GET  /                         — Web UI (index.html)
//   GET  /styles.css, /app.js      — Web UI assets
//   GET  /v1/status                 — { version, model, provider }
//   GET  /v1/diag                   — connectivity / latency check
//   GET  /v1/tokens                 — rough token count of active session
//   GET  /v1/agents                 — list of sub-agents
//   GET  /v1/skills                 — list of skills
//   GET  /v1/sessions               — list of sessions
//   POST /v1/session                — { id? } start or resume
//   GET  /v1/usage                  — { inputTokens, outputTokens, cost, topModel }
//   GET  /v1/commands               — list of slash commands
//   GET  /v1/settings               — current settings
//   POST /v1/settings               — { provider, model, baseUrl, apiKey, approval, thinking } update
//   POST /v1/chat                   — { prompt, agent? } one-shot JSON
//   POST /v1/chat/stream            — SSE: text, tool_start, tool_end, info, error, approval_required, usage, done
//   POST /v1/spawn                  — { agent, prompt } — synchronous sub-agent run
//   POST /v1/approval/respond      — { id, decision } — resume a paused approval
//   POST /v1/memory/read            — read MEMORY.md
//   POST /v1/memory/append          — { text } — append to MEMORY.md
//   POST /v1/memory/search          — { query } — search
//
// SSE event shapes:
//   text:               { text: string }
//   tool_start:         { name: string, args: string }
//   tool_end:           { name: string, isError: boolean, display: string }
//   info:               { text: string }
//   error:              { text: string }
//   approval_required:  { id, command, reason }
//   usage:              { inputTokens, outputTokens }
//   done:               { text, usage, steps }

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Session, sessionToMessages } from "./agent/session.js";
import { loadSettings, saveSettings, type Settings } from "./config/settings.js";
import { getProviderPreset, listProviderPresets } from "./providers/presets.js";
import { BUILTIN_REGISTRY, tryParseSlash } from "./slash/index.js";
import { runAgent, DEFAULT_LIMITS } from "./agent/loop.js";
import { log } from "./util/logger.js";
import type { HarnessRuntime } from "./runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

/** In-flight approval requests waiting for a user response. */
const pendingApprovals = new Map<string, { resolve: (decision: string) => void; createdAt: number }>();

/** Read the request body as JSON. */
async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text) throw new Error("empty body");
  return JSON.parse(text) as T;
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

    try {
      // ---- Web UI ----
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        serveStatic(res, "index.html");
        return;
      }
      if (req.method === "GET" && (path === "/styles.css" || path === "/app.js" || path === "/favicon.ico" || path === "/favicon.svg")) {
        serveStatic(res, path.slice(1));
        return;
      }

      // ---- JSON API ----
      if (req.method === "GET" && path === "/v1/status") {
        sendJson(res, 200, {
          ok: true,
          version: "0.2.2",
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
          presets: listProviderPresets().map((preset) => ({
            id: preset.id,
            label: preset.label,
            protocol: preset.protocol,
            defaultBaseUrl: preset.defaultBaseUrl,
            defaultModel: preset.defaultModel,
            authModes: preset.authModes,
            defaultAuthMode: preset.defaultAuthMode,
            authDocsUrl: preset.authDocsUrl,
            authLaunchUrl: preset.authLaunchUrl,
            description: preset.description,
          })),
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
        const result = await runOneChat(runtime, body.prompt);
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/stream") {
        const body = await readJson<{ prompt: string }>(req);
        if (!body.prompt) { sendError(res, 400, "missing prompt"); return; }
        await streamChat(runtime, body.prompt, res);
        return;
      }
      if (req.method === "POST" && path === "/v1/spawn") {
        const body = await readJson<{ agent: string; prompt: string }>(req);
        if (!body.agent || !body.prompt) { sendError(res, 400, "agent and prompt required"); return; }
        const ac = new AbortController();
        const r = await runtime.subagents.spawn({ agent: body.agent, prompt: body.prompt, cwd: process.cwd(), signal: ac.signal });
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

      sendError(res, 404, "not found: " + path);
    } catch (e) {
      const err = e as Error;
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

async function runOneChat(runtime: HarnessRuntime, prompt: string) {
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
    signal: new AbortController().signal,
    limits: { ...DEFAULT_LIMITS },
  });
  await session.append({ kind: "message", message: result.final });
  return { text: result.final.content, usage: result.usage, steps: result.steps };
}

async function streamChat(runtime: HarnessRuntime, prompt: string, res: ServerResponse) {
  setCors(res);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  res.write(": stream start\n\n");

  // Slash command?
  const slash = tryParseSlash(prompt);
  if (slash) {
    const cmd = BUILTIN_REGISTRY.get(slash.name);
    if (cmd) {
      const clearOutput = runtime.setOutputHandler({
        onTextDelta: (text) => { res.write(sse("text", { text })); },
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
  const session = await runtime.ensureSession();
  await session.append({ kind: "message", message: { role: "user", content: prompt } });
  const messages = sessionToMessages(session);

  let lastText = "";
  let usage = { inputTokens: 0, outputTokens: 0 };
  let steps = 0;

  try {
    const result = await runAgent({
      provider, model,
      system: await runtime.buildSystemPrompt(),
      messages, tools: runtime.tools, cwd: process.cwd(),
      signal: new AbortController().signal,
      limits: { ...DEFAULT_LIMITS },
      failoverChain: runtime.buildFailoverChain(),
      hooks: {
        onTextDelta: (t: string) => { lastText += t; res.write(sse("text", { text: t })); },
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
    await session.append({ kind: "message", message: result.final });
  } catch (e) {
    res.write(sse("error", { text: (e as Error).message }));
  }

  res.write(sse("done", { text: lastText, usage, steps }));
  res.end();
}
