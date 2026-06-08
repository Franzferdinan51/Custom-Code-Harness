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
    $("version").textContent = "v" + state.version;
    $("model").textContent = state.provider + " / " + state.model;
    $("approval-status").textContent = state.approval;
  } catch (e) {
    console.error("status:", e);
  }
}

async function refreshSessions() {
  try {
    const j = await api("/v1/sessions");
    state.recentSessions = (j.sessions || []).slice(0, 6);
    const list = $("session-list");
    list.innerHTML = "";
    if (state.recentSessions.length === 0) {
      list.appendChild(el("div", { class: "sidebar-empty" }, "none"));
    } else {
      for (const s of state.recentSessions) {
        const marker = s.id === state.session ? "●" : " ";
        const when = formatAgo(s.updatedAt);
        const short = s.id.slice(0, 8);
        const row = el("div", { class: "row" }, [
          el("span", { class: "marker" }, marker),
          el("span", {}, short),
          el("span", { class: "when" }, when),
        ]);
        row.style.cursor = "pointer";
        row.title = "Click to resume " + s.id;
        row.addEventListener("click", () => resumeSession(s.id));
        list.appendChild(row);
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

function getSlashMatches(query) {
  const normalized = query.trim().replace(/^\//, "").toLowerCase();
  if (!normalized) return state.slashCommands.slice(0, 8);
  return state.slashCommands
    .filter((cmd) => cmd.name.toLowerCase().includes(normalized) || cmd.description.toLowerCase().includes(normalized))
    .slice(0, 8);
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
  for (const cmd of matches) {
    const row = el("div", { class: "command-palette-item" }, [
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

// ---------- Streaming chat ----------

async function sendPrompt(prompt) {
  if (state.streaming) return;
  state.streaming = true;
  $("send-button").disabled = true;
  $("send-button").textContent = "running…";
  state.streamBuffer = "";

  // Echo user message.
  addMessage({ kind: "user", text: prompt });

  try {
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
    case "info":       addMessage({ kind: "info", text: p.text || "" }); break;
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
  inputEl.value = "";
  autoResize();
  renderSlashPanel("");
  sendPrompt(text);
});

// ---------- New session / resume ----------

$("new-session").addEventListener("click", async () => {
  try {
    await api("/v1/session", { method: "POST", body: {} });
    messagesEl.innerHTML = "";
    refreshAll();
  } catch (e) { addMessage({ kind: "error", text: "new session: " + e.message }); }
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
$("settings").addEventListener("click", async () => {
  // Load current settings.
  try {
    const s = await api("/v1/settings");
    // Populate.
    $("setting-model").value = s.model || "";
    $("setting-approval").value = s.approval || "on-mutation";
    $("setting-thinking").value = s.thinking || "medium";
    const provSel = $("setting-provider");
    provSel.innerHTML = "";
    for (const p of (s.providers || [])) {
      provSel.appendChild(el("option", { value: p.id }, p.id + (p.model ? " (" + p.model + ")" : "")));
    }
    provSel.value = s.provider || "";
  } catch (e) { /* ignore */ }
  settingsModal.hidden = false;
});
$("settings-cancel").addEventListener("click", () => { settingsModal.hidden = true; });
$("settings-save").addEventListener("click", async () => {
  try {
    await api("/v1/settings", { method: "POST", body: {
      provider: $("setting-provider").value,
      model: $("setting-model").value,
      approval: $("setting-approval").value,
      thinking: $("setting-thinking").value,
    }});
    settingsModal.hidden = true;
    refreshAll();
  } catch (e) { addMessage({ kind: "error", text: "settings: " + e.message }); }
});

// ---------- Init ----------

(async () => {
  await refreshAll();
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
      }
      window.ch.onMenuCommand && window.ch.onMenuCommand(() => {
        // File > New Session
        const newBtn = document.getElementById("new-session");
        if (newBtn) newBtn.click();
        else location.reload();
      });
      window.ch.onDeepLink && window.ch.onDeepLink((url) => {
        // ch://new-session or ch://session/abc123
        showInfo("Deep link: " + url);
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
