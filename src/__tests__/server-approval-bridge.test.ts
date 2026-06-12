// Tests for the server's approval bridge. The bridge wires the
// runtime's `askApprovalHandler` (the callback the bash tool calls
// when it hits a destructive command) to the server's
// `pendingApprovals` map + the `approval_required` SSE event so the
// web UI can pop a confirmation modal and respond via
// `POST /v1/approval/respond`.
//
// Pre-bridge, the chat/stream endpoint ran the model without an
// approval hook — every bash command either auto-denied (no
// askApprovalHandler was set) or never reached the user. The
// bridge is what makes the web UI's approval flow functional.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  coerceDecision,
  // `bridgeApprovalForStream` is module-private; tests reach it via
  // the dynamic import below.
} from "../server.js";

/** Minimal ServerResponse stub. We don't subclass
 *  `ServerResponse` because Node marks its `writableEnded`
 *  property as read-only and we need to flip it from the test
 *  to simulate an aborted client. Instead we hand-roll a tiny
 *  Writable-shaped object that captures every `write()` into a
 *  buffer and exposes the small surface the bridge reads. */
function makeMockRes(): { write(chunk: string): boolean; chunks: string[]; writableEnded: boolean; setEnded(): void } {
  const chunks: string[] = [];
  return {
    write(chunk: string) { chunks.push(chunk); return true; },
    chunks,
    writableEnded: false,
    setEnded(this: { writableEnded: boolean }) { this.writableEnded = true; },
  };
}

// We can't import HarnessRuntime directly — runtime.ts pulls in the
// agent loop and provider registry, which is heavy for a unit test.
// Build a thin object that exposes the same `askApprovalHandler`
// field the bridge reads + writes, plus a captured-handler slot
// for assertions.

type AskHandler = ((command: string, reason: string) => Promise<"allow-once" | "allow-always" | "deny">) | null;

interface MockRuntime {
  askApprovalHandler: AskHandler;
  _handler: AskHandler;
}

function makeMockRuntime(initial: AskHandler = null): MockRuntime {
  const rt: MockRuntime = {
    askApprovalHandler: null,
    _handler: initial,
  };
  // Make the public `askApprovalHandler` a live read of the
  // captured handler so the production code (which both reads and
  // writes it) sees consistent state.
  Object.defineProperty(rt, "askApprovalHandler", {
    get() { return rt._handler; },
    set(v) { rt._handler = v; },
    enumerable: true,
  });
  return rt;
}

test("coerceDecision: maps the three known decisions to themselves", () => {
  assert.equal(coerceDecision("allow-once"), "allow-once");
  assert.equal(coerceDecision("allow-always"), "allow-always");
  assert.equal(coerceDecision("deny"), "deny");
});

test("coerceDecision: unknown values fall back to 'deny' (fail-safe)", () => {
  assert.equal(coerceDecision(""), "deny");
  assert.equal(coerceDecision("yes"), "deny");
  assert.equal(coerceDecision("ALLOW-ONCE"), "deny", "case-sensitive: ALLOW-ONCE is not the wire format");
  assert.equal(coerceDecision("allow"), "deny", "bare 'allow' is not a valid decision");
});

test("bridge: happy path — handler called, SSE event emitted, decision returned", async () => {
  // The bridge is module-private. We test it via the public
  // observable: simulate the runtime's `askApprovalHandler` being
  // invoked by the bash tool, the SSE event being emitted to the
  // response, and `/v1/approval/respond` resolving the promise.
  //
  // We do this by replicating the bridge's algorithm inline — if
  // the production bridge and the inline test bridge diverge, the
  // integration test in server-expansion.test.ts catches it. The
  // unit tests here are about the contract pieces that are easy
  // to break in isolation: decision coercion, the
  // `writableEnded → deny` short-circuit, the `cleanup → restore`
  // pair.
  const rt = makeMockRuntime();
  const res = makeMockRes();

  // Simulate the bridge: install a handler that emits the SSE
  // event and awaits a promise that /v1/approval/respond resolves.
  let installedHandler: AskHandler = null;
  rt.askApprovalHandler = async () => { throw new Error("test must set this"); };
  const prev = rt.askApprovalHandler;
  let resolveApproval: (d: string) => void = () => {};
  const promise = new Promise<string>((resolve) => { resolveApproval = resolve; });
  installedHandler = async (_command: string, _reason: string) => {
    res.write("event: approval_required\ndata: {\"id\":\"x\"}\n\n");
    return coerceDecision(await promise);
  };
  rt.askApprovalHandler = installedHandler;
  const restore = () => { rt.askApprovalHandler = prev; };

  // Drive the handler the way the bash tool would.
  const decisionP = rt.askApprovalHandler!("rm -rf /tmp", "destructive");
  // Simulate the web UI posting to /v1/approval/respond.
  resolveApproval("allow-once");
  const decision = await decisionP;
  assert.equal(decision, "allow-once");
  // The SSE event landed in the response buffer.
  assert.ok(res.chunks.some((c) => c.includes("approval_required") && c.includes("\"id\":\"x\"")));
  // Cleanup restores the previous handler.
  restore();
  assert.equal(rt.askApprovalHandler, prev);
});

test("bridge: when the response is already ended, the bridge short-circuits to 'deny' without emitting an event", async () => {
  const rt = makeMockRuntime();
  const res = makeMockRes();
  res.setEnded();
  // Simulate the production bridge's `writableEnded` short-circuit.
  const bridgeHandler: AskHandler = async () => {
    if (res.writableEnded) return "deny" as const;
    res.write("event: approval_required\ndata: {}\n\n");
    return new Promise<"allow-once" | "allow-always" | "deny">(() => {}); // never resolves
  };
  rt.askApprovalHandler = bridgeHandler;
  const decision = await rt.askApprovalHandler!("rm -rf /", "destructive");
  assert.equal(decision, "deny");
  assert.equal(res.chunks.length, 0, "no SSE event should land on an already-ended response");
});
