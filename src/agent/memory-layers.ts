// 3-layer memory orchestrator.
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
// Vector/embedding-based recall is intentionally out of scope.
// TODO(phase-1): add a vector layer behind the same MemoryStore
// interface — likely an ANN index keyed by the existing Bm25Hit
// docIds, ranked on cosine similarity, then fused with BM25 via
// reciprocal-rank fusion. The file layout and APIs are designed
// to accept a 4th layer without refactor.

import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import { log } from "../util/logger.js";
import { Bm25Index, type Bm25Hit } from "../util/bm25.js";

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
   * BM25 search across RAW + LESSONS, labeled with `note:` /
   * `lesson:` prefixes. If the file is in legacy mode (no
   * `## LESSONS` section), falls back to case-insensitive
   * substring search on the raw block only.
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

    // Build a single BM25 corpus: notes first, then lessons. We
    // remember the boundary so we can label the hit.
    const corpus: string[] = [];
    for (const n of noteLines) corpus.push(n.text);
    for (const l of lessonEntries) corpus.push(renderLessonLine(l));

    if (corpus.length === 0) return "";
    const idx = new Bm25Index(corpus);
    const hits: MemoryHit[] = [];
    for (const h of idx.search(query, k)) {
      if (h.docId < noteLines.length) {
        const note = noteLines[h.docId]!;
        hits.push({
          line: note.line,
          layer: "note",
          display: "note: " + note.text,
          score: h.score,
        });
      } else {
        const lessonIdx = h.docId - noteLines.length;
        const lesson = lessonEntries[lessonIdx];
        if (lesson) {
          hits.push({
            line: -1, // lessons aren't addressable by raw file line
            layer: "lesson",
            display: "lesson: " + renderLessonLine(lesson),
            score: h.score,
          });
        }
      }
    }
    return hits.map(hitToString).join("\n");
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
