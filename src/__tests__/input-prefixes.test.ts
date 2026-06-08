import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expandInputPrefixes } from "../util/input-prefixes.js";

describe("input prefixes (OpenCode-style)", () => {
  test("slash commands pass through unchanged", async () => {
    const out = await expandInputPrefixes("/help", process.cwd());
    assert.equal(out.prompt, "/help");
    assert.equal(out.injectedBlocks.length, 0);
  });

  test("@file injects file contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ch-at-"));
    try {
      const file = join(dir, "note.txt");
      writeFileSync(file, "hello from file", "utf-8");
      const out = await expandInputPrefixes("summarize @note.txt", dir);
      assert.match(out.prompt, /hello from file/);
      assert.match(out.prompt, /attached-file/);
      assert.equal(out.injectedBlocks.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("!shell injects command output", async () => {
    const out = await expandInputPrefixes("!echo shell-prefix-ok", process.cwd());
    assert.match(out.prompt, /shell-prefix-ok/);
    assert.match(out.prompt, /shell-output/);
  });
});