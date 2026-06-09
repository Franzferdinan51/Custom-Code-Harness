// Tests for the /undo + /redo stack added to HarnessRuntime.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessRuntime } from "../runtime.js";
import { BUILTIN_REGISTRY } from "../slash/builtin.js";

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ch-undo-redo-"));
  for (const sub of ["sessions", "logs", "cache", "extensions", "prompts", "skills", "agents", "cron", "memory", "context"]) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  return home;
}

test("undoLastTurn on an empty session returns null", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
    const session = await rt.ensureSession();
    const rewound = await rt.undoLastTurn();
    assert.equal(rewound, null);
    assert.equal(rt.getRedoStackDepth(), 0);
    // Suppress unused warning.
    assert.ok(session);
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("undoLastTurn rewinds past the most recent assistant turn and pushes to the redo stack", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
    const session = await rt.ensureSession();
    await session.append({ kind: "message", message: { role: "user", content: "first user prompt" } });
    await session.append({ kind: "message", message: { role: "assistant", content: "first assistant reply" } });
    await session.append({ kind: "message", message: { role: "user", content: "second user prompt" } });
    await session.append({ kind: "message", message: { role: "assistant", content: "second assistant reply" } });

    // Undo: should rewind to the user message before the most recent assistant
    // turn (i.e. "second user prompt") and push it onto the redo stack.
    const rewound = await rt.undoLastTurn();
    assert.equal(rewound, "second user prompt");
    assert.equal(rt.getRedoStackDepth(), 1);

    // The session head should now point at the "second user prompt" entry.
    const all = session.allEntries();
    const headEntry = all.find((e) => e.id === session.meta.head);
    assert.ok(headEntry);
    assert.equal(headEntry!.payload.kind, "message");
    if (headEntry!.payload.kind === "message") {
      assert.equal(headEntry!.payload.message.content, "second user prompt");
    }
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("redoLastTurn replays the most recently undone prompt", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
    const session = await rt.ensureSession();
    await session.append({ kind: "message", message: { role: "user", content: "alpha" } });
    await session.append({ kind: "message", message: { role: "assistant", content: "alpha-reply" } });
    await session.append({ kind: "message", message: { role: "user", content: "beta" } });
    await session.append({ kind: "message", message: { role: "assistant", content: "beta-reply" } });

    // Stub runUserTurn so the redo path doesn't actually call a model.
    let captured: string | null = null;
    (rt as unknown as { runUserTurn: (s: string) => Promise<void> }).runUserTurn = async (s: string) => {
      captured = s;
    };

    const rewound = await rt.undoLastTurn();
    assert.equal(rewound, "beta");
    assert.equal(rt.getRedoStackDepth(), 1);

    const replayed = await rt.redoLastTurn();
    assert.equal(replayed, "beta");
    assert.equal(captured, "beta");
    assert.equal(rt.getRedoStackDepth(), 0);
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("redoLastTurn returns null when the stack is empty", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
    const out = await rt.redoLastTurn();
    assert.equal(out, null);
    assert.equal(rt.getRedoStackDepth(), 0);
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("setSession clears the redo stack", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
    const a = await rt.ensureSession();
    await a.append({ kind: "message", message: { role: "user", content: "u" } });
    await a.append({ kind: "message", message: { role: "assistant", content: "a" } });
    await a.append({ kind: "message", message: { role: "user", content: "v" } });
    await a.append({ kind: "message", message: { role: "assistant", content: "b" } });
    await rt.undoLastTurn();
    assert.equal(rt.getRedoStackDepth(), 1);

    // Create a fresh, distinct session and switch to it. The session
    // body file is only created when entries are appended, so we add
    // one and flush so Session.open can find the .jsonl on disk.
    const { Session } = await import("../agent/session.js");
    const b = await Session.create({ cwd: home });
    await b.append({ kind: "message", message: { role: "user", content: "new session" } });
    await b.flush();
    assert.notEqual(a.id, b.id, "Session.create should produce a new id");
    await rt.setSession(b.id);
    assert.equal(rt.getRedoStackDepth(), 0);
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the redo stack caps at 10 entries (LRU eviction)", async () => {
  const home = makeHome();
  const previousHome = process.env.CODINGHARNESS_HOME;
  process.env.CODINGHARNESS_HOME = home;
  try {
    const rt = new HarnessRuntime({ cwd: home, ephemeral: true });
    const session = await rt.ensureSession();

    // Build up 12 user/assistant pairs, undoing each one to push
    // 12 entries onto the redo stack. The first 2 should be evicted
    // to keep the stack at 10.
    for (let i = 0; i < 12; i++) {
      await session.append({ kind: "message", message: { role: "user", content: "u" + i } });
      await session.append({ kind: "message", message: { role: "assistant", content: "a" + i } });
      const rewound = await rt.undoLastTurn();
      assert.equal(rewound, "u" + i);
    }
    assert.equal(rt.getRedoStackDepth(), 10);

    // Pop them all off in reverse order; the LAST one we undid should
    // come out FIRST.
    const popped: (string | null)[] = [];
    for (let i = 0; i < 10; i++) {
      popped.push(await rt.redoLastTurn());
    }
    // The most recent undo was u11, but the stack capped at 10, so the
    // first undo (u0) was evicted. The remaining entries are u1..u11,
    // popped in reverse: u11, u10, ..., u1.
    assert.deepEqual(popped, ["u11", "u10", "u9", "u8", "u7", "u6", "u5", "u4", "u3", "u2"]);
  } finally {
    if (previousHome === undefined) delete process.env.CODINGHARNESS_HOME;
    else process.env.CODINGHARNESS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("/undo slash command reports nothing to undo on empty stack", async () => {
  const undo = BUILTIN_REGISTRY.get("undo");
  assert.ok(undo);
  const rt = {
    undoLastTurn: async () => null,
  };
  const out = await undo!.run("", { cwd: "/", runtime: () => rt as never });
  assert.equal(out, "nothing to undo");
});

test("/undo slash command returns the rewound prompt", async () => {
  const undo = BUILTIN_REGISTRY.get("undo");
  assert.ok(undo);
  const rt = {
    undoLastTurn: async () => "the prompt that was rewound to",
  };
  const out = await undo!.run("", { cwd: "/", runtime: () => rt as never });
  assert.match(out!, /rewound to: the prompt that was rewound to/);
});

test("/undo slash command truncates long prompts", async () => {
  const undo = BUILTIN_REGISTRY.get("undo");
  assert.ok(undo);
  const long = "x".repeat(200);
  const rt = {
    undoLastTurn: async () => long,
  };
  const out = await undo!.run("", { cwd: "/", runtime: () => rt as never });
  // /undo returns "rewound to: <truncated>" — the ellipsis is the
  // last char of the truncated prompt.
  assert.match(out!, /…$/);
  assert.ok(out!.length < 200, "long prompts should be truncated, got length " + out!.length);
});

test("/redo slash command reports nothing to redo on empty stack", async () => {
  const redo = BUILTIN_REGISTRY.get("redo");
  assert.ok(redo, "/redo should be registered");
  const rt = {
    redoLastTurn: async () => null,
  };
  const out = await redo!.run("", { cwd: "/", runtime: () => rt as never });
  assert.equal(out, "nothing to redo");
});

test("/redo slash command reports when there's no runtime", async () => {
  const redo = BUILTIN_REGISTRY.get("redo");
  assert.ok(redo);
  const out = await redo!.run("", { cwd: "/", runtime: () => ({}) as never });
  assert.equal(out, "no active session");
});

test("/redo slash command returns the replayed prompt", async () => {
  const redo = BUILTIN_REGISTRY.get("redo");
  assert.ok(redo);
  const rt = {
    redoLastTurn: async () => "the prompt that was replayed",
  };
  const out = await redo!.run("", { cwd: "/", runtime: () => rt as never });
  assert.match(out!, /replayed the prompt that was replayed/);
});

test("/redo slash command truncates long prompts", async () => {
  const redo = BUILTIN_REGISTRY.get("redo");
  assert.ok(redo);
  const long = "y".repeat(200);
  const rt = {
    redoLastTurn: async () => long,
  };
  const out = await redo!.run("", { cwd: "/", runtime: () => rt as never });
  // The output ends with ")" — the ellipsis is the last char of the
  // truncated prompt, which appears just before the closing paren.
  assert.match(out!, /…\)/, "output should contain a truncation ellipsis");
  // The wrapped output is "(replayed " + truncated + ")" so its
  // total length is 10 + 61 (truncated to 60 chars + ellipsis) + 1
  // = 72, well under 200. What we're really asserting is that the
  // 200-char payload was NOT echoed in full.
  assert.ok(out!.length < 220, "long prompts should be truncated, got length " + out!.length);
  assert.ok(!out!.includes("y".repeat(100)), "output should not contain the full long payload");
});
