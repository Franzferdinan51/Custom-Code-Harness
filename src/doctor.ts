// Doctor — diagnostics that surface common issues. Borrowed from
// Hermes (`hermes doctor`) and OpenClaw (`openclaw doctor`).

import { existsSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config/paths.js";
import { loadSettings } from "./config/settings.js";
import { ProviderRegistry } from "./providers/registry.js";
import { execFileSync } from "node:child_process";

export interface DiagnosticItem {
  name: string;
  status: "ok" | "warn" | "error" | "info";
  message: string;
  fix?: string;
}

export async function runDiagnostics(opts: { cwd: string } = { cwd: process.cwd() }): Promise<DiagnosticItem[]> {
  const out: DiagnosticItem[] = [];

  // 1. Node version
  const nodeMajor = parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  out.push({
    name: "Node.js",
    status: nodeMajor >= 18 ? "ok" : "error",
    message: "v" + process.versions.node + (nodeMajor >= 18 ? " (>= 18.17 required)" : " — please upgrade to Node 18+"),
  });

  // 2. Home directory
  try {
    const s = statSync(paths.home);
    out.push({ name: "Home dir", status: s.isDirectory() ? "ok" : "error", message: paths.home + " exists" });
  } catch {
    out.push({ name: "Home dir", status: "warn", message: paths.home + " not yet created (will be created on first run)" });
  }

  // 3. Writable home
  const probe = join(paths.home, ".doctor-probe-" + Date.now());
  try { writeFileSync(probe, "ok"); unlinkSync(probe); out.push({ name: "Home writable", status: "ok", message: paths.home + " is writable" }); }
  catch (e) { out.push({ name: "Home writable", status: "error", message: "cannot write to " + paths.home + ": " + (e as Error).message }); }

  // 4. ripgrep (recommended but not required)
  try {
    const v = execFileSync("rg", ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 }).trim();
    out.push({ name: "ripgrep", status: "ok", message: v.split("\n")[0] ?? "rg" });
  } catch {
    out.push({ name: "ripgrep", status: "info", message: "ripgrep not installed — CodingHarness falls back to a JS-based search" });
  }

  // 5. bash on PATH
  try {
    execFileSync("bash", ["-c", "echo ok"], { stdio: "ignore", timeout: 2_000 });
    out.push({ name: "bash", status: "ok", message: "available" });
  } catch {
    out.push({ name: "bash", status: "warn", message: "bash not on PATH — the bash tool will fail" });
  }

  // 6. Settings
  const settings = loadSettings();
  out.push({
    name: "Settings",
    status: settings.providers && Object.keys(settings.providers).length > 0 ? "ok" : "warn",
    message: settings.providers ? Object.keys(settings.providers).length + " provider(s) configured" : "no providers configured",
    fix: settings.providers && Object.keys(settings.providers).length === 0 ? "set OPENAI_API_KEY or ANTHROPIC_API_KEY, or add a profile to settings.json" : undefined,
  });

  // 7. Provider reachability (don't actually call the model; just check keys are present)
  const reg = new ProviderRegistry(settings);
  for (const id of reg.configuredIds()) {
    const p = reg.get(id);
    if (!p) { out.push({ name: "Provider " + id, status: "warn", message: "configured but could not be built (missing apiKey?)" }); continue; }
    const check = await p.isConfigured();
    out.push({ name: "Provider " + id, status: check.ok ? "ok" : "error", message: check.ok ? "configured" : (check.reason ?? "not configured") });
  }

  // 8. Default model
  if (settings.defaultProvider && settings.defaultModel) {
    out.push({ name: "Default", status: "ok", message: settings.defaultProvider + " / " + settings.defaultModel });
  } else {
    out.push({ name: "Default", status: "warn", message: "no default provider/model set", fix: "run /model or /provider inside ch" });
  }

  // 9. Sessions dir
  out.push({
    name: "Sessions dir",
    status: existsSync(paths.sessions) ? "ok" : "info",
    message: paths.sessions,
  });

  return out;
}

export function renderDiagnostics(items: DiagnosticItem[]): string {
  const icon = (s: DiagnosticItem["status"]): string => {
    switch (s) {
      case "ok": return "✓";
      case "warn": return "!";
      case "error": return "✗";
      case "info": return "·";
    }
  };
  const lines: string[] = ["CodingHarness doctor:", ""];
  for (const i of items) {
    lines.push("  " + icon(i.status) + " " + i.name + ": " + i.message);
    if (i.fix) lines.push("      fix: " + i.fix);
  }
  const errs = items.filter((i) => i.status === "error").length;
  const warns = items.filter((i) => i.status === "warn").length;
  lines.push("");
  lines.push("Summary: " + errs + " error(s), " + warns + " warning(s).");
  return lines.join("\n");
}
