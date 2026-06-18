// Render a session as an ASCII tree. The current head is marked
// with ●, the linear tail with "→". Tool calls are abbreviated.
// The active path (from head back to root) is marked with these
// markers; inactive branches are still shown but without them.
//
// Two optional knobs tame large trees (per `docs/ink-spike.md`,
// scenario 2 — `/tree` on a 200-node session renders 202 lines
// / 68.2 KB, the worst case in the REPL):
//
//   - `opts.depth` — cap the tree depth from the root
//     (root = depth 0). When a node would recurse past the cap,
//     we emit a leaf-line with `(… N more below)` and stop.
//   - `opts.limit` — cap the total number of rendered lines.
//     When the cap is hit, we append a single
//     `(truncated at N; use --depth=K or --limit=K)` footer and
//     stop the walk.

import type { SessionEntry } from "../agent/session.js";

export interface RenderTreeOpts {
  /** Max depth from the root (root = 0). Undefined = unlimited. */
  depth?: number;
  /** Max number of lines to emit. Undefined = unlimited. */
  limit?: number;
}

export function renderSessionTree(entries: ReadonlyArray<SessionEntry>, headId: string, opts: RenderTreeOpts = {}): string {
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

  function walk(node: SessionEntry, prefix: string, isLast: boolean, depth: number): void {
    if (limitReached) return;
    const isActive = activePath.has(node.id);
    const isHead = node.id === headId;
    const marker = isActive ? (isHead ? "● " : "→ ") : "  ";
    const label = shortLabel(node);
    const ts = new Date(node.ts).toISOString().slice(11, 19);
    const idShort = node.id.slice(0, 6);
    lines.push(prefix + (isLast ? "└─ " : "├─ ") + marker + idShort + "  " + ts + "  " + node.type.padEnd(11) + "  " + label);
    if (limit !== undefined && lines.length >= limit) {
      limitReached = true;
      return;
    }

    const children = byParent.get(node.id) ?? [];
    if (children.length === 0) return;
    // Depth cap reached — render a single "(… N more)" leaf line
    // so the user can tell the tree was truncated (and by how much).
    if (opts.depth !== undefined && depth >= opts.depth) {
      const below = countDescendants(node.id);
      if (below > 0) {
        lines.push(prefix + (isLast ? "   " : "│  ") + "    " + "(…" + below + " more below — pass --depth=" + (opts.depth + 1) + " to expand)");
        if (limit !== undefined && lines.length >= limit) {
          limitReached = true;
          return;
        }
      }
      return;
    }
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const childPrefix = prefix + (isLast ? "   " : "│  ");
      walk(child, childPrefix, i === children.length - 1, depth + 1);
      if (limitReached) return;
    }
  }

  // Count the total descendants of a node so the "(… N more)" leaf
  // can report a stable total. BFS over the byParent index; O(n)
  // per call but only invoked when `depth` is hit, which is at
  // most one extra pass over the tree.
  function countDescendants(rootId: string): number {
    let n = 0;
    const stack: string[] = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const kids = byParent.get(id) ?? [];
      for (const k of kids) {
        n += 1;
        stack.push(k.id);
      }
    }
    return n;
  }

  const limit = opts.limit;
  let limitReached = false;
  for (let i = 0; i < roots.length; i++) {
    walk(roots[i]!, "", i === roots.length - 1, 0);
    if (limitReached) break;
  }
  if (limitReached) {
    lines.push("(truncated at " + limit + " lines — pass --depth=K or --limit=K to expand)");
  }
  return lines.join("\n");
}
