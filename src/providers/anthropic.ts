// Anthropic native provider (Messages API).
// Translates our internal ChatMessage shape to and from Anthropic's
// `messages` format, including tool use blocks.

import type {
  ChatMessage,
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ToolCall,
  ToolSpec,
} from "../types.js";
import { retry } from "../util/retry.js";
import { withTimeout } from "../util/errors.js";
import { log } from "../util/logger.js";

export interface AnthropicConfig {
  apiKey: string;
  defaultModel: string;
  /** Optional base URL override (default https://api.anthropic.com). */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  readonly displayName = "Anthropic";
  private readonly cfg: AnthropicConfig;

  constructor(cfg: AnthropicConfig) {
    if (!cfg.apiKey) throw new Error("anthropic: apiKey required");
    this.cfg = cfg;
  }

  async isConfigured(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.cfg.apiKey) return { ok: false, reason: "missing ANTHROPIC_API_KEY" };
    return { ok: true };
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const base = this.cfg.baseUrl ?? DEFAULT_BASE_URL;
    const url = new URL("/v1/messages", base).toString();
    const body = toAnthropicBody(req, this.cfg.defaultModel);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-api-key": this.cfg.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };

    log.debug("provider anthropic request", { url, model: req.model });

    const res = await retry(() =>
      withTimeout(
        fetch(url, { method: "POST", headers, body: JSON.stringify(body) }),
        DEFAULT_TIMEOUT_MS,
        "provider anthropic",
        req.signal
      )
    );
    if (!res.ok) {
      // Stream-read with a cap so a hostile / runaway Anthropic
      // error response can't OOM the harness. Pre-fix:
      // `await res.text()` materialized the full error body
      // before slicing to 500 chars. Now: stream-read up to
      // 1 MB (well past what a real Anthropic error looks like)
      // and slice at the end. Same pattern as the `http` /
      // `web_search` / `runApiKind` tools.
      const ERROR_BODY_CAP = 1_000_000;
      const chunks: Uint8Array[] = [];
      let received = 0;
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            if (received + value.byteLength > ERROR_BODY_CAP) {
              const allowed = Math.max(0, ERROR_BODY_CAP - received);
              if (allowed > 0) {
                chunks.push(value.subarray(0, allowed));
                received += allowed;
              }
              try { await reader.cancel(); } catch { /* best-effort */ }
              break;
            }
            chunks.push(value);
            received += value.byteLength;
          }
        }
      }
      const bytes = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
      const text = new TextDecoder("utf-8").decode(bytes);
      throw new Error(`provider anthropic HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    if (!res.body) throw new Error("provider anthropic: empty body");

    yield* parseAnthropicSSE(res.body, req.signal);
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    let message: ChatMessage = { role: "assistant", content: "" };
    let usage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls: ToolCall[] = [];
    for await (const ev of this.stream(req)) {
      switch (ev.type) {
        case "text":
          message.content += ev.text ?? "";
          break;
        case "reasoning":
          message.reasoning = (message.reasoning ?? "") + (ev.reasoning ?? "");
          break;
        case "tool_call":
          if (ev.toolCall) toolCalls.push(ev.toolCall);
          break;
        case "usage":
          if (ev.usage) usage = ev.usage;
          break;
        case "error":
          throw new Error(ev.error?.message ?? "anthropic error");
        case "done":
          break;
      }
    }
    if (toolCalls.length > 0) message.toolCalls = toolCalls;
    return { message, usage };
  }
}

function toAnthropicBody(req: ProviderRequest, defaultModel: string): unknown {
  // Anthropic takes system as a top-level field, not as a message.
  const messages: unknown[] = [];
  for (const m of req.messages) {
    if (m.role === "system") continue; // handled separately
    if (m.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
            is_error: m.meta?.isError === true,
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: safeParseJson(tc.argsJson),
        });
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content });
    }
  }
  return {
    model: req.model || defaultModel,
    system: req.system ?? "",
    messages,
    ...(req.tools && req.tools.length > 0 ? { tools: req.tools.map(toAnthropicTool) } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : { max_tokens: 4096 }),
    stream: true,
  };
}

function toAnthropicTool(t: ToolSpec): unknown {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  };
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

async function* parseAnthropicSSE(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<ProviderStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  // Anthropic streams content_block_start with tool input accumulated via deltas.
  let currentTool: { id: string; name: string; args: string } | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  const flushTool = () => {
    if (currentTool) {
      const call: ToolCall = { id: currentTool.id, name: currentTool.name, argsJson: currentTool.args || "{}" };
      currentTool = null;
      return call;
    }
    return null;
  };

  try {
    while (true) {
      if (signal.aborted) {
        try { reader.cancel(); } catch {}
        const e = new Error("aborted"); e.name = "AbortError"; throw e;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = raw.split("\n");
        let event = "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) event += line.slice(6).trim();
          if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed: any;
        try { parsed = JSON.parse(data); } catch { continue; }
        switch (event) {
          case "content_block_start":
            if (parsed.content_block?.type === "tool_use") {
              currentTool = {
                id: parsed.content_block.id,
                name: parsed.content_block.name,
                args: JSON.stringify(parsed.content_block.input ?? {}),
              };
            } else if (parsed.content_block?.type === "text") {
              // Text block start — Anthropic resets its own accumulator
              // on the wire; we just stream the deltas as they arrive.
            }
            break;
          case "content_block_delta":
            if (parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
              yield { type: "text", text: parsed.delta.text };
            } else if (parsed.delta?.type === "input_json_delta" && currentTool) {
              // Anthropic streams partial JSON; we accumulate then emit at stop.
              // But emitting the partial is fine since downstream validates.
              // Keep accumulating to emit on stop.
              try {
                const cur = currentTool.args === "{}" ? "" : currentTool.args;
                currentTool.args = cur + parsed.delta.partial_json;
              } catch { /* ignore */ }
            } else if (parsed.delta?.type === "thinking_delta" && typeof parsed.delta.thinking === "string") {
              yield { type: "reasoning", reasoning: parsed.delta.thinking };
            }
            break;
          case "content_block_stop": {
            const flushed = flushTool();
            if (flushed) yield { type: "tool_call", toolCall: flushed };
            break;
          }
          case "message_delta":
            if (parsed.usage?.output_tokens !== undefined) {
              outputTokens = parsed.usage.output_tokens;
            }
            break;
          case "message_start":
            if (parsed.message?.usage?.input_tokens !== undefined) {
              inputTokens = parsed.message.usage.input_tokens;
            }
            break;
          case "message_stop":
            yield { type: "usage", usage: { inputTokens, outputTokens } };
            yield { type: "done" };
            return;
          case "error":
            yield { type: "error", error: { message: String(parsed.error?.message ?? "anthropic error") } };
            return;
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    // Pre-fix: a mid-stream throw (broken pipe, malformed SSE,
    // upstream reset) returned without flushing `currentTool`,
    // so the consumer (agent/loop.ts) saw no `tool_call` event
    // and the model's intent vanished. Mirror the
    // `content_block_stop` flush in the catch path: emit the
    // in-progress tool call with its accumulated args (using
    // "{}" if the args never reached a parseable shape) before
    // reporting the error. Same pattern as the parseSSE fix
    // in openai-compat.ts (2026-07-08).
    if (currentTool) {
      const call: ToolCall = { id: currentTool.id, name: currentTool.name, argsJson: currentTool.args || "{}" };
      currentTool = null;
      yield { type: "tool_call", toolCall: call };
    }
    yield { type: "error", error: { message: (err as Error).message } };
    return;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  yield { type: "done" };
}
