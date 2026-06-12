// 4th memory layer — vector index with brute-force cosine and RRF fusion.
//
//   Layer 4 — VECTOR       embeddings (Float32Array) of every line in
//                          MEMORY.md, plus a `## LESSONS` mirror, scored
//                          by cosine similarity against the query's
//                          embedding. Fused with BM25 hits via
//                          reciprocal-rank fusion (RRF) so a hit that
//                          appears high in both lists wins, and a hit
//                          that appears high in either alone still has
//                          a chance.
//
// v1 design choices (per docs/phase3.md §T2):
//
//   * Brute-force cosine over the on-disk corpus. The corpus is tens
//     of MB at most; the v1 surface does not need a real ANN index.
//   * Embeddings are computed lazily and cached to disk at
//     `$CH_HOME/memory/MEMORY.embeddings.json`, keyed by line number
//     (NOT by text hash), so re-indexing after an append only
//     re-embeds the new lines.
//   * The default embedding function is a stable, dependency-free
//     hash-based pseudo-embedding derived from `crypto.createHash`
//     of the text. This is what the tests use — deterministic, no
//     network, no model download. A provider-based path is exposed
//     via `embedTextWithProvider()` for callers that want to wire
//     an actual embedding endpoint; when no provider is configured
//     the hash fallback is the always-runnable default.
//
// File layout on disk (single MEMORY.embeddings.json):
//
//   {
//     "version": 1,
//     "dim": 64,
//     "entries": {
//       "42": { "vec": [0.12, -0.34, ...], "text": "<source line>" },
//       "lesson:0": { "vec": [...], "text": "[iso] lesson body" }
//     }
//   }
//
// Cache key is the line number for raw notes (stable across reads of
// the same MEMORY.md) and `lesson:<index>` for lessons (the lesson
// block is appended at the end, so its line numbers in MEMORY.md
// shift as raw notes grow — using a stable lesson index keeps the
// cache valid across appends).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import { log } from "../util/logger.js";

/** Default embedding dimensionality. 64 is enough to make cosine
 *  discriminative on the hash-fallback path; the dimension is part
 *  of the on-disk cache format so bumping it invalidates the cache. */
export const DEFAULT_EMBED_DIM = 64;

/** RRF damping constant. `k0 = 60` is the value used in the original
 *  Cormack et al. (2009) paper and is the default in the
 *  Elasticsearch / OpenSearch RRF implementations. Higher k0
 *  flattens the score distribution (top ranks matter less), lower
 *  sharpens it. */
export const DEFAULT_RRF_K0 = 60;

/** One ranked hit from a vector search. */
export interface VectorHit {
  /** Stable document id (line number for raw notes, `lesson:N` for
   *  lessons, or any caller-supplied id). */
  readonly docId: string;
  /** 1-indexed line number inside MEMORY.md, or -1 for lessons. */
  readonly line: number;
  /** Cosine similarity in [-1, 1]. Higher = more similar. */
  readonly score: number;
}

/** One ranked item handed to RRF. We only need the id and the
 *  line so the fusion helper stays generic — it doesn't care if
 *  the list came from BM25, vectors, dense-passage-retrieval, or
 *  whatever else the future holds. */
export interface RankedItem {
  readonly docId: string;
  readonly line: number;
}

/** One fused RRF hit. */
export interface FusedHit {
  readonly docId: string;
  readonly line: number;
  /** RRF score = Σ_i 1 / (k0 + rank_i). Higher = more relevant. */
  readonly rrf: number;
}

/** On-disk cache shape. Versioned so we can bump the schema later. */
interface EmbeddingCache {
  readonly version: 1;
  readonly dim: number;
  readonly entries: Record<string, { vec: number[]; text: string; line: number }>;
}

/** Resolve the on-disk path to the embeddings cache. */
export function embeddingsFilePath(): string {
  return join(paths.memory, "MEMORY.embeddings.json");
}

/**
 * Hash-based pseudo-embedding. Maps arbitrary text to a
 * `Float32Array(dim)` of values in `[-1, 1]`. Deterministic (same
 * text → same vector), dependency-free, no network. The quality
 * is intentionally low — it's a placeholder for real provider
 * embeddings, not a substitute — but it gives the 4th layer a
 * non-trivial similarity signal that the brute-force cosine loop
 * can rank over.
 *
 * Algorithm: SHA-256 of the text, then split the 32 bytes across
 * `dim` slots (cycling). Each byte is mapped from `[0, 255]` to
 * `[-1, 1]` by `b / 127.5 - 1`. This guarantees every slot is
 * deterministic and gives a roughly balanced signed distribution.
 */
export function hashEmbed(text: string, dim: number = DEFAULT_EMBED_DIM): Float32Array {
  const hash = createHash("sha256").update(text, "utf-8").digest();
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const b = hash[i % hash.length] ?? 0;
    out[i] = b / 127.5 - 1;
  }
  return out;
}

/**
 * Default `embedText` — always returns the hash-based
 * pseudo-embedding. v1 of the 4th layer is intentionally
 * dependency-free; tests rely on this being deterministic and
 * side-effect-free. Callers that have a real provider can use
 * `embedTextWithProvider` instead and route the result into the
 * same `VectorIndex` API.
 */
export async function embedText(text: string): Promise<Float32Array> {
  return hashEmbed(text);
}

/**
 * Optional `embedText` variant that consults a provider hook.
 * Pass `{ provider: { kind: "openai" | "openrouter" | "vllm", ... } }`
 * to attempt a real embedding call. If the provider does NOT
 * expose embeddings (e.g. Anthropic, which has no native embedding
 * endpoint), or if the call fails for any reason, falls back to
 * `hashEmbed` so the call is always runnable. The v1 tests only
 * exercise the fallback path.
 *
 * The signature is intentionally a thin shim — wiring the actual
 * provider call is a follow-up; this just establishes the
 * dependency-injection seam so the call site doesn't have to
 * change when the real path lands.
 */
export async function embedTextWithProvider(
  text: string,
  opts: {
    provider?: { kind: string; embed?: (text: string) => Promise<number[] | undefined> };
    dim?: number;
  } = {}
): Promise<Float32Array> {
  const dim = opts.dim ?? DEFAULT_EMBED_DIM;
  const embed = opts.provider?.embed;
  if (embed) {
    try {
      const out = await embed(text);
      if (out && out.length > 0) {
        const vec = new Float32Array(dim);
        for (let i = 0; i < dim; i++) vec[i] = out[i % out.length] ?? 0;
        return vec;
      }
    } catch (e) {
      log.warn("vector embed: provider call failed, using hash fallback", e);
    }
  }
  return hashEmbed(text, dim);
}

/** Cosine similarity in [-1, 1]. Returns 0 if either vector is
 *  zero-magnitude (no overlap, no signal). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Brute-force cosine ANN index. v1 keeps every vector in memory and
 * scans them linearly on each `search()`. The corpus is small
 * (tens of MB at most) so the cost is bounded and predictable.
 *
 * The index is keyed by caller-supplied `docId` strings, with a
 * parallel `line` array for the file-line number to return to the
 * UX layer. Adding the same `docId` twice replaces the prior
 * entry (useful for re-indexing after an in-place edit).
 */
export class VectorIndex {
  private readonly docIds: string[] = [];
  private readonly lines: number[] = [];
  private readonly vecs: Float32Array[] = [];
  private readonly dim: number;

  constructor(opts: { dim?: number } = {}) {
    this.dim = opts.dim ?? DEFAULT_EMBED_DIM;
  }

  /** Number of entries in the index. */
  get size(): number { return this.docIds.length; }

  /** Add (or replace) a single entry. */
  add(docId: string, vec: Float32Array, line: number = -1): void {
    const existing = this.docIds.indexOf(docId);
    if (existing >= 0) {
      this.vecs[existing] = vec;
      this.lines[existing] = line;
      return;
    }
    this.docIds.push(docId);
    this.lines.push(line);
    this.vecs.push(vec);
  }

  /** Convenience: embed `text` via the supplied embedder and add it. */
  async addText(docId: string, text: string, line: number, embed: (s: string) => Promise<Float32Array> = embedText): Promise<void> {
    const vec = await embed(text);
    this.add(docId, vec, line);
  }

  /**
   * Brute-force top-K cosine search. Ties are broken by lower
   * docId (insertion order) for determinism, matching the BM25
   * contract. Returns up to `k` hits; fewer if the index is
   * smaller.
   */
  search(queryVec: Float32Array, k: number): VectorHit[] {
    if (k <= 0 || this.vecs.length === 0) return [];
    // Return EVERY entry, not just the positive-cosine ones. RRF
    // uses the rank (position in this sorted list) as its signal,
    // not the score — so an entry with a negative cosine still
    // contributes a "this is the lowest-ranked vec match" weight
    // (1 / (k0 + rank)) and gets a fair shot in the fused ranking.
    //
    // The old `if (s > 0)` filter was wrong for the hash-based
    // pseudo-embedding: a 64-dim SHA-256 cycled vector can have a
    // negative cosine against a query that *does* contain the
    // text — it's random, not semantic. Filtering those out meant
    // a relevant entry could be dropped from the vec list and
    // lose its RRF contribution, letting a strictly weaker BM25
    // hit (e.g. one that *happens* to align with the random
    // embedding direction) win the fused ranking. Symptom: a
    // 4-layer search occasionally demoted the dense-match hit to
    // 2nd place.
    const scored: VectorHit[] = [];
    for (let i = 0; i < this.vecs.length; i++) {
      const v = this.vecs[i] ?? new Float32Array(0);
      const s = cosineSimilarity(queryVec, v);
      scored.push({
        docId: this.docIds[i] ?? "",
        line: this.lines[i] ?? -1,
        score: s,
      });
    }
    scored.sort((a, b) => (b.score - a.score) || a.docId.localeCompare(b.docId));
    return scored.slice(0, k);
  }

  /**
   * Serialize the index to a plain JSON object. Float32Array is
   * unwrapped to `number[]` for portability — the cache file is
   * human-inspectable and the size is fine at v1's scale.
   */
  serialize(): EmbeddingCache {
    const entries: Record<string, { vec: number[]; text: string; line: number }> = {};
    // NOTE: we only carry the docId/line here; the source text
    // is optional and is only stored when the caller set it via
    // `addTextWithText`. The full on-disk cache managed by
    // `loadOrBuildIndex` keeps a `text` field for cache
    // invalidation; the raw `serialize()` keeps the wire format
    // minimal so callers that don't need text don't pay for it.
    for (let i = 0; i < this.docIds.length; i++) {
      const id = this.docIds[i] ?? "";
      const v = this.vecs[i] ?? new Float32Array(0);
      const line = this.lines[i] ?? -1;
      entries[id] = { vec: Array.from(v), text: "", line };
    }
    return { version: 1, dim: this.dim, entries };
  }

  /** Reconstruct an index from a previously-serialized cache. */
  static load(cache: EmbeddingCache): VectorIndex {
    const idx = new VectorIndex({ dim: cache.dim });
    for (const [id, entry] of Object.entries(cache.entries)) {
      const vec = new Float32Array(entry.vec);
      // Trust the cached `line` field. Fall back to parsing the
      // docId for caches written before the line field existed.
      const line = typeof entry.line === "number"
        ? entry.line
        : (id.startsWith("lesson:") ? -1 : (Number.isFinite(Number(id)) ? Number(id) : -1));
      idx.add(id, vec, line);
    }
    return idx;
  }
}

/**
 * Reciprocal-rank fusion. Combines multiple ranked lists into a
 * single score per item, where each list's contribution is
 * `1 / (k0 + rank_i)` (rank_i is 1-indexed). Items that appear in
 * multiple lists get their contributions summed. Ties on the RRF
 * score are broken by lower docId (string compare) for determinism.
 *
 * Pure function — no I/O, no side effects, easy to test.
 */
export function reciprocalRankFusion(
  rankedLists: ReadonlyArray<ReadonlyArray<RankedItem>>,
  k0: number = DEFAULT_RRF_K0
): FusedHit[] {
  if (k0 <= 0) throw new Error("reciprocalRankFusion: k0 must be positive");
  const scores = new Map<string, FusedHit>();
  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item) continue;
      const rank = i + 1;
      const contrib = 1 / (k0 + rank);
      const prev = scores.get(item.docId);
      if (prev) {
        // Preserve the line number of the first list that mentioned
        // the docId — caller can override by listing the most
        // trustworthy list first. RRF is rank-only, not line-aware.
        scores.set(item.docId, { docId: item.docId, line: prev.line, rrf: prev.rrf + contrib });
      } else {
        scores.set(item.docId, { docId: item.docId, line: item.line, rrf: contrib });
      }
    }
  }
  const out = Array.from(scores.values());
  out.sort((a, b) => (b.rrf - a.rrf) || a.docId.localeCompare(b.docId));
  return out;
}

/**
 * Load an existing embeddings cache from disk, or build a fresh
 * one. Pure-TS: never touches the network. The cache is keyed by
 * the supplied `lineKeys` and `lessonKeys` maps — entries whose
 * key is present in the cache AND whose stored text matches the
 * current source text are reused; everything else is re-embedded
 * via the supplied `embed` function (defaulting to `embedText`).
 *
 * On any successful re-embed or fresh load, the cache is written
 * back atomically (tmp + rename) to `paths.memoryEmbeddingsFile`.
 *
 * Returns `{ index, hits, misses }` so the caller can observe
 * cache effectiveness. `hits + misses === total entries`.
 */
export async function loadOrBuildIndex(
  sources: ReadonlyArray<{ docId: string; line: number; text: string }>,
  opts: {
    diskPath?: string;
    embed?: (s: string) => Promise<Float32Array>;
    dim?: number;
  } = {}
): Promise<{ index: VectorIndex; hits: number; misses: number }> {
  const dim = opts.dim ?? DEFAULT_EMBED_DIM;
  const embed = opts.embed ?? embedText;
  const diskPath = opts.diskPath ?? embeddingsFilePath();

  let cache: EmbeddingCache = { version: 1, dim, entries: {} };
  if (existsSync(diskPath)) {
    try {
      const raw = JSON.parse(readFileSync(diskPath, "utf-8")) as EmbeddingCache;
      if (raw && raw.version === 1 && raw.dim === dim) {
        cache = raw;
      }
    } catch (e) {
      log.warn("vector: failed to load embeddings cache, rebuilding", e);
    }
  }

  const idx = new VectorIndex({ dim });
  let hits = 0;
  let misses = 0;
  for (const src of sources) {
    const cached = cache.entries[src.docId];
    if (cached && cached.text === src.text) {
      idx.add(src.docId, new Float32Array(cached.vec), src.line);
      hits++;
    } else {
      const vec = await embed(src.text);
      idx.add(src.docId, vec, src.line);
      cache.entries[src.docId] = { vec: Array.from(vec), text: src.text, line: src.line };
      misses++;
    }
  }

  if (misses > 0) {
    try {
      mkdirSync(paths.memory, { recursive: true });
      const tmp = diskPath + ".tmp-" + process.pid;
      writeFileSync(tmp, JSON.stringify(cache), "utf-8");
      try {
        renameSync(tmp, diskPath);
      } catch {
        // Cross-device fallback: best-effort direct write.
        writeFileSync(diskPath, JSON.stringify(cache), "utf-8");
      }
    } catch (e) {
      log.warn("vector: failed to write embeddings cache", e);
    }
  }

  return { index: idx, hits, misses };
}
