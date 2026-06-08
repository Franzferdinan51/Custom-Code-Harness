// CodingHarness web UI — client-side logic.
// Talks to ch serve at the same origin (relative URLs).

// ---------- State ----------

const state = {
  version: "—",
  model: "—",
  provider: "—",
  session: "—",
  tokensIn: 0,
  tokensOut: 0,
  cost: 0,
  steps: 0,
  thinking: "medium",
  approval: "on-mutation",
  streaming: false,
  currentStreamEl: null,
  slashNames: [],
  slashCommands: [],
  history: [],
  historyIndex: -1,
  pendingApproval: null,   // { resolve, command, reason }
  activeSubagents: [],
  recentSessions: [],
  sessionQuery: "",
  goalActivity: null,
  composerMode: "build",
  providerPresets: [],
  providerProfiles: [],
};

// ---------- DOM helpers ----------

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const inputEl = $("input");
const inputForm = $("input-form");
const infoBanner = $("info-banner");
const slashPanel = $("slash-panel");
const commandPaletteEl = $("command-palette");
const commandPaletteInput = $("command-palette-input");
const commandPaletteList = $("command-palette-list");
let composerHintEl = null;
let composerBuildButton = null;
let composerPlanButton = null;

const COMPOSER_MODE_STORAGE_KEY = "codingharness.composerMode";
const COMPOSER_MODE_HELP = {
  build: "plain prompts become implementation requests",
  plan: "plain prompts become planning requests",
};
const COMPOSER_MODE_FRAME = {
  build: [
    "Build mode:",
    "Treat the user's request as an implementation task in the current repository.",
    "Prefer concrete edits, clear next steps, and concise explanations.",
    "If details are missing, make sensible assumptions and state them briefly.",
  ].join("\n"),
  plan: [
    "Plan mode:",
    "Treat the user's request as a planning task in the current repository.",
    "Do not propose file edits unless the user explicitly asks for implementation.",
    "Return a concise plan, key files or areas to inspect, and any risks or unknowns.",
  ].join("\n"),
};

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "style") Object.assign(e.style, v);
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function renderText(text) {
  // Minimal Markdown: code fences, inline code, links.
  if (!text) return document.createTextNode("");
  // For simplicity, escape HTML, then handle ```code``` blocks and `inline`.
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out = document.createElement("span");
  // Code blocks
  const re = /```(\w*)\n?([\s\S]*?)```|`([^`]+)`/g;
  let last = 0; let m;
  while ((m = re.exec(escaped))) {
    if (m.index > last) out.appendChild(document.createTextNode(escaped.slice(last, m.index)));
    if (m[2] !== undefined) {
      const pre = el("pre");
      pre.appendChild(document.createTextNode(m[2]));
      out.appendChild(pre);
    } else {
      const c = el("code");
      c.appendChild(document.createTextNode(m[3]));
      out.appendChild(c);
    }
    last = re.lastIndex;
  }
  if (last < escaped.length) out.appendChild(document.createTextNode(escaped.slice(last)));
  return out;
}

function shortSessionId(id) {
  if (!id || id === "—") return "—";
  return id.slice(0, 8);
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "true");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}

function normalizeComposerMode(mode) {
  return mode === "plan" ? "plan" : "build";
}

function loadComposerMode() {
  try {
    return normalizeComposerMode(localStorage.getItem(COMPOSER_MODE_STORAGE_KEY));
  } catch {
    return "build";
  }
}

function saveComposerMode(mode) {
  try {
    localStorage.setItem(COMPOSER_MODE_STORAGE_KEY, normalizeComposerMode(mode));
  } catch {
    /* ignore persistence failures */
  }
}

function composerPromptFrame(mode) {
  return COMPOSER_MODE_FRAME[normalizeComposerMode(mode)];
}

function composeComposerPrompt(text, mode) {
  if (text.startsWith("/")) return text;
  return composerPromptFrame(mode) + "\n\nUser request:\n" + text;
}

function updateComposerHint() {
  if (!composerHintEl) return;
  composerHintEl.textContent =
    state.composerMode + " mode · " +
    COMPOSER_MODE_HELP[state.composerMode] +
    " · ⌘/Ctrl+K commands · ⏎ send · ⇧⏎ newline · Tab complete slash · ↑/↓ history · Ctrl+L clear";
}

function renderComposerModeButtons() {
  const buttons = [
    [composerBuildButton, "build"],
    [composerPlanButton, "plan"],
  ];
  for (const [button, mode] of buttons) {
    if (!button) continue;
    const active = state.composerMode === mode;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.style.opacity = active ? "1" : "0.72";
    button.style.borderColor = active
      ? (mode === "plan" ? "rgba(126, 212, 163, 0.42)" : "rgba(94, 209, 255, 0.42)")
      : "rgba(94, 209, 255, 0.22)";
    button.style.background = active
      ? (mode === "plan"
        ? "linear-gradient(135deg, rgba(126, 212, 163, 0.22), rgba(94, 209, 255, 0.16))"
        : "linear-gradient(135deg, rgba(94, 209, 255, 0.24), rgba(108, 140, 255, 0.20))")
      : "";
  }
}

function setComposerMode(mode, { focusInput = false } = {}) {
  const next = normalizeComposerMode(mode);
  if (state.composerMode !== next) {
    state.composerMode = next;
    saveComposerMode(next);
  }
  updateComposerHint();
  renderComposerModeButtons();
  renderGoalActivity();
  if (focusInput) inputEl.focus();
}

// ---------- Messages ----------

function addMessage({ kind, text, meta }) {
  const m = el("div", { class: "message message-" + kind });
  m.appendChild(el("div", { class: "message-prefix" }, [
    kind === "user" ? "›" :
    kind === "tool" ? (meta?.status === "ok" ? "✓" : meta?.status === "err" ? "✗" : "⋯") :
    kind === "error" ? "!" :
    kind === "info" ? "·" :
    kind === "system" ? "·" : "·"
  ]));
  m.appendChild(el("div", { class: "message-body" }));
  m.lastChild.appendChild(renderText(text));
  messagesEl.appendChild(m);
  scrollToBottom();
  return m;
}

function appendToStream(text) {
  if (!state.currentStreamEl) {
    state.currentStreamEl = addMessage({ kind: "assistant", text: "" });
    state.currentStreamEl.classList.add("streaming");
  }
  // Append to the body — for streaming, simplest: re-render. For better perf, use a text node.
  const body = state.currentStreamEl.querySelector(".message-body");
  // Clear and re-render (cheap for our sizes).
  body.innerHTML = "";
  body.appendChild(renderText(state.streamBuffer + text));
  scrollToBottom();
}

function endStream() {
  if (state.currentStreamEl) {
    state.currentStreamEl.classList.remove("streaming");
    state.currentStreamEl = null;
  }
  state.streamBuffer = "";
}

function addToolCall({ name, status, detail }) {
  return addMessage({
    kind: "tool",
    text: name + (detail ? "  " + detail : ""),
    meta: { name, status },
  });
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- API ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = j.error || detail; } catch {}
    throw new Error(detail);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

// ---------- Status sync ----------

async function refreshStatus() {
  try {
    const s = await api("/v1/status");
    state.version = s.version;
    state.model = s.model || "—";
    state.provider = s.provider || "—";
    state.session = s.session || "—";
    state.goalActivity = s.goalActivity || null;
    $("version").textContent = "v" + state.version;
    $("model").textContent = state.provider + " / " + state.model;
    $("header-session").textContent = "session " + shortSessionId(state.session);
    $("approval-status").textContent = state.approval;
    renderGoalActivity();
  } catch (e) {
    console.error("status:", e);
  }
}

function renderGoalActivity() {
  const root = $("goal-activity");
  const activity = state.goalActivity;
  root.innerHTML = "";
  const sessionId = state.session;
  const sessionActive = sessionId !== "—";
  const sessionChip = el("button", {
    class: "sidebar-run-chip sidebar-run-chip-copy" + (sessionActive ? "" : " is-muted"),
    type: "button",
    title: sessionActive ? "Copy the full session id" : "No active session",
  }, sessionActive ? "session " + shortSessionId(sessionId) : "session —");
  if (!sessionActive) {
    sessionChip.disabled = true;
    sessionChip.setAttribute("aria-disabled", "true");
  }
  if (sessionActive) {
    sessionChip.addEventListener("click", async () => {
      try {
        await copyText(sessionId);
        showInfo("Session id copied.");
      } catch {
        showInfo("Could not copy session id.");
      }
    });
  }

  const actionRow = el("div", { class: "sidebar-run-actions" }, []);
  const goalButton = el("button", { class: "sidebar-run-action", type: "button" }, "/goal");
  const commandsButton = el("button", { class: "sidebar-run-action", type: "button" }, "commands");
  goalButton.addEventListener("click", () => primeGoalInput());
  commandsButton.addEventListener("click", () => openCommandPalette(""));
  actionRow.appendChild(goalButton);
  actionRow.appendChild(commandsButton);

  const modeRow = el("div", { class: "sidebar-run-actions" }, []);
  const buildButton = el("button", {
    class: "sidebar-run-action",
    type: "button",
    "aria-pressed": state.composerMode === "build" ? "true" : "false",
  }, "build");
  const planButton = el("button", {
    class: "sidebar-run-action",
    type: "button",
    "aria-pressed": state.composerMode === "plan" ? "true" : "false",
  }, "plan");
  const paintComposerButton = (button, mode) => {
    const active = state.composerMode === mode;
    button.style.opacity = active ? "1" : "0.72";
    button.style.borderColor = active
      ? (mode === "plan" ? "rgba(126, 212, 163, 0.42)" : "rgba(94, 209, 255, 0.42)")
      : "";
    button.style.background = active
      ? (mode === "plan"
        ? "linear-gradient(135deg, rgba(126, 212, 163, 0.22), rgba(94, 209, 255, 0.16))"
        : "linear-gradient(135deg, rgba(94, 209, 255, 0.24), rgba(108, 140, 255, 0.20))")
      : "";
  };
  paintComposerButton(buildButton, "build");
  paintComposerButton(planButton, "plan");
  buildButton.addEventListener("click", () => setComposerMode("build", { focusInput: true }));
  planButton.addEventListener("click", () => setComposerMode("plan", { focusInput: true }));
  modeRow.appendChild(buildButton);
  modeRow.appendChild(planButton);

  const phaseLabel = activity ? (activity.phase === "executing" ? "running" : activity.phase) : state.composerMode;
  const stepLabel = activity
    ? (activity.step > 0 ? "step " + activity.step + "/" + activity.maxSteps : "plan")
    : (state.composerMode === "plan" ? "plan first" : "build direct");
  const progress = activity && activity.maxSteps > 0 ? Math.max(0, Math.min(100, Math.round((activity.step / activity.maxSteps) * 100))) : 0;
  const objective = activity
    ? activity.objective
    : (state.composerMode === "plan"
      ? "Plan mode frames plain prompts as planning requests."
      : "Build mode frames plain prompts as implementation requests.");
  const status = activity
    ? (activity.statusText || "Working through the goal.")
    : (state.composerMode === "plan"
      ? "Plain prompts will be framed as planning requests."
      : "Plain prompts will be framed as implementation requests.");

  root.appendChild(el("div", { class: "sidebar-goal-card" }, [
    el("div", { class: "sidebar-goal-top" }, [
      el("span", { class: "sidebar-goal-phase" }, phaseLabel),
      el("span", {}, activity ? formatAgo(activity.updatedAt) : "idle"),
    ]),
    el("div", { class: "sidebar-run-session" }, [
      sessionChip,
      el("span", { class: "sidebar-run-session-meta" }, activity ? "started " + formatAgo(activity.startedAt) : "current session"),
    ]),
    el("div", { class: "sidebar-goal-objective" }, objective),
    el("div", { class: "sidebar-goal-meta" }, [
      el("span", {}, stepLabel),
      el("span", {}, activity ? activity.mode : state.composerMode),
    ]),
    el("div", { class: "sidebar-run-progress", "aria-hidden": "true" }, [
      el("span", { style: { width: progress + "%" } }),
    ]),
    el("div", { class: "sidebar-goal-status" }, status),
    modeRow,
    actionRow,
  ]));
}

async function refreshSessions() {
  try {
    const query = state.sessionQuery ? "?query=" + encodeURIComponent(state.sessionQuery) : "";
    const j = await api("/v1/sessions" + query);
    state.recentSessions = (j.sessions || []).slice(0, 6);
    const list = $("session-list");
    const sessionsLabel = $("sessions-label");
    if (sessionsLabel) {
      sessionsLabel.textContent = "sessions" + (state.sessionQuery ? " · filtered" : "") + " (" + state.recentSessions.length + ")";
    }
    list.innerHTML = "";
    if (state.recentSessions.length === 0) {
      list.appendChild(el("div", { class: "sidebar-empty" }, state.sessionQuery ? "no matches" : "none"));
    } else {
      for (const s of state.recentSessions) {
        const marker = s.id === state.session ? "●" : " ";
        const when = formatAgo(s.updatedAt);
        const short = s.id.slice(0, 8);
        const row = el("div", { class: "row" + (s.id === state.session ? " is-active" : "") }, [
          el("span", { class: "marker" }, marker),
          el("span", {}, short),
          s.id === state.session ? el("span", { class: "session-pill" }, "active") : null,
          el("span", { class: "when" }, when),
        ]);
        row.style.cursor = "pointer";
        row.title = "Click to resume " + s.id;
        row.addEventListener("click", () => resumeSession(s.id));
        list.appendChild(row);
        if (s.preview) {
          list.appendChild(el("div", { class: "sidebar-preview" }, s.preview));
        }
      }
    }
  } catch (e) { console.error("sessions:", e); }
}

async function refreshAgents() {
  try {
    const j = await api("/v1/agents");
    const list = $("agents-list");
    list.innerHTML = "";
    const agents = (j.agents || []).filter(a => a.builtin);
    if (agents.length === 0) {
      list.appendChild(el("div", { class: "sidebar-empty" }, "none"));
      return;
    }
    for (const a of agents.slice(0, 8)) {
      list.appendChild(el("div", { class: "row" }, [
        el("span", { class: "marker" }, "·"),
        el("span", {}, a.name),
      ]));
    }
  } catch (e) { console.error("agents:", e); }
}

async function refreshUsage() {
  try {
    const j = await api("/v1/usage");
    state.tokensIn = j.inputTokens || 0;
    state.tokensOut = j.outputTokens || 0;
    state.cost = j.cost || 0;
    $("tokens").textContent = "tokens " + state.tokensIn + " in / " + state.tokensOut + " out";
    $("cost").textContent = formatUSD(state.cost);
    $("cost-total").textContent = formatUSD(state.cost);
    $("cost-tokens").textContent = state.tokensIn + " in / " + state.tokensOut + " out";
    if (j.topModel) {
      const m = j.topModel;
      $("cost-model").textContent = (m.model.length > 22 ? m.model.slice(0, 20) + "…" : m.model) + "  " + formatUSD(m.cost);
    }
  } catch (e) { console.error("usage:", e); }
}

function formatUSD(n) {
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}

function formatAgo(t) {
  const dt = Date.now() - t;
  if (dt < 60_000) return Math.floor(dt / 1000) + "s";
  if (dt < 3_600_000) return Math.floor(dt / 60_000) + "m";
  if (dt < 86_400_000) return Math.floor(dt / 3_600_000) + "h";
  return Math.floor(dt / 86_400_000) + "d";
}

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshSessions(), refreshAgents(), refreshUsage()]);
  try {
    const cmds = await api("/v1/commands");
    state.slashNames = cmds.commands || [];
    state.slashCommands = cmds.items || [];
  } catch {}
}

const SLASH_GROUP_PRIORITY = {
  workflow: 0,
  session: 1,
  model: 2,
  memory: 3,
  agent: 4,
  other: 5,
};

function scoreSlashCommand(cmd, query) {
  const groupRank = SLASH_GROUP_PRIORITY[cmd.group] ?? SLASH_GROUP_PRIORITY.other;
  if (!query) {
    const goalRank = cmd.name === "goal" ? -20 : 0;
    const helpRank = cmd.name === "help" ? -10 : 0;
    return groupRank * 100 + goalRank + helpRank;
  }
  const haystack = [cmd.name, cmd.description, cmd.usage || "", cmd.group || ""].join(" ").toLowerCase();
  if (!haystack.includes(query)) return Number.POSITIVE_INFINITY;
  let score = groupRank * 10;
  if (cmd.name === query) score -= 80;
  if (cmd.name.startsWith(query)) score -= 40;
  if ((cmd.usage || "").toLowerCase().includes(query)) score -= 15;
  if (cmd.description.toLowerCase().includes(query)) score -= 10;
  if (cmd.name === "goal") score -= 5;
  return score + cmd.name.length / 100;
}

function getSlashMatches(query) {
  const normalized = query.trim().replace(/^\//, "").toLowerCase();
  return state.slashCommands
    .map((cmd) => ({ cmd, score: scoreSlashCommand(cmd, normalized) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score || a.cmd.name.localeCompare(b.cmd.name))
    .slice(0, normalized ? 10 : 8)
    .map(({ cmd }) => cmd);
}

function renderSlashPanel(query) {
  const value = query.trim();
  if (!value.startsWith("/")) {
    slashPanel.hidden = true;
    slashPanel.innerHTML = "";
    return;
  }
  const base = value.slice(1);
  if (base.includes(" ")) {
    slashPanel.hidden = true;
    slashPanel.innerHTML = "";
    return;
  }
  const matches = getSlashMatches(base);
  if (matches.length === 0) {
    slashPanel.hidden = true;
    slashPanel.innerHTML = "";
    return;
  }
  slashPanel.hidden = false;
  slashPanel.innerHTML = "";
  matches.forEach((cmd, index) => {
    const row = el("div", { class: "slash-item" + (index === 0 ? " active" : "") }, [
      el("div", { class: "slash-name" }, "/" + cmd.name),
      el("div", { class: "slash-desc" }, cmd.description),
    ]);
    row.addEventListener("click", () => {
      inputEl.value = "/" + cmd.name + " ";
      autoResize();
      inputEl.focus();
      slashPanel.hidden = true;
    });
    slashPanel.appendChild(row);
  });
}

function renderCommandPalette(filter = "") {
  const matches = getSlashMatches(filter);
  commandPaletteList.innerHTML = "";
  if (matches.length === 0) {
    commandPaletteList.appendChild(el("div", { class: "command-palette-empty" }, "No matching commands."));
    return;
  }
  for (const cmd of matches) {
    const row = el("div", { class: "command-palette-item" + (cmd.name === "goal" ? " featured" : "") }, [
      el("div", { class: "slash-name" }, cmd.usage || "/" + cmd.name),
      el("div", { class: "slash-desc" }, cmd.description),
      el("div", { class: "command-palette-meta" }, [
        el("span", {}, cmd.group || "other"),
        el("span", {}, "slash"),
      ]),
    ]);
    row.addEventListener("click", () => {
      inputEl.value = "/" + cmd.name + " ";
      autoResize();
      closeCommandPalette();
      inputEl.focus();
    });
    commandPaletteList.appendChild(row);
  }
}

function openCommandPalette(prefill = "") {
  commandPaletteEl.hidden = false;
  commandPaletteInput.value = prefill;
  renderCommandPalette(prefill);
  commandPaletteInput.focus();
  commandPaletteInput.select();
}

function closeCommandPalette() {
  commandPaletteEl.hidden = true;
  commandPaletteInput.value = "";
}

function setComposerMode(mode) {
  state.composerMode = mode === "plan" ? "plan" : "build";
  const isPlan = state.composerMode === "plan";
  $("mode-plan")?.classList.toggle("is-active", isPlan);
  $("mode-build")?.classList.toggle("is-active", !isPlan);
  $("mode-plan")?.setAttribute("aria-pressed", String(isPlan));
  $("mode-build")?.setAttribute("aria-pressed", String(!isPlan));
  $("composer-metric-plan")?.classList.toggle("is-active", isPlan);
  $("composer-metric-build")?.classList.toggle("is-active", !isPlan);
  $("composer-copy").textContent = isPlan
    ? "Stay in analysis mode: clarify scope, assumptions, and next steps before changing code."
    : "Execute directly in the repo: use tools, commands, and edits to ship the task.";
  $("composer-status").textContent = isPlan
    ? "Plan mode · reasoning first"
    : "Build mode · direct execution";
  $("composer-plan-copy").textContent = isPlan
    ? "active · scope, assumptions, next steps"
    : "scope, assumptions, next steps";
  $("composer-build-copy").textContent = isPlan
    ? "tools stay parked until you switch"
    : "active · tools, commands, and edits";
  $("input-hint").textContent = isPlan
    ? "Plan mode avoids repo changes by default · ⌘/Ctrl+K commands · ⇧⏎ newline"
    : "⌘/Ctrl+K commands · ⏎ send · ⇧⏎ newline · Tab complete slash · ↑/↓ history · Ctrl+L clear";
  $("input-meta").textContent = "Mode: " + state.composerMode;
  inputEl.placeholder = isPlan
    ? "Describe the outcome and constraints. I’ll plan it before building."
    : "Ask something, or start with /goal...";
}

function preparePromptForComposerMode(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return trimmed;
  if (state.composerMode === "plan") {
    return [
      "Planning mode:",
      "Analyze the task, call out assumptions, and produce a concise implementation plan.",
      "Do not make repository changes or run tools unless the user explicitly asks you to execute.",
      "",
      "User request:",
      trimmed,
    ].join("\n");
  }
  return trimmed;
}

function primeGoalInput() {
  setComposerMode("build");
  inputEl.value = "/goal ";
  autoResize();
  renderSlashPanel(inputEl.value);
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}

function handleDesktopCommand(command) {
  switch (command) {
    case "new-session":
      $("new-session").click();
      break;
    case "plan":
      setComposerMode("plan");
      inputEl.focus();
      break;
    case "build":
      setComposerMode("build");
      inputEl.focus();
      break;
    case "goal":
      primeGoalInput();
      break;
    case "command-palette":
      openCommandPalette("");
      break;
    case "show-logs":
      window.ch?.showLogs?.();
      break;
    case "reveal-appdata":
      window.ch?.revealAppData?.();
      break;
  }
}

function handleDeepLink(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const parts = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    if (host === "new-session") {
      $("new-session").click();
      showInfo("Started a new session from deep link.");
      return;
    }
    if (host === "goal") {
      const objective = [parts.join("/"), parsed.searchParams.get("q") || ""].filter(Boolean).join(" ").trim();
      inputEl.value = objective ? "/goal " + objective : "/goal ";
      autoResize();
      inputEl.focus();
      showInfo("Goal mode ready.");
      return;
    }
    if (host === "plan") {
      setComposerMode("plan");
      inputEl.focus();
      showInfo("Plan mode ready.");
      return;
    }
    if (host === "build") {
      setComposerMode("build");
      inputEl.focus();
      showInfo("Build mode ready.");
      return;
    }
    if (host === "session" && parts[0]) {
      void resumeSession(parts[0]);
      showInfo("Resuming session " + parts[0].slice(0, 8) + "…");
      return;
    }
    if (host === "command" && parts[0]) {
      inputEl.value = "/" + parts[0] + " ";
      autoResize();
      inputEl.focus();
      return;
    }
  } catch {}
  showInfo("Deep link: " + url);
}

// ---------- Streaming chat ----------

async function sendPrompt(prompt, opts = {}) {
  if (state.streaming) return;
  state.streaming = true;
  $("send-button").disabled = true;
  $("send-button").textContent = "running…";
  state.streamBuffer = "";

  // Echo user message.
  addMessage({ kind: "user", text: opts.displayText || prompt });

  try {
    await refreshStatus();
    const res = await fetch("/v1/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { const j = await res.json(); detail = j.error || detail; } catch {}
      addMessage({ kind: "error", text: "error: " + detail });
      state.streaming = false;
      $("send-button").disabled = false;
      $("send-button").textContent = "send";
      return;
    }

    // Parse SSE.
    const reader = res.body.getReader();
    const dec = new TextDecoder("utf-8");
    let buf = "";
    let pendingApproval = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = block.split("\n");
        let event = "message"; let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        await handleEvent(event, payload, (decision) => {
          pendingApproval = { resolve: null, decision };
        });
      }
    }
    endStream();
    // If we were waiting on an approval, resolve it now.
    if (pendingApproval) pendingApproval.decision("deny");
  } catch (e) {
    addMessage({ kind: "error", text: "stream error: " + e.message });
  } finally {
    state.streaming = false;
    $("send-button").disabled = false;
    $("send-button").textContent = "send";
    refreshUsage();
    refreshSessions();
  }
}

async function handleEvent(event, p, _resolveApproval) {
  switch (event) {
    case "text":       appendToStream(p.text || ""); break;
    case "tool_start": addToolCall({ name: p.name, status: "run" }); break;
    case "tool_end":
      // Find the last "run" tool call with this name and update its status.
      const tools = messagesEl.querySelectorAll(".message-tool.tool-run");
      for (let i = tools.length - 1; i >= 0; i--) {
        const m = tools[i];
        const prefix = m.querySelector(".message-prefix");
        if (prefix.textContent === "⋯") {
          m.classList.remove("tool-run");
          m.classList.add(p.isError ? "tool-err" : "tool-ok");
          prefix.textContent = p.isError ? "✗" : "✓";
          const body = m.querySelector(".message-body");
          body.innerHTML = "";
          body.appendChild(renderText(p.name + (p.detail ? "  " + p.detail : "")));
          break;
        }
      }
      break;
    case "info":
      addMessage({ kind: "info", text: p.text || "" });
      if ((p.text || "").includes("[goal]")) void refreshStatus();
      break;
    case "error":      addMessage({ kind: "error", text: p.text || "" }); break;
    case "approval_required": {
      // Pop the approval modal; resolve the SSE with the user's decision
      // via a separate POST to /v1/approval/respond.
      const decision = await askApproval(p.command, p.reason);
      await api("/v1/approval/respond", { method: "POST", body: { id: p.id, decision } });
      break;
    }
    case "usage":      /* server will refresh on completion */ break;
    case "done":       break;
    case "approval_resolved": addMessage({ kind: "info", text: "approval: " + p.decision }); break;
  }
}

// ---------- Approval modal ----------

function askApproval(command, reason) {
  return new Promise((resolve) => {
    const modal = $("approval-modal");
    $("approval-reason").textContent = "Reason: " + reason;
    $("approval-cmd").textContent = command;
    modal.hidden = false;

    const cleanup = (decision) => {
      modal.hidden = true;
      $("approval-allow").removeEventListener("click", onAllow);
      $("approval-always").removeEventListener("click", onAlways);
      $("approval-deny").removeEventListener("click", onDeny);
      resolve(decision);
    };
    const onAllow = () => cleanup("allow-once");
    const onAlways = () => cleanup("allow-always");
    const onDeny = () => cleanup("deny");
    $("approval-allow").addEventListener("click", onAllow);
    $("approval-always").addEventListener("click", onAlways);
    $("approval-deny").addEventListener("click", onDeny);
  });
}

// ---------- Input form ----------

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(200, inputEl.scrollHeight) + "px";
}

inputEl.addEventListener("input", autoResize);
inputEl.addEventListener("input", () => renderSlashPanel(inputEl.value));
inputEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openCommandPalette(inputEl.value.startsWith("/") ? inputEl.value : "");
    return;
  }
  // Enter to send, Shift+Enter for newline.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    inputForm.requestSubmit();
    return;
  }
  // Tab to complete slash commands.
  if (e.key === "Tab") {
    e.preventDefault();
    const v = inputEl.value;
    if (v.startsWith("/") && !v.includes(" ")) {
      const base = v.slice(1);
      const matches = state.slashNames.filter(n => n.startsWith(base));
      if (matches.length > 0) {
        inputEl.value = "/" + matches[0] + " ";
        autoResize();
        renderSlashPanel(inputEl.value);
      }
    }
  }
  // Up/Down when at the top/bottom of a single-line prompt: history.
  if (e.key === "ArrowUp" && !e.shiftKey && inputEl.selectionStart === 0) {
    e.preventDefault();
    if (state.history.length > 0) {
      if (state.historyIndex === -1) state.historyIndex = state.history.length - 1;
      else if (state.historyIndex > 0) state.historyIndex -= 1;
      inputEl.value = state.history[state.historyIndex];
      autoResize();
    }
  }
  if (e.key === "ArrowDown" && !e.shiftKey && inputEl.selectionStart === inputEl.value.length) {
    e.preventDefault();
    if (state.historyIndex >= 0) {
      state.historyIndex += 1;
      if (state.historyIndex >= state.history.length) {
        state.historyIndex = -1;
        inputEl.value = "";
      } else {
        inputEl.value = state.history[state.historyIndex];
      }
      autoResize();
    }
  }
  // Ctrl+L: clear messages.
  if (e.key === "l" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    messagesEl.innerHTML = "";
  }
});

$("command-palette-button").addEventListener("click", () => openCommandPalette(""));
$("goal-button").addEventListener("click", () => primeGoalInput());
$("quick-goal").addEventListener("click", () => primeGoalInput());
$("composer-goal")?.addEventListener("click", () => primeGoalInput());
$("composer-commands")?.addEventListener("click", () => openCommandPalette(""));
$("composer-new-session")?.addEventListener("click", () => $("new-session").click());
$("mode-plan")?.addEventListener("click", () => setComposerMode("plan"));
$("mode-build")?.addEventListener("click", () => setComposerMode("build"));
$("command-palette-backdrop").addEventListener("click", closeCommandPalette);
commandPaletteInput.addEventListener("input", () => renderCommandPalette(commandPaletteInput.value));
commandPaletteInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeCommandPalette();
    inputEl.focus();
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const first = getSlashMatches(commandPaletteInput.value)[0];
    if (first) {
      inputEl.value = "/" + first.name + " ";
      autoResize();
      closeCommandPalette();
      inputEl.focus();
    }
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openCommandPalette("");
  } else if (e.key === "Escape" && !commandPaletteEl.hidden) {
    closeCommandPalette();
  }
});

inputForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || state.streaming) return;
  // Slash commands handled by server (which dispatches the existing
  // /command path on the runtime side). We send everything as a chat
  // message; the server distinguishes.
  if (text === "/clear") {
    messagesEl.innerHTML = "";
    inputEl.value = "";
    autoResize();
    return;
  }
  if (text === "/quit" || text === "/exit") {
    window.close();
    return;
  }
  if (state.history[state.history.length - 1] !== text) state.history.push(text);
  state.historyIndex = -1;
  const preparedText = preparePromptForComposerMode(text);
  inputEl.value = "";
  autoResize();
  renderSlashPanel("");
  sendPrompt(preparedText, { displayText: text });
});

// ---------- New session / resume ----------

$("new-session").addEventListener("click", async () => {
  try {
    await api("/v1/session", { method: "POST", body: {} });
    messagesEl.innerHTML = "";
    refreshAll();
  } catch (e) { addMessage({ kind: "error", text: "new session: " + e.message }); }
});

$("show-logs").addEventListener("click", () => window.ch?.showLogs?.());
$("reveal-appdata").addEventListener("click", () => window.ch?.revealAppData?.());
$("session-search").addEventListener("input", (e) => {
  state.sessionQuery = e.target.value.trim();
  refreshSessions();
});

async function resumeSession(id) {
  try {
    await api("/v1/session", { method: "POST", body: { id } });
    messagesEl.innerHTML = "";
    refreshAll();
  } catch (e) { addMessage({ kind: "error", text: "resume: " + e.message }); }
}

// ---------- Settings ----------

const settingsModal = $("settings-modal");
const settingsProviderMeta = $("setting-provider-meta");
const settingsAuthMeta = $("setting-auth-meta");

function providerPresetById(id) {
  return state.providerPresets.find((item) => item.id === id) || null;
}

function providerProfileById(id) {
  return state.providerProfiles.find((item) => item.id === id) || null;
}

function labelForAuthMode(mode) {
  switch (mode) {
    case "oauth": return "OAuth";
    case "optional": return "No auth / API key";
    default: return "API key";
  }
}

function setAuthButtonsForPreset(preset) {
  const openButton = $("setting-auth-open");
  const launchButton = $("setting-auth-launch");
  const docsUrl = preset?.authDocsUrl || "";
  const launchUrl = preset?.authLaunchUrl || docsUrl;
  openButton.disabled = !docsUrl;
  launchButton.disabled = !launchUrl;
  openButton.dataset.url = docsUrl;
  launchButton.dataset.url = launchUrl;
}

async function openProviderUrl(url) {
  if (!url) return;
  if (window.ch?.openExternal) {
    await window.ch.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function syncProviderSettingsForm() {
  const select = $("setting-provider");
  const selectedId = select.value;
  const preset = providerPresetById(selectedId);
  const configured = providerProfileById(selectedId);
  const previousProviderId = select.dataset.lastProviderId || "";
  const preserveTypedSecrets = previousProviderId === selectedId;
  const currentOauthValue = preserveTypedSecrets ? ($("setting-oauth-token")?.value || "") : "";
  const currentApiKeyValue = preserveTypedSecrets ? ($("setting-apikey")?.value || "") : "";
  const authModeSelect = $("setting-auth-mode");
  const authModes = preset?.authModes?.length ? preset.authModes : ["apiKey"];
  const selectedAuthMode = configured?.authMode || preset?.defaultAuthMode || authModes[0] || "apiKey";
  authModeSelect.innerHTML = "";
  for (const mode of authModes) {
    authModeSelect.appendChild(el("option", { value: mode }, labelForAuthMode(mode)));
  }
  authModeSelect.value = selectedAuthMode;
  $("setting-model").value = configured?.model || preset?.defaultModel || "";
  if (configured?.baseUrl) $("setting-baseurl").value = configured.baseUrl;
  else $("setting-baseurl").value = preset?.defaultBaseUrl || "";
  $("setting-oauth-token").value = currentOauthValue;
  $("setting-apikey").value = currentApiKeyValue;
  settingsProviderMeta.textContent = preset?.description || "Custom provider profile.";
  settingsAuthMeta.textContent = [
    authModes.includes("oauth") ? "OAuth/session token supported." : null,
    authModes.includes("apiKey") ? "API key supported." : null,
    authModes.includes("optional") ? "Credential optional for local servers." : null,
    configured?.hasOauthToken ? "OAuth token saved." : null,
    configured?.hasApiKey ? "API key saved." : null,
  ].filter(Boolean).join(" ");
  $("setting-oauth-row").hidden = !authModes.includes("oauth");
  $("setting-apikey-row").hidden = !(authModes.includes("apiKey") || authModes.includes("optional"));
  $("setting-oauth-label").textContent = selectedAuthMode === "oauth" ? "OAuth token" : "OAuth token (fallback)";
  $("setting-apikey-label").textContent = selectedAuthMode === "apiKey" || selectedAuthMode === "optional" ? "API key" : "API key (fallback)";
  $("setting-apikey").placeholder = authModes.includes("optional") ? "optional for local providers" : "paste provider API key";
  setAuthButtonsForPreset(preset);
  select.dataset.lastProviderId = selectedId;
}

$("settings").addEventListener("click", async () => {
  // Load current settings.
  try {
    const s = await api("/v1/settings");
    state.providerPresets = s.presets || [];
    state.providerProfiles = s.providers || [];
    // Populate.
    $("setting-model").value = s.model || "";
    $("setting-approval").value = s.approval || "on-mutation";
    $("setting-thinking").value = s.thinking || "medium";
    const provSel = $("setting-provider");
    provSel.innerHTML = "";
    const seen = new Set();
    for (const preset of state.providerPresets) {
      seen.add(preset.id);
      const configured = state.providerProfiles.find((item) => item.id === preset.id);
      const label = preset.label + (configured?.model ? " (" + configured.model + ")" : "");
      provSel.appendChild(el("option", { value: preset.id }, label));
    }
    for (const provider of state.providerProfiles) {
      if (seen.has(provider.id)) continue;
      provSel.appendChild(el("option", { value: provider.id }, provider.id + (provider.model ? " (" + provider.model + ")" : "")));
    }
    provSel.value = s.provider || state.providerPresets[0]?.id || "";
    syncProviderSettingsForm();
  } catch (e) { /* ignore */ }
  // Desktop-only controls (no-op in browser).
  if (window.ch) {
    try {
      const info = await window.ch.info();
      // Keychain status
      const kc = info.keychain || {};
      $("setting-keychain").textContent = kc.available
        ? `${kc.backend} · ${kc.entries.length} credential${kc.entries.length === 1 ? "" : "s"}`
        : "unavailable on this platform";
      // Auto-launch
      const al = info.autoLaunch || {};
      $("setting-autolaunch").checked = !!al.openAtLogin;
      $("setting-autolaunch-hidden").checked = !!al.openAsHidden;
      // Notifications
      $("setting-notifications").checked = info.notifications && info.notifications.enabled !== false;
      // Update channel
      const ch = info.updateChannel || "stable";
      $("setting-update-channel").value = ch;
      // Recent projects
      const recentList = info.recentProjects || [];
      const recentContainer = $("setting-recent-list");
      recentContainer.innerHTML = "";
      if (recentList.length === 0) {
        recentContainer.appendChild(el("div", { class: "settings-list-empty" }, "(none yet)"));
      } else {
        for (const p of recentList) {
          const row = el("div", { class: "settings-list-row" }, [
            el("span", { class: "settings-list-path", title: p }, p),
            el("button", {
              class: "settings-list-x",
              title: "Remove from list",
              onclick: async () => {
                await window.ch.recentForget(p);
                const refreshed = await window.ch.recentList();
                renderRecentList(refreshed);
              },
            }, "×"),
          ]);
          recentContainer.appendChild(row);
        }
      }
    } catch { /* ignore */ }
  }
  settingsModal.hidden = false;
});

function renderRecentList(list) {
  const recentContainer = $("setting-recent-list");
  recentContainer.innerHTML = "";
  if (!list || list.length === 0) {
    recentContainer.appendChild(el("div", { class: "settings-list-empty" }, "(none yet)"));
    return;
  }
  for (const p of list) {
    const row = el("div", { class: "settings-list-row" }, [
      el("span", { class: "settings-list-path", title: p }, p),
      el("button", {
        class: "settings-list-x",
        title: "Remove from list",
        onclick: async () => {
          await window.ch.recentForget(p);
          const refreshed = await window.ch.recentList();
          renderRecentList(refreshed);
        },
      }, "×"),
    ]);
    recentContainer.appendChild(row);
  }
}

// Desktop-only settings handlers
if (window.ch) {
  // Auto-launch
  $("setting-autolaunch").addEventListener("change", async (e) => {
    const al = await window.ch.autoLaunchGet();
    await window.ch.autoLaunchSet({ openAtLogin: e.target.checked, openAsHidden: al.openAsHidden });
  });
  $("setting-autolaunch-hidden").addEventListener("change", async (e) => {
    const al = await window.ch.autoLaunchGet();
    await window.ch.autoLaunchSet({ openAtLogin: al.openAtLogin, openAsHidden: e.target.checked });
  });
  // Notifications
  $("setting-notifications").addEventListener("change", (e) => {
    window.ch.setNotificationsEnabled(e.target.checked);
  });
  // Update channel
  $("setting-update-channel").addEventListener("change", async (e) => {
    await window.ch.updateChannelSet(e.target.value);
    showInfo("Update channel set to " + e.target.value + ". Re-check on next launch.");
  });
  // Keychain save (uses the API key field in the same form)
  $("setting-keychain-save").addEventListener("click", async () => {
    const providerId = $("setting-provider").value;
    const authMode = $("setting-auth-mode").value;
    const oauthToken = $("setting-oauth-token").value.trim();
    const apiKey = $("setting-apikey").value.trim();
    const credential = authMode === "oauth" ? oauthToken || apiKey : apiKey || oauthToken;
    const suffix = authMode === "oauth" ? ".oauthToken" : ".apiKey";
    if (!providerId || !credential) {
      showInfo("Pick a provider and enter a credential first.");
      return;
    }
    const ok = await window.ch.keychainSet(providerId + suffix, credential);
    showInfo(ok ? "Saved to Keychain." : "Keychain unavailable on this platform.");
    const info = await window.ch.info();
    $("setting-keychain").textContent = info.keychain.available
      ? `${info.keychain.backend} · ${info.keychain.entries.length} credential${info.keychain.entries.length === 1 ? "" : "s"}`
      : "unavailable on this platform";
  });
}
$("setting-provider").addEventListener("change", () => syncProviderSettingsForm());
$("setting-auth-mode").addEventListener("change", () => syncProviderSettingsForm());
$("setting-auth-open").addEventListener("click", async () => {
  const url = $("setting-auth-open").dataset.url;
  await openProviderUrl(url);
});
$("setting-auth-launch").addEventListener("click", async () => {
  const url = $("setting-auth-launch").dataset.url;
  await openProviderUrl(url);
});
$("settings-cancel").addEventListener("click", () => { settingsModal.hidden = true; });
$("settings-save").addEventListener("click", async () => {
  try {
    await api("/v1/settings", { method: "POST", body: {
      provider: $("setting-provider").value,
      authMode: $("setting-auth-mode").value,
      model: $("setting-model").value,
      baseUrl: $("setting-baseurl").value,
      oauthToken: $("setting-oauth-token").value,
      apiKey: $("setting-apikey").value,
      approval: $("setting-approval").value,
      thinking: $("setting-thinking").value,
    }});
    settingsModal.hidden = true;
    refreshAll();
  } catch (e) { addMessage({ kind: "error", text: "settings: " + e.message }); }
});

// ---------- Init ----------

(async () => {
  setComposerMode(state.composerMode);
  await refreshAll();
  setInterval(refreshStatus, 5000);
  setInterval(refreshUsage, 5000);
  setInterval(refreshSessions, 15000);
  setInterval(refreshAgents, 30000);
  // Quick info banner if no provider is configured.
  if (state.provider === "—") {
    showInfo("No provider configured. Open ⚙ settings or set OPENAI_API_KEY in your environment.");
  }
  // Native shell hooks (Electron only — window.ch is undefined in browser).
  if (window.ch) {
    try {
      const info = await window.ch.info();
      if (info && info.electron) {
        // Show a "Desktop" badge in the header so the user knows the
        // native shell is wrapping the page.
        const badge = document.createElement("span");
        badge.className = "desktop-badge";
        badge.textContent = "Desktop v" + info.version;
        badge.title = "Electron " + info.electron + " · Node " + info.node + " · Chrome " + info.chrome;
        const brand = document.querySelector(".sidebar-title");
        if (brand) brand.appendChild(badge);
        document.querySelectorAll(".desktop-only").forEach((el) => { el.hidden = false; });
      }
      window.ch.onMenuCommand && window.ch.onMenuCommand((command) => {
        handleDesktopCommand(command);
      });
      window.ch.onDeepLink && window.ch.onDeepLink((url) => {
        handleDeepLink(url);
      });
    } catch { /* not in electron — ignore */ }
  }
})();

function showInfo(text) {
  infoBanner.textContent = text;
  infoBanner.classList.add("visible");
  setTimeout(() => {
    infoBanner.classList.remove("visible");
    infoBanner.textContent = "";
  }, 8000);
}
