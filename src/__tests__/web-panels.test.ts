// HTTP endpoint tests for the new web UI panels:
//   GET /v1/goals
//   GET /v1/delegations
//
// These are the data sources for the `goalList` (left sidebar) and
// `delegations` (bottom strip) panels added in this change. The
// tests spawn the actual `ch serve` process on a free port and
// hit the endpoints over the wire — same pattern as
// `info-endpoints.test.ts` and `cli-wireup.test.ts`.
//
// For goals we pre-seed `goals.json` in the test's
// `CODINGHARNESS_HOME` so the server picks up the records on
// boot. The store auto-loads the file in its constructor
// (`src/agent/goals.ts`). For delegations we can only test the
// empty case from the outside — the manager keeps runs in
// memory and there is no public RPC to inject one for the test
// (intentional: the manager is meant to be driven by the
// /goal / /spawn / approval flows, not direct injection).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Find a free TCP port by opening a listen socket and immediately
 *  closing it. Small race window; fine for these short-lived
 *  test runs. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("couldn't get a free port")));
      }
    });
  });
}

function startServer(home: string): Promise<{ port: number; proc: ChildProcess; kill: () => void }> {
  return new Promise(async (resolve, reject) => {
    let port = 0;
    try {
      port = await pickFreePort();
    } catch (e) {
      reject(e as Error);
      return;
    }
    const proc = spawn("bun", ["src/cli.ts", "serve", "--no-open", "--port", String(port)], {
      env: { ...process.env, CODINGHARNESS_HOME: home, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let stderrBuf = "";
    const onStdout = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const m = buf.match(/server listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        proc.stdout?.off("data", onStdout);
        proc.stderr?.off("data", onStderr);
        resolve({ port, proc, kill: () => proc.kill("SIGTERM") });
      }
    };
    const onStderr = (chunk: Buffer) => { stderrBuf += chunk.toString("utf-8"); };
    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("error", reject);
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error("server didn't start in 15s — stdout: " + buf.slice(0, 500) + " stderr: " + stderrBuf.slice(0, 500)));
    }, 15_000);
  });
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  const body = await res.json() as T;
  return { status: res.status, body };
}

// ---------- Goal endpoint shape ----------

interface GoalRecordShape {
  id: string;
  objective: string;
  status: "pending" | "in_progress" | "complete" | "blocked" | "failed";
  loopStatus: string;
  createdAt: number;
  updatedAt: number;
  maxSteps: number;
  stepsTaken: number;
  successCriteria?: { deliverables: string[]; qualityChecks?: string[] };
  evaluations?: Array<{ id: string; iteration: number; score: number; passed: boolean; feedback: string; createdAt: number }>;
  parentGoalId?: string;
}

test("GET /v1/goals returns the goals array (empty case)", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-panels-goals-empty-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ goals: GoalRecordShape[] }>(`http://127.0.0.1:${port}/v1/goals`);
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.goals));
      assert.equal(r.body.goals.length, 0);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("GET /v1/goals returns the seeded goals with the expected shape", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-panels-goals-list-"));
  try {
    // Pre-seed goals.json. v2 envelope: { version: 2, goals: [...] }.
    // We create one parent and one child to exercise the
    // parentGoalId relationship and the ?id=<id> detail view.
    const now = Date.now();
    const goalsJson = {
      version: 2,
      goals: [
        {
          id: "goal-test-parent",
          objective: "wire up the new panels endpoint",
          status: "in_progress",
          loopStatus: "executing",
          createdAt: now - 60_000,
          updatedAt: now - 5_000,
          maxSteps: 8,
          stepsTaken: 2,
          currentIteration: 1,
          successCriteria: { deliverables: ["GET /v1/goals", "GET /v1/delegations"] },
          evaluations: [
            {
              id: "eval-1",
              iteration: 1,
              score: 50,
              passed: false,
              feedback: "1/2 deliverables met so far",
              createdAt: now - 10_000,
            },
          ],
        },
        {
          id: "goal-test-child",
          objective: "sub-task: handle the parent chain in the delegations endpoint",
          status: "pending",
          loopStatus: "pending",
          createdAt: now - 30_000,
          updatedAt: now - 30_000,
          maxSteps: 4,
          stepsTaken: 0,
          parentGoalId: "goal-test-parent",
        },
      ],
    };
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "goals.json"), JSON.stringify(goalsJson, null, 2), "utf-8");

    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ goals: GoalRecordShape[] }>(`http://127.0.0.1:${port}/v1/goals`);
      assert.equal(r.status, 200);
      assert.equal(r.body.goals.length, 2);
      // Most recent first (parent is older, so child is at index 0).
      const child = r.body.goals[0]!;
      assert.equal(child.id, "goal-test-child");
      assert.equal(child.parentGoalId, "goal-test-parent");
      assert.equal(child.status, "pending");
      assert.equal(child.loopStatus, "pending");
      assert.equal(child.maxSteps, 4);
      const parent = r.body.goals[1]!;
      assert.equal(parent.id, "goal-test-parent");
      assert.equal(parent.objective, "wire up the new panels endpoint");
      assert.equal(parent.status, "in_progress");
      assert.equal(parent.loopStatus, "executing");
      assert.equal(parent.stepsTaken, 2);
      assert.equal(parent.maxSteps, 8);
      assert.ok(parent.successCriteria);
      assert.deepEqual(parent.successCriteria!.deliverables, ["GET /v1/goals", "GET /v1/delegations"]);
      assert.ok(Array.isArray(parent.evaluations));
      assert.equal(parent.evaluations!.length, 1);
      assert.equal(parent.evaluations![0]!.score, 50);
      assert.equal(parent.evaluations![0]!.passed, false);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("GET /v1/goals?id=<id> returns the goal + its children + evaluations", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-panels-goals-detail-"));
  try {
    const now = Date.now();
    const goalsJson = {
      version: 2,
      goals: [
        {
          id: "goal-test-parent",
          objective: "parent",
          status: "in_progress",
          loopStatus: "executing",
          createdAt: now - 60_000,
          updatedAt: now - 5_000,
          maxSteps: 8,
          stepsTaken: 1,
        },
        {
          id: "goal-test-child-a",
          objective: "child A",
          status: "pending",
          loopStatus: "pending",
          createdAt: now - 30_000,
          updatedAt: now - 30_000,
          maxSteps: 4,
          stepsTaken: 0,
          parentGoalId: "goal-test-parent",
        },
        {
          id: "goal-test-child-b",
          objective: "child B",
          status: "pending",
          loopStatus: "pending",
          createdAt: now - 20_000,
          updatedAt: now - 20_000,
          maxSteps: 4,
          stepsTaken: 0,
          parentGoalId: "goal-test-parent",
        },
      ],
    };
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "goals.json"), JSON.stringify(goalsJson, null, 2), "utf-8");

    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ goal: GoalRecordShape; children: GoalRecordShape[] }>(
        `http://127.0.0.1:${port}/v1/goals?id=goal-test-parent`,
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.goal.id, "goal-test-parent");
      assert.equal(r.body.goal.objective, "parent");
      assert.equal(r.body.goal.status, "in_progress");
      assert.equal(r.body.children.length, 2);
      const childIds = r.body.children.map((c) => c.id).sort();
      assert.deepEqual(childIds, ["goal-test-child-a", "goal-test-child-b"]);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("GET /v1/goals?id=<unknown> returns 404 with an error message", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-panels-goals-404-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ error?: string }>(
        `http://127.0.0.1:${port}/v1/goals?id=goal-does-not-exist`,
      );
      assert.equal(r.status, 404);
      assert.match(r.body.error ?? "", /goal not found/);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("GET /v1/goals?active=1 returns only pending + in_progress goals", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-panels-goals-active-"));
  try {
    const now = Date.now();
    const goalsJson = {
      version: 2,
      goals: [
        { id: "g-active", objective: "active", status: "in_progress", loopStatus: "executing", createdAt: now - 30_000, updatedAt: now, maxSteps: 4, stepsTaken: 1 },
        { id: "g-pending", objective: "pending", status: "pending", loopStatus: "pending", createdAt: now - 20_000, updatedAt: now - 20_000, maxSteps: 4, stepsTaken: 0 },
        { id: "g-done", objective: "done", status: "complete", loopStatus: "done", createdAt: now - 10_000, updatedAt: now - 5_000, maxSteps: 4, stepsTaken: 4 },
        { id: "g-failed", objective: "failed", status: "failed", loopStatus: "failed", createdAt: now - 5_000, updatedAt: now - 1_000, maxSteps: 4, stepsTaken: 4 },
      ],
    };
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "goals.json"), JSON.stringify(goalsJson, null, 2), "utf-8");

    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ goals: GoalRecordShape[] }>(`http://127.0.0.1:${port}/v1/goals?active=1`);
      assert.equal(r.status, 200);
      assert.equal(r.body.goals.length, 2);
      const ids = r.body.goals.map((g) => g.id).sort();
      assert.deepEqual(ids, ["g-active", "g-pending"]);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------- Delegations endpoint shape ----------

interface DelegationRunShape {
  id: string;
  kind: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  parentId?: string;
  parentChain: Array<{ id: string; kind: string; status: string }>;
  startedAt?: number;
  completedAt?: number;
  createdAt?: number;
}

test("GET /v1/delegations returns the delegations array (empty case)", async () => {
  const home = mkdtempSync(join(tmpdir(), "ch-panels-delegations-empty-"));
  try {
    const { port, kill } = await startServer(home);
    try {
      const r = await getJson<{ delegations: DelegationRunShape[] }>(`http://127.0.0.1:${port}/v1/delegations`);
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.delegations));
      // No runs at boot — the manager is empty until the goal loop
      // or the spawn endpoint submits one.
      assert.equal(r.body.delegations.length, 0);
    } finally { kill(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
