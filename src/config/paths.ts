// Resolved filesystem paths for CodingHarness state.
// All state lives under $CH_HOME (default ~/.codingharness) so the
// tool is self-contained and easy to wipe.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

function expand(p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  return p;
}

function home(): string {
  return process.env.CODINGHARNESS_HOME
    ? expand(process.env.CODINGHARNESS_HOME)
    : process.env.CH_HOME
    ? expand(process.env.CH_HOME)
    : join(homedir(), ".codingharness");
}

/** All paths. Evaluated lazily so tests can override $CH_HOME. */
export const paths = {
  get home() { return home(); },
  get settings() { return join(home(), "settings.json"); },
  get providers() { return join(home(), "providers.json"); },
  get sessions() { return join(home(), "sessions"); },
  get logs() { return join(home(), "logs"); },
  get cache() { return join(home(), "cache"); },
  get extensions() { return join(home(), "extensions"); },
  get prompts() { return join(home(), "prompts"); },
  get skills() { return join(home(), "skills"); },
  get agents() { return join(home(), "agents"); },
  get cron() { return join(home(), "cron"); },
  get memory() { return join(home(), "memory"); },
  get context() { return join(home(), "context"); },
} as const;

export function ensurePaths(): void {
  for (const dir of [paths.home, paths.sessions, paths.logs, paths.cache, paths.extensions, paths.prompts, paths.skills, paths.agents, paths.cron, paths.memory, paths.context]) {
    mkdirSync(dir, { recursive: true });
  }
}
