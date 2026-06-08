// Preload script — exposes a tiny, safe surface to the web UI.
// The web UI is loaded from our own server so it doesn't strictly need
// this, but it lets us put native-only affordances (e.g. a "show in
// Finder" link, native menus, deep-link handling) behind a
// permissioned bridge.

const { contextBridge, ipcRenderer } = require("electron");

// Web UI listens on `menu:command` and `deep-link` for native menu
// commands and ch:// deep links.
function on(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("ch", {
  platform: process.platform,
  arch: process.arch,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  // Request info from the main process.
  info: () => ipcRenderer.invoke("ch:info"),
  showLogs: () => ipcRenderer.send("ch:show-logs"),
  revealAppData: () => ipcRenderer.send("ch:reveal-appdata"),
  // Listen for native menu commands (new session, goal, command palette).
  onMenuCommand: (cb) => on("menu:command", cb),
  // Listen for ch:// deep links.
  onDeepLink: (cb) => on("deep-link", cb),
  // Listen for badge count updates.
  onBadge: (cb) => on("ch:badge", cb),
  // Listen for notifications from the web server (agent done, etc).
  onServerNotify: (cb) => on("server:notify", cb),

  // --- safeStorage / keychain ---
  keychainSummary: () => ipcRenderer.invoke("ch:keychain-summary"),
  keychainGet: (name) => ipcRenderer.invoke("ch:keychain-get", name),
  keychainSet: (name, value) => ipcRenderer.invoke("ch:keychain-set", name, value),
  keychainClear: () => ipcRenderer.invoke("ch:keychain-clear"),

  // --- Auto-launch ---
  autoLaunchGet: () => ipcRenderer.invoke("ch:auto-launch-get"),
  autoLaunchSet: (opts) => ipcRenderer.invoke("ch:auto-launch-set", opts),

  // --- Notifications ---
  notificationPush: (payload) => ipcRenderer.invoke("ch:notification-push", payload),
  setNotificationsEnabled: (enabled) => ipcRenderer.send("ch:notifications-set", enabled),

  // --- Recent projects ---
  recentList: () => ipcRenderer.invoke("ch:recent-list"),
  recentPin: (root) => ipcRenderer.invoke("ch:recent-pin", root),
  recentForget: (root) => ipcRenderer.invoke("ch:recent-forget", root),

  // --- Update channel ---
  updateChannelGet: () => ipcRenderer.invoke("ch:update-channel-get"),
  updateChannelSet: (channel) => ipcRenderer.invoke("ch:update-channel-set", channel),

  // --- Badge count ---
  setBadge: (n) => ipcRenderer.send("ch:badge-set", n),
});
