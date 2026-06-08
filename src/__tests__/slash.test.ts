// Tests for slash command parsing and the registry.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_REGISTRY } from "../slash/builtin.js";
import { tryParseSlash } from "../slash/registry.js";
import { Session } from "../agent/session.js";

process.env.CODINGHARNESS_HOME = mkdtempSync(join(tmpdir(), "ch-slash-"));

type GoalStateSnapshot = {
  mode: string;
  objective: string;
  phase: string;
  step: number;
  maxSteps: number;
  startedAt: number;
  updatedAt: number;
  statusText?: string;
};

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
  for (const want of ["commands", "help", "clear", "quit", "session", "resume", "model", "provider", "goal", "plan", "build", "loop", "compact", "tree", "fork", "export", "cost", "approval", "think", "verbose", "trace", "info"]) {
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

test("/help groups commands and shows the quick-start card", async () => {
  const help = BUILTIN_REGISTRY.get("help");
  assert.ok(help);
  const out = await help!.run("", { cwd: "/" });
  assert.ok(typeof out === "string");
  // Quick start at the top with the canonical 4 commands.
  assert.match(out!, /Quick start/);
  assert.match(out!, /\/help\b/);
  assert.match(out!, /\/model\b/);
  assert.match(out!, /\/goal\b/);
  assert.match(out!, /\/status\b/);
  // Grouped headings appear in the reference section.
  assert.match(out!, /Workflow/);
  assert.match(out!, /Session/);
  assert.match(out!, /Model/);
  assert.match(out!, /Context/);
  assert.match(out!, /Tools/);
  assert.match(out!, /Settings/);
  assert.match(out!, /Status/);
  // Key hints at the bottom so the user always sees the bindings.
  assert.match(out!, /Tab completes/);
  assert.match(out!, /Ctrl\+G/);
});

test("/help <name> gives a focused one-command view", async () => {
  const help = BUILTIN_REGISTRY.get("help");
  assert.ok(help);
  const out = await help!.run("goal", { cwd: "/" });
  assert.ok(typeof out === "string");
  assert.match(out!, /\/goal —/);
  assert.match(out!, /group: workflow/);
  assert.match(out!, /\/help alone shows every command/);
});

test("/help on an unknown command suggests /help", async () => {
  const help = BUILTIN_REGISTRY.get("help");
  assert.ok(help);
  const out = await help!.run("nope", { cwd: "/" });
  assert.ok(typeof out === "string");
  assert.match(out!, /no such command: \/nope/);
  assert.match(out!, /\/help/);
});

test("/welcome renders the quick-start card", async () => {
  const welcome = BUILTIN_REGISTRY.get("welcome");
  assert.ok(welcome);
  const out = await welcome!.run("", { cwd: "/" });
  assert.ok(typeof out === "string");
  assert.match(out!, /Quick start/);
  assert.match(out!, /\/help/);
  assert.match(out!, /\/model/);
  assert.match(out!, /\/goal/);
  assert.match(out!, /\/status/);
  // Workflow modes are the second thing the user discovers — they
  // need to know /plan and /build exist to set their framing.
  assert.match(out!, /Workflow modes:/);
  assert.match(out!, /\/plan/);
  assert.match(out!, /\/build/);
  assert.match(out!, /Session ops:/);
  assert.match(out!, /\/tree/);
  assert.match(out!, /\/fork/);
  assert.match(out!, /\/compact/);
  assert.match(out!, /\/export/);
});

test("/commands renders grouped command output", async () => {
  const commands = BUILTIN_REGISTRY.get("commands");
  assert.ok(commands);
  const out = await commands!.run("", { cwd: "/" });
  assert.ok(typeof out === "string");
  assert.match(out!, /Quick start/);
  assert.match(out!, /Full reference/);
  assert.match(out!, /\/goal/);
  assert.match(out!, /\/plan/);
  assert.match(out!, /\/build/);
});

test("/welcome includes workflow modes and the quick-start card", async () => {
  const welcome = BUILTIN_REGISTRY.get("welcome");
  assert.ok(welcome);
  const out = await welcome!.run("", { cwd: "/" });
  assert.ok(typeof out === "string");
  assert.match(out!, /Quick start/);
  assert.match(out!, /Workflow modes:/);
  assert.match(out!, /\/plan/);
  assert.match(out!, /\/build/);
});

test("/mcp reports transport and usage hints", async () => {
  const mcp = BUILTIN_REGISTRY.get("mcp");
  assert.ok(mcp);
  const out = await mcp!.run("status", { cwd: "/" });
  assert.ok(typeof out === "string");
  assert.match(out!, /MCP support is built in/);
  assert.match(out!, /stdio/);
  assert.match(out!, /HTTP/);
});

test("/export writes a trajectory file for the active session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ch-slash-export-"));
  try {
    const s = await Session.create({ cwd, name: "export-slash" });
    await s.append({ kind: "message", message: { role: "user", content: "export me" } });
    const outDir = join(cwd, "exports");
    const exp = BUILTIN_REGISTRY.get("export");
    assert.ok(exp);
    const result = await exp!.run(`--format openai --out ${outDir}`, {
      cwd,
      runtime: () => ({ sessionId: () => s.id, getSession: () => s } as never),
    });
    assert.match(String(result), /exported 1 line/);
    assert.ok(existsSync(outDir));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("/tree renders the current session tree", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ch-slash-tree-"));
  try {
    const s = await Session.create({ cwd, name: "tree-slash" });
    const first = await s.append({ kind: "message", message: { role: "user", content: "hello tree" } });
    await s.append({ kind: "message", message: { role: "assistant", content: "mainline answer" } });
    await s.flush();
    s.rewindTo(first.id);
    await s.append({ kind: "message", message: { role: "assistant", content: "branched answer" } });
    await s.flush();
    const tree = BUILTIN_REGISTRY.get("tree");
    assert.ok(tree);
    const result = await tree!.run("", {
      cwd,
      runtime: () => ({ sessionId: () => s.id, getSession: () => s } as never),
    });
    assert.match(String(result), /hello tree/);
    assert.match(String(result), /mainline answer/);
    assert.match(String(result), /branched answer/);
    assert.match(String(result), /→ .*user\s+hello tree/);
    assert.match(String(result), /● .*assistant\s+branched answer/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("/fork forks from the previous user message and records a fork marker", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ch-slash-fork-"));
  try {
    const s = await Session.create({ cwd, name: "fork-slash" });
    const first = await s.append({ kind: "message", message: { role: "user", content: "fork me" } });
    await s.append({ kind: "message", message: { role: "assistant", content: "reply one" } });
    await s.append({ kind: "message", message: { role: "user", content: "fork target" } });
    await s.append({ kind: "message", message: { role: "assistant", content: "reply two" } });
    await s.flush();
    const fork = BUILTIN_REGISTRY.get("fork");
    assert.ok(fork);
    const result = await fork!.run("", {
      cwd,
      runtime: () => ({ sessionId: () => s.id, getSession: () => s } as never),
    });
    const match = String(result).match(/^forked into (\S+) \(from (\S+)\)$/);
    assert.ok(match, "unexpected /fork output: " + result);
    assert.equal(match?.[2], first.id);

    const child = await s.fork(first.id);
    const entries = child.allEntries();
    const last = entries[entries.length - 1];
    assert.equal(last?.payload.kind, "fork");
    assert.equal(last?.payload.kind === "fork" ? last.payload.fromEntryId : null, first.id);
    assert.equal(entries.some((e) => e.payload.kind === "message" && e.payload.message.content === "fork me"), true);
    assert.equal(entries.some((e) => e.payload.kind === "message" && e.payload.message.content === "reply one"), false);
    assert.equal(entries.some((e) => e.payload.kind === "message" && e.payload.message.content === "fork target"), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("/plan and /build toggle composer mode in runtime", async () => {
  let mode: "plan" | "build" = "build";
  const rt = {
    setComposerMode(next: "plan" | "build") { mode = next; },
  };
  const plan = BUILTIN_REGISTRY.get("plan");
  const build = BUILTIN_REGISTRY.get("build");
  assert.ok(plan);
  assert.ok(build);
  const out1 = await plan!.run("", { cwd: "/", runtime: () => rt as never });
  const out2 = await build!.run("", { cwd: "/", runtime: () => rt as never });
  assert.equal(mode, "build");
  assert.match(out1!, /workflow set to plan/);
  assert.match(out2!, /workflow set to build/);
});

test("/goal uses internal prompts instead of recursively invoking slash commands", async () => {
  const goal = BUILTIN_REGISTRY.get("goal");
  assert.ok(goal);
  const seen: string[] = [];
  const printed: string[] = [];
  const states: Array<{ mode: string; objective: string; phase: string; step: number; maxSteps: number; startedAt: number; updatedAt: number; statusText?: string }> = [];
  const rt = {
    print(text: string) { printed.push(text); },
    setGoalActivity(state: { mode: string; objective: string; phase: string; step: number; maxSteps: number; startedAt: number; updatedAt: number; statusText?: string } | null) {
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

test("/think, /verbose, and /trace report and toggle runtime flags", async () => {
  const think = BUILTIN_REGISTRY.get("think");
  const verbose = BUILTIN_REGISTRY.get("verbose");
  const trace = BUILTIN_REGISTRY.get("trace");
  assert.ok(think);
  assert.ok(verbose);
  assert.ok(trace);
  const rt = {
    settings: { thinking: "medium", ui: { verbose: false, trace: false } },
    setThinking(level: string) { this.settings.thinking = level; },
    setVerbose(enabled: boolean) { this.settings.ui.verbose = enabled; },
    setTrace(enabled: boolean) { this.settings.ui.trace = enabled; },
  };
  const t1 = await think!.run("", { cwd: "/", runtime: () => rt as never });
  assert.match(t1!, /thinking level: medium/);
  await think!.run("high", { cwd: "/", runtime: () => rt as never });
  assert.equal(rt.settings.thinking, "high");
  const v1 = await verbose!.run("", { cwd: "/", runtime: () => rt as never });
  assert.match(v1!, /verbose: off/);
  await verbose!.run("on", { cwd: "/", runtime: () => rt as never });
  assert.equal(rt.settings.ui.verbose, true);
  const tr1 = await trace!.run("", { cwd: "/", runtime: () => rt as never });
  assert.match(tr1!, /trace: off/);
  await trace!.run("toggle", { cwd: "/", runtime: () => rt as never });
  assert.equal(rt.settings.ui.trace, true);
});

test("/goal reports blocked state and max-step fallback", async () => {
  const goal = BUILTIN_REGISTRY.get("goal");
  assert.ok(goal);
  const states: GoalStateSnapshot[] = [];
  const rt = {
    print() {},
    setGoalActivity(state: GoalStateSnapshot | null) {
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
  const states: GoalStateSnapshot[] = [];
  const responses = ["still working", "still working"];
  const rt = {
    print() {},
    setGoalActivity(state: GoalStateSnapshot | null) {
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
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
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
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
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

test("/sessions with no args defaults to list (not the usage string)", async () => {
  const sessions = BUILTIN_REGISTRY.get("sessions");
  assert.ok(sessions);
  // Even with no sessions, the output should be the empty-state
  // marker or a list, NOT the usage error.
  const out = await sessions!.run("", { cwd: "/" });
  assert.ok(typeof out === "string");
  assert.doesNotMatch(out!, /^usage:/);
  assert.match(out!, /\(no sessions\)|Recent sessions:/);
});

test("/memory with no args defaults to read", async () => {
  const memory = BUILTIN_REGISTRY.get("memory");
  assert.ok(memory);
  // /memory with no runtime means "memory not available", which is
  // a different early-return — but with a runtime that has memory,
  // the no-arg call should call read() and print the buffer.
  const buf: string[] = [];
  const rt = {
    memory: {
      read() { return buf.join(""); },
      async append(_t: string) { /* noop */ },
      async search(_q: string) { return ""; },
      readUser() { return ""; },
      async appendUser(_t: string) { /* noop */ },
    },
  };
  buf.push("test memory entry\n");
  const out = await memory!.run("", { cwd: "/", runtime: () => rt as never });
  assert.ok(typeof out === "string");
  assert.match(out!, /test memory entry/);
});

test("/agents <name> shows the focused one-agent view", async () => {
  const { AgentRegistry } = await import("../agent/agents.js");
  const reg = new AgentRegistry();
  const agents = BUILTIN_REGISTRY.get("agents");
  assert.ok(agents);
  const explore = reg.get("explore");
  assert.ok(explore);
  const out = await agents!.run("explore", { cwd: "/", runtime: () => ({
    listAgents: () => reg.list(),
    getAgent: (n: string) => reg.get(n),
  } as never) });
  assert.ok(typeof out === "string");
  assert.match(out!, /explore\b/);
  assert.match(out!, /Read-only explorer/);
  assert.match(out!, /tools: read, grep, find, ls, bash/);
  assert.match(out!, /max steps: 12/);
});

test("/agents <name> returns a friendly error for an unknown name", async () => {
  const { AgentRegistry } = await import("../agent/agents.js");
  const reg = new AgentRegistry();
  const agents = BUILTIN_REGISTRY.get("agents");
  assert.ok(agents);
  const out = await agents!.run("nope", { cwd: "/", runtime: () => ({
    listAgents: () => reg.list(),
    getAgent: (n: string) => reg.get(n),
  } as never) });
  assert.match(String(out), /no such agent: nope/);
  assert.match(String(out), /\/agents alone/);
});

test("/info renders the runtime snapshot", async () => {
  const info = BUILTIN_REGISTRY.get("info");
  assert.ok(info);
  const out = await info!.run("", { cwd: "/" });
  assert.ok(typeof out === "string");
  assert.match(out!, /CodingHarness \d+\.\d+\.\d+/);
  assert.match(out!, /node:/);
  assert.match(out!, /home:/);
  assert.match(out!, /Settings/);
  assert.match(out!, /provider:/);
  assert.match(out!, /Paths:/);
  assert.match(out!, /sessions:/);
});

test("/skill show <name> renders the focused one-skill view", async () => {
  const skill = BUILTIN_REGISTRY.get("skill");
  assert.ok(skill);
  // Mock the skills registry with two entries.
  const skills = [
    { name: "alpha", description: "first skill" },
    { name: "beta", description: "second skill" },
  ];
  const rt = {
    skills: {
      list: async () => skills,
      load: async (n: string) => n === "alpha" ? { content: "alpha body" } : null,
    },
  };
  // show <name> should print the body and a friendly header.
  const out = await skill!.run("show alpha", { cwd: "/", runtime: () => rt as never });
  assert.ok(typeof out === "string");
  assert.match(out!, /Skill: alpha/);
  assert.match(out!, /first skill/);
  assert.match(out!, /alpha body/);
});

test("/skill <name> still loads (backward-compatible shorthand)", async () => {
  const skill = BUILTIN_REGISTRY.get("skill");
  assert.ok(skill);
  const rt = {
    skills: {
      list: async () => [{ name: "alpha", description: "first skill" }],
      load: async (n: string) => n === "alpha" ? { content: "alpha body" } : null,
    },
  };
  const out = await skill!.run("alpha", { cwd: "/", runtime: () => rt as never });
  assert.match(String(out), /Loaded skill: alpha/);
  assert.match(String(out), /alpha body/);
});

test("/skill show <unknown> returns a friendly error", async () => {
  const skill = BUILTIN_REGISTRY.get("skill");
  assert.ok(skill);
  const rt = {
    skills: {
      list: async () => [{ name: "alpha", description: "first skill" }],
      load: async (_n: string) => null,
    },
  };
  const out = await skill!.run("show nope", { cwd: "/", runtime: () => rt as never });
  assert.match(String(out), /no such skill: nope/);
  assert.match(String(out), /\/skill list/);
});
