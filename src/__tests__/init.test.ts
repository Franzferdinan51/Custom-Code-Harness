// Tests for the project-detection module that backs /init. Each test
// stands up a tiny fixture directory with the manifest(s) it cares
// about, runs detectProject() against it, and asserts the resulting
// ProjectFacts. No real manifest from the harness project is touched.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectProject, renderAgentsTemplate } from "../project/init.js";

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), "ch-init-" + prefix + "-"));
  return d;
}

function cleanup(d: string): void {
  rmSync(d, { recursive: true, force: true });
}

test("detectProject: empty directory returns unknown stack + dir basename", () => {
  const d = freshDir("empty");
  try {
    const facts = detectProject(d);
    assert.equal(facts.stack, "unknown");
    assert.ok(facts.name.length > 0);
    assert.equal(facts.sourceRoots.length, 0);
    assert.equal(facts.hasTests, false);
  } finally { cleanup(d); }
});

test("detectProject: package.json drives Node detection", () => {
  const d = freshDir("node");
  try {
    writeFileSync(join(d, "package.json"), JSON.stringify({
      name: "demo",
      description: "demo project",
      license: "MIT",
      scripts: { build: "tsc", test: "bun test", lint: "eslint ." },
    }));
    mkdirSync(join(d, "src"));
    const facts = detectProject(d);
    assert.equal(facts.stack, "node");
    assert.equal(facts.name, "demo");
    assert.equal(facts.description, "demo project");
    assert.equal(facts.license, "MIT");
    assert.equal(facts.buildCommand, "npm run build");
    assert.equal(facts.testCommand, "npm run test");
    assert.equal(facts.lintCommand, "npm run lint");
    assert.deepEqual(facts.sourceRoots, ["src"]);
  } finally { cleanup(d); }
});

test("detectProject: package.json falls back when scripts are missing", () => {
  const d = freshDir("node-bare");
  try {
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "bare" }));
    const facts = detectProject(d);
    assert.equal(facts.stack, "node");
    assert.equal(facts.buildCommand, "npm run build");
    assert.equal(facts.testCommand, "npm test");
    // Lint and typecheck are optional and should be undefined when the
    // manifest has no script for them.
    assert.equal(facts.lintCommand, undefined);
    assert.equal(facts.typecheckCommand, undefined);
  } finally { cleanup(d); }
});

test("detectProject: Cargo.toml drives Rust detection", () => {
  const d = freshDir("rust");
  try {
    writeFileSync(join(d, "Cargo.toml"), [
      "[package]",
      'name = "demo"',
      'description = "a cli"',
      'license = "MIT"',
      'edition = "2021"',
      "",
      "[dependencies]",
      'clap = "4"',
    ].join("\n"));
    mkdirSync(join(d, "src"));
    const facts = detectProject(d);
    assert.equal(facts.stack, "rust");
    assert.equal(facts.name, "demo");
    assert.equal(facts.description, "a cli");
    assert.equal(facts.license, "MIT");
    assert.equal(facts.buildCommand, "cargo build");
    assert.equal(facts.testCommand, "cargo test");
    assert.equal(facts.lintCommand, "cargo clippy -- -D warnings");
    assert.equal(facts.typecheckCommand, "cargo check");
    assert.deepEqual(facts.sourceRoots, ["src"]);
  } finally { cleanup(d); }
});

test("detectProject: pyproject.toml drives Python detection", () => {
  const d = freshDir("py");
  try {
    writeFileSync(join(d, "pyproject.toml"), [
      "[project]",
      'name = "demo"',
      'description = "python tool"',
      'license = {text = "Apache-2.0"}',
    ].join("\n"));
    const facts = detectProject(d);
    assert.equal(facts.stack, "python");
    assert.equal(facts.name, "demo");
    assert.equal(facts.license, "Apache-2.0");
    assert.equal(facts.testCommand, "pytest");
  } finally { cleanup(d); }
});

test("detectProject: pyproject.toml prefers pytest when mentioned", () => {
  const d = freshDir("py-pytest");
  try {
    writeFileSync(join(d, "pyproject.toml"), [
      "[project]",
      'name = "demo"',
      "[tool.pytest.ini_options]",
      'testpaths = ["tests"]',
    ].join("\n"));
    const facts = detectProject(d);
    assert.equal(facts.testCommand, "pytest");
  } finally { cleanup(d); }
});

test("detectProject: go.mod drives Go detection", () => {
  const d = freshDir("go");
  try {
    writeFileSync(join(d, "go.mod"), "module github.com/example/demo\n\ngo 1.22\n");
    const facts = detectProject(d);
    assert.equal(facts.stack, "go");
    assert.equal(facts.name, "demo");
    assert.equal(facts.buildCommand, "go build ./...");
    assert.equal(facts.testCommand, "go test ./...");
  } finally { cleanup(d); }
});

test("detectProject: README heading fills missing description", () => {
  const d = freshDir("readme");
  try {
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(d, "README.md"), "# My Awesome Tool\n\nThis is a tool.\n");
    const facts = detectProject(d);
    assert.equal(facts.description, "My Awesome Tool");
  } finally { cleanup(d); }
});

test("detectProject: tests/ directory is detected", () => {
  const d = freshDir("tests");
  try {
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x" }));
    mkdirSync(join(d, "tests"));
    const facts = detectProject(d);
    assert.equal(facts.hasTests, true);
  } finally { cleanup(d); }
});

test("detectProject: src/__tests__ is detected too", () => {
  const d = freshDir("src-tests");
  try {
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x" }));
    mkdirSync(join(d, "src"));
    mkdirSync(join(d, "src", "__tests__"));
    const facts = detectProject(d);
    assert.equal(facts.hasTests, true);
  } finally { cleanup(d); }
});

test("renderAgentsTemplate: includes commands when present", () => {
  const out = renderAgentsTemplate({
    name: "x",
    description: "",
    stack: "node",
    sourceRoots: ["src"],
    hasTests: true,
    buildCommand: "npm run build",
    testCommand: "npm test",
  });
  assert.match(out, /npm run build/);
  assert.match(out, /npm test/);
  // When commands exist, the placeholder line should NOT appear.
  assert.doesNotMatch(out, /add your build command here/);
  assert.match(out, /## Stack/);
  assert.match(out, /Node\.js/);
  assert.match(out, /## How to verify a change/);
});

test("renderAgentsTemplate: shows placeholder when commands are missing", () => {
  const out = renderAgentsTemplate({
    name: "x",
    description: "",
    stack: "unknown",
    sourceRoots: [],
    hasTests: false,
  });
  assert.match(out, /add your build command here/);
  assert.doesNotMatch(out, /## Stack/);
  // License section is omitted when license is unknown.
  assert.doesNotMatch(out, /## License/);
});

test("renderAgentsTemplate: shows License section when license is known", () => {
  const out = renderAgentsTemplate({
    name: "x",
    description: "",
    stack: "rust",
    sourceRoots: ["src"],
    hasTests: false,
    license: "MIT",
  });
  assert.match(out, /## License/);
  assert.match(out, /MIT/);
});
