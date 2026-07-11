// Per-model cost accounting. We keep a static table of (model id
// pattern → price per 1M input/output tokens) and provide an
// aggregator that the runtime uses after every turn.
//
// Prices are in USD. Update them by editing the table — the model
// keys are substrings, so "gpt-4o" matches "gpt-4o-2024-08-06" etc.

export interface ModelPrice {
  /** Per 1M input tokens, in USD. */
  input: number;
  /** Per 1M output tokens, in USD. */
  output: number;
  /** Provider id (for the provider routing). */
  provider?: string;
  /** Display name. */
  label?: string;
}

const TABLE: Array<{ match: RegExp; price: ModelPrice }> = [
  // OpenAI — order matters; more-specific patterns (5.5, 5.4,
  // 5-mini, 5-nano) must precede the bare-`gpt-5` prefix.
  // Pre-fix (June 2026) the GPT-5.5, GPT-5.4-mini, GPT-5.4-nano,
  // GPT-5.3-codex, and GPT-5 (original, August 2025) entries were
  // all WRONG — the cost tracker was using numbers from
  // uncertain web searches rather than OpenAI's official
  // pricing page. Real numbers per OpenAI's API pricing
  // page as of July 2026:
  { match: /^gpt-5\.5-pro/,          price: { input: 30.00, output: 180.00, provider: "openai", label: "GPT-5.5 pro" } },
  // GPT-5.6 (Sol/Terra/Luna) — launched July 9, 2026.
  // Must precede the bare /^gpt-5/ prefix (which would
  // otherwise match at the GPT-5 (Aug 2025) $1.25/$10 rate
  // — same prefix-stealing class as o1-mini vs o1).
  { match: /^gpt-5\.6-sol/,          price: { input: 5.00,  output: 30.00, provider: "openai", label: "GPT-5.6 Sol" } },
  { match: /^gpt-5\.6-terra/,        price: { input: 2.50,  output: 15.00, provider: "openai", label: "GPT-5.6 Terra" } },
  { match: /^gpt-5\.6-luna/,         price: { input: 1.00,  output: 6.00,  provider: "openai", label: "GPT-5.6 Luna" } },
  { match: /^gpt-5\.6/,              price: { input: 5.00,  output: 30.00, provider: "openai", label: "GPT-5.6" } },
  { match: /^gpt-5\.5/,              price: { input: 5.00,  output: 30.00, provider: "openai", label: "GPT-5.5" } },
  { match: /^gpt-5\.4-pro/,          price: { input: 30.00, output: 180.00, provider: "openai", label: "GPT-5.4 pro" } },
  { match: /^gpt-5\.4-nano/,         price: { input: 0.20,  output: 1.25,  provider: "openai", label: "GPT-5.4 nano" } },
  { match: /^gpt-5\.4-mini/,         price: { input: 0.75,  output: 4.50,  provider: "openai", label: "GPT-5.4 mini" } },
  { match: /^gpt-5\.4/,              price: { input: 2.50,  output: 15.00, provider: "openai", label: "GPT-5.4" } },
  { match: /^gpt-5\.3-codex/,        price: { input: 1.75,  output: 14.00, provider: "openai", label: "GPT-5.3 Codex" } },
  // Generic Codex entry. `gpt-5.3-codex` matched above at
  // $1.75/$14 (the official Codex rate). Older or newer
  // Codex-flavored model ids (`gpt-5.1-codex`, future
  // `gpt-5.4-codex`, ...) fall through to this entry.
  { match: /codex/,                  price: { input: 1.75,  output: 14.00, provider: "openai", label: "Codex variant" } },
  // bare GPT-5 (August 2025): $1.25/$10.
  { match: /^gpt-5-nano/,            price: { input: 0.05,  output: 0.40,  provider: "openai", label: "GPT-5 nano" } },
  { match: /^gpt-5-mini/,            price: { input: 0.25,  output: 2.00,  provider: "openai", label: "GPT-5 mini" } },
  { match: /^gpt-5/,                 price: { input: 1.25,  output: 10.00, provider: "openai", label: "GPT-5" } },
  { match: /^gpt-4\.1-mini/,         price: { input: 0.40,  output: 1.60,  provider: "openai", label: "GPT-4.1 mini" } },
  { match: /^gpt-4\.1/,              price: { input: 2.00,  output: 8.00,  provider: "openai", label: "GPT-4.1" } },
  { match: /^gpt-4o-mini/,           price: { input: 0.15,  output: 0.60,  provider: "openai", label: "GPT-4o mini" } },
  { match: /^gpt-4o/,                price: { input: 2.50,  output: 10.00, provider: "openai", label: "GPT-4o" } },
  { match: /^gpt-4-turbo/,           price: { input: 10,    output: 30,    provider: "openai", label: "GPT-4 Turbo" } },
  { match: /^gpt-3\.5-turbo/,        price: { input: 0.50,  output: 1.50,  provider: "openai", label: "GPT-3.5 Turbo" } },
  // o1 (full) must come AFTER o1-mini because `^o1` is a
  // prefix match without `$` and would otherwise steal the
  // o1-mini match. Pre-fix o1-mini was being charged at the
  // o1 (full) rate ($15/$60) — a 5x overcharge on the
  // cheaper mini model. Same fix shape as o3 / o3-mini.
  { match: /^o1-mini/,               price: { input: 3,     output: 12,    provider: "openai", label: "o1 mini" } },
  { match: /^o1/,                    price: { input: 15,    output: 60,    provider: "openai", label: "o1" } },
  { match: /^o3-mini/,               price: { input: 1.10,  output: 4.40,  provider: "openai", label: "o3 mini" } },
  // o3 (full) must come AFTER o3-mini because `^o3` would
  // otherwise steal the o3-mini match. Pre-fix this entry
  // was missing entirely and o3 fell through to $0/$0.
  { match: /^o3/,                    price: { input: 10,    output: 40,    provider: "openai", label: "o3" } },
  // Anthropic
  { match: /^claude-3-5-haiku/,      price: { input: 0.80,  output: 4.00,  provider: "anthropic", label: "Claude 3.5 Haiku" } },
  { match: /^claude-3-5-sonnet/,     price: { input: 3.00,  output: 15.00, provider: "anthropic", label: "Claude 3.5 Sonnet" } },
  { match: /^claude-3-haiku/,        price: { input: 0.25,  output: 1.25,  provider: "anthropic", label: "Claude 3 Haiku" } },
  { match: /^claude-3-sonnet/,       price: { input: 3.00,  output: 15.00, provider: "anthropic", label: "Claude 3 Sonnet" } },
  // Claude 4.x line. Sonnet and Opus 4.x are at the prices
  // quoted on Anthropic's pricing page as of 2026; if Anthropic
  // introduces a 4.x model at a different price, add a more
  // specific pattern ABOVE these. Haiku 4.5 was missing before
  // (it fell through to the unknown-model fallback of $0/$0,
  // so a real $1/$5 call was reported as free — a 100% off-by-
  // infinity bug in the cost tracker).
  { match: /^claude-haiku-4-/,       price: { input: 1.00,  output: 5.00,  provider: "anthropic", label: "Claude Haiku 4.x" } },
  { match: /^claude-sonnet-4-/,      price: { input: 3.00,  output: 15.00, provider: "anthropic", label: "Claude Sonnet 4.x" } },
  { match: /^claude-opus-4-/,        price: { input: 5.00,  output: 25.00, provider: "anthropic", label: "Claude Opus 4.x" } },
  // Claude Sonnet 5 (launched July 2026). Introductory
  // pricing $2/$10 through August 31, 2026; standard $3/$15
  // thereafter. We track the standard rate; the model itself
  // applies the discounted rate at billing time. Must
  // come BEFORE the ^claude-sonnet-4- entry if Anthropic
  // ever ships a "claude-sonnet-5-*" variant.
  { match: /^claude-sonnet-5/,       price: { input: 3.00,  output: 15.00, provider: "anthropic", label: "Claude Sonnet 5" } },
  // Claude Fable 5 / Mythos 5 (Mythos-class, launched
  // June 9, 2026). $10/$50 — 2x Opus 4.8. Fable is the
  // public version with safety classifiers; Mythos 5 is the
  // restricted Glasswing-partner version with cyber safeguards
  // lifted. Same model, same pricing — Anthropic charges no
  // premium for the safety-classifier wrapper.
  { match: /^claude-fable-5/,        price: { input: 10.00, output: 50.00, provider: "anthropic", label: "Claude Fable 5" } },
  { match: /^claude-mythos-5/,       price: { input: 10.00, output: 50.00, provider: "anthropic", label: "Claude Mythos 5" } },
  // Legacy Claude 3 Opus (3.0) — keep for users still on the original
  // Opus model. The Anthropic 4.x line dropped the price to $5/$25.
  { match: /^claude-3-opus/,         price: { input: 15.00, output: 75.00, provider: "anthropic", label: "Claude 3 Opus" } },
  // DeepSeek (OpenRouter-style)
  { match: /^deepseek-chat/,         price: { input: 0.27,  output: 1.10,  provider: "deepseek", label: "DeepSeek Chat" } },
  { match: /^deepseek-reasoner/,     price: { input: 0.55,  output: 2.19,  provider: "deepseek", label: "DeepSeek Reasoner" } },
  // xAI Grok — xAI launched Grok 4.5 on July 8, 2026 at
  // $2/$6 (and Grok 4.5 Fast at $4/$18). The bare /^grok-4/
  // catch-all was correct for the older 4.0/4.3 line at
  // $1.25/$2.50 but UNDER-CHARGES Grok 4.5 by 60% on input
  // and 140% on output. The new entries must come BEFORE
  // the bare /^grok-4/ catch-all to avoid the same
  // prefix-stealing class as o1-mini vs o1 / gpt-5.6 vs
  // gpt-5.
  { match: /^grok-4\.5-fast/,        price: { input: 4.00,  output: 18.00, provider: "xai", label: "Grok 4.5 Fast" } },
  { match: /^grok-4\.5/,             price: { input: 2.00,  output: 6.00,  provider: "xai", label: "Grok 4.5" } },
  { match: /^grok-4/,                price: { input: 1.25,  output: 2.50,  provider: "xai", label: "Grok 4.x" } },
  // OpenRouter passthrough prices (rough)
  { match: /llama-3\.1-405b/,         price: { input: 3.50,  output: 3.50,  provider: "openrouter", label: "Llama 3.1 405B" } },
  { match: /llama-3\.1-70b/,          price: { input: 0.88,  output: 0.88,  provider: "openrouter", label: "Llama 3.1 70B" } },
  { match: /mistral-large/,          price: { input: 2.00,  output: 6.00,  provider: "openrouter", label: "Mistral Large" } },
];

const FALLBACK: ModelPrice = { input: 0, output: 0, label: "unknown" };

/** Look up the price for a model id. Falls back to FALLBACK. */
export function priceFor(model: string): ModelPrice {
  for (const { match, price } of TABLE) {
    if (match.test(model)) return { ...price, label: price.label ?? model };
  }
  return { ...FALLBACK, label: model };
}

/** Compute the cost (USD) of a single model call. */
export function callCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  const inCost  = (inputTokens  / 1_000_000) * p.input;
  const outCost = (outputTokens / 1_000_000) * p.output;
  return inCost + outCost;
}

export interface UsageRecord {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  at: number;
  /** Sub-agent name if this usage came from a sub-agent run. */
  agent?: string;
}

export class CostTracker {
  private records: UsageRecord[] = [];
  private byModel = new Map<string, UsageRecord>();

  record(model: string, provider: string, inputTokens: number, outputTokens: number, agent?: string): UsageRecord {
    const cost = callCost(model, inputTokens, outputTokens);
    const rec: UsageRecord = { model, provider, inputTokens, outputTokens, cost, at: Date.now(), agent };
    this.records.push(rec);
    const key = model + "|" + (agent ?? "main");
    const prev = this.byModel.get(key);
    if (prev) {
      prev.inputTokens += inputTokens;
      prev.outputTokens += outputTokens;
      prev.cost += cost;
    } else {
      this.byModel.set(key, { ...rec });
    }
    return rec;
  }

  total(): { inputTokens: number; outputTokens: number; cost: number } {
    let input = 0, output = 0, cost = 0;
    for (const r of this.records) {
      input += r.inputTokens;
      output += r.outputTokens;
      cost += r.cost;
    }
    return { inputTokens: input, outputTokens: output, cost };
  }

  perModel(): UsageRecord[] {
    return [...this.byModel.values()].sort((a, b) => b.cost - a.cost);
  }

  perAgent(): Array<{ agent: string; cost: number; calls: number; inputTokens: number; outputTokens: number }> {
    const m = new Map<string, { agent: string; cost: number; calls: number; inputTokens: number; outputTokens: number }>();
    for (const r of this.records) {
      const key = r.agent ?? "main";
      const prev = m.get(key);
      if (prev) {
        prev.cost += r.cost;
        prev.calls += 1;
        prev.inputTokens += r.inputTokens;
        prev.outputTokens += r.outputTokens;
      } else {
        m.set(key, { agent: key, cost: r.cost, calls: 1, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
      }
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  }
}

export function formatUSD(n: number): string {
  // Stable display for the three small / boundary cases that
  // surface in the cost UI before any model call has run
  // (`cost` is 0) or during a refund / correction path
  // (negative cents). Without the explicit `n === 0` guard
  // the `< 0.01` branch returned `"$0.0000"` for a fresh
  // session; without the `n < 0` clamp the function emitted
  // a leading minus and a string that read as a credit instead
  // of a charge. Both were cosmetic but showed up in the
  // web UI on every cold start.
  if (n === 0) return "$0.00";
  if (n < 0) return "-" + formatUSD(-n);
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}
