// src/agent/workflow-store.ts
//
// CRUD layer for `WorkflowRecord`s. Direct port of agnt-gg's
// `WorkflowService.js` + `WorkflowModel.js` (§4.1, §5.2 of
// `docs/agnt-workflow-audit.md`) — minus the `user_id` /
// `is_shareable` columns, which are dropped (single-user harness).
//
// Persistence model: **one JSON file per workflow** at
// `$CH_HOME/workflows/<id>.json`. We chose per-file over the
// agnt-gg SQLite table for two reasons:
//
// 1. The audit recommends "git-versionable" workflows-as-files for
//    v1 (audit §8.3 "What the port is NOT" — no versioning
//    service). Per-file is the natural fit for that story.
// 2. The existing `src/agent/session.ts` already uses per-file
//    JSONL; per-workflow JSON follows the same shape, simplifies
//    the directory layout, and keeps the failure mode of "one
//    corrupt workflow" from corrupting the others.
//
// Atomicity: every write goes to a temp file in the same
// directory, then `rename()`-s into place. This matches the
// session.ts pattern (and the AGENTS.md reliability note about
// crash-resistant writes).
//
// Concurrency: a single in-process `WorkflowStore` instance is
// the only writer. We serialize file writes with a per-store
// promise chain. Multiple readers are safe — Node `fs.readFile`
// is atomic per file.
//
// Summary fields: the agnt-gg model extracts `name`, `description`,
// `category`, and `node_summary` denormalized columns at save time
// for fast list/summary queries (audit §2.1). We follow the same
// pattern but compute the summary in-memory on every read; the
// per-file layout is fast enough that the disk read is the
// dominant cost. The summary is recomputed on every save to
// match the agnt-gg "not authoritative" rule (audit §2.1).
//
// The directory is created **lazily on first write**, not at
// import time — this keeps `import { WorkflowStore }` from
// forcing a `mkdir` and matches the per-task instructions.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { paths } from "../config/paths.js";
import { log } from "../util/logger.js";
import type { WorkflowRecord } from "./workflow-types.js";

// ---------- Types ----------

/** A lightweight summary of a stored workflow. Returned by
 *  `list()` and `listSummary()` so the CLI / TUI / web UI can
 *  render a list view without loading the full graph. */
export interface WorkflowSummary {
    id: string;
    name: string;
    description?: string;
    category?: string;
    /** Node count, computed on save. */
    nodeCount: number;
    /** Edge count, computed on save. */
    edgeCount: number;
    /** When the record was last written, in epoch ms. */
    updatedAt: number;
    /** When the record was first created, in epoch ms. */
    createdAt: number;
}

/** The export envelope shape — `ch workflow export <id>` writes
 *  this, `ch workflow import <file>` reads it. Modeled on the
 *  agnt-gg `buildWorkflowEnvelope` /
 *  `WorkflowRoutes.js:152-181` shape (a versioned wrapper
 *  around the full record). The `format` discriminator lets
 *  future `export --format` values coexist (the audit
 *  reserves `share` / `versioned` as future options). */
export interface WorkflowExportEnvelope {
    format: "share";
    /** Envelope version. Bump when the shape changes
     *  incompatibly. */
    version: 1;
    /** When the envelope was built, in epoch ms. */
    exportedAt: number;
    /** The full record. */
    workflow: WorkflowRecord;
}

/** A minimal CRUD option for `createOrUpdate` — the caller can
 *  pass either a `record` to upsert as-is, or a partial
 *  `name` + (optional) `nodes` / `edges` to construct a fresh
 *  one. */
export type CreateOrUpdateInput =
    | { record: WorkflowRecord }
    | { name: string; description?: string; category?: string; nodes?: WorkflowRecord["nodes"]; edges?: WorkflowRecord["edges"] };

/** Per-store options. `root` overrides the directory used for
 *  per-workflow JSON files (default `paths.workflows`).
 *  Primarily used by tests. */
export interface WorkflowStoreOptions {
    root?: string;
}

// ---------- Errors ----------

/** Thrown by `WorkflowStore` operations on I/O / parse
 *  failures. The CLI catches this and emits a friendly
 *  message; the runtime surfaces it as a `status: "failed"`
 *  result. */
export class WorkflowStoreError extends Error {
    constructor(message: string, public readonly code: "not_found" | "parse_error" | "io_error") {
        super(message);
        this.name = "WorkflowStoreError";
    }
}

// ---------- Implementation ----------

/** CRUD over per-workflow JSON files. One instance is
 *  typically wired on `HarnessRuntime` and shared by the
 *  CLI / REPL / HTTP routes. */
export class WorkflowStore {
    private readonly root: string;
    /** Serializes all writes through a single promise chain.
     *  Multiple readers are safe. */
    private writeChain: Promise<void> = Promise.resolve();
    /** True after we've mkdir'd the root at least once. */
    private rootReady = false;

    constructor(opts: WorkflowStoreOptions = {}) {
        this.root = opts.root ?? paths.workflows;
    }

    // ---------- helpers ----------

    private fileFor(id: string): string {
        // id is an arbitrary caller-supplied string; we
        // sanitize by stripping any path separators and
        // disallowing `..`. The CLI/runtime should generate
        // ids via `randomUUID()` (which is path-safe) but
        // we don't trust upstream.
        const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
        if (safe.length === 0 || safe === "." || safe === "..") {
            throw new WorkflowStoreError(`invalid workflow id: ${id}`, "io_error");
        }
        return join(this.root, `${safe}.json`);
    }

    private async ensureRoot(): Promise<void> {
        if (this.rootReady) return;
        await mkdir(this.root, { recursive: true });
        this.rootReady = true;
    }

    /** Compute a denormalized summary from a record. Pure. */
    static summarize(rec: WorkflowRecord, createdAt: number, updatedAt: number): WorkflowSummary {
        return {
            id: rec.id,
            name: rec.name,
            ...(rec.description !== undefined ? { description: rec.description } : {}),
            ...(rec.category !== undefined ? { category: rec.category } : {}),
            nodeCount: rec.nodes.length,
            edgeCount: rec.edges.length,
            createdAt,
            updatedAt,
        };
    }

    /** A timestamped record file's path is paired with a
     *  `<id>.json.meta.json` sidecar. The sidecar holds the
     *  `createdAt` and the file mtime, so we can return
     *  `updatedAt` without stat-ing on every read. */
    private metaFileFor(id: string): string {
        return this.fileFor(id) + ".meta.json";
    }

    private async readMeta(id: string): Promise<{ createdAt: number; updatedAt: number }> {
        const f = this.metaFileFor(id);
        if (!existsSync(f)) {
            // No sidecar (legacy / first run) — derive both
            // from the file's mtime. This is best-effort; if
            // the file is missing too, `get()` will throw the
            // not_found error.
            try {
                const { stat } = await import("node:fs/promises");
                const st = await stat(this.fileFor(id));
                return { createdAt: st.mtimeMs, updatedAt: st.mtimeMs };
            } catch {
                return { createdAt: Date.now(), updatedAt: Date.now() };
            }
        }
        try {
            const raw = await readFile(f, "utf-8");
            const parsed = JSON.parse(raw) as { createdAt: number; updatedAt: number };
            return {
                createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
                updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
            };
        } catch {
            return { createdAt: Date.now(), updatedAt: Date.now() };
        }
    }

    private async writeMeta(id: string, createdAt: number, updatedAt: number): Promise<void> {
        // Track the tmp path so a mid-flight failure can unlink
        // the orphan. (Same pattern as the main `save()` below.)
        let tmp: string | undefined = this.metaFileFor(id) + ".tmp";
        try {
            await writeFile(tmp, JSON.stringify({ createdAt, updatedAt }), "utf-8");
            await rename(tmp, this.metaFileFor(id));
            tmp = undefined;
        } catch (e) {
            if (tmp !== undefined) {
                try { await unlink(tmp); } catch { /* best-effort */ }
            }
            throw e;
        }
    }

    // ---------- CRUD ----------

    /** List all workflows, sorted by `updatedAt` desc. Returns
     *  summaries (no full graph) for speed. */
    async list(): Promise<WorkflowSummary[]> {
        const { readdir } = await import("node:fs/promises");
        let files: string[];
        try {
            files = (await readdir(this.root)).filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw new WorkflowStoreError(`list workflows: ${(e as Error).message}`, "io_error");
        }
        const out: WorkflowSummary[] = [];
        for (const f of files) {
            const id = f.replace(/\.json$/, "");
            try {
                const rec = await this.get(id);
                const meta = await this.readMeta(id);
                out.push(WorkflowStore.summarize(rec, meta.createdAt, meta.updatedAt));
            } catch (e) {
                // Skip corrupt records but log so the operator
                // can recover. `not_found` is the common case
                // (race with delete) and is not logged.
                if ((e as WorkflowStoreError).code !== "not_found") {
                    log.warn(`workflow-store: skip ${f}: ${(e as Error).message}`);
                }
            }
        }
        out.sort((a, b) => b.updatedAt - a.updatedAt);
        return out;
    }

    /** Read a full record by id. */
    async get(id: string): Promise<WorkflowRecord> {
        const f = this.fileFor(id);
        if (!existsSync(f)) {
            throw new WorkflowStoreError(`workflow not found: ${id}`, "not_found");
        }
        let raw: string;
        try {
            raw = await readFile(f, "utf-8");
        } catch (e) {
            throw new WorkflowStoreError(`read ${id}: ${(e as Error).message}`, "io_error");
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            throw new WorkflowStoreError(`parse ${id}: ${(e as Error).message}`, "parse_error");
        }
        return parsed as WorkflowRecord;
    }

    /** Upsert a record. If `record.id` is empty, a UUID is
     *  generated. If a record with the same id exists, it is
     *  overwritten (with a fresh `updatedAt`). Returns the
     *  stored record (with any default fields filled in). */
    async createOrUpdate(input: CreateOrUpdateInput): Promise<WorkflowRecord> {
        const record = "record" in input
            ? input.record
            : {
                id: "",
                name: input.name,
                nodes: input.nodes ?? [],
                edges: input.edges ?? [],
                ...(input.description !== undefined ? { description: input.description } : {}),
                ...(input.category !== undefined ? { category: input.category } : {}),
            };
        const isNew = !record.id;
        const id = record.id || WorkflowStore.newId();
        const now = Date.now();
        const stored: WorkflowRecord = { ...record, id };
        // Serialize all writes through the chain.
        const work = async (): Promise<void> => {
            await this.ensureRoot();
            const f = this.fileFor(id);
            let tmp: string | undefined = f + ".tmp";
            try {
                const data = JSON.stringify(stored, null, 2);
                await writeFile(tmp, data, "utf-8");
                await rename(tmp, f);
                tmp = undefined; // rename consumed it
                // Update meta sidecar.
                const prevMeta = isNew ? null : await this.readMeta(id).catch(() => null);
                const createdAt = prevMeta?.createdAt ?? now;
                await this.writeMeta(id, createdAt, now);
            } catch (e) {
                // Pre-fix: a failed `rename` (e.g. target exists
                // as a directory, FS full) leaked the `.tmp`
                // orphan next to the workflow file — visually
                // noisy in `~/.codingharness/workflows/`.
                if (tmp !== undefined) {
                    try { await unlink(tmp); } catch { /* best-effort */ }
                }
                throw e;
            }
        };
        this.writeChain = this.writeChain.then(work, work);
        await this.writeChain;
        return stored;
    }

    /** Delete a record. Throws `not_found` if the id is
     *  unknown. */
    async delete(id: string): Promise<void> {
        const work = async (): Promise<void> => {
            const f = this.fileFor(id);
            if (!existsSync(f)) {
                throw new WorkflowStoreError(`workflow not found: ${id}`, "not_found");
            }
            await unlink(f);
            const mf = this.metaFileFor(id);
            if (existsSync(mf)) {
                try { await unlink(mf); } catch { /* best-effort */ }
            }
        };
        this.writeChain = this.writeChain.then(work, work);
        await this.writeChain;
    }

    /** Rename a workflow in place. Throws `not_found` if the
     *  id is unknown. */
    async rename(id: string, newName: string): Promise<WorkflowRecord> {
        const work = async (): Promise<void> => {
            const rec = await this.get(id);
            rec.name = newName;
            await this.ensureRoot();
            const f = this.fileFor(id);
            const tmp = f + ".tmp";
            await writeFile(tmp, JSON.stringify(rec, null, 2), "utf-8");
            await rename(tmp, f);
            const now = Date.now();
            const prevMeta = await this.readMeta(id).catch(() => null);
            const createdAt = prevMeta?.createdAt ?? now;
            await this.writeMeta(id, createdAt, now);
        };
        this.writeChain = this.writeChain.then(work, work);
        await this.writeChain;
        return this.get(id);
    }

    /** Generate a fresh workflow id. */
    static newId(): string {
        return randomUUID();
    }

    // ---------- import / export ----------

    /** Build a shareable envelope for a workflow. */
    async exportWorkflow(id: string): Promise<WorkflowExportEnvelope> {
        const rec = await this.get(id);
        return {
            format: "share",
            version: 1,
            exportedAt: Date.now(),
            workflow: rec,
        };
    }

    /** Parse a shareable envelope, validate the shape, and
     *  insert / overwrite the workflow. Returns the stored
     *  record. Throws on a malformed envelope. */
    async importWorkflow(envelope: unknown): Promise<WorkflowRecord> {
        if (!envelope || typeof envelope !== "object") {
            throw new WorkflowStoreError("envelope must be an object", "parse_error");
        }
        const env = envelope as Partial<WorkflowExportEnvelope>;
        if (env.format !== "share") {
            throw new WorkflowStoreError(`unsupported envelope format: ${String(env.format)}`, "parse_error");
        }
        if (env.version !== 1) {
            throw new WorkflowStoreError(`unsupported envelope version: ${String(env.version)}`, "parse_error");
        }
        if (!env.workflow || typeof env.workflow !== "object") {
            throw new WorkflowStoreError("envelope.workflow must be an object", "parse_error");
        }
        const wf = env.workflow as WorkflowRecord;
        if (typeof wf.id !== "string" || typeof wf.name !== "string" || !Array.isArray(wf.nodes) || !Array.isArray(wf.edges)) {
            throw new WorkflowStoreError("envelope.workflow is missing id/name/nodes/edges", "parse_error");
        }
        // Always assign a fresh id on import — importing the
        // same envelope twice should yield two distinct
        // records, not collide. Callers that want to
        // overwrite can read the id from the returned
        // record and call `createOrUpdate({ record })` with
        // a known id.
        return this.createOrUpdate({ record: { ...wf, id: "" } });
    }
}
