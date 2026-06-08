// OpenCode-style attach client — connect a line REPL to a running
// `ch serve` instance so web, desktop, and terminal share one agent.

import { createInterface } from "node:readline";
import { c } from "./ui/colors.js";

export interface AttachClientOpts {
  baseUrl: string;
  onStatus?: (text: string) => void;
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("attach URL must start with http:// or https://");
  }
  return trimmed;
}

async function fetchJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(baseUrl + path, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json() as { error?: string };
      if (j.error) detail = j.error;
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  return await res.json() as T;
}

async function postApproval(baseUrl: string, id: string, decision: string): Promise<void> {
  await fetchJson(baseUrl, "/v1/approval/respond", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, decision }),
  });
}

function parseSseBlock(block: string): { event: string; data: string } {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return { event, data };
}

/** Attach an interactive REPL to `baseUrl` (e.g. http://127.0.0.1:7777). */
export async function runAttachClient(opts: AttachClientOpts): Promise<number> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  let status: { version?: string; model?: string; provider?: string };
  try {
    status = await fetchJson<{ version?: string; model?: string; provider?: string }>(baseUrl, "/v1/status");
  } catch (e) {
    process.stderr.write(c.red("attach failed: ") + (e as Error).message + "\n");
    process.stderr.write("Start a server first:  ch serve --port 7777\n");
    return 1;
  }

  const banner = [
    "Attached to " + baseUrl,
    "  provider: " + (status.provider ?? "—"),
    "  model:    " + (status.model ?? "—"),
    "  version:  " + (status.version ?? "—"),
    "",
    "Type a prompt to chat (shared session with web/desktop).",
    "Prefix tips (OpenCode-style):  @src/cli.ts   !git status",
    "Ctrl+C aborts the current turn · Ctrl+D quits.",
  ].join("\n");
  process.stdout.write(banner + "\n");
  opts.onStatus?.(banner);

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const prompt = c.cyan("attach") + c.gray(" › ");
  rl.setPrompt(prompt);

  let busy = false;
  let ac: AbortController | null = null;

  const streamPrompt = async (raw: string): Promise<void> => {
    ac = new AbortController();
    let pendingApproval: { id: string } | null = null;
    try {
      const res = await fetch(baseUrl + "/v1/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: raw }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        let detail = res.statusText;
        try {
          const j = await res.json() as { error?: string };
          if (j.error) detail = j.error;
        } catch { /* ignore */ }
        process.stdout.write(c.red("error: ") + detail + "\n");
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder("utf-8");
      let buf = "";
      process.stdout.write("\n");

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const { event, data } = parseSseBlock(block);
          if (!data) continue;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(data) as Record<string, unknown>; } catch { continue; }

          if (event === "text") {
            process.stdout.write(String(payload.text ?? ""));
          } else if (event === "reasoning") {
            process.stdout.write(c.dim(String(payload.text ?? "")));
          } else if (event === "tool_start") {
            process.stdout.write(c.dim("\n▸ " + String(payload.name ?? "tool") + "\n"));
          } else if (event === "tool_end") {
            const detail = String(payload.display ?? payload.detail ?? "");
            if (detail) process.stdout.write(c.dim(detail + "\n"));
          } else if (event === "info") {
            process.stdout.write(c.dim("\n· " + String(payload.text ?? "") + "\n"));
          } else if (event === "error") {
            process.stdout.write(c.red("\nerror: " + String(payload.text ?? "unknown") + "\n"));
          } else if (event === "approval_required") {
            pendingApproval = { id: String(payload.id ?? "") };
            process.stdout.write(c.yellow("\n⚠ approval required: ") + String(payload.command ?? "") + "\n");
            process.stdout.write("  (y) allow once  (a) always  (n) deny: ");
            const decision = await new Promise<string>((resolveDecision) => {
              const onLine = (answer: string) => {
                rl.off("line", onLine);
                const d = answer.trim().toLowerCase();
                if (d === "y" || d === "yes" || d === "a" || d === "always") {
                  resolveDecision(d.startsWith("a") ? "allow-always" : "allow-once");
                } else {
                  resolveDecision("deny");
                }
              };
              rl.once("line", onLine);
            });
            if (pendingApproval?.id) {
              await postApproval(baseUrl, pendingApproval.id, decision);
            }
            pendingApproval = null;
          }
        }
      }
      process.stdout.write("\n");
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        process.stdout.write(c.red("stream error: ") + (e as Error).message + "\n");
      }
    } finally {
      ac = null;
    }
  };

  return await new Promise<number>((resolve) => {
    const onSigInt = () => {
      if (busy && ac) {
        ac.abort();
        process.stdout.write(c.dim("\n(aborted)\n"));
      } else {
        rl.close();
        resolve(0);
      }
    };
    process.on("SIGINT", onSigInt);

    rl.on("line", async (line) => {
      const text = line.trim();
      if (!text) { rl.prompt(true); return; }
      if (busy) return;
      busy = true;
      try {
        await streamPrompt(text);
      } finally {
        busy = false;
        rl.prompt(true);
      }
    });

    rl.on("close", () => {
      process.removeListener("SIGINT", onSigInt);
      resolve(0);
    });

    rl.prompt();
  });
}