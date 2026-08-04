// Tests for trajectory export (v0.2.2).
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Session } from "../agent/session.js";
import { exportSession, defaultExportDir } from "../agent/trajectory.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ch-export-"));
}

function makeSession(cwd: string, id: string): Promise<Session> {
  return Session.create({ cwd, name: "export-test-" + id });
}

test("export: hermes format writes one JSON per entry with type/ts/payload", async () => {
  const cwd = freshDir();
  try {
    const s = await makeSession(cwd, "hermes");
    await s.append({ kind: "message", message: { role: "user", content: "hello" } });
    await s.append({ kind: "message", message: { role: "assistant", content: "hi" } });
    const out = freshDir();
    const r = await exportSession(s, { format: "hermes", outDir: out });
    assert.ok(existsSync(r.path));
    const lines = readFileSync(r.path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!);
    // Entry type is the role (user/assistant/...); payload.kind says "message".
    assert.equal(first.type, "user");
    assert.ok(typeof first.ts === "number");
    assert.equal(first.payload.kind, "message");
    assert.equal(first.payload.message.role, "user");
    assert.equal(first.payload.message.content, "hello");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export: openai format produces one line with messages array", async () => {
  const cwd = freshDir();
  try {
    const s = await makeSession(cwd, "openai");
    await s.append({ kind: "message", message: { role: "user", content: "test" } });
    await s.append({ kind: "message", message: { role: "assistant", content: "ok" } });
    const out = freshDir();
    const r = await exportSession(s, { format: "openai", outDir: out });
    const lines = readFileSync(r.path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const obj = JSON.parse(lines[0]!);
    assert.equal(obj.messages.length, 2);
    assert.equal(obj.messages[0].role, "user");
    assert.equal(obj.messages[1].role, "assistant");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export: share format redacts API keys", async () => {
  const cwd = freshDir();
  try {
    const s = await makeSession(cwd, "share");
    await s.append({ kind: "message", message: { role: "user", content: "key=sk-1234567890abcdefghijklmnopqrstuv" } });
    const out = freshDir();
    const r = await exportSession(s, { format: "share", outDir: out });
    const content = readFileSync(r.path, "utf-8");
    assert.ok(!content.includes("sk-1234567890"), "API key should be redacted");
    assert.ok(content.includes("[REDACTED]"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export: share format redacts Groq / Perplexity / NVIDIA NIM API key prefixes", async () => {
  // Pre-fix the SECRET_RE covered the major providers (OpenAI,
  // Anthropic, xAI, GitHub, AWS, Google) but missed three
  // increasingly-common keys: Groq's `gsk-` prefix, Perplexity's
  // `pplx-` prefix, and NVIDIA NIM's `nvapi-` prefix. A
  // session that pasted any of these into a user message
  // and then exported in `share` format would have leaked
  // the key verbatim. Fix: extend SECRET_RE to match all
  // three with the same 20+ char shape. The test pins the
  // redaction for each prefix so a future regression where
  // the pattern is dropped is caught.
  const cwd = freshDir();
  try {
    const s = await makeSession(cwd, "share-vendor-keys");
    await s.append({
      kind: "message",
      message: {
        role: "user",
        // Each key is exactly 24+ chars after the prefix — matches
        // the {20,} shape in SECRET_RE.
        content:
          "gsk-" + "A".repeat(24) +
          " pplx-" + "B".repeat(24) +
          " nvapi-" + "C".repeat(24),
      },
    });
    const out = freshDir();
    const r = await exportSession(s, { format: "share", outDir: out });
    const content = readFileSync(r.path, "utf-8");
    assert.ok(!content.includes("gsk-" + "A".repeat(24)), "gsk- key should be redacted");
    assert.ok(!content.includes("pplx-" + "B".repeat(24)), "pplx- key should be redacted");
    assert.ok(!content.includes("nvapi-" + "C".repeat(24)), "nvapi- key should be redacted");
    // All three should be replaced with the [REDACTED] marker.
    const redactions = content.match(/\[REDACTED\]/g) ?? [];
    assert.ok(redactions.length >= 3, "expected at least 3 redactions, got " + redactions.length);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export: share format redacts Hugging Face / Replicate / Cohere / GitLab / Postman key prefixes", async () => {
  // Pre-fix: SECRET_RE covered OpenAI, Anthropic, xAI,
  // GitHub, AWS, Google, Groq, Perplexity, NVIDIA NIM —
  // but missed several other common developer-API key
  // prefixes that show up in LLM-adjacent workflows:
  //   hf_    Hugging Face (used to pull models + Inference API)
  //   r8_    Replicate
  //   co-    Cohere
  //   glpat- GitLab personal access token
  //   PMAK-  Postman API key
  // A session that pasted any of these into a user message
  // and then exported in `share` format would have leaked
  // the key verbatim — same class of bug as the
  // gsk-/pplx-/nvapi- fix. Fix: extend SECRET_RE to match
  // all five. The test pins the redaction for each prefix.
  const cwd = freshDir();
  try {
    const s = await makeSession(cwd, "share-vendor-keys-2");
    await s.append({
      kind: "message",
      message: {
        role: "user",
        // Each key is 24+ chars after the prefix to match
        // the {20,} shape in SECRET_RE.
        content:
          "hf_" + "A".repeat(24) +
          " r8_" + "B".repeat(24) +
          " co-" + "C".repeat(24) +
          " glpat-" + "D".repeat(24) +
          " PMAK-" + "E".repeat(24),
      },
    });
    const out = freshDir();
    const r = await exportSession(s, { format: "share", outDir: out });
    const content = readFileSync(r.path, "utf-8");
    assert.ok(!content.includes("hf_" + "A".repeat(24)), "hf_ key should be redacted");
    assert.ok(!content.includes("r8_" + "B".repeat(24)), "r8_ key should be redacted");
    assert.ok(!content.includes("co-" + "C".repeat(24)), "co- key should be redacted");
    assert.ok(!content.includes("glpat-" + "D".repeat(24)), "glpat- key should be redacted");
    assert.ok(!content.includes("PMAK-" + "E".repeat(24)), "PMAK- key should be redacted");
    // All five should be replaced with the [REDACTED] marker.
    const redactions = content.match(/\[REDACTED\]/g) ?? [];
    assert.ok(redactions.length >= 5, "expected at least 5 redactions, got " + redactions.length);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export: share format redacts Slack tokens, webhook secrets, and other vendor PATs (xoxb-/xoxp-/xapp-/whsec_/dop_v1_/dd_api_/npm_)", async () => {
  // Pre-fix: SECRET_RE covered the major LLM / VCS / cloud
  // key prefixes but missed a number of channel-plugin and
  // infrastructure prefixes that show up in real workflows:
  //   xoxb-    Slack bot token (channel plugin / integration)
  //   xoxp-    Slack user OAuth token
  //   xoxa-    Slack workspace OAuth token
  //   xapp-    Slack app-level token (socket mode)
  //   whsec_   Generic webhook signing secret (Stripe et al)
  //   dop_v1_  DigitalOcean personal access token
  //   dd_api_  Datadog API key
  //   npm_     npm automation token
  // A session that pasted any of these into a user message
  // and then exported in `share` format would have leaked
  // the key verbatim. Fix: extend SECRET_RE with all
  // eight patterns. The test pins the redaction for each.
  const cwd = freshDir();
  try {
    const s = await makeSession(cwd, "share-vendor-keys-3");
    await s.append({
      kind: "message",
      message: {
        role: "user",
        // Each key is 24+ chars after the prefix to match
        // the {20,} shape in SECRET_RE.
        content:
          "xoxb-" + "A".repeat(24) +
          " xoxp-" + "B".repeat(24) +
          " xoxa-" + "C".repeat(24) +
          " xapp-" + "D".repeat(24) +
          " whsec_" + "E".repeat(24) +
          " dop_v1_" + "F".repeat(24) +
          " dd_api_" + "G".repeat(24) +
          " npm_" + "H".repeat(24),
      },
    });
    const out = freshDir();
    const r = await exportSession(s, { format: "share", outDir: out });
    const content = readFileSync(r.path, "utf-8");
    assert.ok(!content.includes("xoxb-" + "A".repeat(24)), "xoxb- key should be redacted");
    assert.ok(!content.includes("xoxp-" + "B".repeat(24)), "xoxp- key should be redacted");
    assert.ok(!content.includes("xoxa-" + "C".repeat(24)), "xoxa- key should be redacted");
    assert.ok(!content.includes("xapp-" + "D".repeat(24)), "xapp- key should be redacted");
    assert.ok(!content.includes("whsec_" + "E".repeat(24)), "whsec_ key should be redacted");
    assert.ok(!content.includes("dop_v1_" + "F".repeat(24)), "dop_v1_ key should be redacted");
    assert.ok(!content.includes("dd_api_" + "G".repeat(24)), "dd_api_ key should be redacted");
    assert.ok(!content.includes("npm_" + "H".repeat(24)), "npm_ key should be redacted");
    // All eight should be replaced with the [REDACTED] marker.
    const redactions = content.match(/\[REDACTED\]/g) ?? [];
    assert.ok(redactions.length >= 8, "expected at least 8 redactions, got " + redactions.length);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export: share format redacts Stripe, GitHub OAuth, SendGrid, Linear, Google OAuth, PyPI, GitLab new PAT (sk_live_/sk_test_/rk_live_/gho_/ghu_/ghr_/ghs_/SG./lin_api_/ya29./pypi-/glsa1_)", async () => {
  // Pre-fix: SECRET_RE covered the major LLM / VCS / cloud /
  // channel-plugin prefixes but missed a second wave of
  // common vendor prefixes that show up in real workflows:
  //   sk_live_ / sk_test_ / rk_live_  Stripe secret + restricted keys
  //                                    (NOT covered by the bare
  //                                    sk- pattern, because Stripe
  //                                    uses an underscore after `sk`,
  //                                    not a dash)
  //   gho_ / ghu_ / ghr_ / ghs_      GitHub OAuth / user / refresh /
  //                                    server tokens (separate from
  //                                    ghp_ which is the PAT format)
  //   SG.                            SendGrid API key (literal
  //                                    "SG." prefix, then base64-ish
  //                                    payload, then ".", then more
  //                                    payload)
  //   lin_api_                       Linear API key
  //   ya29.                          Google OAuth2 access token
  //   pypi-...                       PyPI upload token (the project
  //                                    base64-encodes a project URL
  //                                    so we use a more permissive
  //                                    pattern for the suffix)
  //   glsa1_                         GitLab new PAT format (separate
  //                                    from glpat- which is the older
  //                                    format)
  // A session that pasted any of these into a user message
  // and then exported in `share` format would have leaked
  // the key verbatim. Fix: extend SECRET_RE with all 11
  // new patterns. The test pins the redaction for each.
  const cwd = freshDir();
  try {
    const s = await makeSession(cwd, "share-vendor-keys-4");
    await s.append({
      kind: "message",
      message: {
        role: "user",
        // Each key is 24+ chars after the prefix to match
        // the {20,} shape in SECRET_RE.
        content:
          "sk_live_" + "A".repeat(24) +
          " sk_test_" + "B".repeat(24) +
          " rk_live_" + "C".repeat(24) +
          " gho_" + "D".repeat(36) +
          " ghu_" + "E".repeat(36) +
          " ghr_" + "F".repeat(36) +
          " ghs_" + "G".repeat(36) +
          " SG." + "H".repeat(22) + "." + "I".repeat(22) +
          " lin_api_" + "J".repeat(24) +
          " ya29." + "K".repeat(24) +
          " pypi-AgEIcHlwaS5vcmc" + "L".repeat(60) +
          " glsa1_" + "M".repeat(24),
      },
    });
    const out = freshDir();
    const r = await exportSession(s, { format: "share", outDir: out });
    const content = readFileSync(r.path, "utf-8");
    assert.ok(!content.includes("sk_live_" + "A".repeat(24)), "sk_live_ key should be redacted");
    assert.ok(!content.includes("sk_test_" + "B".repeat(24)), "sk_test_ key should be redacted");
    assert.ok(!content.includes("rk_live_" + "C".repeat(24)), "rk_live_ key should be redacted");
    assert.ok(!content.includes("gho_" + "D".repeat(36)), "gho_ key should be redacted");
    assert.ok(!content.includes("ghu_" + "E".repeat(36)), "ghu_ key should be redacted");
    assert.ok(!content.includes("ghr_" + "F".repeat(36)), "ghr_ key should be redacted");
    assert.ok(!content.includes("ghs_" + "G".repeat(36)), "ghs_ key should be redacted");
    assert.ok(!content.includes("SG." + "H".repeat(22) + "." + "I".repeat(22)), "SG. key should be redacted");
    assert.ok(!content.includes("lin_api_" + "J".repeat(24)), "lin_api_ key should be redacted");
    assert.ok(!content.includes("ya29." + "K".repeat(24)), "ya29. key should be redacted");
    assert.ok(!content.includes("pypi-AgEIcHlwaS5vcmc" + "L".repeat(60)), "pypi- key should be redacted");
    assert.ok(!content.includes("glsa1_" + "M".repeat(24)), "glsa1_ key should be redacted");
    // All twelve should be replaced with the [REDACTED] marker.
    const redactions = content.match(/\[REDACTED\]/g) ?? [];
    assert.ok(redactions.length >= 12, "expected at least 12 redactions, got " + redactions.length);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export: share format redacts Discord bot tokens, Vercel tokens, and Google Maps API keys (dc0_/dck_/va_/vercel_/key-)", async () => {
  // Pre-fix: SECRET_RE covered the major LLM / VCS / cloud /
  // channel-plugin / payment / GitHub-OAuth / SendGrid /
  // Linear / PyPI / GitLab-new-PAT / Slack / webhook-secret
  // prefixes but missed a final wave of common developer
  // tool prefixes that show up in real workflows:
  //   dc0_      Discord bot token (new format, since 2024)
  //   dck_      Discord bot token (compact, alternate)
  //   va_       Vercel access token (older format)
  //   vercel_   Vercel access token (newer format, longer)
  //   key-      Google Maps / Places API key
  // A session that pasted any of these into a user message
  // and then exported in `share` format would have leaked
  // the key verbatim. Fix: extend SECRET_RE with all five
  // patterns. The test pins the redaction for each.
  const cwd = freshDir();
  try {
    const s = await makeSession(cwd, "share-vendor-keys-5");
    await s.append({
      kind: "message",
      message: {
        role: "user",
        // Each key is 24+ chars after the prefix to match
        // the {20,} shape in SECRET_RE.
        content:
          "dc0_" + "A".repeat(24) +
          " dck_" + "B".repeat(24) +
          " va_" + "C".repeat(24) +
          " vercel_" + "D".repeat(24) +
          " key-" + "E".repeat(39),
      },
    });
    const out = freshDir();
    const r = await exportSession(s, { format: "share", outDir: out });
    const content = readFileSync(r.path, "utf-8");
    assert.ok(!content.includes("dc0_" + "A".repeat(24)), "dc0_ key should be redacted");
    assert.ok(!content.includes("dck_" + "B".repeat(24)), "dck_ key should be redacted");
    assert.ok(!content.includes("va_" + "C".repeat(24)), "va_ key should be redacted");
    assert.ok(!content.includes("vercel_" + "D".repeat(24)), "vercel_ key should be redacted");
    assert.ok(!content.includes("key-" + "E".repeat(39)), "key- key should be redacted");
    // All five should be replaced with the [REDACTED] marker.
    const redactions = content.match(/\[REDACTED\]/g) ?? [];
    assert.ok(redactions.length >= 5, "expected at least 5 redactions, got " + redactions.length);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export: share format replaces absolute cwd paths with relative", async () => {
  const cwd = freshDir();
  try {
    const s = await makeSession(cwd, "share-paths");
    await s.append({ kind: "message", message: { role: "user", content: "open " + cwd + "/foo.ts" } });
    const out = freshDir();
    const r = await exportSession(s, { format: "share", outDir: out });
    const content = readFileSync(r.path, "utf-8");
    // The user message content should have the cwd anonymized to "./".
    assert.ok(content.includes("open ./foo.ts"), "user content should be anonymized; got: " + content);
    // The metadata `cwd` should also be anonymized to a relative form.
    const obj = JSON.parse(content);
    assert.ok(!obj.cwd.includes(freshDir().slice(1, 20)), "metadata cwd should be anonymized; got: " + obj.cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export: tool results surface as 'tool' role messages", async () => {
  const cwd = freshDir();
  try {
    const s = await makeSession(cwd, "tool");
    await s.append({
      kind: "tool_result",
      toolCallId: "tc1",
      toolName: "bash",
      result: { toolCallId: "tc1", display: "ok", content: "hello world", isError: false },
    });
    const out = freshDir();
    const r = await exportSession(s, { format: "openai", outDir: out });
    const obj = JSON.parse(readFileSync(r.path, "utf-8").trim());
    const toolMsg = obj.messages.find((m: { role: string }) => m.role === "tool");
    assert.ok(toolMsg, "should have a tool message");
    assert.equal(toolMsg.tool_call_id, "tc1");
    assert.equal(toolMsg.name, "bash");
    assert.match(toolMsg.content, /hello world/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export: empty session writes an empty file (no lines)", async () => {
  const cwd = freshDir();
  try {
    const s = await makeSession(cwd, "empty");
    const out = freshDir();
    const r = await exportSession(s, { format: "openai", outDir: out });
    assert.equal(r.lineCount, 0);
    // File exists but has 0 bytes (or trailing newline only).
    const content = readFileSync(r.path, "utf-8");
    assert.ok(content.length <= 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export: compaction surfaces as a [compaction] system message", async () => {
  const cwd = freshDir();
  try {
    const s = await makeSession(cwd, "compact");
    await s.compact("the user asked about the build", "test");
    const out = freshDir();
    const r = await exportSession(s, { format: "openai", outDir: out });
    const obj = JSON.parse(readFileSync(r.path, "utf-8").trim());
    const sys = obj.messages.find((m: { role: string }) => m.role === "system");
    assert.ok(sys);
    assert.match(sys.content, /compaction/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("defaultExportDir: lives under ~/.codingharness/exports", () => {
  const d = defaultExportDir();
  assert.ok(d.includes("codingharness"));
  assert.ok(d.endsWith("exports"));
});

test("ALL OK", () => {});
