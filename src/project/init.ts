// Project detection for /init. Looks at the most common manifest
// files (package.json, Cargo.toml, pyproject.toml, go.mod, etc.) and
// returns a small `ProjectFacts` object the /init template uses to
// pre-fill the AGENTS.md. Detection is best-effort: missing files
// just don't contribute.
//
// This is a separate module so:
//   1. /init is the only caller today, but `ch doctor` and the future
//      `ch init --skill` command will want the same facts.
//   2. Tests can drive it against a fixture directory without spinning
//      up a whole CodingHarness runtime.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectFacts {
  /** Project name (from manifest or directory name). */
  name: string;
  /** One-line description (from manifest or README first line). */
  description: string;
  /** Detected ecosystem, in priority order. */
  stack:
    | "node"
    | "rust"
    | "python"
    | "go"
    | "ruby"
    | "java"
    | "dotnet"
    | "elixir"
    | "unknown";
  /** Build command discovered from the manifest. */
  buildCommand?: string;
  /** Test command discovered from the manifest. */
  testCommand?: string;
  /** Lint command discovered from the manifest. */
  lintCommand?: string;
  /** Typecheck command discovered from the manifest. */
  typecheckCommand?: string;
  /** License, if discoverable. */
  license?: string;
  /** Source roots (relative to cwd). */
  sourceRoots: string[];
  /** True if a tests/ or __tests__/ directory was found. */
  hasTests: boolean;
}

interface PackageJson {
  name?: string;
  description?: string;
  version?: string;
  license?: string | { type?: string };
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

interface CargoTomlPackage {
  name?: string;
  description?: string;
  license?: string;
}

interface PyprojectToml {
  name?: string;
  description?: string;
  license?: { text?: string };
  project?: {
    name?: string;
    description?: string;
    license?: string | { text?: string };
  };
}

interface GoMod {
  module?: string;
}

const NODE_SOURCE_ROOTS = ["src", "lib", "packages", "app"];
const RUST_SOURCE_ROOTS = ["src", "crates"];
const PYTHON_SOURCE_ROOTS = ["src", "lib", "app"];
const GO_SOURCE_ROOTS = ["cmd", "internal", "pkg"];
const RUBY_SOURCE_ROOTS = ["app", "lib", "src"];
const JAVA_SOURCE_ROOTS = ["src/main/java", "src"];
const DOTNET_SOURCE_ROOTS = ["src", "Source"];
const ELIXIR_SOURCE_ROOTS = ["lib"];

const TEST_DIRS = ["test", "tests", "__tests__", "spec"];

export function detectProject(cwd: string): ProjectFacts {
  const facts: ProjectFacts = {
    name: basename(cwd),
    description: "",
    stack: "unknown",
    sourceRoots: [],
    hasTests: false,
  };

  // Node / TypeScript — highest priority because package.json is most
  // descriptive. If both Node and Rust manifests exist (rare), Node wins
  // because `npm`/`pnpm` test commands are usually what the user wants.
  if (tryReadJson(join(cwd, "package.json"))) {
    populateFromPackageJson(facts, cwd);
  } else if (tryReadToml(join(cwd, "Cargo.toml"))) {
    populateFromCargoToml(facts, cwd);
  } else if (tryReadText(join(cwd, "pyproject.toml"))) {
    populateFromPyproject(facts, cwd);
  } else if (tryReadText(join(cwd, "go.mod"))) {
    populateFromGoMod(facts, cwd);
  } else if (tryReadText(join(cwd, "Gemfile"))) {
    populateFromGemfile(facts, cwd);
  } else if (
    existsSync(join(cwd, "pom.xml")) ||
    existsSync(join(cwd, "build.gradle")) ||
    existsSync(join(cwd, "build.gradle.kts"))
  ) {
    facts.stack = "java";
    facts.buildCommand = "mvn package  # or: gradle build";
    facts.testCommand = "mvn test     # or: gradle test";
    facts.sourceRoots = JAVA_SOURCE_ROOTS.filter((r) => existsSync(join(cwd, r)));
  } else if (findFirstFileWithSuffix(cwd, ".csproj") || findFirstFileWithSuffix(cwd, ".sln")) {
    facts.stack = "dotnet";
    facts.buildCommand = "dotnet build";
    facts.testCommand = "dotnet test";
    facts.sourceRoots = DOTNET_SOURCE_ROOTS.filter((r) => existsSync(join(cwd, r)));
  } else if (tryReadText(join(cwd, "mix.exs"))) {
    facts.stack = "elixir";
    facts.buildCommand = "mix compile";
    facts.testCommand = "mix test";
    facts.sourceRoots = ELIXIR_SOURCE_ROOTS.filter((r) => existsSync(join(cwd, r)));
  }

  // README: if we don't have a description, lift the first markdown
  // heading as a candidate. Cheap, almost always informative.
  if (!facts.description) {
    const readme = readFirstHeading(join(cwd, "README.md"))
      ?? readFirstHeading(join(cwd, "README"));
    if (readme) facts.description = readme;
  }

  // Tests. We look at the project root AND each detected source root
  // so monorepos and src/-heavy layouts (src/__tests__) are caught.
  const testProbes = [...TEST_DIRS, ...TEST_DIRS.map((d) => "src/" + d)];
  facts.hasTests = testProbes.some((d) => existsSync(join(cwd, d)));

  // Source roots: if we didn't pick any from the stack table, try
  // a generic guess so the template can mention them.
  if (facts.sourceRoots.length === 0) {
    for (const candidate of ["src", "lib", "app", "pkg", "cmd"]) {
      if (existsSync(join(cwd, candidate))) {
        facts.sourceRoots.push(candidate);
        break;
      }
    }
  }

  return facts;
}

// ---------- Template ----------

/** Render the AGENTS.md body for the given facts. Sections are
 *  omitted when there's nothing useful to put in them. */
export function renderAgentsTemplate(facts: ProjectFacts): string {
  const out: string[] = [];
  out.push("# " + (facts.name || "Project") + " — Agent Instructions");
  if (facts.description) {
    out.push("");
    out.push("> " + facts.description);
  }
  out.push("");
  out.push("This file is automatically loaded into every CodingHarness session started in this directory. Add project-specific conventions, common commands, and gotchas here so the agent has the same context you do.");
  out.push("");

  if (facts.buildCommand || facts.testCommand || facts.lintCommand || facts.typecheckCommand) {
    out.push("## Commands");
    out.push("");
    if (facts.buildCommand) out.push("- **Build:** `" + facts.buildCommand + "`");
    if (facts.testCommand) out.push("- **Test:** `" + facts.testCommand + "`");
    if (facts.lintCommand) out.push("- **Lint:** `" + facts.lintCommand + "`");
    if (facts.typecheckCommand) out.push("- **Typecheck:** `" + facts.typecheckCommand + "`");
    out.push("");
  } else {
    out.push("## Build / test commands");
    out.push("");
    out.push("- (add your build command here, e.g. `npm run build`)");
    out.push("- (add your test command here, e.g. `npm test`)");
    out.push("");
  }

  if (facts.stack !== "unknown") {
    out.push("## Stack");
    out.push("");
    out.push("- Language/build: **" + stackLabel(facts.stack) + "**");
    if (facts.sourceRoots.length > 0) {
      out.push("- Source roots: " + facts.sourceRoots.map((r) => "`" + r + "/`").join(", "));
    }
    if (facts.hasTests) {
      out.push("- Tests live in a top-level `test*` directory.");
    }
    out.push("");
  }

  if (facts.license) {
    out.push("## License");
    out.push("");
    out.push("This project is released under the **" + facts.license + "** license. Be respectful of it when generating or modifying code.");
    out.push("");
  }

  out.push("## Conventions");
  out.push("");
  out.push("- (style, formatting, naming, error handling — what should the agent do without being told?)");
  out.push("- (common gotchas: watch out for X, never edit Y directly, etc.)");
  out.push("");
  out.push("## How to verify a change");
  out.push("");
  out.push("1. Run the test command above.");
  if (facts.lintCommand || facts.typecheckCommand) {
    out.push("2. Run the lint / typecheck command(s).");
  }
  out.push("3. If you changed a public API, run the smoke script (if one exists) or exercise the changed path manually.");
  out.push("");
  return out.join("\n");
}

function stackLabel(stack: ProjectFacts["stack"]): string {
  switch (stack) {
    case "node": return "Node.js / TypeScript (npm, pnpm, or yarn)";
    case "rust": return "Rust (cargo)";
    case "python": return "Python (pip, poetry, or uv)";
    case "go": return "Go (go modules)";
    case "ruby": return "Ruby (bundler)";
    case "java": return "Java (Maven or Gradle)";
    case "dotnet": return ".NET (dotnet CLI)";
    case "elixir": return "Elixir (mix)";
    default: return "unknown";
  }
}

// ---------- Helpers ----------

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

function tryReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function tryReadJson(path: string): PackageJson | null {
  const raw = tryReadText(path);
  if (!raw) return null;
  try { return JSON.parse(raw) as PackageJson; } catch { return null; }
}

function tryReadToml(path: string): string | null {
  // We don't pull in a TOML library — /init only needs a couple of
  // fields and the manifest format is well-known enough to scrape
  // with regex when needed. Returns the raw text so populateFromCargoToml
  // can do its own extraction.
  return tryReadText(path);
}

function populateFromPackageJson(facts: ProjectFacts, cwd: string): void {
  const pkg = tryReadJson(join(cwd, "package.json"));
  if (!pkg) return;
  facts.stack = "node";
  if (pkg.name) facts.name = pkg.name;
  if (pkg.description) facts.description = pkg.description;
  if (typeof pkg.license === "string") facts.license = pkg.license;
  else if (typeof pkg.license === "object" && pkg.license?.type) facts.license = pkg.license.type;

  // Prefer real scripts over generic commands. Falls back to a
  // sensible default if the manifest doesn't define them.
  const scripts = pkg.scripts ?? {};
  facts.buildCommand = pickScript(scripts, ["build", "compile", "bundle"], "npm run build");
  facts.testCommand = pickScript(scripts, ["test", "test:unit"], "npm test");
  facts.lintCommand = pickScript(scripts, ["lint", "lint:fix"], undefined);
  facts.typecheckCommand = pickScript(scripts, ["typecheck", "tsc", "check:types"], undefined);

  facts.sourceRoots = NODE_SOURCE_ROOTS.filter((r) => existsSync(join(cwd, r)));
}

function pickScript(scripts: Record<string, string>, prefer: string[], fallback: string | undefined): string | undefined {
  for (const k of prefer) {
    if (scripts[k] && !scripts[k]!.includes("echo ")) return "npm run " + k;
  }
  return fallback;
}

function populateFromCargoToml(facts: ProjectFacts, cwd: string): void {
  const raw = tryReadToml(join(cwd, "Cargo.toml"));
  if (!raw) return;
  facts.stack = "rust";
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(raw);
  if (name) facts.name = name[1]!;
  const desc = /^\s*description\s*=\s*"([^"]+)"/m.exec(raw);
  if (desc) facts.description = desc[1]!;
  const lic = /^\s*license\s*=\s*"([^"]+)"/m.exec(raw);
  if (lic) facts.license = lic[1]!;
  facts.buildCommand = "cargo build";
  facts.testCommand = "cargo test";
  facts.lintCommand = "cargo clippy -- -D warnings";
  facts.typecheckCommand = "cargo check";
  facts.sourceRoots = RUST_SOURCE_ROOTS.filter((r) => existsSync(join(cwd, r)));
}

function populateFromPyproject(facts: ProjectFacts, cwd: string): void {
  const raw = tryReadToml(join(cwd, "pyproject.toml"));
  if (!raw) return;
  facts.stack = "python";
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(raw);
  if (name) facts.name = name[1]!;
  const desc = /^\s*description\s*=\s*"([^"]+)"/m.exec(raw);
  if (desc) facts.description = desc[1]!;
  const lic = /^\s*license\s*=\s*\{[^}]*text\s*=\s*"([^"]+)"/m.exec(raw);
  if (lic) facts.license = lic[1]!;
  // Test runner inference: prefer the framework hint in the manifest,
  // otherwise fall back to pytest (most common today).
  if (/pytest/i.test(raw)) facts.testCommand = "pytest";
  else if (/unittest/i.test(raw)) facts.testCommand = "python -m unittest discover";
  else facts.testCommand = "pytest";
  facts.lintCommand = "ruff check .";
  facts.typecheckCommand = "mypy .";
  facts.sourceRoots = PYTHON_SOURCE_ROOTS.filter((r) => existsSync(join(cwd, r)));
}

function populateFromGoMod(facts: ProjectFacts, cwd: string): void {
  const raw = tryReadText(join(cwd, "go.mod"));
  if (!raw) return;
  facts.stack = "go";
  const m = /^module\s+(\S+)/m.exec(raw);
  if (m) {
    const modPath = m[1]!;
    facts.name = modPath.split("/").pop() || modPath;
  }
  facts.buildCommand = "go build ./...";
  facts.testCommand = "go test ./...";
  facts.lintCommand = "go vet ./...";
  facts.typecheckCommand = "go build ./...";
  facts.sourceRoots = GO_SOURCE_ROOTS.filter((r) => existsSync(join(cwd, r)));
}

function populateFromGemfile(facts: ProjectFacts, cwd: string): void {
  const raw = tryReadText(join(cwd, "Gemfile"));
  if (!raw) return;
  facts.stack = "ruby";
  // Try to pull a name from the gemspec — best effort. The Node
  // filesystem API has no glob support, so we read the directory
  // listing and pick the first `.gemspec` we find.
  const gemspec = findFirstFileWithSuffix(cwd, ".gemspec");
  if (gemspec) {
    const g = tryReadText(join(cwd, gemspec));
    if (g) {
      const name = /\.name\s*=\s*["']([^"']+)/.exec(g);
      if (name) facts.name = name[1]!;
    }
  }
  facts.buildCommand = "bundle install";
  facts.testCommand = "bundle exec rspec  # or: bundle exec rake test";
  facts.sourceRoots = RUBY_SOURCE_ROOTS.filter((r) => existsSync(join(cwd, r)));
}

/** Return the basename of the first file in `cwd` whose name ends
 *  with `suffix`. Returns null if there is no such file. Used in
 *  place of glob patterns (which `fs.existsSync` and
 *  `fs.readFileSync` do not understand). The directory listing is
 *  read once and reused so a Ruby project that drops a
 *  `.gemspec` mid-run is picked up the next time the project
 *  is detected. */
function findFirstFileWithSuffix(cwd: string, suffix: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.endsWith(suffix)) return e;
  }
  return null;
}

function readFirstHeading(path: string): string | null {
  const raw = tryReadText(path);
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) {
      // Strip surrounding markdown noise.
      const t = m[1]!.replace(/[`*_]/g, "").trim();
      if (t.length > 0) return t;
    }
  }
  return null;
}
