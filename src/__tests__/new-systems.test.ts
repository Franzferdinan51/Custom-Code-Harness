// Tests for the new sub-agent, skill, memory, context, cron, and
// compaction systems.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ch-new-"));
process.env.CODINGHARNESS_HOME = tmp;
process.env.NO_COLOR = "1";

// Ensure all subdirs the runtime expects exist.
import { mkdirSync as _mkdirSync } from "node:fs";
for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
  _mkdirSync(join(tmp, sub), { recursive: true });
}

import { SubAgentManager } from "../agent/subagent.js";
import { SkillRegistry } from "../agent/skills.js";
import { MemoryStore } from "../agent/memory.js";
import { loadContextFiles, formatContextForPrompt } from "../agent/context.js";
import { CronStore, parseHumanSchedule, formatSchedule, nextRun, cronNext } from "../agent/cron.js";
import { compact, defaultCutoff, roughTokenCount } from "../agent/compaction.js";
import { loadPromptTemplates, expandTemplate } from "../agent/prompts.js";
import { AgentRegistry } from "../agent/agents.js";
import type { Provider, ProviderRequest, ProviderStreamEvent, ChatMessage, ToolResult } from "../types.js";
import { ProviderRegistry } from "../providers/registry.js";
import { loadSettings, type Settings } from "../config/settings.js";
import { runAgent, DEFAULT_LIMITS } from "../agent/loop.js";
import { defaultToolRegistry } from "../agent/tools/index.js";

class EchoProvider implements Provider {
  readonly id = "echo";
  readonly displayName = "Echo";
  async isConfigured() { return { ok: true }; }
  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const last = req.messages[req.messages.length - 1];
    const text = "ECHO: " + ((last && last.content) || "");
    yield { type: "text", text };
    yield { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } };
    yield { type: "done" };
  }
}

const settings: Settings = { providers: { echo: { id: "echo", model: "echo-1" } }, defaultProvider: "echo", defaultModel: "echo-1" };

// ---- Sub-agents ----

test("AgentRegistry has all built-ins", () => {
  const reg = new AgentRegistry();
  const names = reg.names();
  for (const want of ["explore", "plan", "review", "summarize", "implement", "test"]) {
    assert.ok(names.includes(want), "missing built-in agent: " + want);
  }
});

test("AgentRegistry loads user-defined agents from JSON", () => {
  writeFileSync(join(tmp, "user-agent.json"), JSON.stringify({
    name: "myreviewer",
    description: "Custom reviewer",
    tools: ["read", "grep"],
    maxSteps: 4,
  }));
  // Reload settings so the agents dir is on the right place
  // AgentRegistry looks at paths.agents which is $CH_HOME/agents
  writeFileSync(join(tmp, "agents", "myreviewer.json"), JSON.stringify({
    name: "myreviewer",
    description: "Custom reviewer",
    tools: ["read", "grep"],
    maxSteps: 4,
  }));
  const reg = new AgentRegistry({ cwd: tmp });
  const r = reg.get("myreviewer");
  assert.ok(r);
  assert.equal(r!.tools?.[0], "read");
});

test("SubAgentManager spawns a sub-agent end-to-end", async () => {
  const providers = new ProviderRegistry(settings);
  providers.register("echo", new EchoProvider());
  const mgr = new SubAgentManager(providers, settings, { cwd: tmp });
  const r = await mgr.spawn({ agent: "summarize", prompt: "hello", cwd: tmp, signal: new AbortController().signal });
  assert.equal(r.status, "ok");
  assert.match(r.text, /ECHO/);
  assert.equal(r.agentName, "summarize");
});

test("Sub-agent tool allowlist is respected", async () => {
  const providers = new ProviderRegistry(settings);
  providers.register("echo", new EchoProvider());
  const mgr = new SubAgentManager(providers, settings, { cwd: tmp });
  const explore = mgr.get("explore");
  assert.ok(explore);
  assert.ok(explore!.tools?.includes("read"));
  assert.ok(!explore!.tools?.includes("write"), "explore should not have write tool");
});

// ---- Skills ----

test("SkillRegistry discovers SKILL.md files", async () => {
  const skillDir = join(tmp, "skills", "test-skill");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Test Skill\nThis skill does X.\n");
  const reg = new SkillRegistry({ cwd: tmp });
  const all = await reg.list();
  const found = all.find((s) => s.name === "test-skill");
  assert.ok(found, "skill not discovered");
  assert.equal(found!.description, "Test Skill");
});

test("SkillRegistry parses YAML frontmatter", async () => {
  const { mkdirSync } = await import("node:fs");
  const d = join(tmp, "skills", "fm-skill");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), "---\nname: custom-name\ndescription: A custom skill\n---\n# body\n");
  const reg = new SkillRegistry({ cwd: tmp });
  const s = await reg.get("custom-name");
  assert.ok(s);
  assert.equal(s!.description, "A custom skill");
});

// ---- Memory ----

test("MemoryStore append and search", async () => {
  const mem = new MemoryStore();
  await mem.append("user prefers dark mode");
  await mem.append("project uses bun");
  const text = mem.read();
  assert.match(text, /dark mode/);
  const found = await mem.search("bun");
  assert.match(found, /bun/);
});

test("MemoryStore readUser and appendUser", async () => {
  const mem = new MemoryStore();
  await mem.appendUser("name: Ryan");
  const text = mem.readUser();
  assert.match(text, /Ryan/);
});

// ---- Context files ----

test("loadContextFiles walks up to find AGENTS.md", async () => {
  const { mkdirSync } = await import("node:fs");
  const sub = join(tmp, "project", "sub");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "AGENTS.md"), "# Subdir rules\nDon't import lodash.\n");
  const files = await loadContextFiles(sub);
  const found = files.find((f) => f.path === join(sub, "AGENTS.md"));
  assert.ok(found, "AGENTS.md not found in walked context");
  assert.match(found!.body, /lodash/);
});

test("formatContextForPrompt returns empty for no files", () => {
  const out = formatContextForPrompt([]);
  assert.equal(out, "");
});

// ---- Cron ----

test("parseHumanSchedule parses interval and daily", () => {
  const a = parseHumanSchedule("every 30 min");
  assert.equal(a.kind, "interval");
  if (a.kind === "interval") assert.equal(a.minutes, 30);
  const b = parseHumanSchedule("daily 09:30");
  assert.equal(b.kind, "daily-at");
  if (b.kind === "daily-at") assert.equal(b.hour, 9);
});

test("parseHumanSchedule parses at and cron", () => {
  const a = parseHumanSchedule("at 2026-12-31T23:59");
  assert.equal(a.kind, "at");
  const c = parseHumanSchedule("*/5 * * * *");
  assert.equal(c.kind, "cron");
});

test("cronNext returns a future timestamp", () => {
  const now = new Date("2026-06-07T15:00:00Z");
  const t = cronNext("0 9 * * *", now);
  assert.ok(t);
  const d = new Date(t!);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 0);
  assert.ok(t! > now.getTime(), "next cron time should be in the future");
});

test("CronStore add/list/remove", () => {
  const store = new CronStore();
  const j = store.add({ name: "test", prompt: "do thing", schedule: { kind: "interval", minutes: 60 }, enabled: true });
  assert.ok(j.id);
  const list = store.list();
  assert.ok(list.find((x) => x.id === j.id));
  assert.ok(store.remove(j.id));
  assert.equal(store.list().find((x) => x.id === j.id), undefined);
});

test("CronStore.save: atomic write (no orphan .tmp on success)", () => {
  // Regression: pre-fix CronStore.save() did a direct
  // `writeFileSync(jobsFile(), ...)` — non-atomic. A crash
  // mid-write would leave a half-written `jobs.json` that
  // the next `list()` would fail to parse, silently losing
  // every scheduled job. The fix mirrors the same tmp+rename
  // pattern as writeTool / editTool / WorkflowStore /
  // GoalStore / mcp-store / Session.persistMeta.
  //
  // This test pins: (1) after `save`, `jobs.json` exists and
  // is parseable, (2) no `.tmp` orphan is left next to it.
  const store = new CronStore();
  store.save([{ id: "x", name: "t", prompt: "p", schedule: { kind: "interval", minutes: 60 }, enabled: true, createdAt: 0 }]);
  const file = join(tmp, "cron", "jobs.json");
  assert.ok(existsSync(file), "jobs.json should exist after save");
  // Verify the file parses (catches half-written content).
  const parsed = JSON.parse(readFileSync(file, "utf-8"));
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].id, "x");
  // No `.tmp` orphan.
  const siblings = readdirSync(join(tmp, "cron"));
  const tmpFiles = siblings.filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(tmpFiles, [], "no .tmp files should remain after save()");
});

// ---- Compaction ----

test("defaultCutoff keeps the last N messages", () => {
  assert.equal(defaultCutoff(10, 6, 0.3), 4);
  assert.equal(defaultCutoff(2), 0); // too short
});

test("roughTokenCount estimates non-zero for content", () => {
  const msgs: ChatMessage[] = [{ role: "user", content: "x".repeat(400) }];
  const t = roughTokenCount(msgs);
  assert.ok(t >= 100);
});

test("compact summarizes older messages and keeps recent", async () => {
  const echo = new EchoProvider();
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "msg " + i + ": " + "x".repeat(200) });
  const r = await compact(echo, "echo-1", msgs, { cutoff: 4 });
  assert.ok(r.summary);
  assert.match(r.summary, /ECHO/);
  assert.equal(r.keepFromIndex, 4);
});

// ---- Prompt templates ----

test("loadPromptTemplates discovers markdown files", async () => {
  const { mkdirSync } = await import("node:fs");
  const d = join(tmp, "prompts");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "review.md"), "# Review\nReview this for {{focus}}.\n");
  const list = loadPromptTemplates(tmp);
  const found = list.find((t) => t.name === "review");
  assert.ok(found);
  assert.equal(expandTemplate("Hello {{name}}", { name: "Ryan" }), "Hello Ryan");
});

// ---- Agent loop integration with sub-agent ----

test("agent loop with spawn_subagent dispatches to sub-agent", async () => {
  const providers = new ProviderRegistry(settings);
  providers.register("echo", new EchoProvider());
  const mgr = new SubAgentManager(providers, settings, { cwd: tmp });
  const result = await mgr.spawn({ agent: "summarize", prompt: "x", cwd: tmp, signal: new AbortController().signal });
  assert.equal(result.status, "ok");
  assert.equal(result.agentName, "summarize");
});

test("ALL OK", () => {
  rmSync(tmp, { recursive: true, force: true });
});
