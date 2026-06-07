// Public surface for the slash-command machinery. Re-exports the
// registry interface and the built-in command set, so other parts
// of the harness (server, web UI) don't need to dig into the
// internal builtin.ts file.

export type { SlashCommand, SlashContext, SlashRuntime } from "./registry.js";
export { SlashRegistry, tryParseSlash } from "./registry.js";
export { BUILTIN_REGISTRY } from "./builtin.js";
