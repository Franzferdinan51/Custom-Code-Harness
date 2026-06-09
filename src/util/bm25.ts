// BM25 (Best Matching 25) keyword scorer — small, dependency-free.
//
// BM25 ranks documents by a bag-of-words term frequency / inverse
// document frequency scheme. We use the "Okapi" form with the usual
// saturation (k1) and length normalization (b) parameters:
//
//   score(D, Q) = Σ_{q in Q} IDF(q) * (f(q, D) * (k1 + 1)) /
//                              (f(q, D) + k1 * (1 - b + b * |D| / avgdl))
//
// where f(q, D) is the term frequency in document D, |D| is the
// document length in tokens, avgdl is the average document length
// across the corpus, and IDF(q) is the smoothed inverse document
// frequency log((N - df(q) + 0.5) / (df(q) + 0.5) + 1).
//
// The scorer is intentionally pure and stateless from the caller's
// perspective: build an index once with `Bm25Index`, then call
// `search(query, k)` repeatedly. Tokenization is shared via
// `tokenize` so tests and consumers agree on the same rules.
//
// Note: vector / embedding-based recall is intentionally out of
// scope. See TODO(phase-1) in `memory-layers.ts`.

/** Standard BM25 hyper-parameters. Tuned for short technical notes. */
export const DEFAULT_K1 = 1.5;
export const DEFAULT_B = 0.75;

/**
 * Lower-case, strip punctuation, drop empty tokens. The set of
 * separator characters is intentionally tiny — spaces and ASCII
 * punctuation that has no semantic value in free-form notes.
 * Numbers are kept (they often matter: ports, versions, ids).
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const lower = text.toLowerCase();
  let buf = "";
  for (let i = 0; i < lower.length; i++) {
    const ch = lower.charCodeAt(i);
    // Treat anything outside [a-z0-9_'-] as a separator. Underscore
    // and hyphen are kept because they appear in identifiers like
    // `bm25_test` or `phase-0` that we want to retrieve as one token.
    const isWord =
      (ch >= 0x30 && ch <= 0x39) || // 0-9
      (ch >= 0x61 && ch <= 0x7a) || // a-z
      ch === 0x5f /* _ */ ||
      ch === 0x27 /* ' */ ||
      ch === 0x2d; /* - */
    if (isWord) {
      buf += lower[i];
    } else if (buf.length > 0) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

/** A single scored hit: the document's original text and its BM25 score. */
export interface Bm25Hit {
  /** Index of the document in the corpus, as passed to the constructor. */
  readonly docId: number;
  /** BM25 score (higher = more relevant). */
  readonly score: number;
  /** The original document text, echoed back for the caller. */
  readonly text: string;
}

/**
 * In-memory BM25 index over a fixed corpus. Rebuild with a new
 * instance to add or remove documents — there is no incremental
 * update. The corpus size is expected to be small (hundreds of
 * notes, not millions), which keeps the index cheap to build.
 */
export class Bm25Index {
  private readonly docs: string[];
  private readonly docTokens: string[][];
  private readonly docLengths: number[];
  private readonly df: Map<string, number> = new Map();
  private readonly avgdl: number;
  private readonly k1: number;
  private readonly b: number;

  constructor(docs: readonly string[], opts: { k1?: number; b?: number } = {}) {
    this.docs = docs.slice();
    this.k1 = opts.k1 ?? DEFAULT_K1;
    this.b = opts.b ?? DEFAULT_B;
    this.docTokens = this.docs.map((d) => tokenize(d));
    this.docLengths = this.docTokens.map((t) => t.length);

    let total = 0;
    for (const toks of this.docTokens) {
      total += toks.length;
      // Count each term once per document (document frequency).
      const seen = new Set<string>();
      for (const tok of toks) {
        if (seen.has(tok)) continue;
        seen.add(tok);
        this.df.set(tok, (this.df.get(tok) ?? 0) + 1);
      }
    }
    this.avgdl = this.docTokens.length > 0 ? total / this.docTokens.length : 0;
  }

  /** Number of documents in the index. */
  get size(): number { return this.docs.length; }

  /** Smoothed inverse document frequency for a term. */
  idf(term: string): number {
    const n = this.docs.length;
    if (n === 0) return 0;
    const df = this.df.get(term) ?? 0;
    // Robertson-Sparck Jones IDF with the +1 smoothing so unseen
    // (or single-corpus) terms don't produce negative scores.
    return Math.log((n - df + 0.5) / (df + 0.5) + 1);
  }

  /** Score a single document against a pre-tokenized query. */
  scoreDoc(queryTokens: readonly string[], docId: number): number {
    if (queryTokens.length === 0) return 0;
    const docToks = this.docTokens[docId];
    if (!docToks || docToks.length === 0) return 0;
    const docLen = this.docLengths[docId] ?? 0;

    // Per-term frequency in the document.
    const tf = new Map<string, number>();
    for (const t of docToks) tf.set(t, (tf.get(t) ?? 0) + 1);

    let s = 0;
    for (const q of queryTokens) {
      const f = tf.get(q) ?? 0;
      if (f === 0) continue;
      const idf = this.idf(q);
      // Length normalization — shorter-than-average docs get a
      // small boost, longer-than-average docs get penalized.
      const denom = f + this.k1 * (1 - this.b + (this.b * docLen) / (this.avgdl || 1));
      const numer = f * (this.k1 + 1);
      s += idf * (numer / denom);
    }
    return s;
  }

  /**
   * Return the top-K hits for a free-form query, sorted by score
   * descending. Documents with score 0 are dropped. `k` defaults to
   * the full corpus. Ties are broken by lower docId (insertion
   * order) for determinism.
   */
  search(query: string, k: number = this.docs.length): Bm25Hit[] {
    if (k <= 0) return [];
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const hits: Bm25Hit[] = [];
    for (let i = 0; i < this.docs.length; i++) {
      const s = this.scoreDoc(qTokens, i);
      if (s > 0) hits.push({ docId: i, score: s, text: this.docs[i] ?? "" });
    }
    hits.sort((a, b) => (b.score - a.score) || (a.docId - b.docId));
    return hits.slice(0, k);
  }
}
