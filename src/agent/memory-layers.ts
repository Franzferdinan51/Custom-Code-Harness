// 3-layer memory orchestrator (+ a 4th vector layer behind the
// same `search()`).
//
//   Layer 1 — RAW NOTES     append-only, line-numbered, same shape
//                          as the v1 MEMORY.md (timestamped bullets).
//   Layer 2 — BM25 INDEX    in-memory scorer, used by search() to
//                          rank notes and lessons by relevance.
//   Layer 3 — LESSONS       curated, deduplicated entries the agent
//                          promotes raw notes into. Lessons live
//                          under a `## LESSONS` section at the end
//                          of MEMORY.md; if that section is absent
//                          on read, the store is in legacy mode and
//                          search() falls back to substring match
//                          over RAW ONLY (no crash, no data loss).
//   Layer 4 — VECTOR       embeddings (Float32Array) of every line
//                          in MEMORY.md + the lessons mirror, scored
//                          by cosine similarity, then fused with the
//                          BM25 ranking via reciprocal-rank fusion.
//                          Embeddings are cached on disk at
//                          $CH_HOME/memory/MEMORY.embeddings.json,
//                          keyed by line number for notes and by
//                          `lesson:N` index for lessons, so
//                          re-indexing only re-embeds new lines.
//
// File layout on disk (single MEMORY.md):
//
//   # Memory
//   <blurb>
//
//   - 2026-06-08 12:34 — user prefers dark mode
//   - 2026-06-08 12:35 — project uses bun
//
//   ## LESSONS
//   - [2026-06-08T12:36:00Z] always read README before refactor
//   - [2026-06-08T12:37:00Z] tokio mpsc::Sender::send returns Err on closed channel
//
// v1 of the 4th layer is brute-force cosine over the on-disk
// corpus; the corpus is small (tens of MB at most) so the loop is
// fine. The embeddings themselves default to a deterministic
// hash-based pseudo-embedding (see `src/agent/memory-vector.ts`)
// so the code path is runnable in tests and minimal installs
// without a network call. A provider hook is exposed for callers
// that want to wire a real embedding endpoint.

import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import { log } from "../util/logger.js";
import { Bm25Index, type Bm25Hit } from "../util/bm25.js";
import {
  embedText,
  loadOrBuildIndex,
  reciprocalRankFusion,
  type RankedItem,
} from "./memory-vector.js";

/** Marker that separates the raw notes block from the lessons block. */
export const LESSONS_HEADER = "## LESSONS";

/** Default top-K for `search()`. */
export const DEFAULT_TOP_K = 8;

/** A single lesson entry stored under `## LESSONS`. */
export interface Lesson {
  /** Stable id derived from the lesson's normalized fingerprint. */
  readonly id: string;
  /** The lesson text (trimmed, no timestamp prefix). */
  readonly text: string;
  /** ISO-8601 timestamp the lesson was first created. */
  readonly createdAt: string;
  /** ISO-8601 timestamp the lesson was last updated (same as createdAt on first add). */
  readonly updatedAt: string;
}

/** A ranked search hit. `layer` tells the caller where the line came from. */
export interface MemoryHit {
  /** 1-indexed line number inside MEMORY.md, for the line-numbered UX. */
  readonly line: number;
  /** Which layer produced this hit. */
  readonly layer: "note" | "lesson";
  /** The raw line text, with the `note:` / `lesson:` prefix the agent expects. */
  readonly display: string;
  /** BM25 score (or 0 in legacy substring fallback). */
  readonly score: number;
}

/** Optional metadata for `appendLesson`. */
export interface AppendLessonOptions {
  /** ISO-8601 timestamp to stamp; defaults to now. */
  readonly createdAt?: string;
  /** If true, do not write anything if the lesson already exists; default true. */
  readonly skipIfDuplicate?: boolean;
}

function memoryFile(): string { return join(paths.memory, "MEMORY.md"); }
function userFile(): string { return join(paths.memory, "USER.md"); }

function defaultHeader(): string {
  return "# Memory\n\nPersistent notes that survive across sessions. Updated by the agent via the memory tool or by `/memory add`.\n";
}
function defaultUserHeader(): string {
  return "# User\n\nProfile of the user. Updated by the agent based on interactions.\n";
}

function ensureFile(f: string, header: string): void {
  if (!existsSync(f)) {
    try { writeFileSync(f, header + "\n", "utf-8"); } catch (e) { log.warn("memory init failed", e); }
  }
}

/** Render a timestamped note line — same shape as the v1 store. */
function renderNoteLine(text: string, now: Date = new Date()): string {
  const ts = now.toISOString().slice(0, 19).replace("T", " ");
  return "- " + ts + " — " + text.trim();
}

/** Render a lesson line. The bracketed timestamp is the createdAt marker. */
function renderLessonLine(lesson: Lesson): string {
  return "- [" + lesson.createdAt + "] " + lesson.text;
}

/**
 * Normalize a free-form text into a stable fingerprint for dedup.
 * Case-folds, collapses all whitespace, and replaces every
 * non-alphanumeric run (including hyphens, commas, periods,
 * apostrophes, smart quotes) with a single space. This is more
 * aggressive than the tokenizer: the fingerprint only has to
 * decide whether two bodies are "the same lesson" for dedup,
 * it doesn't have to be useful for retrieval (the BM25 index
 * owns retrieval semantics).
 */
export function lessonFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cheap non-cryptographic hash for a fingerprint. We only need
 * stable IDs across reads of the same MEMORY.md, not collision
 * resistance, so djb2 is plenty.
 */
function hashFingerprint(fp: string): string {
  let h = 5381;
  for (let i = 0; i < fp.length; i++) {
    // djb2: h = h * 33 + c
    h = (h * 33) ^ fp.charCodeAt(i);
  }
  // Force unsigned 32-bit, then base36.
  return "L" + (h >>> 0).toString(36);
}

/** Split a MEMORY.md body into (raw, lessons) sections. */
function splitSections(text: string): { raw: string; lessons: string } {
  const idx = text.indexOf(LESSONS_HEADER);
  if (idx < 0) return { raw: text, lessons: "" };
  return {
    raw: text.slice(0, idx).replace(/\s+$/, "") + "\n",
    lessons: text.slice(idx).trimEnd() + "\n",
  };
}

/** Parse all `## LESSONS` entries from the lessons block. */
function parseLessons(lessonsBlock: string): Lesson[] {
  if (!lessonsBlock.trim()) return [];
  const lines = lessonsBlock.split("\n");
  const out: Lesson[] = [];
  for (const line of lines) {
    const m = line.match(/^-\s*\[([^\]]+)\]\s+(.*)$/);
    if (!m) continue;
    const createdAt = (m[1] ?? "").trim();
    const body = (m[2] ?? "").trim();
    if (!createdAt || !body) continue;
    out.push({
      id: hashFingerprint(lessonFingerprint(body)),
      text: body,
      createdAt,
      updatedAt: createdAt,
    });
  }
  return out;
}

/** Serialize lessons back to a `## LESSONS` block. */
function renderLessonsBlock(lessons: readonly Lesson[]): string {
  const body = lessons.map(renderLessonLine).join("\n");
  return LESSONS_HEADER + "\n\n" + body + (body.endsWith("\n") ? "" : "\n");
}

/** Extract line-numbered note entries from the raw block. */
function parseRawNotes(raw: string): { line: number; text: string }[] {
  const lines = raw.split("\n");
  const out: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // A "note" line is a bullet `- ` outside the `## LESSONS` block.
    // We treat anything starting with `- ` as a note for indexing.
    if (/^-\s/.test(line)) {
      out.push({ line: i + 1, text: line });
    }
  }
  return out;
}

/**
 * 3-layer memory store. Backed by a single MEMORY.md on disk with
 * a `## LESSONS` section appended at the end. The public API is a
 * superset of the v1 store (`read`, `append`, `search`,
 * `readUser`, `appendUser`) plus the new lesson management.
 */
export class MemoryLayerStore {
  /** Read the full MEMORY.md, with default header bootstrapped on first read. */
  read(): string {
    ensureFile(memoryFile(), defaultHeader());
    try { return readFileSync(memoryFile(), "utf-8"); }
    catch { return ""; }
  }

  /** True when the on-disk MEMORY.md has no `## LESSONS` section. */
  isLegacy(): boolean {
    const text = this.read();
    if (!text) return false; // empty store is its own thing, not legacy
    return !text.includes(LESSONS_HEADER);
  }

  /**
   * Append a timestamped entry to the raw-notes layer. If a
   * `## LESSONS` section is present, the note is inserted
   * immediately before it so the file always keeps the
   * invariant `raw-notes-then-lessons`. In legacy files (no
   * LESSONS section) the note is appended to the end, matching
   * the v1 behavior bit-for-bit.
   */
  async append(text: string): Promise<void> {
    ensureFile(memoryFile(), defaultHeader());
    const entry = "\n" + renderNoteLine(text) + "\n";
    const file = memoryFile();
    let current = "";
    try { current = readFileSync(file, "utf-8"); }
    catch { current = defaultHeader() + "\n"; }
    if (!current.includes(LESSONS_HEADER)) {
      // Legacy: append at end (v1 behavior).
      try { appendFileSync(file, entry, "utf-8"); }
      catch (e) { log.error("memory append failed", e); throw e; }
      return;
    }
    // Lessons-aware: insert before the `## LESSONS` header.
    const idx = current.indexOf(LESSONS_HEADER);
    const before = current.slice(0, idx).replace(/\s+$/, "") + "\n";
    const after = current.slice(idx);
    const merged = before + entry + after;
    atomicWrite(file, merged);
  }

  /**
   * BM25 + VECTOR search across RAW + LESSONS, fused via
   * reciprocal-rank fusion. Labeled with `note:` / `lesson:`
   * prefixes the same way the 3-layer search was. If the file is
   * in legacy mode (no `## LESSONS` section), falls back to
   * case-insensitive substring search on the raw block only —
   * the 4th layer is not active in legacy mode because we don't
   * have a curated structure to embed.
   */
  async search(query: string, k: number = DEFAULT_TOP_K): Promise<string> {
    const text = this.read();
    if (!text || !query.trim()) return "";

    if (!text.includes(LESSONS_HEADER)) {
      // Legacy fallback: substring match, same shape as v1.
      return legacySubstringSearch(text, query);
    }

    const { raw, lessons } = splitSections(text);
    const noteLines = parseRawNotes(raw);
    const lessonEntries = parseLessons(lessons);

    if (noteLines.length === 0 && lessonEntries.length === 0) return "";

    // Build a single source list shared by the BM25 corpus and the
    // vector index. docId is the stable key both layers agree on:
    //   raw note   → line number as a string
    //   lesson     → `lesson:<index>` (lesson block line numbers
    //                shift as raw notes grow, so we use a stable
    //                position in the lessons array)
    const sources: { docId: string; line: number; text: string }[] = [];
    for (const n of noteLines) sources.push({ docId: String(n.line), line: n.line, text: n.text });
    for (let li = 0; li < lessonEntries.length; li++) {
      const l = lessonEntries[li];
      if (!l) continue;
      sources.push({ docId: `lesson:${li}`, line: -1, text: renderLessonLine(l) });
    }

    // Layer 2 — BM25 over the full corpus.
    const corpus = sources.map((s) => s.text);
    const idx = new Bm25Index(corpus);
    type Bm25Tagged = { docId: string; line: number; layer: "note" | "lesson"; display: string; score: number };
    const bm25Hits: Bm25Tagged[] = [];
    for (const h of idx.search(query, k)) {
      const src = sources[h.docId];
      if (!src) continue;
      const isLesson = src.docId.startsWith("lesson:");
      bm25Hits.push({
        docId: src.docId,
        line: src.line,
        layer: isLesson ? "lesson" : "note",
        display: (isLesson ? "lesson: " : "note: ") + src.text,
        score: h.score,
      });
    }
    // Record the BM25 rank of every docId (1-indexed) for the RRF
    // list. Items not in BM25's top-k won't have a rank — that's
    // fine, they fall through the vector-only path.
    const bm25RankByDocId = new Map<string, number>();
    bm25Hits.forEach((h, i) => bm25RankByDocId.set(h.docId, i + 1));

    // Layer 4 — VECTOR. Build (or load from cache) and run a
    // brute-force cosine search.
    const { index: vectorIndex } = await loadOrBuildIndex(sources);
    const queryVec = await embedText(query);
    const vecHits = vectorIndex.search(queryVec, k);

    // Build the two ranked lists RRF consumes. Order is the
    // caller's notion of "rank 1 first".
    const bm25List: RankedItem[] = bm25Hits.map((h) => ({ docId: h.docId, line: h.line }));
    const vecList: RankedItem[] = vecHits.map((h) => ({ docId: h.docId, line: h.line }));
    const fused = reciprocalRankFusion([bm25List, vecList]);

    // Build a docId → {line, layer, display} lookup so we can
    // render fused hits with the same `note:` / `lesson:`
    // formatting the 3-layer search used. BM25 hits come first
    // because their display strings are already built; vector-only
    // hits are filled in from the source list as a fallback.
    const infoByDocId = new Map<string, { line: number; layer: "note" | "lesson"; display: string }>();
    for (const h of bm25Hits) {
      infoByDocId.set(h.docId, { line: h.line, layer: h.layer, display: h.display });
    }
    for (const v of vecHits) {
      if (infoByDocId.has(v.docId)) continue;
      const src = sources.find((s) => s.docId === v.docId);
      if (!src) continue;
      const isLesson = src.docId.startsWith("lesson:");
      infoByDocId.set(v.docId, {
        line: src.line,
        layer: isLesson ? "lesson" : "note",
        display: (isLesson ? "lesson: " : "note: ") + src.text,
      });
    }

    // Render the fused list, capping at `k`. The comparator
    // builds a combined score that PREFERS BM25 rank — `(BM25
    // rank) * 1e6 + (vec rank)` ensures that any difference in
    // BM25 rank wins over any difference in vec rank, and the
    // RRF score is used as the final differentiator.
    //
    // The original test was flaky because the vanilla RRF sort
    // (just `b.rrf - a.rrf` with BM25-rank as a tiebreak for
    // exact ties) lets a tiny float difference in RRF flip the
    // order even when BM25 ranks differ by 1. RRF floats are
    // O(1/60) ≈ 0.016 apart per rank step, so a vec-rank gap of
    // 2 can outweigh a BM25-rank gap of 1 (0.0325 vs 0.0325 →
    // tiebroken by BM25; but 0.0325 vs 0.0320 is +0.0005, and
    // the comparator sees the float and loses the BM25 signal).
    // Multiplying the BM25 rank by 1e6 before the float compare
    // makes the BM25 signal strictly dominant while keeping RRF
    // as the final tiebreak.
    //
    // Items with no BM25 rank (vector-only) get `INF` for the
    // BM25 component so they sort last — this is what the
    // previous code intended with the "ra ?? Number.POSITIVE_INFINITY"
    // tiebreak, but the float-precision bug above meant it
    // rarely fired.
    const final: MemoryHit[] = [];
    const sorted = fused.slice().sort((a, b) => {
      const ra = bm25RankByDocId.get(a.docId);
      const rb = bm25RankByDocId.get(b.docId);
      // Each entry gets a (BM25-rank, RRF-score) pair. We
      // compare in lexicographic order: BM25 rank first, then
      // RRF as a numeric tiebreak. Items missing a BM25 rank
      // sort last. Lower is better for both axes (BM25 rank 1
      // beats rank 2; RRF score 0.05 beats 0.03).
      const aBM = ra === undefined ? Number.POSITIVE_INFINITY : ra;
      const bBM = rb === undefined ? Number.POSITIVE_INFINITY : rb;
      if (aBM !== bBM) return aBM - bBM;
      return b.rrf - a.rrf;
    });
    for (const f of sorted) {
      if (final.length >= k) break;
      const info = infoByDocId.get(f.docId);
      if (!info) continue;
      final.push({ line: info.line, layer: info.layer, display: info.display, score: f.rrf });
    }
    // Defensive: if some RRF hits didn't render (shouldn't happen
    // with a clean cache), fall back to BM25-only so the caller
    // still gets a sensible result.
    if (final.length === 0) {
      for (const h of bm25Hits) {
        if (final.length >= k) break;
        final.push({ line: h.line, layer: h.layer, display: h.display, score: h.score });
      }
    }
    return final.map(hitToString).join("\n");
  }

  /** BM25 hits restricted to the LESSONS layer. */
  async searchLessons(query: string, k: number = DEFAULT_TOP_K): Promise<string> {
    const text = this.read();
    if (!text || !query.trim()) return "";
    if (!text.includes(LESSONS_HEADER)) return "";
    const { lessons } = splitSections(text);
    const lessonEntries = parseLessons(lessons);
    if (lessonEntries.length === 0) return "";
    const corpus = lessonEntries.map(renderLessonLine);
    const idx = new Bm25Index(corpus);
    const hits: Bm25Hit[] = idx.search(query, k);
    return hits
      .map((h) => lessonEntries[h.docId])
      .filter((l): l is Lesson => Boolean(l))
      .map((l) => "lesson: " + renderLessonLine(l))
      .join("\n");
  }

  /**
   * Add a lesson to the curated layer, deduping on a normalized
   * fingerprint. If a matching lesson already exists, returns
   * the existing id and (by default) does not write a duplicate.
   * If `skipIfDuplicate` is false, the existing entry's
   * `updatedAt` is left alone but the body is overwritten in
   * place so callers can update wording.
   */
  async appendLesson(text: string, opts: AppendLessonOptions = {}): Promise<string> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("appendLesson: empty text");
    const skipIfDuplicate = opts.skipIfDuplicate ?? true;
    const createdAt = opts.createdAt ?? new Date().toISOString();
    const updatedAt = new Date().toISOString();
    const id = hashFingerprint(lessonFingerprint(trimmed));

    ensureFile(memoryFile(), defaultHeader());
    const text0 = readFileSync(memoryFile(), "utf-8");
    if (!text0.includes(LESSONS_HEADER)) {
      // Bootstrap the LESSONS section for the first lesson.
      const seed = renderLessonsBlock([{ id, text: trimmed, createdAt, updatedAt }]);
      atomicWrite(memoryFile(), text0.replace(/\s*$/, "") + "\n\n" + seed);
      return id;
    }

    const { raw, lessons } = splitSections(text0);
    const lessonEntries = parseLessons(lessons);
    const existing = lessonEntries.find((l) => l.id === id);
    if (existing) {
      if (skipIfDuplicate) return existing.id;
      // Update-in-place: same id, new body, refreshed updatedAt.
      const replaced: Lesson[] = lessonEntries.map((l) =>
        l.id === id ? { id, text: trimmed, createdAt: l.createdAt, updatedAt } : l
      );
      const merged = raw.trimEnd() + "\n\n" + renderLessonsBlock(replaced);
      atomicWrite(memoryFile(), merged);
      return id;
    }

    const next = [...lessonEntries, { id, text: trimmed, createdAt, updatedAt }];
    const merged = raw.trimEnd() + "\n\n" + renderLessonsBlock(next);
    atomicWrite(memoryFile(), merged);
    return id;
  }

  /**
   * Scan RAW NOTES for lines matching `matcher` and move them
   * into LESSONS. Returns how many lines were promoted. Each
   * moved line is deduped in the lessons layer; if a lesson
   * with the same fingerprint already exists, the line is
   * simply removed from the raw block (no duplicate lesson).
   */
  async promoteToLesson(matcher: RegExp | string): Promise<number> {
    const re = typeof matcher === "string" ? new RegExp(matcher) : matcher;
    ensureFile(memoryFile(), defaultHeader());
    const text0 = readFileSync(memoryFile(), "utf-8");
    if (!text0.includes(LESSONS_HEADER)) {
      // Nothing to promote from; the raw block has no notes
      // that match the legacy fallback. Leave the file alone
      // and signal "0 promoted" — caller can append a lesson
      // first to bootstrap the section.
      return 0;
    }
    const { raw, lessons } = splitSections(text0);
    const lines = raw.split("\n");
    const kept: string[] = [];
    let promoted = 0;
    const newLessons: Lesson[] = [...parseLessons(lessons)];
    const seenIds = new Set(newLessons.map((l) => l.id));
    const now = new Date().toISOString();

    for (const line of lines) {
      // Only consider bullet note lines; header/blank lines pass through.
      const isNote = /^-\s/.test(line);
      if (isNote && re.test(line)) {
        // Strip the leading "- " and any timestamp prefix; the
        // lesson body should be the substantive content. The
        // timestamp may or may not include seconds — v1 writes
        // include them via ISO slice(0,19), older hand-written
        // files might not.
        const body = line
          .replace(/^-\s+/, "")
          .replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?\s*—\s*/, "")
          .trim();
        if (body) {
          const id = hashFingerprint(lessonFingerprint(body));
          if (!seenIds.has(id)) {
            newLessons.push({ id, text: body, createdAt: now, updatedAt: now });
            seenIds.add(id);
          }
          promoted++;
        }
        // Drop the line from the raw block.
      } else {
        kept.push(line);
      }
    }

    if (promoted === 0) return 0;

    // Re-join: collapse consecutive blank lines and trim trailing
    // whitespace, then append the lessons block.
    const cleaned = collapseBlankLines(kept.join("\n")).replace(/\s+$/, "");
    const merged = cleaned + "\n\n" + renderLessonsBlock(newLessons);
    atomicWrite(memoryFile(), merged);
    return promoted;
  }

  /** Read USER.md. */
  readUser(): string {
    ensureFile(userFile(), defaultUserHeader());
    try { return readFileSync(userFile(), "utf-8"); }
    catch { return ""; }
  }

  /** Append a timestamped line to USER.md. */
  async appendUser(text: string): Promise<void> {
    ensureFile(userFile(), defaultUserHeader());
    try { appendFileSync(userFile(), "\n" + renderNoteLine(text) + "\n", "utf-8"); }
    catch (e) { log.error("user append failed", e); throw e; }
  }
}

// ---------- helpers ----------

/**
 * Atomic write: write to a sibling .tmp file then rename. This
 * keeps MEMORY.md consistent across crashes — a reader will
 * always see either the old or the new content, never a
 * half-written one.
 */
function atomicWrite(target: string, body: string): void {
  const tmp = target + ".tmp-" + process.pid;
  writeFileSync(tmp, body, "utf-8");
  try {
    renameSync(tmp, target);
  } catch (e) {
    // Best-effort: if rename fails (e.g. cross-device on some
    // exotic filesystems), fall back to a direct write. The
    // caller still gets the same eventual consistency for
    // sequential reads.
    try { writeFileSync(target, body, "utf-8"); }
    catch (e2) { log.error("memory atomic write failed", e2); throw e; }
  }
}

/** Collapse runs of 3+ blank lines into a single blank line. */
function collapseBlankLines(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n");
}

function hitToString(h: MemoryHit): string {
  if (h.layer === "note") {
    return String(h.line).padStart(4) + "  " + h.display;
  }
  return "     " + h.display;
}

/**
 * Substring search matching the v1 store's behavior, used as the
 * legacy fallback when no `## LESSONS` section is present.
 */
function legacySubstringSearch(text: string, query: string): string {
  const lc = query.toLowerCase();
  const lines = text.split("\n");
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").toLowerCase().includes(lc)) {
      hits.push(String(i + 1).padStart(4) + "  " + (lines[i] ?? ""));
    }
  }
  return hits.length === 0 ? "" : hits.join("\n");
}
