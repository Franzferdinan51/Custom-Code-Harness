// Provider setup wizard. The same code path powers:
//   - `/provider` (slash command, TUI): lists providers, shows a
//     setup card for one, or runs a multi-step wizard via follow-up
//     messages.
//   - `ch provider` (CLI subcommand): same flows, plus a real
//     `readline`-driven interactive `setup` subcommand that prompts
//     for the key without echo.
//
// We deliberately keep the wizard as plain text + parseable answers
// (rather than a fancy TUI component) so the same code can run
// inside the TUI, the simple REPL, and the headless CLI.

import type { ProviderPreset } from "../providers/presets.js";
import { getProviderPreset, listProviderPresets } from "../providers/presets.js";

/** Render the master "pick a provider" card. */
export function renderProviderList(): string {
  const lines: string[] = ["Provider setup — pick one:"];
  for (const p of listProviderPresets()) {
    const auth = p.authModes.join("/");
    const desc = p.description ?? "";
    lines.push("  /" + p.id.padEnd(10) + " — " + p.label + " (" + auth + ")");
    if (desc) lines.push("               " + desc);
  }
  lines.push("");
  lines.push("Then run:");
  lines.push("  /provider setup <id>           # guided setup");
  lines.push("  /provider setup <id> <api-key> # one-line setup");
  lines.push("  ch provider set-key <id> <key> # non-interactive");
  return lines.join("\n");
}

/** Render a single-provider setup card. The user reads this and
 *  then runs `/provider setup <id> <key>` (TUI/REPL) or feeds the
 *  answer to the wizard in the next message. */
export function renderProviderSetup(p: ProviderPreset): string {
  const lines: string[] = [];
  lines.push("Setup: " + p.label);
  if (p.description) lines.push("  " + p.description);
  lines.push("");
  lines.push("  base URL:  " + (p.defaultBaseUrl ?? "(required)"));
  lines.push("  model:     " + p.defaultModel);
  lines.push("  auth mode: " + p.defaultAuthMode);
  lines.push("  env vars:  " + p.apiKeyEnv.join(", "));
  if (p.authDocsUrl) lines.push("  docs:      " + p.authDocsUrl);
  lines.push("");
  lines.push("Two ways to give me the key:");
  lines.push("  1. Run:  /provider setup " + p.id + " <your-key>");
  lines.push("  2. Set:  " + p.apiKeyEnv[0] + "=<your-key>   (then restart)");
  lines.push("");
  lines.push("I'll test the connection with a tiny /diag after you save it.");
  return lines.join("\n");
}

/** Parse `/provider setup <id> [key]` arguments. Returns
 *  `{ providerId, apiKey? }` or `null` when malformed. */
export function parseProviderSetupArgs(args: string): { providerId: string; apiKey?: string } | null {
  const parts = args.trim().split(/\s+/).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const providerId = parts[0]!;
  if (!getProviderPreset(providerId)) return null;
  if (parts.length === 1) return { providerId };
  return { providerId, apiKey: parts.slice(1).join(" ") };
}

/** Format a provider id + a fresh key for one-line setup.
 *  Returns a string the user can paste in the next message. */
export function renderSetupHint(providerId: string): string {
  const p = getProviderPreset(providerId);
  if (!p) return "no such provider: " + providerId;
  return "Run:  /provider setup " + providerId + " <your-" + p.id + "-key>\n" +
    "Or:   " + p.apiKeyEnv[0] + "=<your-key>  (then restart)";
}
