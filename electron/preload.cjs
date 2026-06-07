// Preload script — exposes a tiny, safe surface to the web UI.
// The web UI is loaded from our own server so it doesn't strictly need
// this, but it lets us put native-only affordances (e.g. a "show in
// Finder" link) behind a permissioned bridge.

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("ch", {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
});
