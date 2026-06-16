// TS extension loader (pi-style). Reads `extensions/<name>/index.ts`
// (or `extensions/<name>.ts`) from the user + project dirs,
// dynamically imports each one, validates the `manifest` wrapper,
// and calls `default(activateContext)` with an `ExtensionContext`
// bound to the supplied `ExtensionRegistry`.
//
// Dynamic import — three strategies in order:
//   1. Native `import(specifier)` — works in any runtime that
//      supports loading the file (bun loads `.ts` natively; node
//      loads `.mjs`/`.js` natively).
//   2. `tsx/esm/api` `tsImport` — works for `.ts` files under
//      node when tsx is installed. We try this as a fallback for
//      `.ts` paths.
//   3. Clear error — if neither works, the file is reported in
//      the loader's error log and skipped. One bad extension
//      MUST NOT prevent the rest from loading.
//
// Per the spec, error isolation is enforced at three levels:
//   - Bad manifest shape (missing `name`, `default` is not a
//     function, etc.): skip, log, continue.
//   - `default(activateContext)` throws synchronously: skip, log,
//     continue.
//   - Handler dispatched later throws: caught by the registry's
//     error isolation, does not affect loading other extensions.
//
// The exported `loadExtensionsIntoRegistry` function returns a
// `LoadResult` so the caller can show a summary in the CLI / REPL
// (e.g. "loaded 3 extensions: 2 ts + 1 json, 0 errors").

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { log as defaultLog } from "../../util/logger.js";
import {
  ExtensionRegistry,
  isHookName,
  type ExtensionHookName,
} from "./registry.js";
import type {
  ExtensionContext,
  ExtensionHandlerMap,
  ExtensionLogger,
  TsExtensionManifest,
} from "./context.js";

/** What `loadExtensionsIntoRegistry` returns. */
export interface LoadResult {
  /** Number of TS extensions successfully activated. */
  tsLoaded: number;
  /** Number of JSON manifests that contributed a hook handler. */
  jsonLoaded: number;
  /** Per-file load failures (bad manifest, import error, activate throw). */
  errors: Array<{ path: string; name?: string; error: string }>;
  /** Per-extension load records (manifest + path). */
  extensions: LoadedExtension[];
}

/** Internal record for a successfully loaded extension. */
export interface LoadedExtension {
  name: string;
  version: string;
  manifest: TsExtensionManifest | ExtensionManifestShim;
  /** Absolute path to the entrypoint file. */
  path: string;
  /** Resolved cwd the extension sees via `ctx.cwd`. */
  cwd: string;
  /** "ts" or "json" — what kind of entrypoint this was. */
  source: "ts" | "json";
  /** Result of `activate(ctx)` — "ok" | "error" (already logged). */
  status: "ok" | "error";
  /** Set when `status === "error"`. */
  error?: string;
}

/** Minimal JSON-manifest shape we need to register a hook from
 *  a JSON extension (parity with TS). The full
 *  `ExtensionManifest` from `src/agent/extensions.ts` has more
 *  fields (commands / tools / bashAllowlist) — those don't map
 *  to hooks, they're loaded as actual extensions via the
 *  existing flow. We only need `systemPromptAppend` for the
 *  JSON→registry parity. */
export interface ExtensionManifestShim {
  name: string;
  description?: string;
  systemPromptAppend?: string;
}

/** One-time search path the loader walks. We expose a small union
 *  type so the caller can opt into either user-level
 *  (`~/.codingharness/extensions/`) or project-level
 *  (`<cwd>/.codingharness/extensions/`) loading. */
export interface LoadOptions {
  /** Absolute path to the user-level extensions dir. */
  userDir: string;
  /** Absolute path to the project-level extensions dir. */
  projectDir: string;
  /** Registry to register hook handlers into. */
  registry: ExtensionRegistry;
  /** Optional logger override (tests pass a stub). */
  logger?: ExtensionLogger;
}

/** Detect whether a runtime-supplied path is loadable as a
 *  dynamic import. `.ts`/`.mts` files need a TS loader; bun
 *  handles them natively, node needs tsx. We try a native
 *  `import()` first, then fall back to tsImport. The error
 *  we report is the second one's (if both fail), since that's
 *  the most informative. */
async function importFile(filePath: string, parentURL: string): Promise<unknown> {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const fileUrl = pathToFileURL(filePath).href;
  // Strategy 1: native import. Works for .mjs/.js under both
  // node and bun; works for .ts under bun only.
  try {
    return await import(fileUrl);
  } catch (nativeErr) {
    // If extension is .js/.mjs, this is a real failure — rethrow.
    if (ext !== ".ts" && ext !== ".mts") throw nativeErr;
    // Strategy 2: tsx/esm/api. May not be installed in production;
    // we let the error propagate if so.
    try {
      // Dynamic import — only resolves if tsx is present.
      const mod = await import("tsx/esm/api");
      const tsImport = (mod as { tsImport: (s: string, opts: { parentURL: string }) => Promise<unknown> }).tsImport;
      if (typeof tsImport !== "function") throw new Error("tsx/esm/api: tsImport export missing");
      return await tsImport(fileUrl, { parentURL });
    } catch (tsxErr) {
      const msg = (tsxErr as Error).message ?? String(tsxErr);
      if (msg.includes("Cannot find package 'tsx'") || msg.includes("ERR_MODULE_NOT_FOUND")) {
        // Surface a friendlier hint when the runtime is node and
        // tsx is missing — the fix is to run via `ch dev` /
        // `tsx` so the loader has a TS-aware runtime.
        const hint = "Run the harness via " + "'bun'" + " or " + "'tsx'" + " (e.g. " + "'bun src/cli.ts'" + " or " + "'ch dev'" + ") so dynamic " + "'.ts'" + " imports resolve.";
        throw new Error(
          `cannot import .ts extension "${filePath}" — no TypeScript loader available. ${hint} (Underlying: ${msg})`,
        );
      }
      throw tsxErr;
    }
  }
}

/** Normalize the default export from a dynamically-imported TS
 *  module. tsx's esbuild interop wraps some `export default fn`
 *  in `{ default: fn }`; bun / native `.mjs` does not. We
 *  accept both shapes — pick the one that is callable. */
function resolveDefaultExport(mod: unknown): unknown {
  if (!mod || typeof mod !== "object") return undefined;
  const m = mod as Record<string, unknown>;
  // Direct: `export default fn` → m.default === fn
  if (typeof m.default === "function") return m.default;
  // CJS-interop: `export default fn` (transpiled) → m.default = { default: fn }
  const inner = m.default as { default?: unknown } | null;
  if (inner && typeof inner === "object" && typeof inner.default === "function") return inner.default;
  return undefined;
}

/** Validate a manifest export. The loader calls this before
 *  activating the extension. Throws on bad shape. */
export function validateManifest(m: unknown): TsExtensionManifest {
  if (!m || typeof m !== "object") {
    throw new Error("manifest must be an object");
  }
  const obj = m as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new Error("manifest.name is required and must be a non-empty string");
  }
  if (obj.name.length > 128) {
    throw new Error(`manifest.name is too long (max 128 chars, got ${obj.name.length})`);
  }
  if (obj.version !== undefined && typeof obj.version !== "string") {
    throw new Error("manifest.version, if present, must be a string");
  }
  if (obj.description !== undefined && typeof obj.description !== "string") {
    throw new Error("manifest.description, if present, must be a string");
  }
  if (obj.hooks !== undefined) {
    if (!obj.hooks || typeof obj.hooks !== "object" || Array.isArray(obj.hooks)) {
      throw new Error("manifest.hooks, if present, must be an object");
    }
    for (const [k, v] of Object.entries(obj.hooks as Record<string, unknown>)) {
      if (!isHookName(k)) {
        throw new Error(`manifest.hooks.${k} is not a known hook (allowed: preSystemPrompt, postToolResult, onError, onCompaction)`);
      }
      if (typeof v !== "string") {
        throw new Error(`manifest.hooks.${k} must be a string (export name to bind), got ${typeof v}`);
      }
    }
  }
  return obj as unknown as TsExtensionManifest;
}

/** Build the per-extension `ExtensionContext`. Used by
 *  `loadTsExtension`; not exported because the API is
 *  loader-internal. */
function makeContext(opts: {
  registry: ExtensionRegistry;
  manifest: TsExtensionManifest;
  cwd: string;
  entrypoint: string;
  logger: ExtensionLogger;
}): ExtensionContext {
  let disposed = false;
  // The set of (hook, handler) tuples the extension itself
  // registered. Tracked so `dispose()` can fire cleanup
  // callbacks and so we can detect / avoid double-register
  // when an extension accidentally calls `on()` more than
  // once for the same handler.
  const selfRegistrations: Array<{ hook: ExtensionHookName; handler: unknown; unsubscribe: () => void }> = [];

  const on = <H extends ExtensionHookName>(event: H, handler: ExtensionHandlerMap[H]): (() => void) => {
    if (disposed) {
      throw new Error(`extension "${opts.manifest.name}" tried to call ctx.on() after dispose`);
    }
    if (!isHookName(event)) {
      throw new Error(`ctx.on: unknown hook "${event}"`);
    }
    if (typeof handler !== "function") {
      throw new Error(`ctx.on: handler must be a function for hook "${event}"`);
    }
    const added = opts.registry.register(opts.manifest.name, event, handler as never);
    const unsubscribe = () => {
      // We use removeExtension which removes ALL of the
      // extension's bindings — coarse but safe. Fine-grained
      // removal needs a per-handler token we don't expose.
      opts.registry.removeExtension(opts.manifest.name);
      // Re-add all the OTHER handlers so the rest of the
      // extension survives a partial unsubscribe.
      for (const reg of selfRegistrations) {
        if (reg.unsubscribe === unsubscribe) continue;
        opts.registry.register(opts.manifest.name, reg.hook, reg.handler as never);
      }
    };
    selfRegistrations.push({ hook: event, handler, unsubscribe });
    return unsubscribe;
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    // Remove every handler the extension added. The registry
    // runs each per-extension disposer callback first, then
    // unregisters.
    opts.registry.removeExtension(opts.manifest.name);
    selfRegistrations.length = 0;
  };

  return {
    name: opts.manifest.name,
    version: opts.manifest.version ?? "0.0.0",
    manifest: deepFreeze({ ...opts.manifest }),
    cwd: opts.cwd,
    entrypoint: opts.entrypoint,
    logger: opts.logger,
    on,
    dispose,
    get disposed() { return disposed; },
  };
}

/** Recursively freeze an object. Used so extensions can't
 *  accidentally mutate the loader's manifest copy. */
function deepFreeze<T>(o: T): Readonly<T> {
  if (o && typeof o === "object") {
    for (const k of Object.keys(o as object)) {
      const v = (o as Record<string, unknown>)[k];
      if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
    }
    Object.freeze(o);
  }
  return o;
}

/** Find candidate TS extension entrypoints in a directory. We
 *  accept two layouts (the loader tries both):
 *    1. `extensions/<name>/index.ts`
 *    2. `extensions/<name>.ts`
 *  (also `<name>.mts` for users who prefer the explicit ESM
 *  extension). Sub-directories whose first segment starts with
 *  "." are skipped (hidden / backups). */
function findTsEntryPoints(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      // Convention 1: <name>/index.ts
      const idx = join(full, "index.ts");
      if (existsSync(idx)) out.push(idx);
      const mts = join(full, "index.mts");
      if (existsSync(mts)) out.push(mts);
    } else if (st.isFile()) {
      if (name.endsWith(".ts") || name.endsWith(".mts")) out.push(full);
    }
  }
  // Stable order: sort by basename so reload is deterministic.
  out.sort();
  return out;
}

/** Load ONE TS extension from an absolute path. Used by
 *  `loadExtensionsIntoRegistry`; can also be called directly
 *  for one-off loads (e.g. CLI `ch ext load <path>` — a
 *  follow-up; not part of T2 scope). */
export async function loadTsExtension(filePath: string, opts: { cwd: string; registry: ExtensionRegistry; logger?: ExtensionLogger }): Promise<LoadedExtension> {
  const absPath = isAbsolute(filePath) ? filePath : resolve(filePath);
  const extLogger: ExtensionLogger = opts.logger ?? makeDefaultLogger(absPath);
  const fallbackName = basename(dirname(absPath)) !== "." ? basename(dirname(absPath)) : basename(absPath, absPath.slice(absPath.lastIndexOf(".")));

  let mod: unknown;
  try {
    mod = await importFile(absPath, pathToFileURL(import.meta.url).href);
  } catch (e) {
    const err = e as Error;
    throw new Error(`failed to import ${absPath}: ${err.message}`);
  }

  const modObj = mod as Record<string, unknown>;
  // Manifest is a NAMED export, not the default.
  let manifest: TsExtensionManifest;
  try {
    manifest = validateManifest(modObj.manifest);
  } catch (e) {
    // Fallback: if name is missing in the manifest, use the
    // directory name so a minor misshape still gets a usable
    // extension record.
    const err = e as Error;
    if (err.message.includes("manifest.name")) {
      try {
        const stub = validateManifest({ ...(modObj.manifest as object ?? {}), name: fallbackName });
        manifest = stub;
      } catch {
        throw err;
      }
    } else {
      throw err;
    }
  }

  // default(activateContext) — call with our context.
  const activate = resolveDefaultExport(mod);
  if (typeof activate !== "function") {
    throw new Error(`extension "${manifest.name}" at ${absPath} has no callable default export (expected \`export default function activate(ctx)\`)`);
  }

  const ctx = makeContext({
    registry: opts.registry,
    manifest,
    cwd: opts.cwd,
    entrypoint: absPath,
    logger: extLogger,
  });

  try {
    const r = (activate as (c: ExtensionContext) => unknown | Promise<unknown>)(ctx);
    if (r && typeof (r as Promise<unknown>).then === "function") {
      await (r as Promise<unknown>);
    }
  } catch (e) {
    const err = e as Error;
    // Tear down whatever the extension registered before throwing.
    await ctx.dispose();
    throw new Error(`activate() threw for extension "${manifest.name}" at ${absPath}: ${err.message}`);
  }

  return {
    name: manifest.name,
    version: manifest.version ?? "0.0.0",
    manifest,
    path: absPath,
    cwd: opts.cwd,
    source: "ts",
    status: "ok",
  };
}

function makeDefaultLogger(absPath: string): ExtensionLogger {
  const tag = `[ext ${basename(absPath)}]`;
  return {
    debug: (m, x) => defaultLog.debug(`${tag} ${m}`, x),
    info: (m, x) => defaultLog.info(`${tag} ${m}`, x),
    warn: (m, x) => defaultLog.warn(`${tag} ${m}`, x),
    error: (m, x) => defaultLog.error(`${tag} ${m}`, x),
  };
}

/** Walk a directory for JSON manifests and register a
 *  `preSystemPrompt` hook for each that has `systemPromptAppend`.
 *  We do NOT take over the full `loadExtensions` flow — that's
 *  the existing JSON-manifest pipeline (commands / tools /
 *  bashAllowlist). We just give JSON extensions a way to
 *  participate in the hook system for parity with TS. */
async function loadJsonHooks(dir: string, registry: ExtensionRegistry, logger: ExtensionLogger): Promise<{ loaded: number; errors: Array<{ path: string; name?: string; error: string }> }> {
  if (!existsSync(dir)) return { loaded: 0, errors: [] };
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return { loaded: 0, errors: [] }; }
  const errors: Array<{ path: string; name?: string; error: string }> = [];
  let loaded = 0;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const p = join(dir, name);
    let raw: string;
    try { raw = await import("node:fs").then((m) => m.readFileSync(p, "utf-8")); } catch (e) {
      errors.push({ path: p, error: (e as Error).message });
      continue;
    }
    let m: unknown;
    try { m = JSON.parse(raw); } catch (e) {
      errors.push({ path: p, error: `invalid JSON: ${(e as Error).message}` });
      continue;
    }
    if (!m || typeof m !== "object") {
      errors.push({ path: p, error: "manifest is not an object" });
      continue;
    }
    const obj = m as Record<string, unknown>;
    const extName = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : basename(name, ".json");
    const sysAppend = typeof obj.systemPromptAppend === "string" ? obj.systemPromptAppend : undefined;
    if (sysAppend === undefined) {
      // No hook contribution; nothing to register, but not an
      // error. The full JSON loader (commands / tools) still
      // runs through the existing flow.
      continue;
    }
    // Register a preSystemPrompt hook that appends `sysAppend`
    // to the system prompt. The handler is a closure bound
    // to this JSON file's path so reloads don't leak.
    const captured = sysAppend;
    const capturedPath = p;
    registry.register<import("./registry.js").PreSystemPromptPayload, string | undefined>(extName, "preSystemPrompt", (payload) => {
      if (payload.system.includes(captured)) return payload.system; // already appended
      return payload.system + "\n\n" + captured;
    });
    logger.info(`registered preSystemPrompt hook from ${capturedPath}`);
    loaded += 1;
  }
  return { loaded, errors };
}

/** Top-level entrypoint. Walks the user + project dirs, loads
 *  TS + JSON entries, registers their hooks on the supplied
 *  registry, and returns a summary. Errors are isolated per
 *  extension — a failure on one file does not affect the
 *  others. */
export async function loadExtensionsIntoRegistry(opts: LoadOptions): Promise<LoadResult> {
  const logger: ExtensionLogger = opts.logger ?? defaultLogger();
  const errors: Array<{ path: string; name?: string; error: string }> = [];
  const extensions: LoadedExtension[] = [];
  let tsLoaded = 0;
  let jsonLoaded = 0;

  // ---- JSON hooks (parity with TS) ----
  // Project first so user overrides win on collision.
  const projectJson = await loadJsonHooks(opts.projectDir, opts.registry, logger);
  const userJson = await loadJsonHooks(opts.userDir, opts.registry, logger);
  jsonLoaded = projectJson.loaded + userJson.loaded;
  errors.push(...projectJson.errors, ...userJson.errors);

  // ---- TS entries ----
  const dirs: Array<{ dir: string; source: "user" | "project" }> = [
    { dir: opts.projectDir, source: "project" },
    { dir: opts.userDir, source: "user" },
  ];
  for (const { dir, source } of dirs) {
    const files = findTsEntryPoints(dir);
    for (const file of files) {
      // Skip files inside dirs whose entrypoint path includes
      // path traversal — defense in depth.
      if (!file.startsWith(resolve(dir) + sep) && !file.startsWith(resolve(dir))) continue;
      try {
        const ext = await loadTsExtension(file, { cwd: dir, registry: opts.registry, logger });
        extensions.push(ext);
        tsLoaded += 1;
        logger.info(`loaded TS extension "${ext.name}" (${ext.version}) from ${file}`);
      } catch (e) {
        const err = e as Error;
        const fallbackName = basename(dirname(file)) !== "." ? basename(dirname(file)) : basename(file, file.slice(file.lastIndexOf(".")));
        errors.push({ path: file, name: fallbackName, error: err.message });
        logger.error(`failed to load extension from ${file}: ${err.message}`);
      }
    }
    // mark unused to satisfy linter
    void source;
  }

  return { tsLoaded, jsonLoaded, errors, extensions };
}

function defaultLogger(): ExtensionLogger {
  return {
    debug: (m, x) => defaultLog.debug(`[ext] ${m}`, x),
    info: (m, x) => defaultLog.info(`[ext] ${m}`, x),
    warn: (m, x) => defaultLog.warn(`[ext] ${m}`, x),
    error: (m, x) => defaultLog.error(`[ext] ${m}`, x),
  };
}
