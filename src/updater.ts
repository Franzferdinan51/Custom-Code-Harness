// Self-update. Pulls the latest source (or upgrades the npm package),
// rebuilds, and reports what changed.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c } from "./ui/colors.js";
import { log } from "./util/logger.js";

export interface UpdateOpts {
  cwd: string;
  channel: string;
  checkOnly?: boolean;
}

const PKG_VERSION = "0.2.0";

export async function runUpdate(opts: UpdateOpts): Promise<number> {
  const repoRoot = findRepoRoot(opts.cwd);
  if (!repoRoot) {
    process.stderr.write(c.red("error: ") + "CodingHarness was not installed from a git repo.\n");
    process.stderr.write("To update an npm install, run: npm install -g codingharness@latest\n");
    return 1;
  }
  process.stdout.write("CodingHarness updater (channel: " + opts.channel + ")\n");
  process.stdout.write("Repo: " + repoRoot + "\n");
  process.stdout.write("Current version: " + PKG_VERSION + "\n\n");

  if (!existsSync(join(repoRoot, ".git"))) {
    process.stderr.write(c.red("error: ") + "no .git directory at " + repoRoot + "\n");
    return 1;
  }

  // 1. Check current branch and remote.
  let branch = "main";
  try {
    branch = execFileSync("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8", timeout: 5_000 }).trim();
  } catch (e) { log.warn("could not read branch", e); }

  // 2. Fetch latest.
  try {
    process.stdout.write("→ git fetch origin...\n");
    execFileSync("git", ["-C", repoRoot, "fetch", "origin", branch], { encoding: "utf-8", stdio: "inherit", timeout: 60_000 });
  } catch (e) {
    process.stderr.write(c.red("error: ") + "git fetch failed: " + (e as Error).message + "\n");
    return 1;
  }

  // 3. Show what's coming.
  let behind = 0;
  try {
    const out = execFileSync("git", ["-C", repoRoot, "rev-list", "--count", "HEAD..origin/" + branch], { encoding: "utf-8", timeout: 5_000 }).trim();
    behind = parseInt(out, 10) || 0;
  } catch { behind = 0; }

  if (behind === 0) {
    process.stdout.write(c.green("✓ ") + "already up to date (HEAD == origin/" + branch + ")\n");
    if (opts.checkOnly) return 0;
    process.stdout.write("(rebuilding anyway)\n");
  } else {
    process.stdout.write("→ " + behind + " new commit" + (behind === 1 ? "" : "s") + " available\n");
    if (opts.checkOnly) {
      process.stdout.write("Run `ch update` to apply.\n");
      return 0;
    }
    // 4. Pull with rebase (or just merge — rebase keeps history linear).
    try {
      process.stdout.write("→ git pull --rebase origin " + branch + "...\n");
      execFileSync("git", ["-C", repoRoot, "pull", "--rebase", "origin", branch], { encoding: "utf-8", stdio: "inherit", timeout: 60_000 });
    } catch (e) {
      process.stderr.write(c.yellow("warning: ") + "git pull --rebase failed; falling back to merge: " + (e as Error).message + "\n");
      try {
        execFileSync("git", ["-C", repoRoot, "pull", "origin", branch], { encoding: "utf-8", stdio: "inherit", timeout: 60_000 });
      } catch (e2) {
        process.stderr.write(c.red("error: ") + "git pull failed: " + (e2 as Error).message + "\n");
        process.stderr.write("Resolve conflicts manually, then run: ch update\n");
        return 1;
      }
    }
  }

  // 5. Reinstall dependencies.
  process.stdout.write("→ npm install...\n");
  try {
    execFileSync("npm", ["install"], { cwd: repoRoot, encoding: "utf-8", stdio: "inherit", timeout: 300_000 });
  } catch (e) {
    process.stderr.write(c.red("error: ") + "npm install failed: " + (e as Error).message + "\n");
    return 1;
  }

  // 6. Rebuild.
  process.stdout.write("→ npm run build...\n");
  try {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, encoding: "utf-8", stdio: "inherit", timeout: 120_000 });
  } catch (e) {
    process.stderr.write(c.red("error: ") + "npm run build failed: " + (e as Error).message + "\n");
    return 1;
  }

  // 7. Re-link globally (if it was linked).
  try {
    process.stdout.write("→ npm link...\n");
    execFileSync("npm", ["link"], { cwd: repoRoot, encoding: "utf-8", stdio: "inherit", timeout: 60_000 });
  } catch (e) {
    process.stderr.write(c.yellow("warning: ") + "npm link failed (you may need to run it manually): " + (e as Error).message + "\n");
  }

  // 8. Print the new version.
  let newVersion = PKG_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    newVersion = pkg.version;
  } catch { /* ignore */ }
  process.stdout.write("\n" + c.green("✓ ") + "updated to v" + newVersion + "\n");

  // 9. Print the latest 10 commit messages so the user can see what changed.
  try {
    const out = execFileSync("git", ["-C", repoRoot, "log", "--oneline", "-10"], { encoding: "utf-8", timeout: 5_000 }).trim();
    if (out) {
      process.stdout.write("\nRecent changes:\n");
      for (const line of out.split("\n")) process.stdout.write("  " + line + "\n");
    }
  } catch { /* ignore */ }

  process.stdout.write("\nRestart any running 'ch' sessions to pick up the new build.\n");
  return 0;
}

/** Walk up looking for a package.json with "name": "codingharness". */
function findRepoRoot(start: string): string | null {
  let cur = start;
  for (let i = 0; i < 16; i++) {
    const p = join(cur, "package.json");
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, "utf-8"));
        if (j.name === "codingharness") return cur;
      } catch { /* ignore */ }
    }
    const parent = join(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/** Async version of the above — runs the git pull in a child and
 *  returns a promise so we don't block the event loop. */
export function runUpdateAsync(opts: UpdateOpts): Promise<number> {
  return new Promise<number>((resolve) => {
    const repoRoot = findRepoRoot(opts.cwd);
    if (!repoRoot) { resolve(runUpdate(opts)); return; }
    const child = spawn("node", [join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), "src/cli.ts", "update"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
