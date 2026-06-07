// Small utilities for logging. Stays out of the way of the agent loop.

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const envLevel: Level = (process.env.CODINGHARNESS_DEBUG ? "debug" : "info") as Level;

function emit(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] < LEVELS[envLevel]) return;
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const line = `${ts} ${tag} ${msg}`;
  // Errors to stderr, everything else to stdout. TTY-friendly.
  if (level === "error" || level === "warn") {
    process.stderr.write(line + (extra !== undefined ? " " + safeJson(extra) : "") + "\n");
  } else {
    process.stdout.write(line + (extra !== undefined ? " " + safeJson(extra) : "") + "\n");
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
};
