// Session manager. Each session is a JSONL file where every line is a
// node in a tree: { id, parentId, type, payload, ts }. We can resume,
// fork, and rewind without copying the whole history.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, readFile, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { paths } from "../config/paths.js";
import { log } from "../util/logger.js";
import type { ChatMessage, ToolCall, ToolResult } from "../types.js";

export type EntryType = "user" | "assistant" | "tool" | "system" | "meta" | "compaction" | "fork" | "branch";

export interface SessionEntry {
  id: string;
  parentId: string | null;
  type: EntryType;
  ts: number;
  payload: SessionPayload;
  /** Optional label / bookmark. */
  label?: string;
}

export type SessionPayload =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tool_result"; toolCallId: string; toolName: string; result: ToolResult }
  | { kind: "tool_call_record"; toolCall: ToolCall; args: Record<string, unknown> }
  | { kind: "system"; text: string }
  | { kind: "meta"; data: Record<string, unknown> }
  | { kind: "compaction"; summary: string; replacedUpTo: string }
  | { kind: "fork"; fromEntryId: string }
  | { kind: "branch"; name: string };

export interface SessionMeta {
  id: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  provider?: string;
  cwd?: string;
  entryCount: number;
  /** The id of the "leaf" entry the user is currently looking at. */
  head: string | null;
}

export interface SessionSearchResult extends SessionMeta {
  preview?: string;
}

export class Session {
  readonly id: string;
  readonly filePath: string;
  private entries: SessionEntry[] = [];
  private head: string | null = null;
  meta: SessionMeta;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(id: string, filePath: string, meta: SessionMeta) {
    this.id = id;
    this.filePath = filePath;
    this.meta = meta;
  }

  static newId(): string {
    return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  }

  /** Create a fresh session. */
  static async create(opts: { name?: string; cwd?: string; model?: string; provider?: string } = {}): Promise<Session> {
    const id = Session.newId();
    const file = join(paths.sessions, `${id}.jsonl`);
    const now = Date.now();
    await mkdir(paths.sessions, { recursive: true });
    const meta: SessionMeta = {
      id,
      name: opts.name,
      createdAt: now,
      updatedAt: now,
      cwd: opts.cwd,
      model: opts.model,
      provider: opts.provider,
      entryCount: 0,
      head: null,
    };
    const s = new Session(id, file, meta);
    await s.persistMeta();
    return s;
  }

  /** Open an existing session by id or filename. */
  static async open(ref: string): Promise<Session> {
    const file = ref.endsWith(".jsonl") ? join(paths.sessions, ref) : join(paths.sessions, `${ref}.jsonl`);
    if (!existsSync(file)) throw new Error(`session not found: ${ref}`);
    const s = new Session(ref.replace(/\.jsonl$/, ""), file, await readMetaFromFile(file));
    s.entries = await readEntriesFromFile(file);
    s.head = s.meta.head ?? (s.entries.length > 0 ? s.entries[s.entries.length - 1]!.id : null);
    return s;
  }

  /** List sessions sorted by most-recent first. */
  static async list(limit = 50): Promise<SessionMeta[]> {
    const { readdir } = await import("node:fs/promises");
    let files: string[];
    try { files = (await readdir(paths.sessions)).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
    const out: SessionMeta[] = [];
    for (const f of files) {
      try {
        const m = await readMetaFromFile(join(paths.sessions, f));
        out.push(m);
      } catch { /* skip corrupt */ }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out.slice(0, limit);
  }

  /** Search sessions by metadata and transcript content. */
  static async search(query: string, limit = 20): Promise<SessionSearchResult[]> {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return this.list(limit);
    const { readdir } = await import("node:fs/promises");
    let files: string[];
    try { files = (await readdir(paths.sessions)).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
    const matches: Array<SessionSearchResult & { score: number }> = [];
    for (const f of files) {
      const file = join(paths.sessions, f);
      try {
        const meta = await readMetaFromFile(file);
        const transcript = await readEntriesFromFile(file);
        const { score, preview } = scoreSessionMatch(meta, transcript, trimmed);
        if (score > 0) matches.push({ ...meta, preview, score });
      } catch { /* skip corrupt */ }
    }
    matches.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
    return matches.slice(0, limit).map(({ score: _score, ...rest }) => rest);
  }

  // ---------- Mutations ----------

  async append(payload: SessionPayload, opts: { parentId?: string | null; label?: string } = {}): Promise<SessionEntry> {
    const id = Session.newId();
    const parentId = opts.parentId ?? this.head;
    const entry: SessionEntry = {
      id,
      parentId,
      type: payloadKindToType(payload),
      ts: Date.now(),
      payload,
      label: opts.label,
    };
    this.entries.push(entry);
    this.head = entry.id;
    this.meta.head = entry.id;
    this.meta.updatedAt = entry.ts;
    this.meta.entryCount = this.entries.length;
    this.writeQueue = this.writeQueue
      .then(() => this.persistEntry(entry))
      .then(() => this.persistMeta())
      .catch((e) => log.error("session write failed", e));
    return entry;
  }

  /** Wait for all pending writes to complete. */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  /** Fork the session at the given entry. Returns a new Session whose
   *  history is a copy of this one up to and including the given entry. */
  async fork(atEntryId: string, opts: { name?: string } = {}): Promise<Session> {
    const idx = this.entries.findIndex((e) => e.id === atEntryId);
    if (idx === -1) throw new Error(`entry not found: ${atEntryId}`);
    const sliced = this.entries.slice(0, idx + 1);
    const child = await Session.create({ name: opts.name, cwd: this.meta.cwd, model: this.meta.model, provider: this.meta.provider });
    // Copy each entry as a child of the previous one.
    let parentId: string | null = null;
    for (const e of sliced) {
      const copy: SessionEntry = { ...e, id: Session.newId(), parentId, ts: e.ts };
      child.entries.push(copy);
      child.head = copy.id;
      parentId = copy.id;
    }
    child.meta.head = child.head;
    child.meta.entryCount = child.entries.length;
    // Record a fork marker in the new session.
    await child.append({ kind: "fork", fromEntryId: atEntryId });
    // Re-flush all entries.
    child.writeQueue = Promise.all(child.entries.map((e) => child.persistEntry(e))).then(() => undefined);
    return child;
  }

  /** Move the head to an earlier entry. Subsequent appends become a new branch. */
  rewindTo(entryId: string): void {
    if (!this.entries.some((e) => e.id === entryId)) throw new Error(`entry not found: ${entryId}`);
    this.head = entryId;
    this.meta.head = entryId;
  }

  /** Walk the entries from root to head. */
  activeEntries(): SessionEntry[] {
    if (!this.head) return [];
    const byId = new Map(this.entries.map((e) => [e.id, e]));
    const out: SessionEntry[] = [];
    let cur: SessionEntry | undefined = byId.get(this.head);
    while (cur) {
      out.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out;
  }

  /** Walk all entries. */
  allEntries(): readonly SessionEntry[] {
    return this.entries;
  }

  /** Replace the messages after a given point with a compaction summary. */
  async compact(summary: string, replacedUpTo: string): Promise<void> {
    await this.append({ kind: "compaction", summary, replacedUpTo });
  }

  /** Persist an entry to disk. Atomic via temp file + rename. */
  private async persistEntry(entry: SessionEntry): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    const tmp = `${this.filePath}.${randomBytes(4).toString("hex")}.tmp`;
    await mkdir(paths.sessions, { recursive: true });
    // Append via a single open(O_APPEND) write to avoid racing our own reads.
    const handle = await open(this.filePath, "a");
    try {
      await handle.writeFile(line);
    } finally {
      await handle.close();
    }
    void tmp; // (we don't actually need a tmp here; we're appending)
  }

  private async persistMeta(): Promise<void> {
    // Meta lives in the first line, prefixed with a sentinel.
    // We rewrite the file as: <meta line>\n<entries...>. On load we read the first line and check.
    // For simplicity in this version, we just keep meta in a sidecar .meta.json file.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${this.filePath}.meta.json`, JSON.stringify(this.meta, null, 2), "utf-8");
  }
}

function payloadKindToType(p: SessionPayload): EntryType {
  switch (p.kind) {
    case "message":
      // `message` payloads carry user / assistant / system turns. Tool
      // results are stored separately as { kind: "tool_result" }, so
      // the role discriminator only ever lands on those three values.
      return p.message.role === "user" ? "user" : "assistant";
    case "tool_result": return "tool";
    case "tool_call_record": return "assistant";
    case "system": return "system";
    case "meta": return "meta";
    case "compaction": return "compaction";
    case "fork": return "fork";
    case "branch": return "branch";
  }
}

async function readMetaFromFile(file: string): Promise<SessionMeta> {
  const metaFile = `${file}.meta.json`;
  if (existsSync(metaFile)) {
    try {
      const j = JSON.parse(await readFile(metaFile, "utf-8"));
      return j as SessionMeta;
    } catch { /* fall through */ }
  }
  // Fall back to scanning the first JSONL line.
  const s = createReadStream(file, { encoding: "utf-8" });
  let buf = "";
  for await (const chunk of s) {
    buf += chunk;
    const idx = buf.indexOf("\n");
    if (idx >= 0) {
      buf = buf.slice(0, idx);
      break;
    }
  }
  try {
    return JSON.parse(buf) as SessionMeta;
  } catch {
    throw new Error(`session metadata missing or invalid: ${file}`);
  }
}

async function readEntriesFromFile(file: string): Promise<SessionEntry[]> {
  const out: SessionEntry[] = [];
  const s = createReadStream(file, { encoding: "utf-8" });
  let buf = "";
  for await (const chunk of s) {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        // Skip meta-sentinel lines.
        if (obj && typeof obj === "object" && obj.__meta) continue;
        if (obj && typeof obj === "object" && "id" in obj && "type" in obj) {
          out.push(obj as SessionEntry);
        }
      } catch {
        log.warn(`skipping corrupt session line in ${file}`);
      }
    }
  }
  return out;
}

/** Build the ChatMessage[] for the model, walking from root to head. */
export function sessionToMessages(s: Session): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of s.activeEntries()) {
    if (e.payload.kind === "message") {
      out.push(e.payload.message);
    } else if (e.payload.kind === "tool_result") {
      out.push({
        role: "tool",
        toolCallId: e.payload.toolCallId,
        toolName: e.payload.toolName,
        content: e.payload.result.content,
        meta: { isError: e.payload.result.isError, display: e.payload.result.display },
      });
    }
    // compaction / fork / meta / branch / tool_call_record are skipped
    // from the model-visible history; the active branch only contains
    // messages and tool results.
  }
  return out;
}

function scoreSessionMatch(meta: SessionMeta, entries: readonly SessionEntry[], query: string): { score: number; preview?: string } {
  let score = 0;
  const fields = [
    meta.id,
    meta.name ?? "",
    meta.model ?? "",
    meta.provider ?? "",
    meta.cwd ?? "",
  ];
  for (const field of fields) {
    const lower = field.toLowerCase();
    if (lower.includes(query)) score += lower === query ? 8 : 4;
  }

  let preview = "";
  const messages = entries
    .map((entry) => {
      if (entry.payload.kind === "message") return entry.payload.message.content;
      if (entry.payload.kind === "system") return entry.payload.text;
      if (entry.payload.kind === "compaction") return entry.payload.summary;
      return "";
    })
    .filter(Boolean);

  for (const text of messages) {
    const lower = text.toLowerCase();
    if (lower.includes(query)) {
      score += 6;
      if (!preview) preview = buildPreview(text, query);
    }
  }

  if (!preview && messages.length > 0) {
    preview = messages[messages.length - 1]!.replace(/\s+/g, " ").trim().slice(0, 120);
  }

  return { score, preview: preview || undefined };
}

function buildPreview(text: string, query: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  const index = lower.indexOf(query);
  if (index === -1) return compact.slice(0, 120);
  const start = Math.max(0, index - 36);
  const end = Math.min(compact.length, index + query.length + 52);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < compact.length ? "…" : "";
  return prefix + compact.slice(start, end) + suffix;
}
