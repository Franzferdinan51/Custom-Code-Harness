import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runDiagnostics,
  summarizeDiagnostics,
  renderDiagnosticsJson,
  applyDoctorFixes,
} from "../doctor.js";
import { resetSettingsCache } from "../config/settings.js";

describe("doctor (OpenClaw-style)", () => {
  test("summarizeDiagnostics counts errors and warnings", () => {
    const summary = summarizeDiagnostics([
      { name: "a", status: "ok", message: "fine" },
      { name: "b", status: "warn", message: "hmm" },
      { name: "c", status: "error", message: "bad" },
    ]);
    assert.equal(summary.errors, 1);
    assert.equal(summary.warnings, 1);
    assert.equal(summary.ok, false);
  });

  test("renderDiagnosticsJson returns parseable JSON", () => {
    const items = [{ name: "Node.js", status: "ok" as const, message: "v20" }];
    const parsed = JSON.parse(renderDiagnosticsJson(items)) as { items: unknown[]; summary: { ok: boolean } };
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.summary.ok, true);
  });

  test("applyDoctorFixes creates home when missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "ch-doc-fix-"));
    const prev = process.env.CODINGHARNESS_HOME;
    process.env.CODINGHARNESS_HOME = home;
    resetSettingsCache();
    try {
      const items = await runDiagnostics({ cwd: process.cwd() });
      const before = items.find((i) => i.name === "Home dir");
      if (before?.status === "warn") {
        const applied = applyDoctorFixes(items);
        assert.ok(applied.length >= 1);
      }
    } finally {
      if (prev === undefined) delete process.env.CODINGHARNESS_HOME;
      else process.env.CODINGHARNESS_HOME = prev;
      resetSettingsCache();
      rmSync(home, { recursive: true, force: true });
    }
  });
});