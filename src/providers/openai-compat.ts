// OpenAI-compatible provider.
// Works with OpenAI, OpenRouter, LM Studio, vLLM, DeepSeek, Groq, Together,
// Cloudflare, OpenCode, OpenAI Responses mode, and any other /v1/chat/completions
// endpoint that speaks the OpenAI shape.

import type {
  ChatMessage,
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  Role,
  ToolCall,
  ToolSpec,
} from "../types.js";
import { retry } from "../util/retry.js";
import { withTimeout } from "../util/errors.js";
import { log } from "../util/logger.js";

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey?: string;
  /** Model to use when the request doesn't specify one. */
  defaultModel: string;
  /** Provider id (e.g. "openai", "openrouter"). */
  id: string;
  /** Override the path (default "/chat/completions"). */
  path?: string;
  /** Extra headers to send with every request. */
  extraHeaders?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenAICompatProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  private readonly cfg: OpenAICompatConfig;

  constructor(cfg: OpenAICompatConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.displayName = cfg.id;
  }

  async isConfigured(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.cfg.baseUrl) return { ok: false, reason: "missing baseUrl" };
    // A bearer credential is required for hosted providers but optional
    // for local servers such as LM Studio or Ollama.
    const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(this.cfg.baseUrl);
    if (!this.cfg.apiKey && !isLocal) {
      return { ok: false, reason: `missing auth token for ${this.id} (set env or settings.json)` };
    }
    return { ok: true };
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const url = new URL(this.cfg.path ?? "/chat/completions", this.cfg.baseUrl).toString();
    const body = toOpenAIBody(req, this.cfg.defaultModel);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...this.cfg.extraHeaders,
    };
    if (this.cfg.apiKey) headers["authorization"] = `Bearer ${this.cfg.apiKey}`;

    log.debug(`provider ${this.id} request`, { url, model: req.model });

    const res = await retry(() =>
      withTimeout(fetch(url, { method: "POST", headers, body: JSON.stringify(body) }), DEFAULT_TIMEOUT_MS, `provider ${this.id}`, req.signal)
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`provider ${this.id} HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    if (!res.body) throw new Error(`provider ${this.id}: empty response body`);

    yield* parseSSE(res.body, req.signal);
  }

  async listModels(): Promise<string[]> {
    if (!this.cfg.apiKey) {
      const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(this.cfg.baseUrl);
      if (!isLocal) return [];
    }
    try {
      const res = await fetch(new URL("/models", this.cfg.baseUrl).toString(), {
        headers: this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {},
      });
      if (!res.ok) return [];
      const j = (await res.json()) as { data?: Array<{ id: string }> };
      return (j.data ?? []).map((m) => m.id).sort();
    } catch {
      return [];
    }
  }

  /** Convenience: collect the full stream into a single response. */
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    let message: ChatMessage = { role: "assistant", content: "" };
    let usage = { inputTokens: 0, outputTokens: 0 };
    let raw: unknown;
    for await (const ev of this.stream(req)) {
      switch (ev.type) {
        case "text":
          message.content += ev.text ?? "";
          break;
        case "reasoning":
          message.reasoning = (message.reasoning ?? "") + (ev.reasoning ?? "");
          break;
        case "tool_call":
          if (ev.toolCall) {
            message.toolCalls = [...(message.toolCalls ?? []), ev.toolCall];
          }
          break;
        case "usage":
          if (ev.usage) usage = ev.usage;
          break;
        case "error":
          throw new Error(ev.error?.message ?? "provider error");
        case "done":
          raw = ev;
          break;
      }
    }
    return { message, usage, raw };
  }
}

// ---------- Request shaping ----------

function toOpenAIBody(req: ProviderRequest, defaultModel: string): unknown {
  const messages = toOpenAIMessages(req);
  return {
    model: req.model || defaultModel,
    messages,
    ...(req.tools && req.tools.length > 0 ? { tools: req.tools.map(toOpenAITool) } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
}

function toOpenAIMessages(req: ProviderRequest): unknown[] {
  const out: unknown[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.argsJson },
        })),
      });
      continue;
    }
    out.push({ role: m.role as Role, content: m.content });
  }
  return out;
}

function toOpenAITool(t: ToolSpec): unknown {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

// ---------- SSE parser ----------

async function* parseSSE(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let done = false;
  // Track partial tool calls (streamed as deltas).
  const partialToolCalls = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string | undefined;

  try {
    while (!done) {
      if (signal.aborted) {
        try { reader.cancel(); } catch {}
        throw makeAbortError();
      }
      const { value, done: d } = await reader.read();
      done = d;
      if (value) buf += decoder.decode(value, { stream: true });
      let idx: number;
      // SSE: lines separated by \n\n. We parse one event at a time.
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = raw.split("\n");
        let data = "";
        for (const line of lines) {
          if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        if (data === "[DONE]") {
          yield { type: "done" };
          return;
        }
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        // OpenAI choice format
        const choice = parsed.choices?.[0];
        if (choice) {
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text", text: delta.content };
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            yield { type: "reasoning", reasoning: delta.reasoning_content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = typeof tc.index === "number" ? tc.index : 0;
              let entry = partialToolCalls.get(i);
              if (!entry) {
                entry = { id: tc.id ?? `call_${i}_${Date.now()}`, name: tc.function?.name ?? "", args: "" };
                partialToolCalls.set(i, entry);
              }
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (typeof tc.function?.arguments === "string") {
                entry.args += tc.function.arguments;
                // Once the args are valid JSON, emit the call.
                if (looksCompleteJson(entry.args)) {
                  const call: ToolCall = { id: entry.id, name: entry.name, argsJson: entry.args };
                  yield { type: "tool_call", toolCall: call };
                }
              }
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        // Usage chunk (sent at the end when stream_options.include_usage=true)
        if (parsed.usage) {
          yield {
            type: "usage",
            usage: {
              inputTokens: parsed.usage.prompt_tokens ?? 0,
              outputTokens: parsed.usage.completion_tokens ?? 0,
            },
          };
        }
        // Error envelope
        if (parsed.error) {
          yield { type: "error", error: { message: String(parsed.error.message ?? parsed.error), code: String(parsed.error.code ?? "") } };
          return;
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    yield { type: "error", error: { message: (err as Error).message } };
    return;
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  // If finishReason was set, emit any unflushed tool calls.
  if (finishReason && partialToolCalls.size > 0) {
    for (const [, entry] of partialToolCalls) {
      yield {
        type: "tool_call",
        toolCall: { id: entry.id, name: entry.name, argsJson: entry.args || "{}" },
      };
    }
    partialToolCalls.clear();
  }
  yield { type: "done" };
}

function looksCompleteJson(s: string): boolean {
  // Cheap check: balanced braces and starts with { ends with }.
  if (!s.startsWith("{")) return false;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return true; }
  }
  return false;
}

function makeAbortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
