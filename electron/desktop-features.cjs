// CodingHarness desktop features — desktop integration for the
// Electron shell, modeled on the patterns that openai/codex and
// openclaw use for their desktop apps.
//
// 1. safeStorage for API keys
//    The web server currently stores API keys in plain settings.json.
//    On the desktop we move them to the OS keychain via Electron's
//    safeStorage API (Keychain on macOS, Credential Vault on
//    Windows, libsecret on Linux). Keys that aren't in the keychain
//    fall through to settings.json (dev / non-desktop usage).
//
// 2. Auto-launch on login
//    app.setLoginItemSettings({ openAtLogin, openAsHidden, args })
//    so the desktop can boot the harness the moment the user logs
//    in. Toggleable from the Settings panel.
//
// 3. Native desktop notifications
//    new Notification({ title, body, silent }).show() on the OS
//    notification center for "agent finished", "approval needed",
//    "MCP server up", etc. Routed through a queue so we can debounce
//    and respect the user's "do not disturb" preference.
//
// 4. Recent projects menu
//    Track the last 8 project roots the desktop opened (from
//    startChServer's cwd), and surface them in the File menu under
//    "Open Recent". Clicking reopens the app pointed at that root.
//
// 5. Tray badge count
//    Update the macOS dock / Linux Unity badge with the number of
//    active sessions. Toggled off if the OS doesn't support badges.
//
// 6. Update channel UI
//    Stable / Beta toggle, persisted via electron-store. "Check for
//    updates" now shows a dialog with the version rather than just
//    logging.
//
// Each feature is additive and degrades gracefully: safeStorage
// returns isAvailable=false on platforms where it isn't wired,
// auto-launch is a no-op on Linux when openAtLogin is unsupported,
// notifications fall back to no-ops, recent projects are a best-effort
// JSON file, the badge is platform-gated, and the channel toggle is
// simply persisted state.

const { app, safeStorage, Notification, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { exec } = require("node:child_process");

// electron-store is ESM-only at v10, which doesn't play with our CJS
// main process. We keep the recent-projects state in a small JSON
// file under the user data dir instead. Same on-disk semantics, no
// ESM dance.
function recentProjectsPath() {
  return path.join(app.getPath("userData"), "recent-projects.json");
}

function loadRecentProjects() {
  try {
    const raw = fs.readFileSync(recentProjectsPath(), "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.filter((p) => typeof p === "string").slice(0, 8);
  } catch { /* first run */ }
  return [];
}

function saveRecentProjects(arr) {
  try {
    const trimmed = arr.slice(0, 8);
    fs.writeFileSync(recentProjectsPath(), JSON.stringify(trimmed, null, 2), "utf-8");
  } catch (e) {
    log.warn("could not persist recent projects:", e.message);
  }
}

function recordRecentProject(root) {
  if (!root) return;
  const cur = loadRecentProjects();
  const without = cur.filter((p) => p !== root);
  without.unshift(root);
  saveRecentProjects(without);
}

// --- 1. safeStorage for API keys ---
//
// We keep an encrypted-at-rest blob on disk (encrypted via
// safeStorage.encryptString). Decrypt on read, encrypt on write. On
// platforms where safeStorage is unavailable, this module reports
// isAvailable=false and callers should fall back to settings.json.

function keychainPath() {
  return path.join(app.getPath("userData"), "keychain.bin");
}

function isKeychainAvailable() {
  return safeStorage.isEncryptionAvailable();
}

function readKeychain() {
  if (!isKeychainAvailable()) return {};
  try {
    const buf = fs.readFileSync(keychainPath());
    const decrypted = safeStorage.decryptString(buf);
    return JSON.parse(decrypted);
  } catch (e) {
    log.warn("keychain: read failed:", e.message);
    return {};
  }
}

function writeKeychain(obj) {
  if (!isKeychainAvailable()) return false;
  try {
    const buf = safeStorage.encryptString(JSON.stringify(obj));
    fs.writeFileSync(keychainPath(), buf);
    return true;
  } catch (e) {
    log.warn("keychain: write failed:", e.message);
    return false;
  }
}

function getKeychainEntry(name) {
  const all = readKeychain();
  return all[name] || null;
}

function setKeychainEntry(name, value) {
  const all = readKeychain();
  if (value == null || value === "") delete all[name];
  else all[name] = value;
  return writeKeychain(all);
}

function clearKeychain() {
  try { fs.unlinkSync(keychainPath()); } catch { /* ignore */ }
}

function keychainSummary() {
  const available = isKeychainAvailable();
  const entries = available ? Object.keys(readKeychain()) : [];
  return {
    available,
    backend: process.platform === "darwin" ? "Keychain"
      : process.platform === "win32" ? "Credential Vault"
      : process.platform === "linux" ? "libsecret" : "unknown",
    entries,
    path: keychainPath(),
  };
}

// --- 2. Auto-launch on login ---

function getAutoLaunch() {
  try {
    return app.getLoginItemSettings();
  } catch (e) {
    return { openAtLogin: false, openAsHidden: false };
  }
}

function setAutoLaunch({ openAtLogin, openAsHidden }) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!openAtLogin,
      openAsHidden: !!openAsHidden,
      // On Windows, this passes --hidden so the app starts in the
      // tray. On macOS, openAsHidden is honored by the OS at login
      // when the app is configured as a LoginItem via SFS.
      args: openAsHidden ? ["--hidden"] : [],
    });
    return true;
  } catch (e) {
    log.warn("setLoginItemSettings failed:", e.message);
    return false;
  }
}

// --- 3. Native desktop notifications ---

let notificationQueue = [];
let notificationsEnabled = true;

function setNotificationsEnabled(v) {
  notificationsEnabled = !!v;
}

function pushNotification({ title, body, silent = false, tag, onClick }) {
  if (!notificationsEnabled) return false;
  if (!Notification.isSupported()) return false;
  try {
    const n = new Notification({
      title: String(title || "CodingHarness"),
      body: body ? String(body) : undefined,
      silent,
      tag,
      // Suppress the default sound on silent notifications.
    });
    if (onClick) n.on("click", onClick);
    n.show();
    return true;
  } catch (e) {
    log.warn("notification failed:", e.message);
    return false;
  }
}

// --- 4. Recent projects (load/record/list are the public API) ---

function listRecentProjects() {
  return loadRecentProjects();
}

function pinRecentProject(root) {
  return recordRecentProject(root);
}

function forgetRecentProject(root) {
  const cur = loadRecentProjects();
  saveRecentProjects(cur.filter((p) => p !== root));
}

// --- 5. Tray badge count (active sessions) ---

let lastBadge = 0;
function setBadgeCount(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return;
  if (n === lastBadge) return;
  lastBadge = n;
  // macOS and Linux Unity expose app.setBadgeCount; Windows uses
  // the taskbar overlay icon (skip — a custom overlay is overkill
  // for a session counter).
  if (process.platform === "darwin" || process.platform === "linux") {
    try { app.setBadgeCount(n); } catch { /* ignore */ }
  }
}

function getBadgeCount() {
  return lastBadge;
}

// --- 6. Update channel ---

function updateChannelPath() {
  return path.join(app.getPath("userData"), "update-channel.json");
}

function getUpdateChannel() {
  try {
    const raw = fs.readFileSync(updateChannelPath(), "utf-8");
    const obj = JSON.parse(raw);
    if (obj && (obj.channel === "stable" || obj.channel === "beta")) return obj.channel;
  } catch { /* first run */ }
  return "stable";
}

function setUpdateChannel(channel) {
  if (channel !== "stable" && channel !== "beta") return false;
  try {
    fs.writeFileSync(updateChannelPath(), JSON.stringify({ channel, ts: Date.now() }, null, 2), "utf-8");
    return true;
  } catch (e) {
    log.warn("could not persist update channel:", e.message);
    return false;
  }
}

// --- 7. Version / git-info (for the Settings panel "About" box) ---

function readPackageInfo() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT_REF, "package.json"), "utf-8"));
    return {
      name: pkg.name,
      version: pkg.version,
      productName: pkg.productName || pkg.name,
    };
  } catch (e) {
    return { name: "codingharness", version: "0.0.0", productName: "CodingHarness" };
  }
}

// APP_ROOT_REF is set by main.cjs before requiring this module —
// avoids a re-derivation. Falls back to a sensible default if the
// module is required before main.cjs assigns it.
let APP_ROOT_REF = process.env.CH_APP_ROOT || path.resolve(__dirname, "..");
try {
  if (!process.env.CH_APP_ROOT) {
    // best-effort: walk up to find package.json
    let dir = __dirname;
    for (let i = 0; i < 4; i++) {
      const p = path.join(dir, "package.json");
      if (fs.existsSync(p) && JSON.parse(fs.readFileSync(p, "utf-8")).name === "codingharness") {
        APP_ROOT_REF = dir;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
} catch { /* ignore */ }

// pull log from electron-log if it's already initialized
let log;
try { log = require("electron-log/main"); } catch { log = { info() {}, warn() {}, error() {} }; }

module.exports = {
  // safeStorage / keychain
  isKeychainAvailable,
  getKeychainEntry,
  setKeychainEntry,
  clearKeychain,
  keychainSummary,
  // auto-launch
  getAutoLaunch,
  setAutoLaunch,
  // notifications
  setNotificationsEnabled,
  pushNotification,
  // recent projects
  listRecentProjects,
  pinRecentProject,
  forgetRecentProject,
  // badge
  setBadgeCount,
  getBadgeCount,
  // update channel
  getUpdateChannel,
  setUpdateChannel,
  // version
  readPackageInfo,
};
