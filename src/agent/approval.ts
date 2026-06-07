// Bash command approval flow.
//
// Before running a bash command, we check it against a configurable
// allowlist / blocklist of patterns. If a pattern matches and the
// command is NOT auto-allowed, we return an "ask" decision — the
// runtime (or TUI) is expected to surface a confirmation prompt.
//
// Modes:
//   - "off"      never ask, run everything
//   - "allowlist" ask unless the command matches the allowlist
//   - "blocklist" ask if the command matches the blocklist
//   - "on-mutation" ask if the command looks like it could mutate
//                   state (writes, deletes, installs, etc.)
//   - "ask"      always ask
//
// v1 ships with a sane "on-mutation" default that catches the usual
// foot-guns (rm -rf, git push --force, etc.) without being annoying.

export type ApprovalMode = "off" | "allowlist" | "blocklist" | "on-mutation" | "ask";

export interface ApprovalConfig {
  mode: ApprovalMode;
  /** Regexes the command must match to be auto-approved (when mode=allowlist). */
  allowlist: string[];
  /** Regexes that, when matched, always require confirmation. */
  blocklist: string[];
  /** Override the per-command decision. */
  override?: "always-allow" | "always-ask";
}

/** Default mutation patterns — the obvious foot-guns. */
export const MUTATION_PATTERNS: RegExp[] = [
  // Destructive file ops
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?[\/~]/,                    // rm -rf /, rm -rf ~/...
  /\brm\s+-[a-zA-Z]*r/,                                          // any rm with -r
  /\brmdir\b/,
  /\bfind\s+.*-delete\b/,
  // Disk / system
  /\bmkfs(\.[a-z0-9]+)?\b/,
  /\bdd\s+if=/,
  /\bshred\b/,
  /\btruncate\b/,
  // Git
  /\bgit\s+push\s+(-f|--force(-with-lease)?)/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bgit\s+checkout\s+--\s+\./,
  /\bgit\s+branch\s+-D\b/,
  // Network
  /\bcurl\s+.*\|\s*(bash|sh)\b/,
  /\bwget\s+.*\|\s*(bash|sh)\b/,
  // Package install (broad)
  /\b(npm|pnpm|yarn|bun|pip)\s+(install|i|add)\b/,
  /\bbrew\s+install\b/,
  /\bapt(-get)?\s+install\b/,
  // System control
  /\b(sudo|doas)\b/,
  /\b(chmod|chown)\s+(-R\s+)?[0-7]{3,4}/,
  /\bsystemctl\s+(start|stop|restart|enable|disable)\b/,
  /\bkill\s+-9\s+(-1\s+)?/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  // Eval
  /\beval\s+/,
  // Process exec with shell
  /\bexec\s+/,
];

/** Patterns that are ALWAYS safe (read-only). When mode=allowlist, these auto-allow. */
export const SAFE_PATTERNS: RegExp[] = [
  /^\s*(ls|cat|head|tail|less|more|file|stat|wc|grep|rg|ag|find\s+[^\n]*-name|pwd|echo|date|whoami|hostname|uname|env|which|whereis|man|info|help|history|top|htop|ps|uptime|df|du|free|vmstat|netstat|ss|ip|ifconfig|route|ping|traceroute|dig|nslookup|curl\s+-[A-Z]+(\s+-[A-Z]+)*\s+["']?https?:\/\/[^\s"']+["']?(\s*$|\s*[|>])\s*(head|tail|less|grep|rg|jq|python[23]?\s+-c)\s*)/,
  /^\s*git\s+(status|log|diff|show|branch|remote|fetch|stash\s+list|tag\s+list|ls-files|rev-parse|config\s+--get|rev-list)\b/,
  /^\s*(node|bun|deno|tsx|ts-node|python|python3|ruby|go|cargo|rustc|gcc|clang|make)\s+--?(version|help|V)\b/,
];

/** Decide whether a command needs user approval. */
export function needsApproval(command: string, cfg: ApprovalConfig): {
  decision: "allow" | "ask";
  reason?: string;
} {
  if (cfg.override === "always-allow") return { decision: "allow", reason: "override: always-allow" };
  if (cfg.override === "always-ask") return { decision: "ask", reason: "override: always-ask" };

  const trimmed = command.trim();

  if (cfg.mode === "off") return { decision: "allow" };
  if (cfg.mode === "ask") return { decision: "ask", reason: "mode=ask" };

  if (cfg.mode === "allowlist") {
    // Auto-allow if the command matches the allowlist OR a SAFE_PATTERN.
    if (matchesAny(trimmed, cfg.allowlist.map((p) => new RegExp(p)))) {
      return { decision: "allow", reason: "matched allowlist" };
    }
    if (matchesAny(trimmed, SAFE_PATTERNS)) {
      return { decision: "allow", reason: "matched safe pattern" };
    }
    return { decision: "ask", reason: "no allowlist match" };
  }

  if (cfg.mode === "blocklist") {
    if (matchesAny(trimmed, cfg.blocklist.map((p) => new RegExp(p)))) {
      return { decision: "ask", reason: "matched blocklist" };
    }
    return { decision: "allow" };
  }

  // mode === "on-mutation"
  if (matchesAny(trimmed, cfg.blocklist.map((p) => new RegExp(p)))) {
    return { decision: "ask", reason: "matched blocklist" };
  }
  if (matchesAny(trimmed, MUTATION_PATTERNS)) {
    return { decision: "ask", reason: "matched mutation pattern" };
  }
  return { decision: "allow" };
}

function matchesAny(command: string, patterns: RegExp[]): boolean {
  for (const p of patterns) {
    if (p.test(command)) return true;
  }
  return false;
}

/** Default config. */
export const DEFAULT_APPROVAL: ApprovalConfig = {
  mode: "on-mutation",
  allowlist: [],
  blocklist: [],
};
