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
});
