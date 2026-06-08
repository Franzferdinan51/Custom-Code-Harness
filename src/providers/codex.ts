// Codex OAuth Responses API provider.
// Uses OpenAI's Responses API (Codex backend) for ChatGPT subscription auth.

import type {
  ChatMessage,
  ImageGenerationRequest,
  ImageGenerationResult,
  Provider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ToolCall,
} from "../types.js";
import { retry } from "../util/retry.js";
import { withTimeout } from "../util/errors.js";
import { log } from "../util/logger.js";
import { toOpenAITool, toResponsesInput } from "./omni.js";

export interface CodexProviderConfig {
  id: string;
  /** OAuth access token (ChatGPT subscription). */
  accessToken: string;
  defaultModel: string;
  /** Codex Responses base URL. */
  baseUrl?: string;
  capabilities?: ProviderCapabilities;
}

const DEFAULT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const DEFAULT_TIMEOUT_MS = 120_000;

export class CodexProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  private readonly cfg: CodexProviderConfig;

  constructor(cfg: CodexProviderConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.displayName = cfg.id;
    this.capabilities = cfg.capabilities ?? { omni: true, imageInput: true, reasoning: true, responsesApi: true };
  }

  async isConfigured(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.cfg.accessToken) return { ok: false, reason: "missing OAuth access token" };
    if (!this.responsesUrl()) return { ok: false, reason: "missing baseUrl" };
    return { ok: true };
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const url = this.responsesUrl();
    const body = {
      model: req.model || this.cfg.defaultModel,
      input: toResponsesInput(req),
      ...(req.tools && req.tools.length > 0
        ? { tools: req.tools.map((t) => toOpenAITool(t)) }
        : {}),
      ...(req.maxTokens !== undefined ? { max_output_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      stream: true,
      reasoning: { effort: "medium", summary: "auto" },
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${this.cfg.accessToken}`,
      originator: "codingharness",
      "User-Agent": "codingharness/0.2.2",
    };

    log.debug(`provider ${this.id} codex request`, { url, model: req.model });

    const res = await retry(() =>
      withTimeout(
        fetch(url, { method: "POST", headers, body: JSON.stringify(body) }),
        DEFAULT_TIMEOUT_MS,
        `provider ${this.id}`,
        req.signal,
      ),
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`provider ${this.id} HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    if (!res.body) throw new Error(`provider ${this.id}: empty response body`);

    yield* parseResponsesSSE(res.body, req.signal);
  }

  async listModels(): Promise<string[]> {
    // Codex models are catalog-driven; return the configured default.
    return [this.cfg.defaultModel];
  }

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
          if (ev.toolCall) message.toolCalls = [...(message.toolCalls ?? []), ev.toolCall];
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

  async generateImage(_req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    throw new Error("Codex OAuth provider does not expose /v1/images/generations — use vllm-omni or openai API key");
  }

  private responsesUrl(): string {
    const base = (this.cfg.baseUrl ?? DEFAULT_CODEX_BASE).replace(/\/$/, "");
    return base.endsWith("/responses") ? base : `${base}/responses`;
  }
}

// ---------- Responses SSE parser ----------

async function* parseResponsesSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<ProviderStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  const partialToolCalls = new Map<string, { id: string; name: string; args: string }>();

  try {
    while (true) {
      if (signal.aborted) {
        try { reader.cancel(); } catch {}
        throw makeAbortError();
      }
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = raw.split("\n");
        let eventType = "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data || data === "[DONE]") {
          if (data === "[DONE]") {
            yield { type: "done" };
            return;
          }
          continue;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        // Text deltas
        if (eventType.includes("output_text.delta") || eventType === "response.output_text.delta") {
          const delta = String(parsed.delta ?? parsed.text ?? "");
          if (delta) yield { type: "text", text: delta };
          continue;
        }

        // Reasoning deltas (summary or content)
        if (
          eventType.includes("reasoning") && eventType.includes("delta") ||
          eventType === "response.reasoning_summary_text.delta" ||
          eventType === "response.reasoning_text.delta"
        ) {
          const delta = String(parsed.delta ?? parsed.text ?? parsed.summary ?? "");
          if (delta) yield { type: "reasoning", reasoning: delta };
          continue;
        }

        // Function/tool call deltas
        if (eventType.includes("function_call") && eventType.includes("delta")) {
          const item = (parsed.item ?? parsed) as Record<string, unknown>;
          const callId = String(item.call_id ?? item.id ?? `call_${partialToolCalls.size}`);
          let entry = partialToolCalls.get(callId);
          if (!entry) {
            entry = { id: callId, name: String(item.name ?? ""), args: "" };
            partialToolCalls.set(callId, entry);
          }
          if (item.name) entry.name = String(item.name);
          if (typeof item.arguments === "string") entry.args += item.arguments;
          if (looksCompleteJson(entry.args)) {
            const call: ToolCall = { id: entry.id, name: entry.name, argsJson: entry.args };
            yield { type: "tool_call", toolCall: call };
            partialToolCalls.delete(callId);
          }
          continue;
        }

        // Image output (when emitted by omni backends)
        if (eventType.includes("image") && (parsed.url || parsed.b64_json)) {
          const url = parsed.url
            ? String(parsed.url)
            : `data:image/png;base64,${String(parsed.b64_json)}`;
          yield { type: "image", image: { url, mimeType: "image/png" } };
          continue;
        }

        if (eventType === "response.completed" || eventType === "response.incomplete") {
          const response = parsed.response as Record<string, unknown> | undefined;
          const usage = response?.usage as Record<string, number> | undefined;
          if (usage) {
            yield {
              type: "usage",
              usage: {
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
              },
            };
          }
          // Flush any remaining tool calls from the final output array.
          const output = response?.output as Array<Record<string, unknown>> | undefined;
          if (output) {
            for (const item of output) {
              if (item.type === "function_call") {
                const call: ToolCall = {
                  id: String(item.call_id ?? item.id ?? `call_${Date.now()}`),
                  name: String(item.name ?? ""),
                  argsJson: String(item.arguments ?? "{}"),
                };
                yield { type: "tool_call", toolCall: call };
              }
              if (item.type === "message") {
                const content = item.content as Array<Record<string, unknown>> | undefined;
                for (const c of content ?? []) {
                  if (c.type === "output_text" && typeof c.text === "string" && c.text.length > 0) {
                    yield { type: "text", text: c.text };
                  }
                  if (c.type === "output_image" && c.image_url) {
                    yield { type: "image", image: { url: String(c.image_url) } };
                  }
                }
              }
            }
          }
          yield { type: "done" };
          return;
        }

        if (eventType === "response.failed") {
          const response = parsed.response as Record<string, unknown> | undefined;
          const err = response?.error as Record<string, unknown> | undefined;
          yield {
            type: "error",
            error: { message: String(err?.message ?? "response failed"), code: String(err?.code ?? "") },
          };
          return;
        }

        // Fallback: OpenAI chat-completions-shaped chunks on some proxies
        const choice = (parsed.choices as Array<Record<string, unknown>> | undefined)?.[0];
        if (choice) {
          const delta = (choice.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text", text: delta.content };
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            yield { type: "reasoning", reasoning: delta.reasoning_content };
          }
        }
        if (parsed.usage) {
          const u = parsed.usage as Record<string, number>;
          yield {
            type: "usage",
            usage: { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 },
          };
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

  yield { type: "done" };
}

function looksCompleteJson(s: string): boolean {
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