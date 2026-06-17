// scripts/bench-repl-pain.mts — D-INK-pre spike measurement harness
//
// Run with:  npx tsx scripts/bench-repl-pain.mts
//
// What this measures:
//   1. 9-voice council transcript: how many lines / bytes would the
//      current `repl-v2.ts` flush to scrollback when a full consensus
//      council deliberation completes?
//   2. /tree slash command on a 200-node session: how big is the
//      framed block, and how long to render?
//   3. 50-msg / 100k-token compaction preview: bytes flushed, render
//      time.
//   4. repl-v2.ts render helpers micro-bench: time to render a typical
//      turn (header + footer + tool call + assistant line + thinking
//      block), averaged over 10k turns.
//
// Output:
//   - JSON to stdout (single object with `scenarios` and `summary`)
//   - Human-readable summary printed to stderr so a CI run can grep
//     for `RESULT:` lines without parsing JSON.
//
// Design:
//   - All scenarios use the actual `repl-v2.ts` render helpers. No
//     mock renderers — we want to measure the real thing.
//   - `CODINGHARNESS_COLOR=always` is forced so ANSI bytes are counted.
//     The shipped REPL uses ANSI on a TTY (the default for `ch`).
//   - Data shapes are taken from the real code paths
//     (`CouncilResult`, `SessionEntry[]`, `ChatMessage[]`) so the
//     numbers reflect what would happen in production.

import { performance } from "node:perf_hooks";

// Force ANSI on so the byte counts match what a TTY user sees.
process.env.CODINGHARNESS_COLOR = "always";

import {
  renderHeader,
  renderFooter,
  renderUserLine,
  renderAssistantLine,
  renderThinkingBlock,
  renderPlanBlock,
  renderToolCall,
  renderInfoLine,
  renderFramedBlock,
  type ReplV2Status,
  type ReplV2TranscriptEntry,
} from "../src/ui/repl-v2.js";

// ---------- Tiny helpers ----------

function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

function time<T>(fn: () => T): { ms: number; result: T } {
  const start = performance.now();
  const result = fn();
  return { ms: performance.now() - start, result };
}

function repeat<T>(n: number, fn: (i: number) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(fn(i));
  return out;
}

function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + " ".repeat(w - str.length);
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return ((n / d) * 100).toFixed(1) + "%";
}

// ---------- Seeded RNG (mulberry32) for reproducibility ----------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260617);

function pick<T>(arr: ReadonlyArray<T>): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function lorem(words: number): string {
  const vocab = (
    "the quick brown fox jumps over the lazy dog " +
    "while pondering whether zero-dependency is a feature or " +
    "an excuse and whether the council should ever have run " +
    "nine voices when four were sufficient and yet " +
    "performance really does depend on memory layout and " +
    "we measured this with a stopwatch so we know it is real " +
    "scrollback content reflects the model output verbatim " +
    "and the synthesizer leans on higher weight voices more"
  ).split(/\s+/);
  return repeat(words, () => pick(vocab)).join(" ");
}

// ---------- Scenario 1: 9-voice council transcript ----------
//
// Replicates what `renderCouncilResult()` produces when 8 councilors
// + 1 synthesizer complete a consensus deliberation. The REPL would
// currently flush this as a `framedBlock` because it's >80 chars AND
// multi-line (see repl-v2.ts:565).

interface CouncilTranscriptEntry {
  round: number;
  role: string;
  content: string;
  usage: { inputTokens: number; outputTokens: number };
}

const COUNCIL_ROLES = [
  "skeptic", "builder", "researcher", "security",
  "performance", "dx", "qa", "domain",
];

function makeCouncilTranscript(): CouncilTranscriptEntry[] {
  const entries: CouncilTranscriptEntry[] = [];
  for (const role of COUNCIL_ROLES) {
    entries.push({
      round: 1,
      role,
      // Real council replies are usually 200-500 words.
      content: lorem(200 + Math.floor(rng() * 300)),
      usage: { inputTokens: 1500 + Math.floor(rng() * 1500), outputTokens: 300 + Math.floor(rng() * 400) },
    });
  }
  // Synthesizer (the special last entry)
  entries.push({
    round: 1,
    role: "synthesizer",
    content: lorem(400 + Math.floor(rng() * 200)),
    usage: { inputTokens: 8000 + Math.floor(rng() * 4000), outputTokens: 600 + Math.floor(rng() * 300) },
  });
  return entries;
}

function renderCouncilAsTranscript(entries: CouncilTranscriptEntry[]): string {
  // Replicates the dispatch path in repl-v2.ts:565 — multi-line
  // output > 80 chars → pushEntry({ kind: "system", text }) +
  // renderFramedBlock.
  const body = entries
    .map((e) => "── " + e.role + " (round " + e.round + ") " + "─".repeat(50) + "\n" + e.content)
    .join("\n\n");
  const header = "[council: consensus · " + entries.length + " voices]";
  return renderFramedBlock(header, body);
}

function benchCouncil(): ScenarioResult {
  const entries = makeCouncilTranscript();
  const t = time(() => renderCouncilAsTranscript(entries));
  const out = t.result;
  const lines = countLines(out);
  const bytes = byteLen(out);
  const totalTokensIn = entries.reduce((n, e) => n + e.usage.inputTokens, 0);
  const totalTokensOut = entries.reduce((n, e) => n + e.usage.outputTokens, 0);
  return {
    name: "9-voice council transcript (consensus, 1 round)",
    renderMs: round(t.ms, 3),
    lines,
    bytes,
    bytesPerLine: round(bytes / lines, 1),
    notes: [
      `9 voices, ${totalTokensIn.toLocaleString()} input + ${totalTokensOut.toLocaleString()} output tokens`,
      `would render as ONE framed block (repl-v2.ts:565 dispatches >80 char multi-line output to renderFramedBlock)`,
      `once flushed, ${lines} lines permanently in scrollback — no way to collapse / fold`,
      "user has to scroll past the entire block to see the next prompt",
    ],
  };
}

// ---------- Scenario 2: /tree on a 200-node session ----------

interface SessionEntryLite {
  id: string;
  parentId: string | null;
  ts: number;
  type: string;
  payload: { kind: string; [k: string]: unknown };
}

function makeSessionTree(n: number): { entries: SessionEntryLite[]; headId: string } {
  // 200 nodes, mostly linear (the realistic shape: a long conversation
  // with occasional branches). Branch factor = 0.05 so we get ~10 forks.
  const entries: SessionEntryLite[] = [];
  const start = Date.now() - 1000 * 60 * 60;
  let lastId: string | null = null;
  for (let i = 0; i < n; i++) {
    const id = "n" + i.toString().padStart(4, "0");
    const type = pick(["user", "assistant", "tool_result", "compaction", "system"]);
    const payload =
      type === "message"
        ? { kind: "message", message: { content: lorem(40) } }
        : type === "tool_result"
        ? { kind: "tool_result", toolName: pick(["bash", "read", "edit", "grep"]), result: { display: lorem(15), isError: false } }
        : type === "compaction"
        ? { kind: "compaction", summary: lorem(80) }
        : { kind: "system", text: "system message: " + lorem(8) };
    // Occasional branch: 5% of nodes have a parent that's NOT the most
    // recent entry. We re-parent to a node 3-7 back.
    let parentId: string | null = lastId;
    if (i > 10 && rng() < 0.05 && entries.length > 5) {
      const back = 3 + Math.floor(rng() * 4);
      parentId = entries[entries.length - back]!.id;
    }
    entries.push({
      id,
      parentId,
      ts: start + i * 1000 * 30,
      type,
      payload,
    });
    lastId = id;
  }
  return { entries, headId: entries[entries.length - 1]!.id };
}

function benchTree(): ScenarioResult {
  const { entries, headId } = makeSessionTree(200);
  // Inline a minimal tree renderer so we don't pull in session.ts
  // types at the bench layer. Mirrors src/slash/tree-render.ts.
  const t = time(() => {
    const byParent = new Map<string | null, SessionEntryLite[]>();
    for (const e of entries) {
      const arr = byParent.get(e.parentId) ?? [];
      arr.push(e);
      byParent.set(e.parentId, arr);
    }
    const activePath = new Set<string>();
    let cur: string | null = headId;
    while (cur) {
      activePath.add(cur);
      cur = entries.find((e) => e.id === cur)?.parentId ?? null;
    }
    for (const arr of byParent.values()) arr.sort((a, b) => a.ts - b.ts);
    const lines: string[] = [];
    const shortLabel = (e: SessionEntryLite): string => {
      const p = e.payload;
      let body = "";
      switch (p.kind) {
        case "message": body = ((p.message as { content?: string }).content ?? "").slice(0, 60); break;
        case "tool_result": body = "✓ " + ((p.result as { display?: string }).display ?? p.toolName); break;
        case "compaction": body = "[compaction] " + ((p.summary as string) ?? "").slice(0, 50); break;
        default: body = e.type;
      }
      return body.replace(/\n/g, " ");
    };
    const walk = (node: SessionEntryLite, prefix: string, isLast: boolean): void => {
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
        walk(child, prefix + (isLast ? "   " : "│  "), i === children.length - 1);
      }
    };
    const roots = byParent.get(null) ?? [];
    for (let i = 0; i < roots.length; i++) walk(roots[i]!, "", i === roots.length - 1);
    return renderFramedBlock("/tree", lines.join("\n"));
  });
  const out = t.result;
  return {
    name: "/tree on 200-node session (≈5% branch factor)",
    renderMs: round(t.ms, 3),
    lines: countLines(out),
    bytes: byteLen(out),
    bytesPerLine: round(byteLen(out) / countLines(out), 1),
    notes: [
      "would render as ONE framed block — entire tree in scrollback",
      "no fold/collapse — user can't hide completed branches",
      "if user runs /tree twice (e.g. compare head before/after a fork) the old tree is still in scrollback",
    ],
  };
}

// ---------- Scenario 3: 50-msg / 100k-token compaction preview ----------

interface ChatMessageLite { role: "user" | "assistant" | "tool" | "system"; content: string; }

function makeLongSession(n: number, targetTokens: number): ChatMessageLite[] {
  // Aim for ~targetTokens total. ~4 chars/token. Each msg ~targetTokens/n
  // tokens. Mix of roles, but mostly assistant (long replies) + user
  // (short prompts) + tool (varied).
  const out: ChatMessageLite[] = [];
  const perMsgChars = Math.floor((targetTokens * 4) / n);
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    out.push({ role, content: lorem(Math.max(20, Math.floor(perMsgChars / 6))) });
  }
  return out;
}

function benchCompaction(): ScenarioResult {
  const messages = makeLongSession(50, 100_000);
  // Format mirrors formatCompactionPreview's shape — the REPL would
  // ship the formatted preview via a slash command, and `compaction`
  // entries appear in the tree (which is already covered in scenario 2).
  const t = time(() => {
    const lines: string[] = [];
    lines.push("Compaction preview: 50 messages · ~100k tokens");
    lines.push("");
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      const idx = String(i).padStart(3);
      const role = m.role.padEnd(9);
      const snippet = m.content.slice(0, 80).replace(/\s+/g, " ").trim();
      lines.push(`  ${idx}  ${role}  ${snippet}`);
    }
    return renderFramedBlock("/compact --preview", lines.join("\n"));
  });
  const out = t.result;
  return {
    name: "compaction preview (50 messages, ~100k tokens)",
    renderMs: round(t.ms, 3),
    lines: countLines(out),
    bytes: byteLen(out),
    bytesPerLine: round(byteLen(out) / countLines(out), 1),
    notes: [
      "100k tokens → 50 entries × ~80 char snippet + framing ≈ 4 KB / 56 lines",
      "if user runs /compact --preview THEN confirms, the preview AND the confirmation are both in scrollback",
      "compaction summary itself is a separate transcript entry → 2nd large block in scrollback",
    ],
  };
}

// ---------- Scenario 4: repl-v2 render helpers micro-bench ----------

function benchReplHelpers(): ScenarioResult {
  const status: ReplV2Status = {
    model: "opus-4.5",
    provider: "anthropic",
    session: "7f2a91c4",
    cwd: "/Users/duckets/Desktop/CodingHarness",
    tokensIn: 12_345,
    tokensOut: 4_321,
    steps: 6,
    lastTurnMs: 12_500,
  };

  // One "typical turn" flush = header + user + thinking + plan +
  // assistant + 3 tool calls + footer redraw.
  const ITER = 10_000;
  const t = time(() => {
    let buf = "";
    for (let i = 0; i < ITER; i++) {
      buf += renderHeader(status) + "\n";
      buf += renderUserLine("refactor the council to use a goal loop") + "\n";
      buf += renderThinkingBlock(lorem(80)) + "\n";
      buf += renderPlanBlock("1. read src/agent/council.ts\n2. split into council + goal-loop adapter\n3. tests") + "\n";
      buf += renderAssistantLine(lorem(40)) + "\n";
      buf += renderToolCall("bash", '{"cmd":"ls -la src/agent"}', "ok", lorem(20)) + "\n";
      buf += renderToolCall("read", '{"path":"src/agent/council.ts"}', "ok", lorem(20)) + "\n";
      buf += renderToolCall("edit", '{"path":"src/agent/council.ts"}', "ok", lorem(20)) + "\n";
      buf += renderFooter(status) + "\n";
    }
    return buf;
  });
  const buf = t.result;
  const totalLines = countLines(buf);
  const totalBytes = byteLen(buf);
  const perTurnMs = t.ms / ITER;
  return {
    name: "repl-v2.ts render path (10k typical turns)",
    renderMs: round(t.ms, 1),
    lines: totalLines,
    bytes: totalBytes,
    bytesPerLine: round(totalBytes / totalLines, 1),
    notes: [
      `${ITER.toLocaleString()} iterations × ~9 render calls each = ${(ITER * 9).toLocaleString()} helper calls`,
      `${perTurnMs.toFixed(4)} ms per typical turn (header + user + thinking + plan + assistant + 3 tool calls + footer)`,
      "perf is NOT the pain point — current helper path is fast",
      "the actual gap: helper returns a string, REPL has no way to fold/collapse/replace an already-flushed entry — once a long block is in scrollback, it's permanent",
    ],
  };
}

// ---------- Aggregate ----------

interface ScenarioResult {
  name: string;
  renderMs: number;
  lines: number;
  bytes: number;
  bytesPerLine: number;
  notes: string[];
}

function round(n: number, d: number): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function main(): void {
  const scenarios: ScenarioResult[] = [
    benchCouncil(),
    benchTree(),
    benchCompaction(),
    benchReplHelpers(),
  ];

  const totalBytes = scenarios.reduce((n, s) => n + s.bytes, 0);
  const totalLines = scenarios.reduce((n, s) => n + s.lines, 0);

  // Print human-readable table to stderr.
  const summary = {
    scenarios,
    summary: {
      totalScenarios: scenarios.length,
      totalLines,
      totalBytes,
      totalRenderMs: round(scenarios.reduce((n, s) => n + s.renderMs, 0), 2),
      notes: [
        "Numbers above use CODINGHARNESS_COLOR=always (ANSI escapes counted).",
        "All bytes are UTF-8; no terminal-control sequences beyond color codes.",
        "Render time is wall-clock on the bench host (no LLM involved — the REPL render path is pure string work).",
      ],
    },
  };

  // Stdout: full JSON
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  // Stderr: human summary
  process.stderr.write("\n--- D-INK-pre spike: REPL scrollback pain ---\n\n");
  for (const s of scenarios) {
    process.stderr.write("[" + s.name + "]\n");
    process.stderr.write("  renderMs:  " + s.renderMs + "\n");
    process.stderr.write("  lines:     " + s.lines.toLocaleString() + "\n");
    process.stderr.write("  bytes:     " + s.bytes.toLocaleString() + "  (" + (s.bytes / 1024).toFixed(1) + " KB)\n");
    process.stderr.write("  bytes/line: " + s.bytesPerLine + "\n");
    for (const n of s.notes) process.stderr.write("  · " + n + "\n");
    process.stderr.write("\n");
  }
  process.stderr.write("RESULT: total_lines=" + totalLines.toLocaleString() + "  total_bytes=" + totalBytes.toLocaleString() + "  (" + (totalBytes / 1024).toFixed(1) + " KB)\n");
  process.stderr.write("RESULT: total_render_ms=" + round(scenarios.reduce((n, s) => n + s.renderMs, 0), 2) + "\n");
}

main();
