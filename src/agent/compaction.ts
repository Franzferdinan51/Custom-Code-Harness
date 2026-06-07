// Compaction. When the conversation history grows past a threshold,
// we summarize older messages and replace them with a single
// `compaction` entry. The recent messages are kept verbatim.

import type { ChatMessage, Provider, ProviderRequest, ProviderStreamEvent } from "../types.js";
import { withTimeout } from "../util/errors.js";

export interface CompactionResult {
  summary: string;
  /** Index (in the original messages array) of the first message we KEPT. */
  keepFromIndex: number;
  /** Number of input tokens that fed into the summary. */
  inputTokens: number;
  /** Output tokens the summary cost. */
  outputTokens: number;
}

/** Pick a default cutoff: keep the last 30% of messages OR the last 6,
 *  whichever is larger. We never compact the most recent turn. */
export function defaultCutoff(totalMessages: number, maxRecent: number = 6, minRecentFraction: number = 0.3): number {
  const min = Math.min(totalMessages, Math.max(maxRecent, Math.floor(totalMessages * minRecentFraction)));
  return Math.max(0, totalMessages - min);
}

/** Heuristic: how many tokens does this transcript roughly use? */
export function roughTokenCount(messages: ChatMessage[]): number {
  // ~4 chars per token is the common rule of thumb for English.
  let chars = 0;
  for (const m of messages) {
    chars += (m.content?.length ?? 0) + (m.reasoning?.length ?? 0);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) chars += tc.argsJson.length + tc.name.length + 16;
    }
  }
  return Math.ceil(chars / 4);
}

/** Summarize a slice of messages via the provider. */
export async function compact(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  opts: { cutoff?: number; maxSummaryTokens?: number; signal?: AbortSignal } = {}
): Promise<CompactionResult> {
  const cutoff = opts.cutoff ?? defaultCutoff(messages.length);
  if (cutoff <= 0) {
    return { summary: "(nothing to compact)", keepFromIndex: 0, inputTokens: 0, outputTokens: 0 };
  }
  const toSummarize = messages.slice(0, cutoff);
  const toKeep = messages.slice(cutoff);

  const transcript = toSummarize.map((m) => formatForSummary(m)).join("\n\n");
  const prompt: ProviderRequest = {
    model,
    system:
      "You are a compaction assistant. Summarize the following conversation " +
      "transcript in a way that preserves all critical facts: file paths, decisions, " +
      "tool results, open questions, and user-stated requirements. Be concise but " +
      "complete. Use bullet points. Do NOT add commentary.",
    messages: [{ role: "user", content: transcript }],
    maxTokens: opts.maxSummaryTokens ?? 1500,
    temperature: 0,
    signal: opts.signal ?? new AbortController().signal,
  };

  const collected: string[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  for await (const ev of provider.stream(prompt)) {
    if (ev.type === "text" && ev.text) collected.push(ev.text);
    else if (ev.type === "usage" && ev.usage) usage = ev.usage;
    else if (ev.type === "error") throw new Error(ev.error?.message ?? "compaction failed");
  }
  const summary = collected.join("").trim() || "(compaction produced no summary)";

  return { summary, keepFromIndex: cutoff, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

function formatForSummary(m: ChatMessage): string {
  let s = "[" + m.role + "]";
  if (m.toolCalls && m.toolCalls.length > 0) {
    s += " (tool calls: " + m.toolCalls.map((t) => t.name + "(" + t.argsJson.slice(0, 80) + ")").join("; ") + ")";
  }
  if (m.content) s += "\n" + m.content;
  if (m.toolCallId) s += "\n[tool_result id=" + m.toolCallId + "]";
  return s;
}
