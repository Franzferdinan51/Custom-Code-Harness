// Tests for slash command parsing and the registry.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { BUILTIN_REGISTRY } from "../slash/builtin.js";
import { tryParseSlash } from "../slash/registry.js";

test("tryParseSlash parses a basic command", () => {
  const r = tryParseSlash("/model gpt-5");
  assert.equal(r?.name, "model");
  assert.equal(r?.args, "gpt-5");
});

test("tryParseSlash handles args with multiple spaces", () => {
  const r = tryParseSlash("/goal   add a /healthcheck   --max-steps=5");
  assert.equal(r?.name, "goal");
  assert.equal(r?.args, "add a /healthcheck   --max-steps=5");
});

test("tryParseSlash returns null for non-slash input", () => {
  assert.equal(tryParseSlash("hello world"), null);
  assert.equal(tryParseSlash(""), null);
  // Leading whitespace is trimmed, so this is still parsed.
  assert.equal(tryParseSlash("  /model x")?.name, "model");
});

test("builtin registry has all expected commands", () => {
  const names = BUILTIN_REGISTRY.names();
  for (const want of ["help", "clear", "quit", "session", "resume", "model", "provider", "goal", "loop"]) {
    assert.ok(names.includes(want), "missing /" + want);
  }
});

test("/help renders a list of commands", async () => {
  const help = BUILTIN_REGISTRY.get("help");
  assert.ok(help);
  const out = await help!.run("", { cwd: "/" });
  assert.ok(typeof out === "string");
  assert.match(out!, /\/help/);
  assert.match(out!, /\/goal/);
  assert.match(out!, /\/loop/);
});
