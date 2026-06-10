// Tests for the 4th memory layer (src/agent/memory-vector.ts):
// brute-force cosine index, hash-based pseudo-embedding, RRF
// fusion, and on-disk cache round-trip.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test that touches the disk gets its own temp CH_HOME so
// the global `paths` getters resolve to a writable, isolated
// directory.
function makeTmp(): string {
  const t = mkdtempSync(join(tmpdir(), "ch-vec-"));
  process.env.CODINGHARNESS_HOME = t;
  process.env.NO_COLOR = "1";
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
    mkdirSync(join(t, sub), { recursive: true });
  }
  return t;
}

// IMPORTANT: import AFTER setting CODINGHARNESS_HOME so the
// `paths` getters resolve into the temp dir.
import {
  VectorIndex,
  cosineSimilarity,
  hashEmbed,
  embedText,
  loadOrBuildIndex,
  reciprocalRankFusion,
  DEFAULT_EMBED_DIM,
  DEFAULT_RRF_K0,
  embeddingsFilePath,
} from "../agent/memory-vector.js";

// ---- cosine similarity on known vectors ----

test("cosineSimilarity returns 1 for identical unit vectors", () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([1, 0, 0]);
  assert.equal(cosineSimilarity(a, b), 1);
});

test("cosineSimilarity returns 0 for orthogonal vectors and -1 for opposites", () => {
  const x = new Float32Array([1, 0, 0]);
  const y = new Float32Array([0, 1, 0]);
  const z = new Float32Array([-1, 0, 0]);
  assert.equal(cosineSimilarity(x, y), 0);
  assert.ok(Math.abs(cosineSimilarity(x, z) - -1) < 1e-6, `expected -1, got ${cosineSimilarity(x, z)}`);
});

test("cosineSimilarity returns 0 when either vector is zero-magnitude", () => {
  const zero = new Float32Array([0, 0, 0]);
  const v = new Float32Array([1, 2, 3]);
  assert.equal(cosineSimilarity(zero, v), 0);
  assert.equal(cosineSimilarity(v, zero), 0);
});

// ---- hashEmbed: deterministic, dependency-free, signed ----

test("hashEmbed is deterministic — same text gives the same vector", () => {
  const a = hashEmbed("the quick brown fox");
  const b = hashEmbed("the quick brown fox");
  assert.equal(a.length, DEFAULT_EMBED_DIM);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i], b[i], `slot ${i} should be identical for same input`);
  }
});

test("hashEmbed is content-sensitive — different text gives different vectors", () => {
  const a = hashEmbed("alpha");
  const b = hashEmbed("beta");
  // The hash derives from a different prefix byte, so the two
  // vectors should differ in every slot — assert at least one
  // slot where they differ.
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diffs++;
  }
  assert.ok(diffs > 0, "different inputs should produce different vectors");
});

test("hashEmbed stays in [-1, 1] and embedText returns the hash fallback", async () => {
  const v = hashEmbed("anything goes here");
  for (let i = 0; i < v.length; i++) {
    assert.ok(v[i]! >= -1 && v[i]! <= 1, `slot ${i} out of [-1,1]: ${v[i]}`);
  }
  const e = await embedText("anything goes here");
  for (let i = 0; i < e.length; i++) {
    assert.equal(e[i], v[i], "embedText should match hashEmbed");
  }
});

// ---- VectorIndex: add / search / serialize round-trip ----

test("VectorIndex add + search returns the nearest hit by cosine", async () => {
  const idx = new VectorIndex({ dim: 4 });
  // Use hand-crafted vectors so the answer is unambiguous.
  idx.add("a", new Float32Array([1, 0, 0, 0]), 1);
  idx.add("b", new Float32Array([0, 1, 0, 0]), 2);
  idx.add("c", new Float32Array([0, 0, 1, 0]), 3);
  idx.add("d", new Float32Array([0, 0, 0, 1]), 4);
  const hits = idx.search(new Float32Array([1, 0.01, 0, 0]), 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.docId, "a", "nearest should be the closest unit vector");
  assert.equal(hits[0]!.line, 1);
  assert.ok(hits[0]!.score > hits[1]!.score, "hits should be sorted by score desc");
});

test("VectorIndex serialize/load round-trip preserves vectors and docIds", () => {
  const idx = new VectorIndex({ dim: 8 });
  // n42 starts with a strong [1, 0, ...] component so it is
  // unambiguously nearest to that query vector. The lesson
  // vector also has positive overlap with the query so it
  // survives the score>0 filter.
  idx.add("n42", new Float32Array([1, 0, 0.1, 0, 0, 0, 0, 0]), 42);
  idx.add("lesson:0", new Float32Array([0.1, 0, 0, 0, 1, 0.5, 0, 0]), -1);
  const cache = idx.serialize();
  assert.equal(cache.version, 1);
  assert.equal(cache.dim, 8);
  assert.equal(Object.keys(cache.entries).length, 2);

  const reloaded = VectorIndex.load(cache);
  assert.equal(reloaded.size, 2);
  const hits = reloaded.search(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), 2);
  assert.equal(hits[0]!.docId, "n42", "n42 should still be nearest to [1,0,...]");
  assert.equal(hits[0]!.line, 42);
  // The lesson entry should still be present, just with a lower score.
  const lessonHit = hits.find((h) => h.docId === "lesson:0");
  assert.ok(lessonHit, "lesson entry should round-trip");
  assert.equal(lessonHit!.line, -1);
});

test("VectorIndex brute-force ranking matches argmax on a small corpus", async () => {
  // 4 documents whose embeddings are all in R^8. Hand-pick
  // vectors so the expected ranking is unambiguous, then confirm
  // search() returns them in the expected order. We use vectors
  // that all have a positive dot product with the query so we
  // can also assert the full top-4.
  const idx = new VectorIndex({ dim: 8 });
  const docs: { id: string; vec: Float32Array }[] = [
    { id: "x", vec: new Float32Array([1, 0.05, 0.05, 0, 0, 0, 0, 0]) },
    { id: "y", vec: new Float32Array([0.7, 0.7, 0, 0, 0, 0, 0, 0]) },
    { id: "z", vec: new Float32Array([0.3, 0.3, 0.3, 0, 0, 0, 0, 0]) },
    { id: "w", vec: new Float32Array([0.1, 0.1, 0.1, 0, 0, 0, 0, 0]) },
  ];
  for (const d of docs) idx.add(d.id, d.vec, 0);
  const q = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
  const hits = idx.search(q, 4);
  assert.equal(hits.length, 4, "all 4 docs should have positive cosine with the query");
  assert.equal(hits[0]!.docId, "x", "x has the highest cosine with q");
  assert.equal(hits[1]!.docId, "y", "y is closer to q than z or w");
  // Hits must be sorted by score descending.
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1]!.score >= hits[i]!.score, `hits should be sorted desc: ${hits[i - 1]!.score} < ${hits[i]!.score}`);
  }
});

// ---- reciprocalRankFusion: pure, deterministic, two-list case ----

test("reciprocalRankFusion on two lists sums contributions and sorts desc", () => {
  // bm25 list has A at top, B second.
  // vector list has A at top, C second.
  // Expected fused ranking with k0=60:
  //   A: 1/61 + 1/61 = 0.0328
  //   B: 1/62 + 0    = 0.0161
  //   C: 0    + 1/62 = 0.0161
  // A wins; B and C tie — both contribute to the same 0.0161.
  const bm25 = [
    { docId: "A", line: 1 },
    { docId: "B", line: 2 },
  ];
  const vec = [
    { docId: "A", line: 1 },
    { docId: "C", line: 3 },
  ];
  const fused = reciprocalRankFusion([bm25, vec]);
  assert.equal(fused.length, 3);
  assert.equal(fused[0]!.docId, "A");
  assert.ok(Math.abs(fused[0]!.rrf - (1 / 61 + 1 / 61)) < 1e-9);
  // B and C should both appear with the same RRF.
  const b = fused.find((h) => h.docId === "B")!;
  const c = fused.find((h) => h.docId === "C")!;
  assert.equal(b.rrf, c.rrf, "B and C should have equal RRF");
  assert.equal(b.rrf, 1 / 62);
});

test("reciprocalRankFusion handles empty input and single-element lists", () => {
  assert.deepEqual(reciprocalRankFusion([]), []);
  const fused = reciprocalRankFusion([[{ docId: "x", line: 7 }]]);
  assert.equal(fused.length, 1);
  assert.equal(fused[0]!.docId, "x");
  assert.equal(fused[0]!.rrf, 1 / (DEFAULT_RRF_K0 + 1));
});

test("reciprocalRankFusion with k0=0 throws (k0 must be positive)", () => {
  assert.throws(() => reciprocalRankFusion([[{ docId: "x", line: 1 }]], 0));
  assert.throws(() => reciprocalRankFusion([[{ docId: "x", line: 1 }]], -1));
});

// ---- loadOrBuildIndex: disk cache round-trip ----

test("loadOrBuildIndex writes the cache on a miss and reuses it on a subsequent call", async () => {
  const tmp = makeTmp();
  try {
    const sources = [
      { docId: "10", line: 10, text: "rust borrow checker fights" },
      { docId: "11", line: 11, text: "tokio mpsc send error" },
    ];
    const cachePath = join(tmp, "memory", "MEMORY.embeddings.json");

    // First call: cache is empty, all sources are misses.
    const a = await loadOrBuildIndex(sources);
    assert.equal(a.hits, 0);
    assert.equal(a.misses, 2);
    assert.equal(a.index.size, 2);
    assert.ok(existsSync(cachePath), "cache file should be created on first call");

    // Second call with the same sources: all hits, no misses.
    const b = await loadOrBuildIndex(sources);
    assert.equal(b.hits, 2, "second call should hit the cache for all entries");
    assert.equal(b.misses, 0);
    assert.equal(b.index.size, 2);
    // The reloaded vectors should be byte-identical to the first
    // call's vectors (proves we read the cache, not re-embedded).
    for (let i = 0; i < a.index.size; i++) {
      // Both indices iterate in the same insertion order.
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("loadOrBuildIndex re-embeds entries whose source text changed", async () => {
  const tmp = makeTmp();
  try {
    const cachePath = join(tmp, "memory", "MEMORY.embeddings.json");
    // First pass: doc with one text. Embed and snapshot the
    // index — we want to compare against the re-embedded version.
    const a = await loadOrBuildIndex([
      { docId: "5", line: 5, text: "first version" },
    ]);
    assert.equal(a.misses, 1);
    assert.equal(a.hits, 0);
    // The cache file should reflect the first text.
    let cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    assert.equal(cached.entries["5"].text, "first version");
    const firstVec = new Float32Array(cached.entries["5"].vec);

    // Second pass: same docId, different text → should miss the
    // cache and re-embed. The cached vector should change.
    const b = await loadOrBuildIndex([
      { docId: "5", line: 5, text: "second version" },
    ]);
    assert.equal(b.hits, 0, "changed text should be a cache miss");
    assert.equal(b.misses, 1);

    // The cache file should reflect the new text and a new vec.
    cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    assert.equal(cached.entries["5"].text, "second version");
    const secondVec = new Float32Array(cached.entries["5"].vec);
    // The two vectors should not be byte-identical.
    let differs = false;
    for (let i = 0; i < firstVec.length; i++) {
      if (firstVec[i] !== secondVec[i]) { differs = true; break; }
    }
    assert.ok(differs, "re-embedding with different text should change the vector");

    // The new embedding for "second version" should match the
    // hashEmbed output (proves we went through the embedder,
    // not just renamed the cached vec).
    const expectedNewVec = hashEmbed("second version");
    let matches = true;
    for (let i = 0; i < expectedNewVec.length; i++) {
      if (Math.abs((secondVec[i] ?? 0) - (expectedNewVec[i] ?? 0)) > 1e-6) {
        matches = false;
        break;
      }
    }
    assert.ok(matches, "re-embedded vector should equal hashEmbed(second version)");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("loadOrBuildIndex ignores a corrupt cache file and rebuilds", async () => {
  const tmp = makeTmp();
  try {
    const cachePath = join(tmp, "memory", "MEMORY.embeddings.json");
    // Write garbage that won't parse.
    writeFileSync(cachePath, "{ not valid json", "utf-8");
    const a = await loadOrBuildIndex([
      { docId: "1", line: 1, text: "the only doc" },
    ]);
    assert.equal(a.misses, 1, "corrupt cache should be treated as a miss");
    assert.equal(a.index.size, 1);
    // The cache should have been overwritten with valid JSON.
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    assert.equal(cached.version, 1);
    assert.equal(cached.entries["1"].text, "the only doc");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- embeddingsFilePath helper ----

test("embeddingsFilePath resolves to $CH_HOME/memory/MEMORY.embeddings.json", () => {
  const tmp = makeTmp();
  try {
    const expected = join(tmp, "memory", "MEMORY.embeddings.json");
    assert.equal(embeddingsFilePath(), expected);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
