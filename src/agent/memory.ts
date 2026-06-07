// Persistent memory store. Two files:
//   - $CH_HOME/memory/MEMORY.md  (agent-curated, project-agnostic notes)
//   - $CH_HOME/memory/USER.md    (user profile, written by /memory user)
//
// Append-only by default. Searches are simple substring matches; for
// v1 we don't bother with embeddings or vector search.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import { log } from "../util/logger.js";

function memoryFile(): string { return join(paths.memory, "MEMORY.md"); }
function userFile(): string { return join(paths.memory, "USER.md"); }

function ensureFile(f: string, header: string): void {
  if (!existsSync(f)) {
    try { writeFileSync(f, header + "\n", "utf-8"); } catch (e) { log.warn("memory init failed", e); }
  }
}

export class MemoryStore {
  /** Read MEMORY.md. */
  read(): string {
    ensureFile(memoryFile(), "# Memory\n\nPersistent notes that survive across sessions. Updated by the agent via the memory tool or by `/memory add`.\n");
    try { return readFileSync(memoryFile(), "utf-8"); } catch { return ""; }
  }

  /** Append a timestamped entry to MEMORY.md. */
  async append(text: string): Promise<void> {
    ensureFile(memoryFile(), "# Memory\n\n");
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    const entry = "\n- " + ts + " — " + text.trim() + "\n";
    try { appendFileSync(memoryFile(), entry, "utf-8"); }
    catch (e) { log.error("memory append failed", e); throw e; }
  }

  /** Search: case-insensitive substring match, with line numbers. */
  async search(query: string): Promise<string> {
    const text = this.read();
    if (!text) return "";
    const lc = query.toLowerCase();
    const lines = text.split("\n");
    const hits: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i] ?? "").toLowerCase().includes(lc)) {
        hits.push(String(i + 1).padStart(4) + "  " + lines[i]);
      }
    }
    return hits.length === 0 ? "" : hits.join("\n");
  }

  /** Read USER.md. */
  readUser(): string {
    ensureFile(userFile(), "# User\n\nProfile of the user. Updated by the agent based on interactions.\n");
    try { return readFileSync(userFile(), "utf-8"); } catch { return ""; }
  }

  /** Append to USER.md. */
  async appendUser(text: string): Promise<void> {
    ensureFile(userFile(), "# User\n\n");
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    const entry = "\n- " + ts + " — " + text.trim() + "\n";
    try { appendFileSync(userFile(), entry, "utf-8"); }
    catch (e) { log.error("user append failed", e); throw e; }
  }
}
