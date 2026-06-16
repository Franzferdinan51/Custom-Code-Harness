// Extension context. The handle an extension receives inside its
// `default activate(ctx)` function. Lets it register hook handlers,
// log, and dispose cleanly on teardown.
//
// The context is intentionally narrow: extensions do not get the
// runtime, the provider, the session, or any other "internal"
// surface. The only channel is the hook registry, accessed via
// `on()`. The `cwd` is exposed so extensions that read user files
// know where to look.
//
// The context is per-extension. One extension throwing inside an
// `on(...)` handler MUST NOT take down the agent loop — see
// `ExtensionRegistry.dispatch` for the isolation contract.

import type {
  ExtensionHookName,
  PreSystemPromptPayload,
  PostToolResultPayload,
  OnErrorPayload,
  OnCompactionPayload,
  ExtensionHandler,
} from "./registry.js";

/** A small logger surface extensions can use. Mirrors the shape of
 *  `src/util/logger.ts` so callers can pass `log` directly, but kept
 *  as a structural type so tests can pass a stub without importing
 *  the singleton. */
export interface ExtensionLogger {
  debug: (msg: string, extra?: unknown) => void;
  info: (msg: string, extra?: unknown) => void;
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
}

/** The manifest shape an extension exports alongside its `default`
 *  function. The loader validates this — anything missing or
 *  wrong-shaped is rejected before `default(ctx)` is called. The
 *  `hooks` field is a hint (which hooks the extension intends to
 *  use) — actual handler routing is via `ctx.on(event, handler)`
 *  inside the activate function. */
export interface TsExtensionManifest {
  /** Required, unique-ish extension name. The loader fills it in
   *  from the directory name if the export is missing. */
  name: string;
  /** Optional semver string. */
  version?: string;
  /** Optional human-readable description (shown by /ext list, if
   *  we ever add that). */
  description?: string;
  /** Hint for which hooks the extension intends to register.
   *  The keys are `ExtensionHookName`; the values are reserved
   *  for future routing (the pi-style convention uses
   *  "default" / named-export names). The harness currently
   *  only validates the shape — actual handler binding is via
   *  `ctx.on(...)` inside `activate()`. */
  hooks?: Partial<Record<ExtensionHookName, string>>;
}

/** Narrow event-name → handler-type map. Keeps `ctx.on<H>(event, handler)`
 *  typed correctly. */
export interface ExtensionHandlerMap {
  preSystemPrompt: ExtensionHandler<PreSystemPromptPayload, string | undefined>;
  postToolResult: ExtensionHandler<PostToolResultPayload, void>;
  onError: ExtensionHandler<OnErrorPayload, void>;
  onCompaction: ExtensionHandler<OnCompactionPayload, void>;
}

/** The handle passed to an extension's `default activate(ctx)`. */
export interface ExtensionContext {
  /** The extension's name (from manifest, or directory fallback). */
  readonly name: string;
  /** The extension's declared version, or "0.0.0" when missing. */
  readonly version: string;
  /** A frozen snapshot of the validated manifest, for
   *  introspection. The `hooks` field is a deep-copy so the
   *  extension can't mutate the loader's copy. */
  readonly manifest: Readonly<TsExtensionManifest>;
  /** The working directory the extension was loaded from. For
   *  `~/.codingharness/extensions/<name>/` this is the parent
   *  (`~/.codingharness/extensions/`); for project-local
   *  `<cwd>/.codingharness/extensions/<name>/` it's the
   *  project's `.codingharness/extensions/`. Extensions that
   *  read user files should use this as the relative root. */
  readonly cwd: string;
  /** The file the loader imported. Useful for resolving
   *  sibling files (e.g. `readFileSync(path.join(dirname(ctx.entrypoint), "data.json"))`). */
  readonly entrypoint: string;
  /** Logger bound to the extension name. */
  readonly logger: ExtensionLogger;
  /** Register a hook handler. Throws on unknown hook names; returns
   *  an unsubscribe function. The same handler reference can be
   *  registered multiple times (de-duplicated). */
  on<H extends ExtensionHookName>(
    event: H,
    handler: ExtensionHandlerMap[H],
  ): () => void;
  /** Imperative teardown. Calls dispose on every registered handler
   *  the extension itself added (NOT other extensions' handlers),
   *  clears internal state, and removes the context's
   *  reference. Idempotent. */
  dispose(): Promise<void>;
  /** True after `dispose()` has been called. */
  readonly disposed: boolean;
}

/** Disposable interface — handlers can return a cleanup function
 *  that runs on context teardown. */
export type Dispose = () => void;
