// Tests for individual tools. We exercise the validate() and run()
// functions with a real temp directory so we know the file ops
// actually work and the atomic rename doesn't corrupt anything.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "../agent/tools/read.js";
import { writeTool } from "../agent/tools/write.js";
import { editTool } from "../agent/tools/edit.js";
import { grepTool } from "../agent/tools/grep.js";
import { findTool } from "../agent/tools/find.js";
import { lsTool } from "../agent/tools/ls.js";
import type { ToolContext } from "../agent/tools/registry.js";

const tmp = mkdtempSync(join(tmpdir(), "ch-tools-"));
const ctx: ToolContext = {
  cwd: tmp,
  signal: new AbortController().signal,
  limits: { bashTimeoutMs: 1, readMaxBytes: 1_000_000 },
  log: () => {},
};

test("writeTool: creates a file", async () => {
  const r = await writeTool.run({ path: "a.txt", content: "hello" }, ctx);
  assert.equal(r.isError, false);
  assert.ok(existsSync(join(tmp, "a.txt")));
  assert.equal(readFileSync(join(tmp, "a.txt"), "utf-8"), "hello");
});

test("writeTool: atomic (no .tmp left behind)", async () => {
  await writeTool.run({ path: "b.txt", content: "world" }, ctx);
  const files = (await import("node:fs/promises")).readdir(tmp);
  const list = (await files).filter((f) => f.endsWith(".tmp"));
  assert.equal(list.length, 0, "no .tmp files should remain");
});

test("writeTool: cleans up the tmp file when the rename step fails", async () => {
  // Force a rename failure: pre-create the destination as a
  // DIRECTORY (rename onto a non-empty dir fails on POSIX). The
  // tool should report the error AND unlink its `<path>.<rand>.tmp`
  // orphan instead of leaving it next to the target.
  const dir = join(tmp, "isdir");
  mkdirSync(dir, { recursive: true });
  const r = await writeTool.run({ path: "isdir", content: "hello" }, ctx);
  assert.equal(r.isError, true, "rename onto a directory must fail");
  // No .tmp should remain in the working dir.
  const fs = await import("node:fs/promises");
  const siblings = (await fs.readdir(tmp)).filter((f) => f.endsWith(".tmp"));
  assert.equal(siblings.length, 0, "no orphan .tmp should remain after a failed rename");
});

test("editTool: replaces a unique block", async () => {
  writeFileSync(join(tmp, "c.txt"), "alpha\nbeta\ngamma\n");
  const r = await editTool.run({ path: "c.txt", old: "beta", new: "BETA" }, ctx);
  assert.equal(r.isError, false);
  assert.equal(readFileSync(join(tmp, "c.txt"), "utf-8"), "alpha\nBETA\ngamma\n");
});

test("editTool: refuses on non-unique old text", async () => {
  writeFileSync(join(tmp, "d.txt"), "x x x");
  const r = await editTool.run({ path: "d.txt", old: "x", new: "y" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /appears 3 times/);
});

test("editTool: replace_globally replaces all", async () => {
  writeFileSync(join(tmp, "e.txt"), "x x x");
  const r = await editTool.run({ path: "e.txt", old: "x", new: "y", replace_globally: true }, ctx);
  assert.equal(r.isError, false);
  assert.equal(readFileSync(join(tmp, "e.txt"), "utf-8"), "y y y");
});

test("readTool: returns file content", async () => {
  writeFileSync(join(tmp, "r.txt"), "line1\nline2\nline3\n");
  const r = await readTool.run({ path: "r.txt" }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.content, /line2/);
});

test("readTool: rejects non-string path", () => {
  assert.throws(() => readTool.validate({ path: 42 }));
});

test("readTool: offset+limit slices from the ORIGINAL file (regression for offset-on-truncated-body bug)", async () => {
  // Pre-fix bug: the slice was applied to the truncated body, so
  // `offset=3000, limit=5` on a 1MB file would render an EMPTY
  // slice (the truncated body only had ~644 lines) and the
  // header would say "lines 3000-644 of 644:" — nonsense. Worse,
  // the user can't see that the slice was out of bounds.
  // Post-fix: slice first from the full text, then truncate the
  // result as a last-resort byte cap. The line numbers always
  // match the original file and the slice always has the
  // requested number of lines.
  //
  // Each line is ~200 chars (label + 150 'x' chars) so 5000
  // lines ≈ 1 MB, well above the 200_000-byte readMaxBytes
  // default in `ctx`. The first ~1000 lines fit in the cap; the
  // pre-fix code's `lines.split("\n")` saw only those ~1000.
  const lines = Array.from({ length: 5000 }, (_, i) => "line-" + (i + 1).toString().padStart(6, "0") + "-x".repeat(150));
  const big = lines.join("\n") + "\n";
  writeFileSync(join(tmp, "big.txt"), big);
  const r = await readTool.run({ path: "big.txt", offset: 3000, limit: 5 }, ctx);
  assert.equal(r.isError, false);
  // Header must report the ORIGINAL total line count.
  assert.match(r.content, /lines 3000-3004 of 5001:/);
  // All 5 requested lines must be present (pre-fix returned empty).
  for (const n of [3000, 3001, 3002, 3003, 3004]) {
    assert.match(r.content, new RegExp("^\\s+" + n + "  line-" + String(n).padStart(6, "0") + "-x", "m"));
  }
  // Lines from the first 1000 must NOT appear (they would if
  // we'd truncated first and then sliced from the truncated body).
  assert.doesNotMatch(r.content, /\bline-000001-x/);
  assert.doesNotMatch(r.content, /\bline-000500-x/);
  assert.doesNotMatch(r.content, /\bline-001000-x/);
});

test("readTool: small file + offset/limit still labels lines correctly", async () => {
  writeFileSync(join(tmp, "small.txt"), "a\nb\nc\nd\ne\n");
  const r = await readTool.run({ path: "small.txt", offset: 2, limit: 2 }, ctx);
  assert.equal(r.isError, false);
  // 5 content lines + 1 empty trailing line = 6 split entries.
  assert.match(r.content, /lines 2-3 of 6:/);
  assert.match(r.content, /^\s+2  b$/m);
  assert.match(r.content, /^\s+3  c$/m);
  assert.doesNotMatch(r.content, /a$/m);
});

test("readTool: past-the-end offset returns a clear 'no more lines' header, not a confusing 'lines N-M of K' where N > K", async () => {
  // Pre-fix: requesting offset=5000 on a 5-line file produced
  // "lines 5000-5004 of 6:" with an empty body — the user has to
  // puzzle out why. The fix detects the past-the-end case and
  // emits a clear "(offset N is past the end of the file (K lines))"
  // header instead.
  writeFileSync(join(tmp, "tiny.txt"), "a\nb\nc\nd\ne\n");
  const r = await readTool.run({ path: "tiny.txt", offset: 5000, limit: 5 }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.content, /offset 5000 is past the end of the file/);
  assert.doesNotMatch(r.content, /lines 5000-/);
});

test("readTool: full file (no offset/limit) still gets truncated by readMaxBytes", async () => {
  const big = "x".repeat(2000);
  writeFileSync(join(tmp, "huge.txt"), big);
  const smallCtx = { ...ctx, limits: { ...ctx.limits, readMaxBytes: 100 } };
  const r = await readTool.run({ path: "huge.txt" }, smallCtx);
  assert.equal(r.isError, false);
  assert.match(r.content, /\(truncated at 100 bytes/);
  // The body should be capped at ~100 chars + the truncation suffix.
  assert.ok(r.content.length < 500, "truncated body should be small");
});

test("grepTool: finds matches", async () => {
  writeFileSync(join(tmp, "g.ts"), "const x = 1;\nconst y = 2;\n");
  writeFileSync(join(tmp, "g.js"), "var z = 3;\n");
  const r = await grepTool.run({ pattern: "^const", path: tmp }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.content, /const x/);
});

test("findTool: lists files by name", async () => {
  writeFileSync(join(tmp, "f1.ts"), "");
  writeFileSync(join(tmp, "f2.txt"), "");
  const r = await findTool.run({ pattern: "*.ts", path: tmp }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.content, /f1\.ts/);
  assert.doesNotMatch(r.content, /f2\.txt/);
});

test("lsTool: lists directory", async () => {
  // Self-contained: create the file the test will look for. The
  // previous test (findTool) happened to also create f1.ts and
  // the test relied on order; with my ls parallelization the
  // render order may shift (sizes now come from Promise.all
  // completion order) and the test started looking for f1.ts
  // before that file was guaranteed to exist in isolation.
  writeFileSync(join(tmp, "ls-target.ts"), "");
  const r = await lsTool.run({ path: tmp }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.content, /ls-target\.ts/);
});

test("lsTool: handles max_entries=undefined (raw call, no validate pass) — regression for NaN-slice bug", async () => {
  // Pre-fix: ls's parallel-stat refactor did
  // `filtered.slice(0, raw.max_entries + 1)`. When the caller
  // bypasses `validate()` (e.g. a test or a future direct
  // caller), `raw.max_entries` is undefined and the slice
  // becomes `slice(0, NaN) = []`, returning "(empty)" on a
  // 1-entry dir. The fix uses `raw.max_entries ?? MAX_ENTRIES`
  // so the default cap still applies.
  writeFileSync(join(tmp, "no-max-entry.ts"), "");
  const r = await lsTool.run({ path: tmp }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.content, /no-max-entry\.ts/);
  assert.doesNotMatch(r.content, /\(empty\)/);
});

test("lsTool: rejects negative max_entries", () => {
  assert.throws(() => lsTool.validate({ max_entries: -1 }));
});

test("ALL OK", () => {
  // Marker
  rmSync(tmp, { recursive: true, force: true });
});
