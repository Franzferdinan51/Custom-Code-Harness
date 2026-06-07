// web_search tool — DuckDuckGo HTML scrape (no API key needed).
// Returns up to N results with title, url, and snippet.

import type { Tool, ToolContext } from "./registry.js";
import { asNumber, asString, parseToolArgs } from "./registry.js";
import type { ToolSpec } from "../../types.js";

interface SearchArgs {
  query: string;
  max_results?: number;
}

const spec: ToolSpec = {
  name: "web_search",
  description:
    "Search the web via DuckDuckGo. Returns up to N results with title, URL, and snippet. " +
    "No API key required. Note: rate-limited by DDG; consider Firecrawl or another provider for production use.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      max_results: { type: "number", description: "Max results to return. Default 8, max 25." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const webSearchTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("web_search", JSON.stringify(rawArgs));
    return {
      query: asString(a.query, "query", { allowEmpty: false, maxLen: 500 }),
      max_results: a.max_results !== undefined ? asNumber(a.max_results, "max_results", { integer: true, min: 1, max: 25 }) : 8,
    } as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const args = rawArgs as unknown as SearchArgs;
    try {
      const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(args.query);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      const onAbort = () => ctrl.abort(ctx.signal.reason);
      if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "codingharness/0.1" },
          body: "q=" + encodeURIComponent(args.query),
          signal: ctrl.signal,
        });
        const html = await res.text();
        const results = parseDuckDuckGo(html, args.max_results ?? 8);
        const body = results.length === 0
          ? "(no results)"
          : results.map((r, i) => (i + 1) + ". " + r.title + "\n   " + r.url + "\n   " + r.snippet).join("\n\n");
        return { toolCallId: "", display: "search: " + results.length + " result" + (results.length === 1 ? "" : "s"), content: body, isError: false };
      } finally {
        clearTimeout(t);
        ctx.signal.removeEventListener("abort", onAbort);
      }
    } catch (e) {
      return { toolCallId: "", display: "web_search failed", content: "web_search failed: " + (e as Error).message, isError: true };
    }
  },
};

function parseDuckDuckGo(html: string, max: number): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  // Each result lives in <a class="result__a" href="...">title</a>
  // with a snippet in <a class="result__snippet">...</a>.
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const titles: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html))) {
    titles.push({ url: decodeEntities(m[1] ?? ""), title: stripTags(m[2] ?? "") });
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html))) {
    snippets.push(stripTags(m[1] ?? ""));
  }
  for (let i = 0; i < Math.min(titles.length, max); i++) {
    out.push({ title: titles[i]?.title ?? "", url: titles[i]?.url ?? "", snippet: snippets[i] ?? "" });
  }
  return out;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
