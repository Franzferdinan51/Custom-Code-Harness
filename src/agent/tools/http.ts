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
}

const MAX_DEFAULT = 500_000;
const DEFAULT_TIMEOUT_MS = 30_000;

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
      body: { type: "string", description: "Request body (optional)" },
      max_bytes: { type: "number", description: "Max response body bytes. Default 500000, max 5000000." },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

export const httpTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("http", JSON.stringify(rawArgs));
    return {
      url: asString(a.url, "url", { allowEmpty: false, maxLen: 4_096 }),
      method: a.method !== undefined ? asString(a.method, "method", { maxLen: 16 }) : "GET",
      headers_json: a.headers_json !== undefined ? asString(a.headers_json, "headers_json", { maxLen: 8_000 }) : undefined,
      body: a.body !== undefined ? asString(a.body, "body", { maxLen: 5_000_000 }) : undefined,
      max_bytes: a.max_bytes !== undefined ? asNumber(a.max_bytes, "max_bytes", { integer: true, min: 1, max: 5_000_000 }) : MAX_DEFAULT,
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
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
      const onAbort = () => ctrl.abort(ctx.signal.reason);
      if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(args.url, { method: args.method, headers, body: args.body, signal: ctrl.signal });
        const buf = await res.arrayBuffer();
        clearTimeout(t);
        ctx.signal.removeEventListener("abort", onAbort);
        const bytes = new Uint8Array(buf).subarray(0, args.max_bytes ?? MAX_DEFAULT);
        const text = new TextDecoder("utf-8").decode(bytes);
        const truncated = buf.byteLength > bytes.byteLength;
        return {
          toolCallId: "",
          display: "HTTP " + res.status,
          content: "HTTP " + res.status + " " + res.statusText + "\ncontent-type: " + (res.headers.get("content-type") ?? "") + "\nbytes: " + buf.byteLength + (truncated ? " (truncated to " + bytes.byteLength + ")" : "") + "\n\n" + text,
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
