// Runtime info snapshot — a single function that pretty-prints a
// structured view of the running install. Shared between the `/info`
// slash command and the `ch info` CLI subcommand so the two surfaces
// never drift.
//
// Consumers: src/slash/builtin.ts (infoCommand), src/cli.ts (runInfoCmd).

import { execFileSync } from "node:child_process";
import { loadSettings } from "../config/settings.js";
import { paths } from "../config/paths.js";

const VERSION = "0.2.2";

export interface RuntimeInfo {
  version: string;
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  cwd: string;
  home: string;
  paths: {
    settings: string;
    sessions: string;
    logs: string;
    memory: string;
    skills: string;
    agents: string;
  };
  cliPath: string;
  defaultProvider: string | null;
  defaultModel: string | null;
  thinking: string;
  approvalMode: string;
  providersConfigured: string[];
}

export function collectRuntimeInfo(cwd: string): RuntimeInfo {
  const settings = loadSettings();
  let cliPath = "";
  try {
    cliPath = execFileSync("which", ["ch"], { encoding: "utf-8", timeout: 2_000 }).trim();
  } catch { /* ch not on PATH — leave empty */ }
  return {
    version: VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd,
    home: paths.home,
    paths: {
      settings: paths.settings,
      sessions: paths.sessions,
      logs: paths.logs,
      memory: paths.memory,
      skills: paths.skills,
      agents: paths.agents,
    },
    cliPath: cliPath || "(not on PATH)",
    defaultProvider: settings.defaultProvider ?? null,
    defaultModel: settings.defaultModel ?? null,
    thinking: settings.thinking ?? "medium",
    approvalMode: settings.approval?.mode ?? "off",
    providersConfigured: Object.keys(settings.providers ?? {}),
  };
}

export function renderRuntimeInfo(cwd: string): string {
  const info = collectRuntimeInfo(cwd);
  const lines: string[] = [];
  lines.push("CodingHarness " + info.version);
  lines.push("");
  lines.push("  node:      " + info.node + " (" + info.platform + "/" + info.arch + ")");
  lines.push("  cli:       " + info.cliPath);
  lines.push("  cwd:       " + info.cwd);
  lines.push("  home:      " + info.home);
  lines.push("");
  lines.push("Settings (" + info.paths.settings + "):");
  lines.push("  provider:  " + (info.defaultProvider ?? "(unset)"));
  lines.push("  model:     " + (info.defaultModel ?? "(unset)"));
  lines.push("  thinking:  " + info.thinking);
  lines.push("  approval:  " + info.approvalMode);
  if (info.providersConfigured.length > 0) {
    lines.push("  providers: " + info.providersConfigured.join(", "));
  } else {
    lines.push("  providers: (none — set OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)");
  }
  lines.push("");
  lines.push("Paths:");
  lines.push("  sessions:  " + info.paths.sessions);
  lines.push("  logs:      " + info.paths.logs);
  lines.push("  memory:    " + info.paths.memory);
  lines.push("  skills:    " + info.paths.skills);
  lines.push("  agents:    " + info.paths.agents);
  lines.push("");
  lines.push("Run `ch doctor` for health checks, `ch help` for all commands.");
  return lines.join("\n");
}
