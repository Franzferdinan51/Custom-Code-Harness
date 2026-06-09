// Tests for src/util/bm25.ts — pure-function scorer, no I/O.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Bm25Index, tokenize, DEFAULT_K1, DEFAULT_B } from "../util/bm25.js";

test("tokenize: lowercases and strips punctuation", () => {
  const toks = tokenize("Hello, World! It's 2026 — Phase-0.");
  // Letters/numbers/_/-/' stay; everything else is a separator.
  // "It's" → ["it's"] (apostrophe kept); "Phase-0" → ["phase-0"].
  assert.deepEqual(toks, ["hello", "world", "it's", "2026", "phase-0"]);
});

test("tokenize: empty and whitespace inputs return empty arrays", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   \t\n  "), []);
  assert.deepEqual(tokenize("!!! ??? ..."), []);
});

test("Bm25Index: empty corpus returns no hits", () => {
  const idx = new Bm25Index([]);
  const hits = idx.search("anything");
  assert.equal(hits.length, 0);
  assert.equal(idx.size, 0);
});

test("Bm25Index: topK truncates results", () => {
  const docs = [
    "alpha beta gamma",
    "alpha delta epsilon",
    "alpha zeta eta",
    "alpha theta iota",
  ];
  const idx = new Bm25Index(docs);
  const hits = idx.search("alpha", 2);
  assert.equal(hits.length, 2);
  // All docs contain "alpha", so the top-K just truncates in
  // insertion order (ties broken by docId).
  assert.equal(hits[0]!.docId, 0);
  assert.equal(hits[1]!.docId, 1);
});

test("Bm25Index: rarer terms outrank common terms when both are present", () => {
  // "common" appears in every doc; "rare" appears in one. A query
  // for "rare common" should rank the doc that contains "rare"
  // first because IDF(common) is near zero.
  const docs = [
    "this doc has the common keyword and nothing else",
    "another common one with common and common and common",
    "this is the rare doc — common keyword plus rare",
    "yet another common doc with common and common",
  ];
  const idx = new Bm25Index(docs);
  const hits = idx.search("rare common", 4);
  assert.ok(hits.length >= 1, "expected at least one hit");
  // The doc containing "rare" should be at the top.
  assert.equal(hits[0]!.docId, 2, "rare-bearing doc should win");
  // IDF for "rare" should be much higher than IDF for "common".
  const idfRare = idx.idf("rare");
  const idfCommon = idx.idf("common");
  assert.ok(idfRare > idfCommon, `idfRare(${idfRare}) should exceed idfCommon(${idfCommon})`);
});

test("Bm25Index: identical documents produce identical scores", () => {
  const docs = [
    "the quick brown fox jumps over the lazy dog",
    "the quick brown fox jumps over the lazy dog",
  ];
  const idx = new Bm25Index(docs);
  const hits = idx.search("quick brown", 5);
  assert.equal(hits.length, 2);
  // Same text → same score (up to float epsilon).
  const s0 = hits[0]!.score;
  const s1 = hits[1]!.score;
  assert.ok(Math.abs(s0 - s1) < 1e-9, `expected equal scores, got ${s0} vs ${s1}`);
});

test("Bm25Index: query with no matching terms returns empty", () => {
  const docs = [
    "alpha beta gamma",
    "delta epsilon zeta",
  ];
  const idx = new Bm25Index(docs);
  const hits = idx.search("nothere");
  assert.equal(hits.length, 0);
});

test("Bm25Index: scores are non-negative for non-empty query", () => {
  const docs = ["a b c", "a b", "x y z"];
  const idx = new Bm25Index(docs);
  const hits = idx.search("a");
  for (const h of hits) {
    assert.ok(h.score > 0, `expected positive score, got ${h.score}`);
  }
});

test("Bm25Index: hit.text echoes the original document", () => {
  const docs = ["first doc", "second doc about cats", "third doc about dogs"];
  const idx = new Bm25Index(docs);
  const hits = idx.search("cats", 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.text, "second doc about cats");
});

test("Bm25Index: default hyperparameters are exposed", () => {
  assert.ok(DEFAULT_K1 > 0);
  assert.ok(DEFAULT_B > 0 && DEFAULT_B < 1);
  // Sanity: k1=1.5, b=0.75 are the standard Okapi defaults.
  assert.equal(DEFAULT_K1, 1.5);
  assert.equal(DEFAULT_B, 0.75);
});
