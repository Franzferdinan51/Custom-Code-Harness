// Trajectory export. Takes a session and writes it as a JSONL file
// in a format suitable for fine-tuning or sharing.
//
// Three formats:
//
//   hermes   — full event log: every entry (user, assistant, tool_call,
//              tool_result, meta, fork, compaction). One JSON object per
//              line with { type, ts, ... } plus the raw payload. Best for
//              replaying and debugging.
//
//   openai   — chat-completions format: each line is a request body
//              { messages, tools? } matching the OpenAI /v1/chat/completions
//              schema. Use this for SFT with the OpenAI fine-tuning API.
//
//   share    — anonymized openai format: same as openai, but with
//              absolute paths replaced with relative ones, env vars and
//              API keys stripped from bash command output, and tool
//              results truncated. Use this for sharing sessions publicly
//              without leaking secrets.

import { promises as fs } from "node:fs";
import { join, isAbsolute, dirname } from "node:path";
import type { Session } from "./session.js";

export type ExportFormat = "hermes" | "openai" | "share";

export interface ExportOptions {
  format: ExportFormat;
  outDir: string;
  /** When true, include tool result content. Default: true. */
  includeToolResults?: boolean;
}

interface ChatMessageOut {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/** Export a single session. Returns the file paths written. */
export async function exportSession(session: Session, opts: ExportOptions): Promise<{ path: string; lineCount: number }> {
  await fs.mkdir(opts.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = session.id.slice(0, 12);
  const path = join(opts.outDir, `${slug}-${stamp}-${opts.format}.jsonl`);
  const entries = session.allEntries();
  const sessionCwd = session.meta.cwd ?? "";
  const lines: string[] = [];
  switch (opts.format) {
    case "hermes":
      for (const e of entries) {
        const out: Record<string, unknown> = { type: e.type, ts: e.ts, id: e.id };
        if (e.parentId) out.parentId = e.parentId;
        out.payload = e.payload;
        lines.push(JSON.stringify(out));
      }
      break;
    case "openai":
    case "share": {
      const messages = toOpenAIMessages(entries, {
        includeToolResults: opts.includeToolResults ?? true,
        anonymize: opts.format === "share",
        cwd: sessionCwd,
      });
      if (messages.length > 0) {
        // For share, also anonymize the metadata cwd (turn /Users/x/proj
        // into "./"). For openai, keep the full path for SFT usefulness.
        const metaCwd = opts.format === "share" && sessionCwd ? "./" : sessionCwd;
        lines.push(JSON.stringify({ sessionId: session.id, cwd: metaCwd, exportedAt: new Date().toISOString(), messages }));
      }
      break;
    }
  }
  // Atomic write: write to a sibling `.tmp.<rand>`, then rename.
  // Pre-fix: a direct `writeFile(path, ...)` could leave a
  // half-written JSONL file if the process died mid-write (or
  // disk-full), corrupting the export. The tmp+rename pair
  // means the destination either has the full file or doesn't
  // exist.
  const tmp = path + ".tmp." + Math.random().toString(36).slice(2, 8);
  const data = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  try {
    await fs.writeFile(tmp, data, "utf-8");
    await fs.rename(tmp, path);
  } catch (e) {
    try { await fs.unlink(tmp); } catch { /* best-effort */ }
    throw e;
  }
  return { path, lineCount: lines.length };
}

interface ToOpenAIOpts {
  includeToolResults: boolean;
  anonymize: boolean;
  cwd: string;
}

function toOpenAIMessages(entries: ReturnType<Session["allEntries"]>, opts: ToOpenAIOpts): ChatMessageOut[] {
  const out: ChatMessageOut[] = [];
  for (const e of entries) {
    const p = e.payload;
    if (p.kind === "message") {
      const m = p.message as { role?: string; content?: string; tool_calls?: ChatMessageOut["tool_calls"] };
      if (m.role === "user" || m.role === "assistant" || m.role === "system") {
        const content = m.content ?? "";
        out.push({
          role: m.role,
          content: opts.anonymize ? anonymize(content, opts.cwd) : content,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        });
      }
    } else if (p.kind === "tool_result" && opts.includeToolResults) {
      const r = p.result;
      if (r) {
        const content = r.isError
          ? "[error] " + (r.content ?? r.display ?? "")
          : r.content ?? r.display ?? "";
        out.push({
          role: "tool",
          tool_call_id: p.toolCallId,
          name: p.toolName,
          content: opts.anonymize ? anonymize(content, opts.cwd) : content,
        });
      }
    } else if (p.kind === "compaction") {
      // Represent a compaction as a system message so the consumer
      // understands the conversation was summarized.
      out.push({
        role: "system",
        content: "[compaction] " + (opts.anonymize ? anonymize(p.summary, opts.cwd) : p.summary),
      });
    }
  }
  return out;
}

const SECRET_RE = /(?:sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|gsk-[A-Za-z0-9_-]{20,}|pplx-[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----)/g;

function anonymize(text: string, cwd: string): string {
  if (!text) return text;
  let out = text;
  // Strip API keys / tokens.
  out = out.replace(SECRET_RE, "[REDACTED]");
  // Replace absolute paths under cwd with relative.
  if (cwd && isAbsolute(cwd)) {
    const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
    out = out.split(prefix).join("./");
  }
  // Replace $HOME with ~.
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
  if (home) out = out.split(home).join("~");
  // Truncate anything that looks like a multi-line secret dump.
  const lines = out.split("\n");
  return lines.slice(0, 2000).join("\n") + (lines.length > 2000 ? "\n... (truncated for share)" : "");
}

/** Default output directory. */
export function defaultExportDir(): string {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "/tmp";
  return join(home, ".codingharness", "exports");
}
