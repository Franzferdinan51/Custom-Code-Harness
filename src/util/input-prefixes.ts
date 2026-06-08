// OpenCode-style input prefixes for the TUI/REPL:
//   @path/to/file.ts  — inject file contents into the prompt
//   !ls -la           — run a shell one-liner and inject stdout/stderr

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { execFile } from "node:child_process";

export interface ExpandedInput {
  /** Final prompt sent to the model (prefix expansions prepended). */
  prompt: string;
  /** Non-empty when shell or file blocks were injected. */
  injectedBlocks: string[];
}

const AT_REF = /@([^\s@]+)/g;

function resolveRefPath(ref: string, cwd: string): string {
  const cleaned = ref.replace(/^['"]|['"]$/g, "");
  return isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
}

async function readRefFile(ref: string, cwd: string): Promise<string | null> {
  const path = resolveRefPath(ref, cwd);
  if (!existsSync(path)) return null;
  try {
    const body = await readFile(path, "utf-8");
    return [
      "<attached-file path=\"" + path + "\">",
      body,
      "</attached-file>",
    ].join("\n");
  } catch {
    return null;
  }
}

function runShellOneLiner(command: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    execFile(
      "bash",
      ["-lc", command],
      { cwd, maxBuffer: 512_000, timeout: 30_000 },
      (err, stdout, stderr) => {
        resolvePromise({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: err && typeof (err as NodeJS.ErrnoException).code === "number"
            ? (err as NodeJS.ErrnoException & { code: number }).code
            : err ? 1 : 0,
        });
      },
    );
  });
}

/**
 * Expand OpenCode-style `@file` and `!shell` prefixes.
 * Slash commands and empty input pass through unchanged.
 */
export async function expandInputPrefixes(raw: string, cwd: string): Promise<ExpandedInput> {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return { prompt: raw, injectedBlocks: [] };
  }

  const injected: string[] = [];

  // Leading `!command` — entire line is a shell injection (OpenCode).
  if (trimmed.startsWith("!")) {
    const command = trimmed.slice(1).trim();
    if (command) {
      const result = await runShellOneLiner(command, cwd);
      const block = [
        "<shell-output command=\"" + command + "\" exit=\"" + String(result.code ?? 0) + "\">",
        result.stdout.trimEnd(),
        result.stderr.trimEnd() ? "\n[stderr]\n" + result.stderr.trimEnd() : "",
        "</shell-output>",
      ].join("\n");
      injected.push(block);
      return { prompt: block, injectedBlocks: injected };
    }
  }

  // Inline `@file` references anywhere in the prompt.
  const refs = [...trimmed.matchAll(AT_REF)].map((m) => m[1]!).filter(Boolean);
  const uniqueRefs = [...new Set(refs)];
  for (const ref of uniqueRefs) {
    const block = await readRefFile(ref, cwd);
    if (block) injected.push(block);
  }

  if (injected.length === 0) {
    return { prompt: raw, injectedBlocks: [] };
  }

  const userText = trimmed.replace(AT_REF, (_m, ref: string) => {
    const path = resolveRefPath(ref, cwd);
    return "`" + path + "`";
  });

  const prompt = [
    ...injected,
    "",
    "User message:",
    userText,
  ].join("\n");

  return { prompt, injectedBlocks: injected };
}