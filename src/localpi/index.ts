// localpi patterns. Borrowed from dutifuldev/localpi (MIT).
// https://github.com/dutifuldev/localpi
//
// Self-contained reference module. See docs/localpi-patterns.md for the
// design rules, attribution, and integration guide.

export { asObject, optionalString, requiredString, asArray, optionalPositiveInteger, optionalStringArray } from "./common/json.js";
export type { JsonObject } from "./common/json.js";
export { ok, fail, errorMessage } from "./common/result.js";
export type { CommandResult } from "./common/result.js";
