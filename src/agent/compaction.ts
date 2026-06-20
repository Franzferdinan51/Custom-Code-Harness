// Compaction. When the conversation history grows past a threshold,
// we summarize older messages and replace them with a single
// `compaction` entry. The recent messages are kept verbatim.

import type { ChatMessage, Provider, ProviderRequest } from "../types.js";

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

// ---- Preview (used by /compact --preview and auto-compaction UI) ----

export interface CompactionPreviewEntry {
  /** 0-based index in the original messages array. */
  index: number;
  role: ChatMessage["role"];
  /** First ~80 chars of the content (single line). */
  snippet: string;
  /** Rough token count for this message. */
  tokens: number;
}

export interface CompactionPreview {
  /** Where the cut would happen: messages [0..cutoff) are summarized,
   *  [cutoff..end) are kept verbatim. */
  cutoff: number;
  totalMessages: number;
  /** The messages that would be removed (and summarized). */
  removed: CompactionPreviewEntry[];
  /** The messages that would be kept verbatim. */
  kept: CompactionPreviewEntry[];
  /** Rough token counts. */
  tokensBefore: number;
  tokensAfter: number;
  /** Tokens saved (rough). */
  tokensSaved: number;
}

/** Build a preview of what compact() would do, without calling the
 *  provider. Used by /compact --preview and the auto-compaction UI. */
export function previewCompaction(
  messages: ChatMessage[],
  opts: { cutoff?: number; maxKeptEntries?: number; maxRemovedEntries?: number } = {}
): CompactionPreview {
  const cutoff = opts.cutoff ?? defaultCutoff(messages.length);
  const maxKept = opts.maxKeptEntries ?? 6;
  const maxRemoved = opts.maxRemovedEntries ?? 6;
  const summarize = (m: ChatMessage): CompactionPreviewEntry => {
    const raw = (m.content ?? m.reasoning ?? "").replace(/\s+/g, " ").trim();
    const snippet = raw.length > 80 ? raw.slice(0, 77) + "…" : raw;
    const chars = (m.content?.length ?? 0) + (m.reasoning?.length ?? 0) + (m.toolCalls ? m.toolCalls.reduce((n, t) => n + t.argsJson.length + t.name.length + 16, 0) : 0);
    return { index: 0, role: m.role, snippet, tokens: Math.ceil(chars / 4) };
  };
  const removedFull = messages.slice(0, cutoff).map(summarize).map((e, i) => ({ ...e, index: i }));
  const keptFull = messages.slice(cutoff).map(summarize).map((e, i) => ({ ...e, index: cutoff + i }));
  // Compact view: head of removed (first 3), tail of removed (last 3), head of kept.
  const head = removedFull.slice(0, 3);
  const tail = removedFull.length > 6 ? removedFull.slice(-3) : [];
  const omitted = Math.max(0, removedFull.length - head.length - tail.length);
  // We splice a synthetic "..." entry.
  const removedPreview: CompactionPreviewEntry[] = [...head];
  if (omitted > 0) {
    removedPreview.push({ index: -1, role: "assistant", snippet: `… (${omitted} more messages omitted)`, tokens: 0 });
  }
  removedPreview.push(...tail);
  const keptPreview = keptFull.slice(-maxKept);
  const tokensBefore = roughTokenCount(messages);
  const tokensAfter = roughTokenCount(messages.slice(cutoff));
  return {
    cutoff,
    totalMessages: messages.length,
    removed: removedPreview,
    kept: keptPreview,
    tokensBefore,
    tokensAfter,
    tokensSaved: Math.max(0, tokensBefore - tokensAfter),
  };
}

/** Format a preview for the terminal: green kept, red removed, gray
 *  summary placeholder. No colors if NO_COLOR is set or stdout isn't a
 *  TTY. */
export function formatCompactionPreview(p: CompactionPreview, opts: { colorize?: boolean } = {}): string {
  const colorize = opts.colorize ?? (process.env.NO_COLOR === undefined && !!process.stdout.isTTY);
  const c = {
    red:    (s: string) => colorize ? `\x1b[31m${s}\x1b[39m` : s,
    green:  (s: string) => colorize ? `\x1b[32m${s}\x1b[39m` : s,
    yellow: (s: string) => colorize ? `\x1b[33m${s}\x1b[39m` : s,
    dim:    (s: string) => colorize ? `\x1b[2m${s}\x1b[22m` : s,
    bold:   (s: string) => colorize ? `\x1b[1m${s}\x1b[22m` : s,
  };
  const lines: string[] = [];
  const fmtEntry = (e: CompactionPreviewEntry, marker: string, color: (s: string) => string): string => {
    const idx = e.index >= 0 ? String(e.index).padStart(3) : "   ";
    const role = e.role.padEnd(9);
    const tokens = e.tokens > 0 ? ` (${e.tokens}t)` : "";
    return `  ${color(marker)} ${idx}  ${role}  ${e.snippet}${c.dim(tokens)}`;
  };
  lines.push(c.bold(`Compaction preview: ${p.removed.length} of ${p.totalMessages} shown in 'removed', ${p.kept.length} in 'kept'`));
  lines.push(c.dim(`  cutoff: message index ${p.cutoff}  ·  tokens: ${p.tokensBefore} → ${p.tokensAfter}  ·  saved ≈ ${p.tokensSaved}`));
  lines.push("");
  lines.push(c.red("  removed (will be summarized)"));
  for (const e of p.removed) {
    if (e.index < 0) {
      lines.push(c.dim("  " + e.snippet));
      continue;
    }
    lines.push(fmtEntry(e, "✗", c.red));
  }
  lines.push("");
  lines.push(c.green("  kept (verbatim)"));
  for (const e of p.kept) lines.push(fmtEntry(e, "✓", c.green));
  return lines.join("\n");
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
