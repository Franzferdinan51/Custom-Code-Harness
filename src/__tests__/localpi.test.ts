// Tests for src/localpi/* — JSON-at-boundary, provider catalog, managed
// process supervision. Borrowed from dutifuldev/localpi (MIT); kept
// dependency-free to match the project's `node:test` + `node:assert` style.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    asObject,
    optionalString,
    requiredString,
    asArray,
    optionalPositiveInteger,
} from "../localpi/common/json.js";
import { ok, fail, errorMessage } from "../localpi/common/result.js";
import {
    lmStudioProvider,
    vllmProvider,
    dedupeProviders,
} from "../localpi/provider/registry.js";
import {
    findContextWindow,
    managedModelSupportsReasoning,
} from "../localpi/provider/catalog.js";
import {
    selectAutomaticModel,
    assertNoLoadedExternalModels,
} from "../localpi/provider/selection.js";
import { serverStatus } from "../localpi/runtime/supervisor.js";

function loadedModel(providerId: string, modelId: string) {
    return {
        providerId,
        providerName: providerId,
        runtime: "openai-compatible" as const,
        baseUrl: "http://x",
        modelId,
        aliases: [] as string[],
        displayName: `${providerId} / ${modelId}`,
        capabilities: ["text"] as const,
        availability: "loaded" as const,
    };
}

function startableModel(providerId: string, modelId: string) {
    return { ...loadedModel(providerId, modelId), availability: "startable" as const };
}

// ---------- common/json ----------

test("asObject: accepts plain object", () => {
    assert.deepEqual(asObject({ a: 1 }, "ctx"), { a: 1 });
});
test("asObject: rejects null", () => {
    assert.throws(() => asObject(null, "ctx"), /ctx must be an object/);
});
test("asObject: rejects array", () => {
    assert.throws(() => asObject([], "ctx"), /ctx must be an object/);
});
test("asObject: rejects primitive", () => {
    assert.throws(() => asObject(42, "ctx"), /ctx must be an object/);
});
test("optionalString: returns string or undefined", () => {
    assert.equal(optionalString("hi"), "hi");
    assert.equal(optionalString(42), undefined);
    assert.equal(optionalString(null), undefined);
});
test("requiredString: throws on non-string", () => {
    assert.throws(() => requiredString(1, "ctx"), /ctx must be a string/);
    assert.equal(requiredString("x", "ctx"), "x");
});
test("asArray: returns the array or throws", () => {
    assert.deepEqual([...asArray([1, 2], "ctx")], [1, 2]);
    assert.throws(() => asArray({}, "ctx"), /ctx must be an array/);
});
test("optionalPositiveInteger: parses number/string, rejects non-positive", () => {
    assert.equal(optionalPositiveInteger("1024"), 1024);
    assert.equal(optionalPositiveInteger(2048), 2048);
    assert.equal(optionalPositiveInteger(0), undefined);
    assert.equal(optionalPositiveInteger(-1), undefined);
    assert.equal(optionalPositiveInteger("abc"), undefined);
});

// ---------- common/result ----------

test("ok: produces code 0 with empty stderr", () => {
    const r = ok("hi");
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "hi");
    assert.equal(r.stderr, "");
});
test("fail: trims trailing newline + sets code", () => {
    const r = fail("bad", 1);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "bad\n");
});
test("fail: appends newline when missing", () => {
    const r = fail("bad");
    assert.equal(r.stderr, "bad\n");
});
test("errorMessage: unwraps Error or returns string", () => {
    assert.equal(errorMessage(new Error("x")), "x");
    assert.equal(errorMessage("x"), "x");
});

// ---------- provider/registry ----------

test("lmStudioProvider: normalizes trailing slash", () => {
    const p = lmStudioProvider("http://127.0.0.1:1234/v1/");
    assert.equal(p.baseUrl, "http://127.0.0.1:1234/v1");
    assert.equal(p.id, "lmstudio");
    assert.equal(p.discover, true);
});
test("vllmProvider: defaults to 8000", () => {
    const p = vllmProvider();
    assert.equal(p.baseUrl, "http://127.0.0.1:8000/v1");
});
test("dedupeProviders: keeps last by id", () => {
    const a = lmStudioProvider();
    const b = { ...lmStudioProvider(), name: "dup" };
    const c = vllmProvider();
    const out = dedupeProviders([a, b, c]);
    assert.equal(out.length, 2);
    assert.equal(out[0]?.name, "dup");
});

// ---------- provider/catalog ----------

test("findContextWindow: walks alias field names", () => {
    assert.equal(findContextWindow({ context_window: 4096 }), 4096);
    assert.equal(findContextWindow({ contextWindow: 8192 }), 8192);
    assert.equal(findContextWindow({ n_ctx: 2048 }), 2048);
    assert.equal(findContextWindow({ max_input_tokens: "16384" }), 16384);
    assert.equal(findContextWindow({}), undefined);
});
test("findContextWindow: recurses into metadata", () => {
    assert.equal(
        findContextWindow({ metadata: { context_window: 1024 } }),
        1024
    );
});
test("findContextWindow: rejects non-positive", () => {
    assert.equal(findContextWindow({ context_window: 0 }), undefined);
    assert.equal(findContextWindow({ context_window: -1 }), undefined);
    assert.equal(findContextWindow({ context_window: "abc" }), undefined);
});
test("managedModelSupportsReasoning: detects known families", () => {
    assert.equal(managedModelSupportsReasoning("gpt-oss-20b"), true);
    assert.equal(managedModelSupportsReasoning("qwen3-8b"), true);
    assert.equal(managedModelSupportsReasoning("deepseek-r1-distill"), true);
    assert.equal(managedModelSupportsReasoning("gemma-4-e2b"), true);
    assert.equal(managedModelSupportsReasoning("llama-3.1-8b"), false);
});

// ---------- provider/selection ----------

test("selection: 1 loaded -> ok", () => {
    const cat = { models: [loadedModel("lmstudio", "m1")], warnings: [] };
    const r = selectAutomaticModel(cat, { isTty: true });
    assert.equal(r.kind, "ok");
});
test("selection: 0 loaded, 0 startable -> error", () => {
    const cat = { models: [], warnings: [] };
    const r = selectAutomaticModel(cat, { isTty: true });
    assert.equal(r.kind, "error");
});
test("selection: 0 loaded, 1 startable -> ok (fallback)", () => {
    const cat = {
        models: [startableModel("llama-server", "gemma-12b")],
        warnings: [],
    };
    const r = selectAutomaticModel(cat, { isTty: true });
    assert.equal(r.kind, "ok");
});
test("selection: multi loaded, non-tty -> error with list", () => {
    const cat = {
        models: [loadedModel("a", "m1"), loadedModel("b", "m2")],
        warnings: [],
    };
    const r = selectAutomaticModel(cat, { isTty: false });
    assert.equal(r.kind, "error");
});
test("selection: multi loaded, tty -> needs-picker", () => {
    const cat = {
        models: [loadedModel("a", "m1"), loadedModel("b", "m2")],
        warnings: [],
    };
    const r = selectAutomaticModel(cat, { isTty: true });
    assert.equal(r.kind, "needs-picker");
    if (r.kind === "needs-picker") {
        assert.equal(r.candidates.length, 2);
    }
});
test("assertNoLoadedExternalModels: blocks when external loaded", () => {
    const cat = { models: [loadedModel("lmstudio", "m1")], warnings: [] };
    assert.throws(() => assertNoLoadedExternalModels(cat), /unload them first/);
});
test("assertNoLoadedExternalModels: allows managed runtime", () => {
    const cat = {
        models: [
            { ...loadedModel("llama-server", "m1"), runtime: "managed-runtime" as const },
        ],
        warnings: [],
    };
    assert.doesNotThrow(() => assertNoLoadedExternalModels(cat));
});

// ---------- runtime/supervisor ----------

test("supervisor: serverStatus returns not-running for empty state dir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "localpi-test-"));
    try {
        const s = await serverStatus(dir);
        assert.equal(s.kind, "not-running");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test("supervisor: serverStatus returns stale-metadata for dead pid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "localpi-test-"));
    try {
        await writeFile(
            path.join(dir, "server.json"),
            JSON.stringify({
                pid: 999_999,
                baseUrl: "http://127.0.0.1:1/v1",
                modelId: "fake",
                modelPath: "/nonexistent.gguf",
                host: "127.0.0.1",
                port: 1,
                contextWindow: 1024,
                gpuLayers: 0,
                parallel: 1,
                serverCommand: "fake-cmd",
                startedAt: new Date().toISOString(),
            })
        );
        const s = await serverStatus(dir);
        assert.equal(s.kind, "stale-metadata");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
