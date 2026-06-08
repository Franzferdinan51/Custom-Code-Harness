// Render a session as an ASCII tree. The current head is marked
// with ●, the linear tail with "→". Tool calls are abbreviated.
// The active path (from head back to root) is marked with these
// markers; inactive branches are still shown but without them.

import type { SessionEntry } from "../agent/session.js";

export function renderSessionTree(entries: ReadonlyArray<SessionEntry>, headId: string): string {
  if (entries.length === 0) return "(empty)";
  // Build a parentId → children index.
  const byParent = new Map<string | null, SessionEntry[]>();
  for (const e of entries) {
    const arr = byParent.get(e.parentId) ?? [];
    arr.push(e);
    byParent.set(e.parentId, arr);
  }
  // Find the root (parentId is null).
  const roots = byParent.get(null) ?? [];
  if (roots.length === 0) return "(no root — corrupted session?)";

  // Walk from the head backward to the root to find the active branch.
  const headEntry = entries.find((e) => e.id === headId);
  const activePath = new Set<string>();
  if (headEntry) {
    let cur: string | null = headEntry.id;
    while (cur) {
      activePath.add(cur);
      const e = entries.find((x) => x.id === cur);
      cur = e?.parentId ?? null;
    }
  }

  // Sort children by insertion order — entries.append() guarantees
  // chronological order, so this gives a stable left-to-right.
  for (const arr of byParent.values()) arr.sort((a, b) => a.ts - b.ts);

  const lines: string[] = [];
  function shortLabel(e: SessionEntry): string {
    const p = e.payload;
    let body = "";
    switch (p.kind) {
      case "message": {
        const m = p.message as { content?: string };
        const c = m.content ?? "";
        body = c.length > 60 ? c.slice(0, 57) + "…" : c;
        break;
      }
      case "tool_result": {
        body = (p.result.isError ? "✗ " : "✓ ") + (p.result.display ?? p.toolName);
        break;
      }
      case "compaction":
        body = "[compaction] " + (p.summary?.slice(0, 50) ?? "");
        break;
      case "fork":
        body = "[fork ← " + p.fromEntryId + "]";
        break;
      case "branch":
        body = "[branch: " + p.name + "]";
        break;
      case "system":
        body = p.text;
        break;
      case "meta":
      case "tool_call_record":
      default:
        body = e.type;
    }
    return body.replace(/\n/g, " ");
  }

  function walk(node: SessionEntry, prefix: string, isLast: boolean): void {
    const isActive = activePath.has(node.id);
    const isHead = node.id === headId;
    const marker = isActive ? (isHead ? "● " : "→ ") : "  ";
    const label = shortLabel(node);
    const ts = new Date(node.ts).toISOString().slice(11, 19);
    const idShort = node.id.slice(0, 6);
    lines.push(prefix + (isLast ? "└─ " : "├─ ") + marker + idShort + "  " + ts + "  " + node.type.padEnd(11) + "  " + label);

    const children = byParent.get(node.id) ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const childPrefix = prefix + (isLast ? "   " : "│  ");
      walk(child, childPrefix, i === children.length - 1);
    }
  }

  for (let i = 0; i < roots.length; i++) {
    walk(roots[i]!, "", i === roots.length - 1);
  }
  return lines.join("\n");
}
