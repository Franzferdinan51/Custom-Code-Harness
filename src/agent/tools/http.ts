// http tool — simple HTTP fetch with a timeout, response size cap,
// and content-type sniffing. Useful for hitting REST APIs.

import type { Tool, ToolContext } from "./registry.js";
import { asNumber, asString, parseToolArgs } from "./registry.js";
import { ToolError } from "../../util/errors.js";
import type { ToolSpec } from "../../types.js";

interface HttpArgs {
  url: string;
  method?: string;
  headers_json?: string;
  body?: string;
  max_bytes?: number;
  timeout_ms?: number;
}

const MAX_DEFAULT = 500_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const VALID_METHODS: ReadonlySet<string> = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
]);

const spec: ToolSpec = {
  name: "http",
  description:
    "Make an HTTP request. Returns status, content-type, and body (truncated to max_bytes). " +
    "Use http for REST APIs, not for general web pages (use web_search/web_fetch instead).",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      method: { type: "string", description: "HTTP method. Default GET." },
      headers_json: { type: "string", description: "JSON object of headers (optional)" },
      body: { type: "string", description: "Request body (optional, ignored for GET/DELETE/HEAD methods)" },
      max_bytes: { type: "number", description: "Max response body bytes. Default 500000, max 5000000." },
      timeout_ms: { type: "number", description: "Request timeout in milliseconds. Default 30000, max 300000 (5 min)." },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

export const httpTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("http", JSON.stringify(rawArgs));
    // Uppercase the method before validation. The HTTP spec
    // mandates uppercase, and Node's fetch uppercases internally
    // on the wire anyway — so accepting lowercase from the model
    // is harmless and matches user expectation. Pre-fix the
    // validate() accepted any string, so a typo like "POSTT"
    // sailed through to fetch and surfaced as a deep
    // "TypeError: fetch failed". Now: validate against the
    // standard set, fail fast with a clear message.
    const method = (a.method !== undefined ? asString(a.method, "method", { maxLen: 16 }) : "GET").toUpperCase();
    if (!VALID_METHODS.has(method)) {
      throw new Error("method: '" + method + "' not allowed; must be one of " + Array.from(VALID_METHODS).join(", "));
    }
    return {
      url: asString(a.url, "url", { allowEmpty: false, maxLen: 4_096 }),
      method,
      headers_json: a.headers_json !== undefined ? asString(a.headers_json, "headers_json", { maxLen: 8_000 }) : undefined,
      body: a.body !== undefined ? asString(a.body, "body", { maxLen: 5_000_000 }) : undefined,
      max_bytes: a.max_bytes !== undefined ? asNumber(a.max_bytes, "max_bytes", { integer: true, min: 1, max: 5_000_000 }) : MAX_DEFAULT,
      timeout_ms: a.timeout_ms !== undefined ? asNumber(a.timeout_ms, "timeout_ms", { integer: true, min: 1, max: MAX_TIMEOUT_MS }) : DEFAULT_TIMEOUT_MS,
    } as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const args = rawArgs as unknown as HttpArgs;
    try {
      const headers: Record<string, string> = {};
      if (args.headers_json) {
        try { Object.assign(headers, JSON.parse(args.headers_json)); }
        catch (e) { throw new ToolError("http", "headers_json: " + (e as Error).message); }
      }
      // GET/DELETE/HEAD are body-less by spec. Without this guard
      // fetch will happily send the body, and many servers (incl.
      // strict REST APIs and several CDNs) reject the request or
      // return a 411 Length Required. Matches the behavior of
      // `DelegationManager.runApiKind` in src/agent/delegation.ts.
      const method = (args.method ?? "GET").toUpperCase();
      const hasBody = args.body !== undefined && method !== "GET" && method !== "DELETE" && method !== "HEAD";
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), args.timeout_ms ?? DEFAULT_TIMEOUT_MS);
      const onAbort = () => ctrl.abort(ctx.signal.reason);
      if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(args.url, {
          method,
          headers,
          ...(hasBody ? { body: args.body } : {}),
          signal: ctrl.signal,
        });
        // Stream-read up to `max_bytes + 1` so we can report a
        // truncation flag WITHOUT loading the full response into
        // memory. Pre-fix: `await res.arrayBuffer()` materialized
        // the entire body before the cap was applied, so a 1 GB
        // hostile / runaway response would OOM the harness.
        const cap = args.max_bytes ?? MAX_DEFAULT;
        const overread = 1; // one extra byte so we can detect overflow
        const chunks: Uint8Array[] = [];
        let received = 0;
        let truncated = false;
        if (res.body) {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              if (received + value.byteLength > cap + overread) {
                const allowed = Math.max(0, cap + overread - received);
                if (allowed > 0) {
                  chunks.push(value.subarray(0, allowed));
                  received += allowed;
                }
                truncated = true;
                try { await reader.cancel(); } catch { /* best-effort */ }
                break;
              }
              chunks.push(value);
              received += value.byteLength;
              if (received >= cap) {
                truncated = (await reader.read()).value !== undefined;
                break;
              }
            }
          }
        }
        // Note: timer + abort listener are cleaned up in the
        // outer `finally` block. Pre-fix the same clearTimeout /
        // removeEventListener calls ran in the success path AND
        // in the finally block — `clearTimeout` is a no-op on a
        // fired timer and `removeEventListener` is a no-op on
        // a non-listening event, so this was harmless but
        // duplicative.
        const bytes = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
        const head = truncated ? bytes.subarray(0, cap) : bytes;
        const text = new TextDecoder("utf-8").decode(head);
        return {
          toolCallId: "",
          display: "HTTP " + res.status,
          content: "HTTP " + res.status + " " + res.statusText + "\ncontent-type: " + (res.headers.get("content-type") ?? "") + "\nbytes: " + received + (truncated ? " (truncated to " + cap + ")" : "") + "\n\n" + text,
          isError: res.status >= 400,
        };
      } finally {
        clearTimeout(t);
        ctx.signal.removeEventListener("abort", onAbort);
      }
    } catch (e) {
      return { toolCallId: "", display: "http failed", content: "http failed: " + (e as Error).message, isError: true };
    }
  },
};
