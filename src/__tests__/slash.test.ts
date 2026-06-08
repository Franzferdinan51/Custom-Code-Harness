// Tests for slash command parsing and the registry.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_REGISTRY } from "../slash/builtin.js";
import { tryParseSlash } from "../slash/registry.js";
import { Session } from "../agent/session.js";

process.env.CODINGHARNESS_HOME = mkdtempSync(join(tmpdir(), "ch-slash-"));

test("tryParseSlash parses a basic command", () => {
  const r = tryParseSlash("/model gpt-5");
  assert.equal(r?.name, "model");
  assert.equal(r?.args, "gpt-5");
});

test("tryParseSlash handles args with multiple spaces", () => {
  const r = tryParseSlash("/goal   add a /healthcheck   --max-steps=5");
  assert.equal(r?.name, "goal");
  assert.equal(r?.args, "add a /healthcheck   --max-steps=5");
});

test("tryParseSlash returns null for non-slash input", () => {
  assert.equal(tryParseSlash("hello world"), null);
  assert.equal(tryParseSlash(""), null);
  // Leading whitespace is trimmed, so this is still parsed.
  assert.equal(tryParseSlash("  /model x")?.name, "model");
});

test("builtin registry has all expected commands", () => {
  const names = BUILTIN_REGISTRY.names();
  for (const want of ["commands", "help", "clear", "quit", "session", "resume", "model", "provider", "goal", "loop", "cost", "approval"]) {
    assert.ok(names.includes(want), "missing /" + want);
  }
});

test("/help renders a list of commands", async () => {
  const help = BUILTIN_REGISTRY.get("help");
  assert.ok(help);
  const out = await help!.run("", { cwd: "/" });
  assert.ok(typeof out === "string");
  assert.match(out!, /\/help/);
  assert.match(out!, /\/goal/);
  assert.match(out!, /\/loop/);
});

test("/commands renders grouped command output", async () => {
  const commands = BUILTIN_REGISTRY.get("commands");
  assert.ok(commands);
  const out = await commands!.run("", { cwd: "/" });
  assert.ok(typeof out === "string");
  assert.match(out!, /Slash commands:/);
  assert.match(out!, /WORKFLOW/);
  assert.match(out!, /\/goal/);
});

test("/goal uses internal prompts instead of recursively invoking slash commands", async () => {
  const goal = BUILTIN_REGISTRY.get("goal");
  assert.ok(goal);
  const seen: string[] = [];
  const printed: string[] = [];
  const states: Array<{ phase: string; step: number; statusText?: string }> = [];
  const rt = {
    print(text: string) { printed.push(text); },
    setGoalActivity(state: { phase: string; step: number; statusText?: string } | null) {
      if (state) states.push(state);
    },
    async sendPrompt(prompt: string) { seen.push(prompt); },
    async sendPromptWithCapture(prompt: string) {
      seen.push(prompt);
      return "GOAL COMPLETE";
    },
  };
  const out = await goal!.run("ship it --max-steps=2", { cwd: "/", runtime: () => rt as never });
  assert.equal(out, "goal complete in 1 step(s)");
  assert.equal(seen.some((prompt) => prompt.startsWith("/goal")), false);
  assert.equal(printed.some((line) => line.includes("[goal] planning")), true);
  assert.deepEqual(states.map((s) => s.phase), ["planning", "executing", "complete"]);
  assert.deepEqual(states.map((s) => s.statusText), [
    "Planning approach",
    "Running step 1 of 2",
    "Completed in 1 step",
  ]);
  assert.equal(new Set(states.map((s) => s.startedAt)).size, 1);
  assert.equal(states[1]?.step, 1);
  assert.equal(states[0]?.maxSteps, 2);
  assert.equal(states.every((s) => s.mode === "goal" && s.objective === "ship it"), true);
});

test("/goal reports blocked state and max-step fallback", async () => {
  const goal = BUILTIN_REGISTRY.get("goal");
  assert.ok(goal);
  const states: Array<{ phase: string; step: number; maxSteps: number; startedAt: number; updatedAt: number; statusText?: string }> = [];
  const rt = {
    print() {},
    setGoalActivity(state: { phase: string; step: number; maxSteps: number; startedAt: number; updatedAt: number; statusText?: string } | null) {
      if (state) states.push({ ...state });
    },
    async sendPrompt() {},
    async sendPromptWithCapture() {
      return "GOAL BLOCKED: repository needs cleanup";
    },
  };
  const out = await goal!.run("triage this --max-steps=3", { cwd: "/", runtime: () => rt as never });
  assert.equal(out, "goal blocked");
  assert.deepEqual(states.map((s) => s.phase), ["planning", "executing", "blocked"]);
  assert.deepEqual(states.map((s) => s.statusText), [
    "Planning approach",
    "Running step 1 of 3",
    "Blocked while executing step 1",
  ]);
  assert.equal(states[2]?.step, 1);
  assert.equal(states[2]?.maxSteps, 3);
});

test("/goal reports max-step exhaustion when the agent never completes", async () => {
  const goal = BUILTIN_REGISTRY.get("goal");
  assert.ok(goal);
  const states: Array<{ phase: string; step: number; maxSteps: number; statusText?: string }> = [];
  const responses = ["still working", "still working"];
  const rt = {
    print() {},
    setGoalActivity(state: { phase: string; step: number; maxSteps: number; statusText?: string } | null) {
      if (state) states.push({ ...state });
    },
    async sendPrompt() {},
    async sendPromptWithCapture() {
      return responses.shift() ?? "still working";
    },
  };
  const out = await goal!.run("finish later --max-steps=2", { cwd: "/", runtime: () => rt as never });
  assert.equal(out, "goal did not complete within 2 steps");
  assert.deepEqual(states.map((s) => s.phase), ["planning", "executing", "executing", "blocked"]);
  assert.deepEqual(states.map((s) => s.statusText), [
    "Planning approach",
    "Running step 1 of 2",
    "Running step 2 of 2",
    "Reached max steps (2)",
  ]);
  assert.equal(states[3]?.step, 2);
});

test("goal activity snapshots are copied on read", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-goal-"));
  process.env.CODINGHARNESS_HOME = home;
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  const { HarnessRuntime } = await import("../runtime.js");
  const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
  rt.setGoalActivity({
    mode: "goal",
    objective: "ship it",
    phase: "planning",
    step: 0,
    maxSteps: 3,
    startedAt: 123,
    updatedAt: 456,
    statusText: "Planning approach",
  });
  const snapshot = rt.getGoalActivity();
  assert.ok(snapshot);
  snapshot!.phase = "blocked";
  snapshot!.statusText = "mutated";
  assert.equal(rt.getGoalActivity()?.phase, "planning");
  assert.equal(rt.getGoalActivity()?.statusText, "Planning approach");
  rt.setGoalActivity(null);
  assert.equal(rt.getGoalActivity(), null);
});

test("/sessions search finds transcript content", async () => {
  const s = await Session.create({ cwd: "/", name: "search-fixture" });
  await s.append({ kind: "message", message: { role: "user", content: "please investigate websocket approval flow" } });
  await s.flush();
  const sessions = BUILTIN_REGISTRY.get("sessions");
  assert.ok(sessions);
  const out = await sessions!.run("search websocket approval", { cwd: "/" });
  assert.ok(typeof out === "string");
  assert.match(out!, /Matching sessions:/);
  assert.match(out!, /search-fixture/);
});
