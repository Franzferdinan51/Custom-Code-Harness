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
  { match: /^gpt-5\.6-sol-pro/,      price: { input: 5.00,  output: 30.00, provider: "openai", label: "GPT-5.6 Sol Pro" } },
  { match: /^gpt-5\.6-sol/,          price: { input: 5.00,  output: 30.00, provider: "openai", label: "GPT-5.6 Sol" } },
  { match: /^gpt-5\.6-terra-pro/,    price: { input: 2.50,  output: 15.00, provider: "openai", label: "GPT-5.6 Terra Pro" } },
  { match: /^gpt-5\.6-terra/,        price: { input: 2.50,  output: 15.00, provider: "openai", label: "GPT-5.6 Terra" } },
  { match: /^gpt-5\.6-luna-pro/,     price: { input: 1.00,  output: 6.00,  provider: "openai", label: "GPT-5.6 Luna Pro" } },
  // GPT-5.6 Luna Pro is the same underlying model as Luna
  // with its reasoning mode set to "pro" — pricing is
  // identical at $1/$6 per OpenAI's API. The bare `^gpt-5.6-luna`
  // entry below also matches `gpt-5.6-luna-pro` (it's a
  // prefix match), so this specific entry is for clarity /
  // test-pinning; the pricing would be correct either way.
  { match: /^gpt-5\.6-luna/,         price: { input: 1.00,  output: 6.00,  provider: "openai", label: "GPT-5.6 Luna" } },
  { match: /^gpt-5\.6/,              price: { input: 5.00,  output: 30.00, provider: "openai", label: "GPT-5.6" } },
  { match: /^gpt-5\.5/,              price: { input: 5.00,  output: 30.00, provider: "openai", label: "GPT-5.5" } },
  { match: /^gpt-5\.4-pro/,          price: { input: 30.00, output: 180.00, provider: "openai", label: "GPT-5.4 pro" } },
  // GPT-5.4 itself (the base 5.4 model). The bare `^gpt-5.4`
  // pattern below matches `gpt-5.4`, `gpt-5.4-20260301`, etc.
  // — same as how `^gpt-5` matches the whole GPT-5 family.
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
  { match: /^o1-pro/,                price: { input: 150.00, output: 600.00, provider: "openai", label: "o1 pro" } },
  { match: /^o1/,                    price: { input: 15,    output: 60,    provider: "openai", label: "o1" } },
  { match: /^o3-pro/,                price: { input: 20.00, output: 80.00, provider: "openai", label: "o3 pro" } },
  { match: /^o3-mini/,               price: { input: 1.10,  output: 4.40,  provider: "openai", label: "o3 mini" } },
  // o3 (full) must come AFTER o3-mini because `^o3` would
  // otherwise steal the o3-mini match. Pre-fix this entry
  // was missing entirely and o3 fell through to $0/$0.
  // Pre-fix-this-fix: the entry was at $10/$40 (the launch
  // price), but OpenAI cut the rate to $2/$8 shortly after
  // launch (per the official pricing page, April 2026).
  // A real `o3` call at the new rate was being reported
  // as 5x over-charged by the cost tracker.
  { match: /^o3-deep-research/,      price: { input: 10.00, output: 40.00, provider: "openai", label: "o3 deep research" } },
  { match: /^o3/,                    price: { input: 2,     output: 8,     provider: "openai", label: "o3 (post-launch price cut from $10/$40)" } },
  // o4-mini (OpenAI's budget reasoning model) — $1.10/$4.40,
  // same as o3-mini. Must come BEFORE any `^o4/` catch-all
  // (none today, but the order keeps the prefix-stealing
  // class consistent with o3 / o3-mini).
  { match: /^o4-mini-deep-research/, price: { input: 2,     output: 8,     provider: "openai", label: "o4-mini deep research" } },
  { match: /^o4-mini/,               price: { input: 1.10,  output: 4.40,  provider: "openai", label: "o4-mini" } },
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
  // DeepSeek (OpenRouter-style). The V4 family (launched
  // mid-July 2026) dropped the output price by ~50% relative
  // to the older V3.x rate that `deepseek-chat` /
  // `deepseek-reasoner` still use. More-specific V4 patterns
  // (v4-pro, v4-flash, v4-base) must come BEFORE the
  // bare `^deepseek/` catch-all to avoid the same
  // prefix-stealing class as o1-mini vs o1. The older
  // `deepseek-chat` / `deepseek-reasoner` entries are
  // preserved at their V3.x rates for callers still on
  // the V3 API.
  { match: /^deepseek-v4-pro/,       price: { input: 0.435, output: 0.87,  provider: "deepseek", label: "DeepSeek V4 Pro (75% permanent price cut, June 2026)" } },
  { match: /^deepseek-v4-flash/,     price: { input: 0.14,  output: 0.28,  provider: "deepseek", label: "DeepSeek V4 Flash (cheapest frontier-ish)" } },
  { match: /^deepseek-v4/,           price: { input: 0.27,  output: 0.55,  provider: "deepseek", label: "DeepSeek V4 (1T base)" } },
  { match: /^deepseek-chat/,         price: { input: 0.27,  output: 1.10,  provider: "deepseek", label: "DeepSeek Chat (V3.x)" } },
  { match: /^deepseek-reasoner/,     price: { input: 0.55,  output: 2.19,  provider: "deepseek", label: "DeepSeek Reasoner (R1)" } },
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
  // Meta Muse Spark 1.1 (launched July 9, 2026) — Meta's
  // first paid/proprietary model after the open Llama
  // era. $1.25/$4.25 per 1M. The bare /^muse/ catch-all
  // sits at the end of the Meta block; specific variants
  // (muse-spark, muse-spark-1.1, future muse-spark-1.2)
  // must come BEFORE the catch-all to avoid the same
  // prefix-stealing class as o1-mini vs o1.
  { match: /^muse-spark-1\.1/,       price: { input: 1.25,  output: 4.25,  provider: "meta", label: "Meta Muse Spark 1.1" } },
  { match: /^muse-spark/,            price: { input: 1.25,  output: 4.25,  provider: "meta", label: "Meta Muse Spark" } },
  { match: /^muse/,                  price: { input: 1.25,  output: 4.25,  provider: "meta", label: "Meta Muse" } },
  // OpenAI GPT-Live voice models (July 8, 2026). Pricing
  // is per-minute, not per-token, so the cost tracker
  // reports the input rate as the per-million-token
  // equivalent of the per-minute rate for the typical 80
  // wpm speech throughput. These will need a real per-call
  // calculator in a future audit pass; for now, log a
  // nominal $0 so the unknown-model fallback ($0) doesn't
  // hide them — the harness user is responsible for adding
  // the real per-call cost.
  { match: /^gpt-live-1/,            price: { input: 0,     output: 0,     provider: "openai", label: "GPT-Live-1 (voice, per-minute billing not in cost tracker)" } },
  { match: /^gpt-live-1-mini/,       price: { input: 0,     output: 0,     provider: "openai", label: "GPT-Live-1 mini (voice, per-minute billing not in cost tracker)" } },
  // Google Gemini family. More-specific patterns (3.5-flash,
  // 3.1-pro, 3.1-flash-lite, 2.5-flash-lite) must come BEFORE
  // the bare /^gemini-/ catch-all to avoid the same
  // prefix-stealing class as o1-mini vs o1. Pre-fix: no
  // Gemini entries existed at all, so every Gemini call fell
  // through to the unknown-model $0/$0 fallback (a real
  // $2/$12 charge on 3.1 Pro silently reported as free).
  // Pricing per Google's Gemini API page (verified July 2026).
  // Note: Gemini 3.1 Pro has a context-tiered rate ($2/$12
  // up to 200K, $4/$18 above 200K). The cost tracker only
  // models the standard rate; long-context requests are
  // under-charged — call out in the label so the user can
  // adjust if needed.
  { match: /^gemini-3\.5-flash/,     price: { input: 1.50,  output: 9.00,  provider: "google", label: "Gemini 3.5 Flash" } },
  { match: /^gemini-3\.1-pro/,       price: { input: 2.00,  output: 12.00, provider: "google", label: "Gemini 3.1 Pro (≤200K context; long-context tier $4/$18 not modeled)" } },
  { match: /^gemini-3\.1-flash-lite/,price: { input: 0.25,  output: 1.50,  provider: "google", label: "Gemini 3.1 Flash-Lite" } },
  { match: /^gemini-3-flash/,        price: { input: 0.50,  output: 3.00,  provider: "google", label: "Gemini 3 Flash" } },
  { match: /^gemini-2\.5-pro/,       price: { input: 1.25,  output: 10.00, provider: "google", label: "Gemini 2.5 Pro" } },
  { match: /^gemini-2\.5-flash-lite/,price: { input: 0.10,  output: 0.40,  provider: "google", label: "Gemini 2.5 Flash-Lite" } },
  { match: /^gemini-2\.5-flash/,     price: { input: 0.30,  output: 2.50,  provider: "google", label: "Gemini 2.5 Flash" } },
  { match: /^gemini-3/,              price: { input: 1.50,  output: 9.00,  provider: "google", label: "Gemini 3.x (unknown tier)" } },
  { match: /^gemini-2/,              price: { input: 0.30,  output: 2.50,  provider: "google", label: "Gemini 2.x (unknown tier)" } },
  { match: /^gemini/,                price: { input: 1.50,  output: 9.00,  provider: "google", label: "Gemini (unknown tier)" } },
  // Kwaipilot KAT-Coder V2.5 family (released July 10, 2026).
  // Kuaishou's coding-focused agentic models. V2.5 supersedes
  // V2 (which was $0.30/$1.20). Two tiers: Pro at $0.74/$2.96
  // and Air at $0.15/$0.60. Pre-fix: no KAT-Coder entries
  // existed, so every call fell through to the unknown-model
  // $0/$0 fallback. Specific patterns (pro, air) must come
  // BEFORE the bare /^kwaipilot\// or /^kat-coder/ catch-all.
  { match: /^kwaipilot\/kat-coder-pro-v2\.5/,  price: { input: 0.74,  output: 2.96,  provider: "kwaipilot", label: "KAT-Coder Pro V2.5" } },
  { match: /^kwaipilot\/kat-coder-air-v2\.5/,  price: { input: 0.15,  output: 0.60,  provider: "kwaipilot", label: "KAT-Coder Air V2.5" } },
  { match: /^kwaipilot\/kat-coder-pro/,        price: { input: 0.74,  output: 2.96,  provider: "kwaipilot", label: "KAT-Coder Pro" } },
  { match: /^kwaipilot\/kat-coder-air/,        price: { input: 0.15,  output: 0.60,  provider: "kwaipilot", label: "KAT-Coder Air" } },
  { match: /^kwaipilot\/kat-coder/,            price: { input: 0.30,  output: 1.20,  provider: "kwaipilot", label: "KAT-Coder (unknown tier)" } },
  { match: /^kat-coder-pro/,                   price: { input: 0.74,  output: 2.96,  provider: "kwaipilot", label: "KAT-Coder Pro" } },
  { match: /^kat-coder-air/,                   price: { input: 0.15,  output: 0.60,  provider: "kwaipilot", label: "KAT-Coder Air" } },
  { match: /^kat-coder/,                       price: { input: 0.30,  output: 1.20,  provider: "kwaipilot", label: "KAT-Coder (unknown tier)" } },
  // Moonshot AI Kimi K3 (released July 16, 2026). 2.8T-
  // parameter MoE with native vision, 1M context, $3 in /
  // $15 out. The Moonshot API is OpenAI-SDK compatible;
  // the canonical model id is `kimi-k3` (with the
  // `moonshotai/` org prefix on OpenRouter). Pre-fix: no
  // Kimi entries existed, so every call fell through to
  // the unknown-model $0/$0 fallback.
  { match: /^kimi-k3/,              price: { input: 3.00,  output: 15.00, provider: "moonshot", label: "Moonshot Kimi K3" } },
  { match: /^moonshotai\/kimi-k3/,  price: { input: 3.00,  output: 15.00, provider: "moonshot", label: "Moonshot Kimi K3 (OpenRouter)" } },
  { match: /^kimi/,                 price: { input: 0.95,  output: 4.00,  provider: "moonshot", label: "Moonshot Kimi (K2.6/K2.7 family; $0.95/$4)" } },
  // Llama 4 family (Meta, released April 2025; latest
  // pricing on OpenRouter / DeepInfra as of July 2026).
  // Two tiers:
  //   llama-4-maverick   $0.20 in / $0.80 out (400B total / 17B active, 1M ctx)
  //   llama-4-scout      $0.11 in / $0.34 out (109B total / 17B active, 10M ctx)
  // Pre-fix: only Llama 3.1 entries existed; Llama 4 calls
  // fell through to the unknown-model fallback. More-specific
  // patterns (maverick, scout) MUST come BEFORE the bare
  // `^llama-4/` catch-all (same prefix-stealing class as
  // o1-mini vs o1 / gpt-5.6 vs gpt-5).
  { match: /^llama-4-maverick/,     price: { input: 0.20,  output: 0.80,  provider: "meta", label: "Llama 4 Maverick (400B / 17B active, 1M ctx)" } },
  { match: /^llama-4-scout/,        price: { input: 0.11,  output: 0.34,  provider: "meta", label: "Llama 4 Scout (109B / 17B active, 10M ctx)" } },
  { match: /^llama-4/,              price: { input: 0.20,  output: 0.80,  provider: "meta", label: "Llama 4 (unknown tier)" } },
  // Mistral family (current lineup as of July 2026, per
  // Mistral's API page). The Medium 3.5, Large 3, and
  // Small 4 entries cover the most current tiers; older
  // `mistral-large` (the v1/v2 line at $2/$6) is preserved
  // at the bottom of the OpenRouter block for callers
  // still on the older API. More-specific patterns
  // (medium-3.5, large-3, small-4) MUST come BEFORE the
  // bare `^mistral-/` catch-all to avoid the same
  // prefix-stealing class as o1-mini vs o1.
  { match: /^mistral-medium-3\.5/,   price: { input: 1.50,  output: 7.50,  provider: "mistral", label: "Mistral Medium 3.5 (128B dense, April 2026)" } },
  { match: /^mistral-medium-3/,      price: { input: 0.40,  output: 2.00,  provider: "mistral", label: "Mistral Medium 3 (May 2025)" } },
  { match: /^mistral-medium-3\.1/,   price: { input: 0.40,  output: 2.00,  provider: "mistral", label: "Mistral Medium 3.1" } },
  { match: /^mistral-large-3/,       price: { input: 0.50,  output: 1.50,  provider: "mistral", label: "Mistral Large 3 (value workhorse)" } },
  { match: /^mistral-small-4/,       price: { input: 0.15,  output: 0.60,  provider: "mistral", label: "Mistral Small 4 (budget tier)" } },
  { match: /^mistral-medium/,        price: { input: 1.50,  output: 7.50,  provider: "mistral", label: "Mistral Medium (unknown tier; default 3.5 rate)" } },
  // OpenRouter passthrough prices (rough)
  { match: /llama-3\.1-405b/,         price: { input: 3.50,  output: 3.50,  provider: "openrouter", label: "Llama 3.1 405B" } },
  { match: /llama-3\.1-70b/,          price: { input: 0.88,  output: 0.88,  provider: "openrouter", label: "Llama 3.1 70B" } },
  { match: /mistral-large/,          price: { input: 2.00,  output: 6.00,  provider: "openrouter", label: "Mistral Large (legacy v1/v2 line)" } },
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
  // For amounts >= 1,000 use a thousands separator so the
  // cost UI doesn't render "$1234567.89" (which was the
  // pre-fix behavior — hard to read for cumulative session
  // totals that routinely pass $1k for long-running agents).
  // We keep the same digit precision as the < 1 branch's
  // sibling (`.toFixed(2)`) so the only visible change is
  // the comma placement. The split-then-rejoin is cheaper
  // than `toLocaleString` (no Intl init) and produces a
  // stable, locale-independent string — the cost UI in the
  // web panel asserts on the exact format during snapshot
  // tests.
  const fixed = n.toFixed(2);
  const parts = fixed.split(".");
  const intPart = parts[0] ?? "0";
  const decPart = parts[1] ?? "00";
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return "$" + withSep + "." + decPart;
}
