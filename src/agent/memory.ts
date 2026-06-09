// Persistent memory store — v2.
//
// Public API is unchanged from v1 (`read`, `append`, `search`,
// `readUser`, `appendUser`) so callers in slash/builtin.ts,
// runtime.ts, and the memory tool keep working. Internally we
// delegate to `MemoryLayerStore` which adds:
//   - BM25-ranked search across raw notes + lessons
//   - a curated, deduplicated LESSONS section
//   - a legacy substring fallback for files written before
//     `## LESSONS` was introduced
//
// Embedding-based vector recall is intentionally out of scope.
// See TODO(phase-1) in memory-layers.ts.

import { MemoryLayerStore } from "./memory-layers.js";

/**
 * The persisted memory store. Backed by a single MEMORY.md file
 * under $CH_HOME/memory/.
 */
export class MemoryStore {
  private readonly inner = new MemoryLayerStore();

  /** Read the full MEMORY.md. */
  read(): string { return this.inner.read(); }

  /** Append a timestamped entry to the raw-notes layer. */
  async append(text: string): Promise<void> { await this.inner.append(text); }

  /**
   * BM25 search across RAW + LESSONS, with `note:` / `lesson:`
   * prefixes. Falls back to substring match in legacy mode.
   */
  async search(query: string): Promise<string> { return await this.inner.search(query); }

  /** Read USER.md (unrelated to the layers refactor). */
  readUser(): string { return this.inner.readUser(); }

  /** Append a timestamped line to USER.md. */
  async appendUser(text: string): Promise<void> { await this.inner.appendUser(text); }
}

// Re-export the layer types and helpers for callers that want
// the full v2 surface (lessons, promotion, etc.).
export { MemoryLayerStore } from "./memory-layers.js";
export {
  LESSONS_HEADER,
  DEFAULT_TOP_K,
  lessonFingerprint,
  type Lesson,
  type MemoryHit,
  type AppendLessonOptions,
} from "./memory-layers.js";
