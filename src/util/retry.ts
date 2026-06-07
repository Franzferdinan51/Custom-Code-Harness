// Generic retry with exponential backoff. Only retries on transient
// errors (network, 5xx, 429). Does NOT retry on 4xx auth errors.

import { log } from "./logger.js";

export interface RetryOpts {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** If provided, the retry only fires when this returns true. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

const defaultShouldRetry = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; status?: number; code?: string; message?: string };
  if (e.name === "AbortError") return false;
  if (e.code === "ENOTFOUND" || e.code === "ECONNRESET" || e.code === "ETIMEDOUT") return true;
  if (typeof e.status === "number") {
    if (e.status === 429) return true;
    if (e.status >= 500 && e.status < 600) return true;
    return false;
  }
  // Network-y messages from fetch failures.
  if (typeof e.message === "string") {
    if (/fetch failed|network|socket hang up/i.test(e.message)) return true;
  }
  return false;
};

export async function retry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const { maxAttempts = 3, baseMs = 400, maxMs = 8_000, shouldRetry = defaultShouldRetry } = opts;
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) throw err;
      const wait = Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      log.debug(`retry: attempt ${attempt} failed, waiting ${Math.round(wait)}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
