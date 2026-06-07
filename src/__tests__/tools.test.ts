// Tests for individual tools. We exercise the validate() and run()
// functions with a real temp directory so we know the file ops
// actually work and the atomic rename doesn't corrupt anything.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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
  const r = await lsTool.run({ path: tmp }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.content, /f1\.ts/);
});

test("lsTool: rejects negative max_entries", () => {
  assert.throws(() => lsTool.validate({ max_entries: -1 }));
});

test("ALL OK", () => {
  // Marker
  rmSync(tmp, { recursive: true, force: true });
});
