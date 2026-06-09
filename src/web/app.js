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
  goals: [],
  delegations: [],
  composerMode: "build",
  providerPresets: [],
  providerProfiles: [],
  attachments: [],
  reasoningBuffer: "",
  currentReasoningEl: null,
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
  if (!text) return;
  state.streamBuffer += text;
  if (!state.currentStreamEl) {
    state.currentStreamEl = addMessage({ kind: "assistant", text: "" });
    state.currentStreamEl.classList.add("streaming");
  }
  const body = state.currentStreamEl.querySelector(".message-body");
  const reasoning = body.querySelector(".message-reasoning");
  body.innerHTML = "";
  if (reasoning) body.appendChild(reasoning);
  body.appendChild(renderText(state.streamBuffer));
  scrollToBottom();
}

function endStream() {
  if (state.currentStreamEl) {
    state.currentStreamEl.classList.remove("streaming");
    state.currentStreamEl = null;
  }
  state.streamBuffer = "";
  state.reasoningBuffer = "";
  state.currentReasoningEl = null;
}

function ensureReasoningBlock() {
  if (!state.currentStreamEl) {
    state.currentStreamEl = addMessage({ kind: "assistant", text: "" });
    state.currentStreamEl.classList.add("streaming");
  }
  if (!state.currentReasoningEl) {
    const details = el("details", { class: "message-reasoning" });
    const summary = el("summary", {}, "Thinking…");
    const body = el("div", { class: "message-reasoning-body" });
    details.appendChild(summary);
    details.appendChild(body);
    const bodyHost = state.currentStreamEl.querySelector(".message-body");
    bodyHost.insertBefore(details, bodyHost.firstChild);
    state.currentReasoningEl = body;
  }
  return state.currentReasoningEl;
}

function appendReasoning(text) {
  if (!text) return;
  state.reasoningBuffer += text;
  const block = ensureReasoningBlock();
  block.textContent = state.reasoningBuffer;
  scrollToBottom();
}

function addImageMessage(url, mimeType) {
  const m = el("div", { class: "message message-assistant message-image" });
  m.appendChild(el("div", { class: "message-prefix" }, ["🖼"]));
  const body = el("div", { class: "message-body" });
  const img = el("img", { src: url, alt: "generated image" });
  if (mimeType) img.dataset.mime = mimeType;
  body.appendChild(img);
  m.appendChild(body);
  messagesEl.appendChild(m);
  scrollToBottom();
  return m;
}

function renderAttachmentPreview() {
  const host = $("attachment-preview");
  if (!host) return;
  host.innerHTML = "";
  if (state.attachments.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  state.attachments.forEach((att, index) => {
    const chip = el("div", { class: "attachment-chip" });
    if (att.mimeType?.startsWith("image/") || att.url.startsWith("data:image/")) {
      chip.appendChild(el("img", { src: att.url, alt: att.name || "attachment" }));
    }
    chip.appendChild(document.createTextNode(att.name || "image"));
    const remove = el("button", { type: "button", title: "Remove attachment" }, "×");
    remove.addEventListener("click", () => {
      state.attachments.splice(index, 1);
      renderAttachmentPreview();
    });
    chip.appendChild(remove);
    host.appendChild(chip);
  });
}

async function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("could not read file"));
    reader.readAsDataURL(file);
  });
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
    // Show the "first-run setup" sidebar button only when no
    // provider is configured. Lets users re-open the wizard
    // after dismissing it once.
    const onboardBtn = $("quick-onboard");
    if (onboardBtn) onboardBtn.hidden = state.provider !== "—";
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
  const treeButton = el("button", {
    class: "sidebar-run-action",
    type: "button",
    title: "Send /tree to the current run",
  }, "/tree");
  const forkButton = el("button", {
    class: "sidebar-run-action",
    type: "button",
    title: "Send /fork to the current run",
  }, "/fork");
  const compactButton = el("button", {
    class: "sidebar-run-action",
    type: "button",
    title: "Send /compact to the current run",
  }, "/compact");
  goalButton.addEventListener("click", () => primeGoalInput());
  commandsButton.addEventListener("click", () => openCommandPalette(""));
  treeButton.addEventListener("click", () => runSlashShortcut("/tree", "session tree"));
  forkButton.addEventListener("click", () => runSlashShortcut("/fork", "fork current session"));
  compactButton.addEventListener("click", () => runSlashShortcut("/compact", "compact session"));
  actionRow.appendChild(goalButton);
  actionRow.appendChild(commandsButton);
  actionRow.appendChild(treeButton);
  actionRow.appendChild(forkButton);
  actionRow.appendChild(compactButton);

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

// In-session todo list. Mirrors the /todo slash command and
// ch todo CLI subcommand. The list is included in every agent
// turn, so changes here are picked up by the next prompt
// automatically.
async function refreshTodo() {
  try {
    const j = await api("/v1/todo");
    const list = $("todo-list");
    list.innerHTML = "";
    const items = j.items || [];
    if (items.length === 0) {
      list.appendChild(el("div", { class: "sidebar-empty" }, "(empty)"));
      return;
    }
    items.forEach((text, i) => {
      const row = el("div", { class: "sidebar-todo-item" }, [
        el("span", { class: "sidebar-todo-item-num" }, (i + 1) + "."),
        el("span", { class: "sidebar-todo-item-text" }, text),
        el("button", {
          class: "sidebar-todo-item-x",
          title: "remove this todo",
          "data-index": String(i),
        }, "×"),
      ]);
      // Wire the remove button.
      const x = row.querySelector(".sidebar-todo-item-x");
      x.addEventListener("click", async () => {
        const next = items.filter((_, k) => k !== i);
        try {
          await api("/v1/todo", { method: "POST", body: { items: next } });
          void refreshTodo();
        } catch (e) { /* ignore */ }
      });
      list.appendChild(row);
    });
  } catch (e) { console.error("todo:", e); }
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

// ---------- Goals panel ----------
//
// The goals panel lives in the left sidebar. Each row is clickable;
// clicking opens the right-side detail pane. The detail fetches a
// single goal + its children + evaluations, and shows them as
// badges / cards. The sidebar list refreshes every 5s; the open
// detail re-fetches every 5s so live state changes are visible.

const goalState = {
  /** Currently selected goal id. `null` means the detail pane is
   *  closed. Persists across refreshes so re-renders don't blank
   *  the pane. */
  selectedId: null,
  /** Last known detail payload, used as a render cache. */
  detail: null,
};

function truncateObjective(text, n = 90) {
  if (!text) return "";
  if (text.length <= n) return text;
  return text.slice(0, n - 1) + "…";
}

function statusPillClass(status) {
  // The class key matches both `is-<status>` for the pill and the
  // section title. Used by both the sidebar row and the detail
  // pane; keep in sync with styles.css.
  return "is-" + (status || "pending");
}

async function refreshGoals() {
  try {
    const j = await api("/v1/goals");
    const goals = j.goals || [];
    state.goals = goals;
    const list = $("goal-list");
    const label = $("goals-label");
    if (label) label.textContent = "goals (" + goals.length + ")";
    list.innerHTML = "";
    if (goals.length === 0) {
      list.appendChild(el("div", { class: "sidebar-empty" }, "none"));
    } else {
      for (const g of goals) {
        const row = el("div", {
          class: "goal-row" + (g.id === goalState.selectedId ? " is-active" : ""),
          "data-goal-id": g.id,
        }, [
          el("div", { class: "goal-row-top" }, [
            el("span", { class: "goal-row-status " + statusPillClass(g.status) }, g.status || "pending"),
            el("span", { class: "goal-row-id" }, g.id.length > 14 ? g.id.slice(0, 12) + "…" : g.id),
            el("span", { class: "goal-row-loop" }, "[" + (g.loopStatus || "pending") + "]"),
          ]),
          el("div", { class: "goal-row-objective" }, truncateObjective(g.objective, 100)),
          el("div", { class: "goal-row-meta" }, [
            el("span", {}, (g.stepsTaken || 0) + "/" + (g.maxSteps || "?") + " steps"),
            el("span", {}, formatAgo(g.updatedAt || g.createdAt)),
          ]),
        ]);
        row.style.cursor = "pointer";
        row.title = "Click to view goal detail\n" + (g.objective || "");
        row.addEventListener("click", () => selectGoal(g.id));
        list.appendChild(row);
      }
    }
    // If we have a selected goal, refresh its detail in place so
    // live state machine moves (pending → planning → executing →
    // …) appear in the detail pane without requiring another
    // click. The detail refresh is best-effort — failures here
    // shouldn't break the sidebar.
    if (goalState.selectedId) {
      void refreshGoalDetail();
    }
  } catch (e) { console.error("goals:", e); }
}

async function selectGoal(id) {
  goalState.selectedId = id;
  // Re-render the sidebar so the row is highlighted.
  void refreshGoals();
  // Open the detail pane + show a placeholder until the fetch
  // returns.
  const detailEl = $("goal-detail");
  if (detailEl) detailEl.hidden = false;
  document.querySelector(".app")?.classList.add("is-goal-open");
  const body = $("goal-detail-body");
  if (body) {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "sidebar-empty" }, "loading…"));
  }
  await refreshGoalDetail();
}

async function refreshGoalDetail() {
  const id = goalState.selectedId;
  if (!id) return;
  try {
    const j = await api("/v1/goals?id=" + encodeURIComponent(id));
    goalState.detail = j;
    renderGoalDetail(j);
  } catch (e) {
    console.error("goal detail:", e);
    const body = $("goal-detail-body");
    if (body && goalState.selectedId === id) {
      body.innerHTML = "";
      body.appendChild(el("div", { class: "goal-detail-empty" }, "failed to load: " + (e?.message || e)));
    }
  }
}

function renderGoalDetail({ goal, children }) {
  const body = $("goal-detail-body");
  if (!body) return;
  body.innerHTML = "";
  if (!goal) {
    body.appendChild(el("div", { class: "goal-detail-empty" }, "goal not found"));
    return;
  }

  // Header
  body.appendChild(el("div", { class: "goal-detail-id" }, goal.id));

  // Objective
  body.appendChild(el("div", { class: "goal-detail-objective" }, goal.objective || "(no objective)"));

  // Badges row
  const badges = el("div", { class: "goal-detail-badges" }, [
    el("span", { class: "goal-detail-badge is-status-" + (goal.status || "pending") }, goal.status || "pending"),
    el("span", { class: "goal-detail-badge is-loop" }, "loop: " + (goal.loopStatus || "pending")),
  ]);
  if (typeof goal.currentIteration === "number" && goal.currentIteration > 0) {
    badges.appendChild(el("span", { class: "goal-detail-badge is-iter" }, "iter " + goal.currentIteration));
  }
  if (goal.model) badges.appendChild(el("span", { class: "goal-detail-badge" }, "model: " + goal.model));
  if (goal.providerId) badges.appendChild(el("span", { class: "goal-detail-badge" }, "provider: " + goal.providerId));
  body.appendChild(badges);

  // Metadata KV block
  const meta = el("dl", { class: "goal-detail-kv" });
  appendKv(meta, "created", formatAgo(goal.createdAt) + " ago");
  appendKv(meta, "updated", formatAgo(goal.updatedAt) + " ago");
  appendKv(meta, "steps", (goal.stepsTaken || 0) + " / " + (goal.maxSteps || "?"));
  if (goal.parentGoalId) appendKv(meta, "parent", goal.parentGoalId);
  body.appendChild(wrapSection("overview", meta));

  // Plan
  if (goal.finalText) {
    body.appendChild(wrapSection(
      "plan / latest output",
      el("div", { class: "goal-detail-plan" }, goal.finalText),
    ));
  } else {
    body.appendChild(wrapSection(
      "plan / latest output",
      el("div", { class: "goal-detail-empty" }, "(no output yet)"),
    ));
  }

  // Success criteria (the world's "deliverables" — what the agent
  // is judged against).
  const sc = goal.successCriteria;
  if (sc && Array.isArray(sc.deliverables) && sc.deliverables.length > 0) {
    const scEl = el("div", { class: "goal-detail-kv" });
    for (const d of sc.deliverables) {
      appendKv(scEl, "✓", d);
    }
    body.appendChild(wrapSection("world state — success criteria", scEl));
  } else {
    body.appendChild(wrapSection(
      "world state — success criteria",
      el("div", { class: "goal-detail-empty" }, "(no success criteria)"),
    ));
  }

  // Evaluations
  const evals = Array.isArray(goal.evaluations) ? goal.evaluations : [];
  if (evals.length > 0) {
    const evalsEl = el("div");
    for (const ev of evals) {
      const top = el("div", { class: "goal-detail-eval-top" }, [
        el("span", { class: "goal-detail-eval-score " + (ev.passed ? "is-passed" : "is-failed") }, "score " + (ev.score ?? 0) + "%"),
        el("span", {}, "iter " + (ev.iteration ?? "?")),
        el("span", {}, formatAgo(ev.createdAt) + " ago"),
      ]);
      const card = el("div", { class: "goal-detail-eval" }, [top, el("div", { class: "goal-detail-eval-feedback" }, ev.feedback || "")]);
      evalsEl.appendChild(card);
    }
    body.appendChild(wrapSection("evaluations (" + evals.length + ")", evalsEl));
  } else {
    body.appendChild(wrapSection(
      "evaluations",
      el("div", { class: "goal-detail-empty" }, "(no evaluations yet)"),
    ));
  }

  // Children
  const kids = Array.isArray(children) ? children : [];
  if (kids.length > 0) {
    const kidsEl = el("div", { class: "goal-detail-children" });
    for (const k of kids) {
      const card = el("div", { class: "goal-detail-child" }, [
        el("div", { class: "goal-detail-child-top" }, [
          el("span", { class: "goal-row-status " + statusPillClass(k.status) }, k.status || "pending"),
          el("span", { class: "goal-row-loop" }, "[" + (k.loopStatus || "pending") + "]"),
          el("span", {}, k.id.length > 14 ? k.id.slice(0, 12) + "…" : k.id),
        ]),
        el("div", { class: "goal-detail-child-obj" }, truncateObjective(k.objective, 120)),
      ]);
      card.addEventListener("click", () => selectGoal(k.id));
      kidsEl.appendChild(card);
    }
    body.appendChild(wrapSection("sub-goals (" + kids.length + ")", kidsEl));
  }
}

function wrapSection(title, ...children) {
  const sec = el("section", { class: "goal-detail-section" });
  sec.appendChild(el("div", { class: "goal-detail-section-title" }, title));
  for (const c of children) sec.appendChild(c);
  return sec;
}

function appendKv(dl, key, value) {
  dl.appendChild(el("dt", {}, key));
  dl.appendChild(el("dd", {}, value));
}

function closeGoalDetail() {
  goalState.selectedId = null;
  goalState.detail = null;
  const detailEl = $("goal-detail");
  if (detailEl) detailEl.hidden = true;
  document.querySelector(".app")?.classList.remove("is-goal-open");
  // Re-render the sidebar so the highlight clears.
  void refreshGoals();
}

// ---------- Delegations panel ----------
//
// Bottom strip listing active + recent delegation runs. Hidden
// when there are none (so the chat takes the full vertical
// space). Mirrors `GET /v1/delegations` which is fed by the
// DelegationManager.

async function refreshDelegations() {
  try {
    const j = await api("/v1/delegations");
    const runs = j.delegations || [];
    state.delegations = runs;
    const strip = $("delegations-strip");
    const list = $("delegations-list");
    const count = $("delegations-count");
    if (!strip || !list || !count) return;
    count.textContent = String(runs.length);
    if (runs.length === 0) {
      strip.hidden = true;
      list.innerHTML = "";
      return;
    }
    strip.hidden = false;
    list.innerHTML = "";
    for (const r of runs) {
      const when = r.completedAt
        ? "ended " + formatAgo(r.completedAt) + " ago"
        : r.startedAt
          ? "started " + formatAgo(r.startedAt) + " ago"
          : "queued";
      list.appendChild(el("div", { class: "delegation-row" }, [
        el("span", { class: "delegation-row-kind" }, r.kind || "?"),
        el("span", { class: "delegation-row-status is-" + (r.status || "queued") }, r.status || "queued"),
        el("span", { class: "delegation-row-when" }, when),
        el("span", { class: "delegation-row-chain", title: chainToString(r.parentChain) }, chainToString(r.parentChain)),
      ]));
    }
  } catch (e) { console.error("delegations:", e); }
}

function chainToString(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return "— root —";
  // Show root → leaf (reversed from the API's leaf → root order).
  const reversed = [...chain].reverse();
  return reversed.map((link) => {
    const kindClass = "is-" + (link.kind || "external");
    const nibble = (link.id || "").length > 8 ? (link.id || "").slice(0, 8) : (link.id || "?");
    return el("span", {}, [
      el("span", { class: "delegation-row-chain-kink " + kindClass }, link.kind || "external"),
      el("span", { class: "delegation-row-chain-nibble" }, nibble),
    ]);
  }).reduce((acc, node, i) => {
    if (i > 0) acc.push(el("span", { class: "delegation-row-chain-sep" }, "→"));
    acc.push(node);
    return acc;
  }, []);
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
  await Promise.all([refreshStatus(), refreshSessions(), refreshAgents(), refreshUsage(), refreshTodo(), refreshGoals(), refreshDelegations()]);
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

function runSlashShortcut(prompt, displayText) {
  if (state.streaming) return;
  if (prompt.trim()) {
    void sendPrompt(prompt, { displayText: displayText || prompt });
  }
}

function exportActiveSession() {
  const sessionId = state.session || "latest";
  runSlashShortcut("/export " + sessionId + " --format share", "export session " + sessionId);
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
  state.reasoningBuffer = "";
  state.currentReasoningEl = null;

  const attachments = (opts.attachments ?? state.attachments).map((att) => ({
    type: att.type || "image",
    url: att.url,
    mimeType: att.mimeType,
  }));

  // Echo user message.
  const userText = opts.displayText || prompt;
  const userMsg = addMessage({ kind: "user", text: userText });
  if (attachments.length > 0) {
    const body = userMsg.querySelector(".message-body");
    for (const att of attachments) {
      if (att.mimeType?.startsWith("image/") || att.url.startsWith("data:image/")) {
        body.appendChild(el("div", { class: "message-image" }, [el("img", { src: att.url, alt: "attachment" })]));
      }
    }
  }

  try {
    await refreshStatus();
    const res = await fetch("/v1/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, attachments: attachments.length > 0 ? attachments : undefined }),
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
    state.attachments = [];
    renderAttachmentPreview();
    refreshUsage();
    refreshSessions();
  }
}

async function handleEvent(event, p, _resolveApproval) {
  switch (event) {
    case "text":       appendToStream(p.text || ""); break;
    case "reasoning":  appendReasoning(p.text || ""); break;
    case "image":      addImageMessage(p.url || "", p.mimeType); break;
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
$("quick-export").addEventListener("click", () => exportActiveSession());

// In-session todo: add via the form, remove via the × button.
const todoForm = $("todo-form");
const todoInput = $("todo-input");
if (todoForm && todoInput) {
  todoForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = todoInput.value.trim();
    if (!text) return;
    todoInput.disabled = true;
    try {
      await api("/v1/todo", { method: "POST", body: { action: "add", item: text } });
      todoInput.value = "";
      void refreshTodo();
    } catch (e) { /* ignore */ }
    finally { todoInput.disabled = false; todoInput.focus(); }
  });
}
$("quick-onboard")?.addEventListener("click", async () => {
  // Manual re-open of the first-run setup wizard. Useful after
  // dismissing it once or when switching providers.
  await loadOnboardCatalog();
  populateOnboardProviderSelect();
  showOnboard();
});
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

// ---------- Provider select (grouped catalog) ----------
//
// The pure tier-grouping helper lives in `onboard-helpers.js`
// (loaded as a classic script before this file). We pull it off
// the global here so the same logic is testable in Node without
// a DOM library, and the <optgroup> DOM assembly stays in this
// file where the `el()` helper is in scope.

const OnboardHelpers = (typeof window !== "undefined" && window.OnboardHelpers) || null;
const PROVIDER_GROUP_LABELS = OnboardHelpers?.PROVIDER_GROUP_LABELS || {
  primary: "Default (local)",
  hosted: "Hosted (OpenAI, Grok, MiniMax, Codex, \u2026)",
  local: "Local alternatives",
};
const PROVIDER_TIER_ORDER = OnboardHelpers?.PROVIDER_TIER_ORDER || ["primary", "hosted", "local"];
const groupProvidersByTier = OnboardHelpers?.groupProvidersByTier || function (presets) {
  const byTier = { primary: [], hosted: [], local: [] };
  for (const preset of presets || []) {
    const tier = preset && preset.tier && byTier[preset.tier] ? preset.tier : "hosted";
    byTier[tier].push(preset);
  }
  return byTier;
};

function labelForProviderOption(preset, profiles, labelMode) {
  if (labelMode === "defaultModel") {
    return preset.label + (preset.defaultModel ? "  (" + preset.defaultModel + ")" : "");
  }
  const configured = profiles?.find((item) => item.id === preset.id);
  return preset.label + (configured?.model ? " (" + configured.model + ")" : "");
}

/** Populate a provider <select> with tiered <optgroup>s so hosted APIs stay prominent. */
function fillProviderSelect(select, presets, profiles, options = {}) {
  const { labelMode = "configured", groupOrder = null } = options;
  select.innerHTML = "";
  const seen = new Set();
  const byTier = groupProvidersByTier(presets);
  for (const tier of PROVIDER_TIER_ORDER) {
    let items = byTier[tier];
    if (!items.length) continue;
    const order = groupOrder?.[tier];
    if (order?.length) {
      items = [...items].sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    }
    const optgroup = el("optgroup", { label: PROVIDER_GROUP_LABELS[tier] });
    for (const preset of items) {
      seen.add(preset.id);
      optgroup.appendChild(
        el("option", { value: preset.id }, labelForProviderOption(preset, profiles, labelMode))
      );
    }
    select.appendChild(optgroup);
  }
  for (const provider of profiles || []) {
    if (seen.has(provider.id)) continue;
    const suffix = provider.model ? " (" + provider.model + ")" : "";
    const text = provider.label || provider.id + suffix;
    select.appendChild(el("option", { value: provider.id }, text));
  }
}

// ---------- Settings ----------

const settingsModal = $("settings-modal");
const settingsProviderMeta = $("setting-provider-meta");
const settingsAuthMeta = $("setting-auth-meta");
const settingsMcpStatus = $("setting-mcp-status");

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
  const showCodexLogin = selectedId === "codex" && authModes.includes("oauth") && selectedAuthMode === "oauth";
  $("setting-codex-login-row").hidden = !showCodexLogin;
  $("setting-codex-login-meta").hidden = !showCodexLogin;
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
    fillProviderSelect(provSel, state.providerPresets, state.providerProfiles);
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
      if (settingsMcpStatus) {
        settingsMcpStatus.textContent = info.chMcpUrl
          ? `${info.chMcpUrl} · ${info.chMcpPort ? "running" : "starting"}`
          : "disabled";
      }
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
    try {
      await api("/v1/settings", { method: "POST", body: {
        provider: providerId,
        authMode,
        model: $("setting-model").value,
        baseUrl: $("setting-baseurl").value,
        oauthToken,
        apiKey,
        persistSecret: false,
        approval: $("setting-approval").value,
        thinking: $("setting-thinking").value,
      }});
    } catch (e) {
      addMessage({ kind: "error", text: "keychain sync: " + e.message });
    }
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

// Fetch the running server's /v1/models and let the user pick one.
//
// Shared between the settings modal's "fetch /v1/models" button
// and the first-run onboarding wizard's step 3. Pass in the
// target <select>, the status line, and a callback for when the
// user picks a model. Returns the resulting list (or [] on
// failure) so callers can chain a follow-up POST /v1/settings
// without re-fetching.
async function fetchProviderModels({ providerId, select, meta, onPick, currentModel }) {
  if (!select) return [];
  if (meta) meta.textContent = "Querying " + (providerId || "(none)") + " /v1/models...";
  select.innerHTML = "";
  select.hidden = true;
  if (!providerId) {
    if (meta) meta.textContent = "no provider selected";
    return [];
  }
  try {
    const r = await api("/v1/provider/models?id=" + encodeURIComponent(providerId));
    if (r.error) {
      if (meta) meta.textContent = "could not list models: " + r.error;
      return [];
    }
    const models = r.models || [];
    if (models.length === 0) {
      if (meta) meta.textContent = "no models returned (server may be offline or /v1/models not exposed)";
      return [];
    }
    const placeholder = "(pick a model — current is " + (currentModel || "(unset)") + ")";
    select.appendChild(el("option", { value: "" }, placeholder));
    for (const m of models) select.appendChild(el("option", { value: m }, m));
    select.hidden = false;
    if (meta) meta.textContent = models.length + " model(s) available from " + providerId;
    if (typeof onPick === "function") {
      select.onchange = () => {
        if (select.value && onPick(select.value)) {
          if (meta) meta.textContent = "set model = " + select.value;
        }
      };
    }
    return models;
  } catch (e) {
    if (meta) meta.textContent = "request failed: " + e.message;
    return [];
  }
}

function discoverProviderModels() {
  // Settings-modal wrapper around the shared helper. The wizard
  // calls fetchProviderModels directly with its own elements so
  // the same HTTP call + DOM dance lives in one place.
  const providerId = $("setting-provider").value;
  return fetchProviderModels({
    providerId,
    select: $("setting-discovered-models"),
    meta: $("setting-models-meta"),
    currentModel: $("setting-model").value,
    onPick: (model) => {
      $("setting-model").value = model;
      return true;
    },
  });
}
$("setting-discover-models")?.addEventListener("click", discoverProviderModels);
$("setting-codex-login")?.addEventListener("click", async () => {
  const meta = $("setting-codex-login-meta");
  if (meta) meta.textContent = "Opening ChatGPT sign-in…";
  try {
    const r = await api("/v1/provider/login/codex", { method: "POST", body: { openBrowser: true } });
    if (meta) meta.textContent = (r.messages || []).join(" · ") || "Signed in with ChatGPT.";
    $("setting-auth-mode").value = "oauth";
    $("setting-oauth-token").value = "(saved via OAuth)";
    await refreshAll();
    showInfo("Codex OAuth saved.");
  } catch (e) {
    if (meta) meta.textContent = "Login failed: " + e.message;
    addMessage({ kind: "error", text: "Codex login: " + e.message });
  }
});
window.ch?.onMcpStatus?.((info) => {
  if (!settingsMcpStatus) return;
  const url = info?.url || "";
  const port = info?.port || 0;
  settingsMcpStatus.textContent = url ? `${url} · ${port > 0 ? "running" : "starting"}` : "disabled";
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

// ---------- First-run onboarding wizard ----------
//
// Mirrors the /onboard slash command and `ch onboard` so all
// three surfaces give the same 3-step flow: pick provider,
// save key, test. The wizard auto-opens when the web app
// loads with no provider configured.

const onboardModal = $("onboard-modal");
const onboardProviderSel = $("onboard-provider");
const onboardProviderMeta = $("onboard-provider-meta");
const onboardApiKey = $("onboard-apikey");
const onboardModel = $("onboard-model");
const onboardEnvHint = $("onboard-env-hint");
const onboardTestBtn = $("onboard-test");
const onboardResult = $("onboard-result");
const onboardSkipBtn = $("onboard-skip");
const onboardKeyStep = document.querySelector('.onboard-step[data-step="key"]');
const onboardSteps = document.querySelector(".onboard-steps");
const onboardSuccess = $("onboard-success");
const onboardSuccessProvider = $("onboard-success-provider");
const onboardSuccessModel = $("onboard-success-model");
const onboardSuccessBaseurl = $("onboard-success-baseurl");
const onboardOpenChatBtn = $("onboard-open-chat");
const onboardFinishBtn = $("onboard-finish");
const onboardDiscover = $("onboard-discover");
const onboardDiscoverSel = $("onboard-discovered-models");
const onboardDiscoverMeta = $("onboard-discover-meta");
const onboardSubtitle = $("onboard-subtitle");
// Auth mode selector + OAuth-token input. Both default to hidden; the
// wizard shows them only when the selected provider advertises more
// than one auth mode in its preset (e.g. xai/grok/minimax with
// authModes: ["oauth", "apiKey"]).
const onboardAuthModesRow = $("onboard-auth-modes");
const onboardAuthModeRadios = () => Array.from(document.querySelectorAll('input[name="onboard-auth-mode"]'));
const onboardAuthModeOauthOption = $("onboard-auth-mode-oauth-option");
const onboardAuthModeOauthLabel = $("onboard-auth-mode-oauth-label");
const onboardOauthRow = $("onboard-oauth-row");
const onboardOauthToken = $("onboard-oauth-token");
const onboardOauthLink = $("onboard-oauth-link");

const ONBOARD_SEEN_STORAGE_KEY = "ch.onboardSeenAt";
const ONBOARD_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let onboardCatalog = null;
let onboardCatalogGroups = null;
let onboardLastChosenModel = null;
let onboardLastBaseUrl = null;

async function loadOnboardCatalog() {
  try {
    const r = await api("/v1/provider/catalog");
    onboardCatalog = r.providers || [];
    onboardCatalogGroups = r.groups || null;
  } catch (e) {
    // Surface the failure so the user can report it. Previously the
    // wizard silently fell back to an empty dropdown, which made
    // "empty dropdown" reports impossible to diagnose.
    onboardCatalog = [];
    onboardCatalogGroups = null;
    console.error("onboard: failed to load provider catalog", e);
    showOnboardError("couldn't load provider list: " + (e?.message || e) + " — try refreshing or check the server log.");
  }
}

function populateOnboardProviderSelect() {
  if (!onboardCatalog) return;
  fillProviderSelect(onboardProviderSel, onboardCatalog, [], {
    labelMode: "defaultModel",
    groupOrder: onboardCatalogGroups,
  });
  // Default to LM Studio — primary local provider.
  onboardProviderSel.value = onboardCatalog.find((p) => p.id === "lmstudio")?.id || onboardCatalog[0]?.id || "";
  syncOnboardMeta();
}

/**
 * Show the auth input that matches the selected provider + auth mode.
 *
 * Provider-agnostic: replaces the previous codex-only hardcode. For
 * providers with `authModes: ["oauth", "apiKey"]` (codex, xai, grok,
 * minimax) the wizard shows a small segmented control. When OAuth is
 * selected, codex renders the device-code button and the other three
 * render a paste-token input + a "Get a token" link to the provider's
 * auth docs.
 */
function syncOnboardMeta() {
  const id = onboardProviderSel.value;
  const p = onboardCatalog?.find((x) => x.id === id);
  if (!p) {
    onboardProviderMeta.textContent = "";
    onboardEnvHint.textContent = "";
    setOnboardAuthModeSelector(null);
    return;
  }
  const authModes = (p.authModes || []).join(" / ");
  onboardProviderMeta.textContent =
    (p.description ? p.description + " · " : "") +
    "auth: " + (authModes || "n/a") +
    (p.authDocsUrl ? " · " + p.authDocsUrl : "");
  onboardModel.placeholder = p.defaultModel ? "(default: " + p.defaultModel + ")" : "model";
  const envVar = (p.apiKeyEnv || [])[0];
  const oauthEnvVar = (p.oauthTokenEnv || [])[0];
  onboardEnvHint.textContent = envVar
    ? "Or set " + envVar + " in your shell and restart — whichever is easier."
    : "Stored locally in settings.json — never sent anywhere except this provider.";
  const modes = p.authModes || [];
  const supportsOauth = modes.includes("oauth");
  const supportsApiKey = modes.includes("apiKey");
  const optionalAuth = modes.includes("optional");
  const apiKeyRequired = supportsApiKey && !optionalAuth && !supportsOauth;
  const defaultMode = p.defaultAuthMode && modes.includes(p.defaultAuthMode)
    ? p.defaultAuthMode
    : (supportsOauth ? "oauth" : (supportsApiKey ? "apiKey" : "optional"));
  setOnboardAuthModeSelector({ provider: p, modes, defaultMode, supportsOauth, supportsApiKey, optionalAuth });
  applyOnboardAuthMode(p);
  if (onboardApiKey) onboardApiKey.dataset.required = apiKeyRequired ? "true" : "false";
  if (onboardApiKey) onboardApiKey.dataset.envVar = envVar || "";
  if (onboardOauthToken) onboardOauthToken.dataset.envVar = oauthEnvVar || "";
}

/**
 * Show / hide the segmented auth mode control based on how many
 * modes the selected provider actually advertises. The label on the
 * OAuth option is provider-specific so users know which OAuth they're
 * picking (e.g. "xAI OAuth" vs "ChatGPT OAuth").
 */
function setOnboardAuthModeSelector(opts) {
  if (!onboardAuthModesRow) return;
  if (!opts) {
    onboardAuthModesRow.hidden = true;
    if (onboardAuthModeOauthOption) onboardAuthModeOauthOption.hidden = true;
    return;
  }
  const showSelector = (opts.supportsOauth && opts.supportsApiKey);
  onboardAuthModesRow.hidden = !showSelector;
  if (onboardAuthModeOauthOption) {
    onboardAuthModeOauthOption.hidden = !opts.supportsOauth;
  }
  if (onboardAuthModeOauthLabel) {
    // Generic label is fine for hosted providers with no device-code
    // flow. Codex gets a more specific label via applyOnboardAuthMode.
    onboardAuthModeOauthLabel.textContent = "OAuth";
  }
  // Sync the radio to the provider's default auth mode.
  for (const r of onboardAuthModeRadios()) {
    r.checked = r.value === opts.defaultMode;
  }
}

function currentOnboardAuthMode() {
  for (const r of onboardAuthModeRadios()) {
    if (r.checked) return r.value;
  }
  return "apiKey";
}

/**
 * Render the right input/button for the selected provider + auth mode.
 *
 * Visibility matrix:
 *   - optional auth (LM Studio, vLLM): hide step 2 entirely
 *   - codex + oauth: device-code button
 *   - non-codex + oauth: OAuth token input + provider link
 *   - apiKey mode: API key input
 */
function applyOnboardAuthMode(p) {
  const id = p?.id || onboardProviderSel.value;
  const mode = currentOnboardAuthMode();
  const isCodex = id === "codex";
  const codexOAuth = isCodex && mode === "oauth" && (p?.authModes || []).includes("oauth");
  const nonCodexOauth = !isCodex && mode === "oauth" && (p?.authModes || []).includes("oauth");
  const showApiKey = mode === "apiKey" && (p?.authModes || []).includes("apiKey");
  const optionalAuth = (p?.authModes || []).includes("optional");
  // Codex uses OAuth — show the sign-in button, hide the key input.
  // Optional-auth providers (LM Studio, vLLM) hide the key input and
  // we mark step 2 as "skipped" so the user knows it was intentional.
  // apiKey-only providers keep the input visible.
  const loginBtn = $("onboard-codex-login");
  if (loginBtn) loginBtn.hidden = !codexOAuth;
  if (onboardApiKey) {
    onboardApiKey.hidden = !(showApiKey || optionalAuth);
    onboardApiKey.placeholder = optionalAuth
      ? "API key (optional for " + (p?.label || id) + ")"
      : "paste API key";
  }
  if (onboardOauthRow) {
    onboardOauthRow.hidden = !nonCodexOauth;
  }
  if (onboardOauthLink) {
    const launch = p?.authLaunchUrl || p?.authDocsUrl || "";
    if (nonCodexOauth && launch) {
      onboardOauthLink.href = launch;
      onboardOauthLink.textContent = "Get a token at " + (new URL(launch).host) + " →";
      onboardOauthLink.hidden = false;
    } else {
      onboardOauthLink.hidden = true;
    }
  }
  if (onboardAuthModeOauthLabel) {
    onboardAuthModeOauthLabel.textContent = isCodex ? "ChatGPT OAuth" : (p?.label ? p.label + " OAuth" : "OAuth");
  }
  if (onboardTestBtn) onboardTestBtn.hidden = codexOAuth;
  if (onboardKeyStep) {
    const skipKey = codexOAuth || optionalAuth;
    onboardKeyStep.classList.toggle("is-skipped", skipKey);
  }
  if (onboardSubtitle) {
    if (codexOAuth) {
      onboardSubtitle.textContent = "Let's set up a provider so the agent can do things. Sign in with ChatGPT, then we'll test it.";
    } else if (optionalAuth) {
      onboardSubtitle.textContent = "Let's set up a provider so the agent can do things. " + (p?.label || id) + " doesn't need a key — just save and test.";
    } else if (mode === "oauth") {
      onboardSubtitle.textContent = "Let's set up a provider so the agent can do things. Paste your " + (p?.label || id) + " OAuth token — get one at the provider's site, then we'll test it.";
    } else {
      onboardSubtitle.textContent = "Let's set up a provider so the agent can do things. Three quick steps.";
    }
  }
}

function showOnboard() {
  if (!onboardModal) return;
  onboardResult.textContent = "";
  onboardResult.className = "onboard-result";
  resetOnboardSuccess();
  onboardModal.hidden = false;
}

function resetOnboardSuccess() {
  if (onboardSuccess) onboardSuccess.hidden = true;
  if (onboardDiscover) onboardDiscover.hidden = true;
  if (onboardDiscoverSel) {
    onboardDiscoverSel.innerHTML = "";
    onboardDiscoverSel.onchange = null;
  }
  if (onboardDiscoverMeta) onboardDiscoverMeta.textContent = "";
  if (onboardSteps) onboardSteps.style.display = "";
}

function closeOnboard() {
  if (!onboardModal) return;
  onboardModal.hidden = true;
  // Persist the "I've seen this" hint so we don't auto-open again
  // on every refresh. Users can still summon it via the sidebar.
  try { localStorage.setItem(ONBOARD_SEEN_STORAGE_KEY, String(Date.now())); } catch {}
  // Restore the wizard body so the next "open" shows the steps
  // rather than the success state.
  resetOnboardSuccess();
}

onboardSkipBtn?.addEventListener("click", closeOnboard);
onboardProviderSel?.addEventListener("change", syncOnboardMeta);
for (const r of onboardAuthModeRadios()) {
  r.addEventListener("change", () => {
    const p = onboardCatalog?.find((x) => x.id === onboardProviderSel.value);
    applyOnboardAuthMode(p);
  });
}
$("onboard-codex-login")?.addEventListener("click", async () => {
  onboardResult.className = "onboard-result";
  onboardResult.textContent = "Starting ChatGPT sign-in…";
  resetOnboardSuccess();
  try {
    const r = await api("/v1/provider/login/codex", { method: "POST", body: { openBrowser: true } });
    showOnboardOk("✓ signed in with ChatGPT. model: " + (r.model || "(default)"));
    await refreshAll();
    // Skip the manual model-discover step for OAuth — the runtime
    // already knows the model. Go straight to the success state.
    await showOnboardSuccess({
      provider: "codex",
      providerLabel: "OpenAI / Codex",
      model: r.model || "(default)",
      baseUrl: providerPresetById("codex")?.defaultBaseUrl || "",
    });
  } catch (e) {
    showOnboardError("Codex login failed: " + (e.message || "unknown error"));
  }
});
$("attach-button")?.addEventListener("click", () => $("attach-input")?.click());
$("attach-input")?.addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const url = await readFileAsDataUrl(file);
      state.attachments.push({ type: "image", url, mimeType: file.type, name: file.name });
    } catch (err) {
      showInfo("Could not read attachment: " + err.message);
    }
  }
  renderAttachmentPreview();
});

onboardTestBtn?.addEventListener("click", async () => {
  const provider = onboardProviderSel.value;
  const model = onboardModel.value.trim();
  if (!provider) { showOnboardError("pick a provider first"); return; }
  const preset = onboardCatalog?.find((p) => p.id === provider);
  const optionalAuth = (preset?.authModes || []).includes("optional");
  const supportsOauth = (preset?.authModes || []).includes("oauth");
  const supportsApiKey = (preset?.authModes || []).includes("apiKey");
  const mode = currentOnboardAuthMode();
  const isCodexOauth = provider === "codex" && mode === "oauth";
  if (isCodexOauth) {
    showOnboardError("use the 'Sign in with ChatGPT' button above");
    return;
  }
  const apiKey = onboardApiKey.value;
  const oauthToken = onboardOauthToken?.value || "";
  // Validate per mode. OAuth tokens are typically opaque strings the
  // same length as an API key, so the 8-char floor is fine.
  if (mode === "oauth") {
    if (!oauthToken || oauthToken.length < 8) { showOnboardError("paste an OAuth token (≥8 chars)"); return; }
  } else if (supportsApiKey && !optionalAuth) {
    if (!apiKey || apiKey.length < 8) { showOnboardError("paste a key (≥8 chars)"); return; }
  } else if (apiKey && apiKey.length > 0 && apiKey.length < 8) {
    showOnboardError("key is too short (≥8 chars)"); return;
  }
  onboardTestBtn.disabled = true;
  onboardTestBtn.textContent = "saving & testing…";
  onboardResult.className = "onboard-result";
  onboardResult.textContent = "";
  resetOnboardSuccess();
  let savedModel = model;
  let savedBaseUrl = preset?.defaultBaseUrl || "";
  try {
    let r;
    if (mode === "oauth") {
      // OAuth path: save token + authMode via /v1/settings (it handles
      // both apiKey and oauthToken), then run /v1/diag separately.
      // We normalize the response to { diag, model } so the rest of
      // the handler stays uniform with the set-key path.
      const saveRes = await api("/v1/settings", {
        method: "POST",
        body: { provider, oauthToken, authMode: "oauth", model: model || undefined },
      });
      if (!saveRes?.ok) {
        showOnboardError("settings save failed");
        return;
      }
      const diag = await api("/v1/diag").catch((e) => ({ ok: false, error: e.message || String(e), firstByteMs: 0, totalMs: 0 }));
      r = { diag, model: model || preset?.defaultModel || "" };
    } else {
      r = await api("/v1/provider/set-key", {
        method: "POST",
        body: { provider, apiKey, model: model || undefined },
      });
    }
    if (!r.diag?.ok) {
      showOnboardError("diag failed: " + (r.diag?.error || "no response") + " — credential saved, but the connection test failed. Re-run to overwrite.");
      return;
    }
    savedModel = r.model || savedModel || preset?.defaultModel || "";
    showOnboardOk(
      "✓ saved. diag: " + r.diag.firstByteMs + "ms first byte, " +
      r.diag.totalMs + "ms total. default model: " + savedModel
    );
    // Refresh everything so the new state shows up immediately.
    await refreshAll();
    // Step 3b — fetch the live model list and let the user pick one.
    const baseUrl = preset?.defaultBaseUrl || "";
    const models = await fetchProviderModels({
      providerId: provider,
      select: onboardDiscoverSel,
      meta: onboardDiscoverMeta,
      currentModel: savedModel,
      onPick: async (chosen) => {
        // Save the chosen model + baseUrl back to settings so the
        // next agent run picks it up.
        savedModel = chosen;
        try {
          await api("/v1/settings", {
            method: "POST",
            body: { provider, model: chosen, baseUrl: baseUrl || undefined },
          });
        } catch (e) {
          if (onboardDiscoverMeta) onboardDiscoverMeta.textContent = "saved: " + chosen + " (settings save failed: " + e.message + ")";
        }
        return true;
      },
    });
    if (onboardDiscover) onboardDiscover.hidden = false;
    if (models.length === 0) {
      // No /v1/models endpoint — fall back to the default model
      // returned by set-key and go straight to the success state.
      if (onboardDiscoverMeta) onboardDiscoverMeta.textContent = "no live model list — using " + savedModel;
    } else {
      // Pre-select the default model (or the first item).
      const defaultModel = preset?.defaultModel || savedModel || models[0];
      const pick = models.includes(defaultModel) ? defaultModel : models[0];
      if (pick) {
        onboardDiscoverSel.value = pick;
        savedModel = pick;
        // Persist the pre-selection immediately.
        try {
          await api("/v1/settings", {
            method: "POST",
            body: { provider, model: pick, baseUrl: baseUrl || undefined },
          });
        } catch { /* best-effort */ }
      }
      if (onboardDiscoverMeta) onboardDiscoverMeta.textContent =
        "default: " + (pick || "(none)") + " — pick a different one or stay";
    }
    onboardLastChosenModel = savedModel;
    onboardLastBaseUrl = baseUrl;
    await showOnboardSuccess({
      provider,
      providerLabel: preset?.label || provider,
      model: savedModel,
      baseUrl: baseUrl,
    });
  } catch (e) {
    showOnboardError("save failed: " + (e?.message || "network error"));
  } finally {
    onboardTestBtn.disabled = false;
    onboardTestBtn.textContent = "save & test";
  }
});

/** Reveal the success state with the configured values and wire
 *  the "open chat" / "close" buttons. Hides the 3-step list so
 *  the user isn't staring at a wizard they just finished. */
async function showOnboardSuccess({ provider, providerLabel, model, baseUrl }) {
  if (!onboardSuccess) return;
  if (onboardSteps) onboardSteps.style.display = "none";
  if (onboardSuccessProvider) onboardSuccessProvider.textContent = providerLabel || provider || "—";
  if (onboardSuccessModel) onboardSuccessModel.textContent = model || "(default)";
  if (onboardSuccessBaseurl) {
    onboardSuccessBaseurl.textContent = baseUrl || "(provider default)";
    onboardSuccessBaseurl.title = baseUrl || "";
  }
  onboardSuccess.hidden = false;
}

function showOnboardOk(text) {
  onboardResult.className = "onboard-result ok";
  onboardResult.textContent = text;
}
function showOnboardError(text) {
  onboardResult.className = "onboard-result err";
  onboardResult.textContent = text;
}

onboardOpenChatBtn?.addEventListener("click", () => {
  closeOnboard();
  // Focus the composer so the user can start typing immediately.
  setComposerMode(state.composerMode, { focusInput: true });
  inputEl?.focus();
  showInfo("You're set up. Start typing — the model is " + (onboardLastChosenModel || "the default") + ".");
});

onboardFinishBtn?.addEventListener("click", closeOnboard);

async function maybeShowOnboard() {
  // Show the wizard only when:
  //   1. The user has never seen it (or saw it >30 days ago), AND
  //   2. There is no provider configured (the existing "no provider"
  //      info banner is the trigger).
  if (state.provider === "—") {
    let seenAt = 0;
    try { seenAt = parseInt(localStorage.getItem(ONBOARD_SEEN_STORAGE_KEY) || "0", 10) || 0; } catch {}
    if (Date.now() - seenAt > ONBOARD_SEEN_TTL_MS) {
      await loadOnboardCatalog();
      populateOnboardProviderSelect();
      showOnboard();
    } else {
      // The user already saw the wizard recently; just keep the
      // small info banner so they remember it's available.
      showInfo("No provider configured. Run /onboard or open ⚙ settings to set one up.");
    }
  }
}

// ---------- Init ----------

(async () => {
  setComposerMode(state.composerMode);
  await refreshAll();
  setInterval(refreshStatus, 5000);
  setInterval(refreshUsage, 5000);
  setInterval(refreshSessions, 15000);
  setInterval(refreshAgents, 30000);
  setInterval(refreshTodo, 10000);
  // Goals + delegations panels. The 5s cadence mirrors the goal
  // state machine's heartbeat — fast enough that an active
  // planning → executing transition feels live, slow enough to
  // not hammer the goal store.
  setInterval(refreshGoals, 5000);
  setInterval(refreshDelegations, 5000);
  // Close button on the goal detail pane.
  $("goal-detail-close")?.addEventListener("click", closeGoalDetail);
  // First-run onboarding. Mirrors /onboard (slash) and ch onboard
  // (CLI) so all three surfaces give the same setup flow. The
  // wizard stays dismissable; the localStorage key suppresses it
  // for 30 days after a skip.
  void maybeShowOnboard();
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
