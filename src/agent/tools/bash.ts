// bash: run a shell command. Always with a timeout (default 30s) and
// always with the AbortSignal plumbed through. We capture stdout and
// stderr separately and cap total output size — runaway commands used
// to be a big source of context-budget explosions.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { Tool, ToolContext } from "./registry.js";
import { asNumber, asString, parseToolArgs } from "./registry.js";
import type { ToolSpec } from "../../types.js";

const MAX_OUTPUT_BYTES = 200_000;

interface BashArgs {
  command: string;
  timeout_ms?: number;
}

const spec: ToolSpec = {
  name: "bash",
  description:
    "Run a shell command. The command runs in a child process with a timeout (default 30s). " +
    "Returns exit code, stdout, and stderr. Long output is truncated. Avoid interactive commands " +
    "(vim, less, ssh) — they will hang. Pass timeout_ms to override.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout_ms: { type: "number", description: "Max runtime in milliseconds. Default 30000, max 600000." },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

export const bashTool: Tool = {
  spec,
  validate(rawArgs) {
    const a = parseToolArgs("bash", JSON.stringify(rawArgs));
    const out: BashArgs = {
      command: asString(a.command, "command", { allowEmpty: false, maxLen: 200_000 }),
      timeout_ms: a.timeout_ms !== undefined ? asNumber(a.timeout_ms, "timeout_ms", { integer: true, min: 1, max: 600_000 }) : undefined,
    };
    return out as unknown as Record<string, unknown>;
  },
  async run(rawArgs, ctx: ToolContext) {
    const raw = rawArgs as unknown as BashArgs;
    const timeoutMs = raw.timeout_ms ?? ctx.limits.bashTimeoutMs;
    return await new Promise((resolveP) => {
      const child: ChildProcessByStdio<null, Readable, Readable> = spawn("bash", ["-lc", raw.command], {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const chunks: { stream: "out" | "err"; data: Buffer }[] = [];
      let outBytes = 0;
      let truncated = false;

      const onData = (stream: "out" | "err") => (chunk: Buffer) => {
        if (truncated) return;
        if (outBytes + chunk.length > MAX_OUTPUT_BYTES) {
          const allowed = Math.max(0, MAX_OUTPUT_BYTES - outBytes);
          if (allowed > 0) {
            chunks.push({ stream, data: chunk.subarray(0, allowed) });
            outBytes += allowed;
          }
          truncated = true;
          chunks.push({
            stream: "err",
            data: Buffer.from("\n... (truncated at " + MAX_OUTPUT_BYTES + " bytes total; command still running) ...\n"),
          });
          try { child.kill("SIGTERM"); } catch {}
          return;
        }
        chunks.push({ stream, data: chunk });
        outBytes += chunk.length;
      };
      child.stdout.on("data", onData("out"));
      child.stderr.on("data", onData("err"));

      let killed = false;
      const timer: NodeJS.Timeout = setTimeout(() => {
        killed = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5_000);
      }, timeoutMs);

      const onAbort = () => {
        killed = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1_000);
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolveP({
          toolCallId: "",
          display: "bash failed: " + err.message,
          content: "bash failed to start: " + err.message,
          isError: true,
        });
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        let stdout = "";
        let stderr = "";
        for (const c of chunks) {
          const s = c.data.toString("utf-8");
          if (c.stream === "out") stdout += s;
          else stderr += s;
        }
        const summary = killed
          ? "killed (" + (signal ?? "timeout") + ")"
          : "exit " + (code ?? 0);
        const header = "cwd: " + ctx.cwd + "\ntimeout: " + timeoutMs + "ms\n" + summary;
        const body = "--stdout--\n" + stdout + (stderr ? "\n--stderr--\n" + stderr : "");
        const isError = killed ? true : code !== 0;
        resolveP({
          toolCallId: "",
          display: "bash " + summary,
          content: header + "\n" + body,
          isError,
        });
      });
    });
  },
};
