// Tests for the `WorkflowStore` CRUD layer. Uses a temp
// `CH_HOME` so the real `~/.codingharness/workflows/` is
// untouched. Per AGENTS.md "test setup rules" — set
// `process.env.CODINGHARNESS_HOME` and mkdir the subdirs
// BEFORE importing modules that read `paths.*`.
//
// We don't set `CH_HOME` here (the resolver checks
// `CODINGHARNESS_HOME` first), so the test can hand a
// custom `root` to the store constructor.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkflowStore, WorkflowStoreError } from "../agent/workflow-store.js";
import type { WorkflowRecord } from "../agent/workflow-types.js";

const root = join(mkdtempSync(join(tmpdir(), "ch-workflow-store-")), "workflows");
mkdirSync(root, { recursive: true });

function makeRecord(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
    return {
        id: "",
        name: "Test Workflow",
        nodes: [
            { id: "n1", text: "Trigger", x: 0, y: 0, type: "webhook-listener", category: "trigger", parameters: {} },
            { id: "n2", text: "Summarize", x: 300, y: 0, type: "generate-with-ai-llm", category: "action", parameters: { prompt: "hi" } },
        ],
        edges: [
            { id: "e1", start: { id: "n1", type: "output" }, end: { id: "n2", type: "input" } },
        ],
        ...overrides,
    };
}

test("workflow-store: createOrUpdate assigns an id and persists to disk", async () => {
    const store = new WorkflowStore({ root });
    const rec = await store.createOrUpdate({ name: "Hello" });
    assert.ok(rec.id.length > 0, "id should be assigned");
    assert.equal(rec.name, "Hello");
    const f = join(root, `${rec.id}.json`);
    assert.ok(existsSync(f), "file should be on disk");
    // Meta sidecar
    const mf = join(root, `${rec.id}.json.meta.json`);
    assert.ok(existsSync(mf), "meta sidecar should be on disk");
});

test("workflow-store: get returns the stored record by id", async () => {
    const store = new WorkflowStore({ root });
    const rec = await store.createOrUpdate({ name: "Read me" });
    const got = await store.get(rec.id);
    assert.equal(got.id, rec.id);
    assert.equal(got.name, "Read me");
});

test("workflow-store: get on unknown id throws not_found", async () => {
    const store = new WorkflowStore({ root });
    await assert.rejects(
        () => store.get("does-not-exist"),
        (e: unknown) => e instanceof WorkflowStoreError && e.code === "not_found",
    );
});

test("workflow-store: list returns summaries sorted by updatedAt desc", async () => {
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-list-")), "wf");
    mkdirSync(sub, { recursive: true });
    const store = new WorkflowStore({ root: sub });
    const a = await store.createOrUpdate({ name: "Alpha" });
    // Wait 5ms so updatedAt differs.
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.createOrUpdate({ name: "Beta" });
    const summaries = await store.list();
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0]!.id, b.id, "most recent first");
    assert.equal(summaries[0]!.name, "Beta");
    assert.equal(summaries[1]!.id, a.id);
    assert.equal(summaries[0]!.nodeCount, 0);
    assert.equal(summaries[0]!.edgeCount, 0);
    assert.ok(summaries[0]!.updatedAt >= summaries[1]!.updatedAt, "updatedAt ordering");
});

test("workflow-store: list computes nodeCount / edgeCount from the record", async () => {
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-counts-")), "wf");
    mkdirSync(sub, { recursive: true });
    const store = new WorkflowStore({ root: sub });
    const rec = makeRecord();
    const stored = await store.createOrUpdate({ record: rec });
    const summaries = await store.list();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.nodeCount, 2);
    assert.equal(summaries[0]!.edgeCount, 1);
    assert.equal(stored.id.length > 0, true);
});

test("workflow-store: createOrUpdate with explicit record overwrites by id", async () => {
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-upsert-")), "wf");
    mkdirSync(sub, { recursive: true });
    const store = new WorkflowStore({ root: sub });
    const rec = makeRecord({ name: "V1" });
    const stored1 = await store.createOrUpdate({ record: rec });
    // Re-upsert with same id, new name.
    const stored2 = await store.createOrUpdate({ record: { ...rec, id: stored1.id, name: "V2" } });
    assert.equal(stored2.id, stored1.id, "id is preserved");
    assert.equal(stored2.name, "V2");
    const got = await store.get(stored1.id);
    assert.equal(got.name, "V2");
    const summaries = await store.list();
    assert.equal(summaries.length, 1, "no duplicate record");
});

test("workflow-store: delete removes the file and sidecar", async () => {
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-del-")), "wf");
    mkdirSync(sub, { recursive: true });
    const store = new WorkflowStore({ root: sub });
    const rec = await store.createOrUpdate({ name: "Doomed" });
    assert.ok(existsSync(join(sub, `${rec.id}.json`)));
    await store.delete(rec.id);
    assert.equal(existsSync(join(sub, `${rec.id}.json`)), false);
    assert.equal(existsSync(join(sub, `${rec.id}.json.meta.json`)), false);
    await assert.rejects(
        () => store.get(rec.id),
        (e: unknown) => e instanceof WorkflowStoreError && e.code === "not_found",
    );
});

test("workflow-store: delete on unknown id throws not_found", async () => {
    const store = new WorkflowStore({ root });
    await assert.rejects(
        () => store.delete("does-not-exist"),
        (e: unknown) => e instanceof WorkflowStoreError && e.code === "not_found",
    );
});

test("workflow-store: rename updates the name in place", async () => {
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-rename-")), "wf");
    mkdirSync(sub, { recursive: true });
    const store = new WorkflowStore({ root: sub });
    const rec = await store.createOrUpdate({ name: "Old" });
    const updated = await store.rename(rec.id, "New");
    assert.equal(updated.name, "New");
    const got = await store.get(rec.id);
    assert.equal(got.name, "New");
    // id is preserved
    assert.equal(updated.id, rec.id);
});

test("workflow-store: rename on unknown id throws not_found", async () => {
    const store = new WorkflowStore({ root });
    await assert.rejects(
        () => store.rename("missing", "X"),
        (e: unknown) => e instanceof WorkflowStoreError && e.code === "not_found",
    );
});

test("workflow-store: exportWorkflow returns a shareable envelope", async () => {
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-export-")), "wf");
    mkdirSync(sub, { recursive: true });
    const store = new WorkflowStore({ root: sub });
    const rec = makeRecord({ name: "Export me" });
    const stored = await store.createOrUpdate({ record: rec });
    const env = await store.exportWorkflow(stored.id);
    assert.equal(env.format, "share");
    assert.equal(env.version, 1);
    assert.equal(env.workflow.name, "Export me");
    assert.equal(env.workflow.nodes.length, 2);
    assert.ok(env.exportedAt > 0);
});

test("workflow-store: importWorkflow round-trips through an envelope", async () => {
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-import-")), "wf");
    mkdirSync(sub, { recursive: true });
    const store = new WorkflowStore({ root: sub });
    const rec = makeRecord({ name: "Round-trip" });
    const stored = await store.createOrUpdate({ record: rec });
    const env = await store.exportWorkflow(stored.id);
    // Wipe so we test the import path.
    await store.delete(stored.id);
    const imported = await store.importWorkflow(env);
    assert.notEqual(imported.id, stored.id, "import assigns a fresh id");
    assert.equal(imported.name, "Round-trip");
    const summaries = await store.list();
    assert.equal(summaries.length, 1);
});

test("workflow-store: importWorkflow rejects a malformed envelope", async () => {
    const store = new WorkflowStore({ root });
    await assert.rejects(
        () => store.importWorkflow({ format: "nope", version: 1, workflow: {} }),
        (e: unknown) => e instanceof WorkflowStoreError && e.code === "parse_error",
    );
    await assert.rejects(
        () => store.importWorkflow({ format: "share", version: 99, workflow: {} }),
        (e: unknown) => e instanceof WorkflowStoreError && e.code === "parse_error",
    );
    await assert.rejects(
        () => store.importWorkflow(null),
        (e: unknown) => e instanceof WorkflowStoreError && e.code === "parse_error",
    );
});

test("workflow-store: directory is created lazily on first write (not on import)", async () => {
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-lazy-")), "wf");
    // Note: we deliberately do NOT mkdirSync the root.
    const store = new WorkflowStore({ root: sub });
    assert.equal(existsSync(sub), false, "directory does not exist before first write");
    await store.createOrUpdate({ name: "Lazy" });
    assert.ok(existsSync(sub), "directory was created on first write");
    // cleanup
    rmSync(sub, { recursive: true, force: true });
});

test("workflow-store: list on a missing directory returns [] (not an error)", async () => {
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-empty-")), "wf");
    const store = new WorkflowStore({ root: sub });
    // sub exists (mkdtempSync creates it), but is empty.
    // Remove it to simulate the "not yet created" case.
    rmSync(sub, { recursive: true, force: true });
    const summaries = await store.list();
    assert.deepEqual(summaries, []);
});

test("workflow-store: ids with path separators are sanitized, not used as a traversal", async () => {
    // Path separators and `..` in the id are stripped /
    // replaced with `_` so the resulting file lives inside
    // the workflows directory and cannot escape it. We
    // assert the *behavior* (the file is contained), not
    // that an error is thrown — sanitization is the
    // security control, not rejection.
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-path-")), "wf");
    mkdirSync(sub, { recursive: true });
    const store = new WorkflowStore({ root: sub });
    const stored = await store.createOrUpdate({ record: { id: "../escape", name: "X", nodes: [], edges: [] } as WorkflowRecord });
    // The store preserves the *original* id on the record
    // (caller's id), but the *file on disk* is in `sub`.
    const filesInRoot = readdirSync(sub);
    // 2 files: the .json and the .meta.json sidecar.
    assert.equal(filesInRoot.length, 2, "exactly one .json + one .meta.json are written");
    const dataFile = filesInRoot.find((f) => f.endsWith(".json") && !f.endsWith(".meta.json"));
    assert.ok(dataFile, "a .json file is present");
    assert.ok(dataFile!.startsWith(".."), "filename starts with `..` after sanitization");
    // And the file does not escape sub.
    assert.ok(existsSync(join(sub, dataFile!)));
    assert.equal(existsSync(join(sub, "..", "escape.json")), false, "no file was written outside sub");
});

test("workflow-store: get rejects empty / dot-only ids", async () => {
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-empty-")), "wf");
    mkdirSync(sub, { recursive: true });
    const store = new WorkflowStore({ root: sub });
    // `get("..")` would let the caller read files outside
    // the store. The sanitizer must throw.
    await assert.rejects(
        () => store.get(".."),
        (e: unknown) => e instanceof WorkflowStoreError && e.code === "io_error",
    );
    await assert.rejects(
        () => store.get(""),
        (e: unknown) => e instanceof WorkflowStoreError && e.code === "io_error",
    );
});

test("workflow-store: corrupt JSON file is reported as parse_error, not crash", async () => {
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-corrupt-")), "wf");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "broken.json"), "{not valid json", "utf-8");
    const store = new WorkflowStore({ root: sub });
    await assert.rejects(
        () => store.get("broken"),
        (e: unknown) => e instanceof WorkflowStoreError && e.code === "parse_error",
    );
    // And `list()` should skip it without throwing.
    const summaries = await store.list();
    assert.equal(summaries.length, 0);
});

test("workflow-store: readdir returns meta.json files are filtered out of list()", async () => {
    // Sanity: ensure the .meta.json sidecars don't show up
    // as workflow entries.
    const sub = join(mkdtempSync(join(tmpdir(), "ch-wf-meta-")), "wf");
    mkdirSync(sub, { recursive: true });
    const store = new WorkflowStore({ root: sub });
    const rec = await store.createOrUpdate({ name: "With meta" });
    // The directory should contain both .json and .json.meta.json
    const files = readdirSync(sub);
    assert.ok(files.includes(`${rec.id}.json`));
    assert.ok(files.includes(`${rec.id}.json.meta.json`));
    // But list() only returns one entry.
    const summaries = await store.list();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.id, rec.id);
});
