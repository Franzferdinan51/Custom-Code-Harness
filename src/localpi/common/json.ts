// JSON-at-boundary helpers. Borrowed from dutifuldev/localpi (MIT).
// https://github.com/dutifuldev/localpi/blob/main/src/common/json.ts
//
// All `unknown` JSON enters through one of these helpers; everything downstream
// is typed. Throws with a context string on malformed input.
// malformed input.

export type JsonObject = Readonly<Record<string, unknown>>;

export function asObject(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonObject;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function requiredString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }
  return value;
}

export function asArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array`);
  }
  return value;
}

export function optionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

export function optionalStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as readonly string[])
    : [];
}
