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
  // OpenAI
  { match: /^gpt-4o-mini/,           price: { input: 0.15,  output: 0.60,  provider: "openai", label: "GPT-4o mini" } },
  { match: /^gpt-4o/,                price: { input: 2.50,  output: 10.00, provider: "openai", label: "GPT-4o" } },
  { match: /^gpt-4-turbo/,            price: { input: 10,    output: 30,    provider: "openai", label: "GPT-4 Turbo" } },
  { match: /^o1/,                    price: { input: 15,    output: 60,    provider: "openai", label: "o1" } },
  { match: /^o1-mini/,               price: { input: 3,     output: 12,    provider: "openai", label: "o1 mini" } },
  { match: /^o3-mini/,               price: { input: 1.10,  output: 4.40,  provider: "openai", label: "o3 mini" } },
  // Anthropic
  { match: /^claude-3-5-haiku/,      price: { input: 0.80,  output: 4.00,  provider: "anthropic", label: "Claude 3.5 Haiku" } },
  { match: /^claude-3-5-sonnet/,     price: { input: 3.00,  output: 15.00, provider: "anthropic", label: "Claude 3.5 Sonnet" } },
  { match: /^claude-3-haiku/,        price: { input: 0.25,  output: 1.25,  provider: "anthropic", label: "Claude 3 Haiku" } },
  { match: /^claude-3-sonnet/,       price: { input: 3.00,  output: 15.00, provider: "anthropic", label: "Claude 3 Sonnet" } },
  { match: /^claude-sonnet-4-5/,     price: { input: 3.00,  output: 15.00, provider: "anthropic", label: "Claude Sonnet 4.5" } },
  { match: /^claude-opus-4/,         price: { input: 15.00, output: 75.00, provider: "anthropic", label: "Claude Opus 4" } },
  // DeepSeek (OpenRouter-style)
  { match: /^deepseek-chat/,         price: { input: 0.27,  output: 1.10,  provider: "deepseek", label: "DeepSeek Chat" } },
  { match: /^deepseek-reasoner/,     price: { input: 0.55,  output: 2.19,  provider: "deepseek", label: "DeepSeek Reasoner" } },
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

  records_(): UsageRecord[] { return this.records; }
}

export function formatUSD(n: number): string {
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}
