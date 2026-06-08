// CodingHarness desktop app — Electron main process.
//
// Modeled on anomalyco/opencode/packages/desktop/src/main (the opencode
// desktop app). The structure is intentionally close to theirs so
// anyone familiar with opencode can navigate CodingHarness's shell
// in seconds:
//
//   1. Single-instance lock: a second launch focuses the existing
//      window instead of opening a duplicate.
//   2. Background color pre-set to the dark theme to avoid white flash.
//   3. Spawn `ch serve` as a sidecar child process on a random port.
//   4. Wait for /v1/status to return 200 (server is ready).
//   5. Open a BrowserWindow with secure web preferences.
//   6. Build a proper app menu (File/Edit/View/Window/Help) with
//      keyboard shortcuts.
//   7. Build a richer tray menu: open / hide / new session / quit,
//      with a status line showing server state.
//   8. Register a `ch://` URL protocol handler for deep links.
//   9. Wire electron-updater: check GitHub releases on startup, then
//      every 6 hours.
//  10. Save window state (size/position) across launches via
//      electron-window-state.
//  11. Log everything to electron-log (OS-native log file).
//  12. Clean SIGTERM → SIGKILL shutdown of the child on quit.
//
// Run:   ./node_modules/.bin/electron .
// Distribute via electron-builder using electron/electron-builder.config.cjs.

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog, protocol } = require("electron");
const log = require("electron-log/main");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");

// electron-context-menu@4 is ESM-only and can't be require()'d from a
// CommonJS main process. Use dynamic import so we can still surface
// the enriched right-click menu (spellcheck, copy, dev tools).
// Falls back to Electron's default context menu if the import fails.
let setupContextMenu = null;
try {
  // Top-level await isn't available in CJS; defer to app.whenReady().
  const importEsm = (m) => import(m);
  setupContextMenu = async () => {
    try {
      const mod = await importEsm("electron-context-menu");
      const contextMenu = mod.default || mod;
      contextMenu({
        showLookUpSelection: true,
        showCopyImage: true,
        showSaveImageAs: true,
        showInspectElement: !app.isPackaged,
      });
      log.info("electron-context-menu loaded");
    } catch (e) {
      log.warn("electron-context-menu not available, using default:", e.message);
    }
  };
} catch (e) {
  log.warn("could not set up context-menu loader:", e.message);
}

const isDev = !app.isPackaged;
const APP_ROOT = isDev ? path.join(__dirname, "..", "..") : path.join(__dirname, "..");
const CH_BIN = process.env.CH_BIN || path.join(APP_ROOT, "bin", "ch");
const WEB_DIR = process.env.CH_WEB_DIR || path.join(
  isDev ? APP_ROOT : process.resourcesPath,
  isDev ? "src" : "app",
  "web"
);

// --- Single-instance lock: a second invocation focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let chProcess = null;
let chPort = 0;
let chUrl = "";
let mainWindow = null;
let tray = null;
let quitting = false;
let windowState = null; // electron-window-state
let serverReady = false;
let serverError = null;

function sendMenuCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("menu:command", command);
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// --- Logging: write to OS-native log file (~/Library/Logs on macOS,
// %APPDATA% on Windows, ~/.config on Linux) so users can attach logs
// to bug reports. ---
log.initialize({ preload: true });
log.info("CodingHarness desktop starting, version=" + app.getVersion() + ", platform=" + process.platform);

// Context menu is set up in app.whenReady() because electron-context-menu
// v4 is ESM-only and requires dynamic import.

// ---------- Helpers ----------

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function startChServer() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CH_BIN)) {
      const msg = "ch binary not found at " + CH_BIN;
      log.error(msg);
      reject(new Error(msg));
      return;
    }
    findFreePort().then((port) => {
      chPort = port;
      chUrl = "http://127.0.0.1:" + port;
      const child = spawn(
        CH_BIN,
        ["serve", "--port", String(port), "--host", "127.0.0.1"],
        {
          env: Object.assign({}, process.env, { CH_WEB_DIR: WEB_DIR, ELECTRON_RUN_AS_NODE: undefined }),
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      chProcess = child;
      let resolved = false;
      const onLine = (line) => {
        if (line.includes("listening on")) {
          if (!resolved) {
            resolved = true;
            // Wait briefly for the port to actually accept connections.
            setTimeout(() => { serverReady = true; refreshTray(); resolve(port); }, 100);
          }
        }
      };
      child.stdout.on("data", (b) => onLine(b.toString()));
      child.stderr.on("data", (b) => {
        const s = b.toString();
        log.warn("[ch] " + s);
        process.stderr.write("[ch] " + s);
      });
      child.on("exit", (code, signal) => {
        log.info("[ch] server exited code=" + code + " signal=" + signal);
        chProcess = null;
        serverReady = false;
        serverError = "server exited (code " + code + ", signal " + signal + ")";
        refreshTray();
        if (!quitting) {
          // Try once to restart after a short delay.
          setTimeout(() => {
            if (!quitting) {
              log.info("attempting to restart ch server after unexpected exit");
              startChServer().then(refreshTray).catch((e) => {
                log.error("restart failed:", e.message);
              });
            }
          }, 1_000);
        }
      });
    }).catch(reject);
  });
}

function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 10_000);
  function attempt() {
    return new Promise((ok) => {
      const req = http.get("http://127.0.0.1:" + port + "/v1/status", (res) => {
        res.resume();
        ok(res.statusCode === 200);
      });
      req.on("error", () => ok(false));
      req.setTimeout(500, () => { req.destroy(); ok(false); });
    });
  }
  return (async () => {
    while (Date.now() < deadline) {
      if (await attempt()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("ch server did not become ready within " + timeoutMs + "ms");
  })();
}

function createMainWindow() {
  // electron-window-state persists bounds across launches.
  windowState = require("electron-window-state");
  const ws = windowState({
    defaultWidth: 1280,
    defaultHeight: 820,
  });

  mainWindow = new BrowserWindow({
    x: ws.x,
    y: ws.y,
    width: ws.width,
    height: ws.height,
    minWidth: 800,
    minHeight: 500,
    title: "CodingHarness",
    backgroundColor: "#0e1116", // matches web UI bg, prevents white flash
    show: false,
    icon: process.platform === "darwin" ? undefined : path.join(APP_ROOT, "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // stricter than just contextIsolation; pairs well with our preload
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  ws.manage(mainWindow);

  // Once the renderer is ready, show the window. This avoids the
  // white-flash that happens if you show on `ready-to-show` while
  // the renderer is still loading the server URL.
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Open external links in the user's browser, not in our window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Block in-app navigation to off-site URLs (security default).
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(chUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on("close", (e) => {
    if (!quitting && process.platform === "darwin") {
      // macOS convention: hide on close, keep app alive in dock.
      e.preventDefault();
      mainWindow.hide();
    } else {
      quitting = true;
    }
  });

  mainWindow.loadURL(chUrl + "/");
}

// ---------- Menu ----------

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Session",
          accelerator: "CmdOrCtrl+N",
          click: () => { sendMenuCommand("new-session"); },
        },
        {
          label: "Goal Mode",
          accelerator: "CmdOrCtrl+Shift+G",
          click: () => { sendMenuCommand("goal"); },
        },
        {
          label: "Command Palette",
          accelerator: "CmdOrCtrl+K",
          click: () => { sendMenuCommand("command-palette"); },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Session",
      submenu: [
        {
          label: "Open in Browser",
          accelerator: "CmdOrCtrl+Shift+B",
          click: () => { shell.openExternal(chUrl + "/"); },
        },
        {
          label: "Copy Server URL",
          click: () => { require("electron").clipboard.writeText(chUrl); },
        },
        { type: "separator" },
        {
          label: "Show Logs",
          click: () => { sendMenuCommand("show-logs"); },
        },
        {
          label: "Reveal App Data",
          click: () => { sendMenuCommand("reveal-appdata"); },
        },
        {
          label: "Export Debug Logs…",
          click: async () => {
            const r = await dialog.showSaveDialog(mainWindow, { defaultPath: "codingharness-logs.txt" });
            if (!r.canceled && r.filePath) {
              try { fs.copyFileSync(log.transports.file.getFile().path, r.filePath); } catch (e) { log.error(e); }
            }
          },
        },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Documentation",
          click: () => { shell.openExternal("https://github.com/Franzferdinan51/Custom-Code-Harness"); },
        },
        {
          label: "Check for Updates",
          click: () => { checkForUpdates(true); },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Tray ----------

function buildTray() {
  try {
    const iconPath = path.join(APP_ROOT, "build", "tray-icon.png");
    let img = nativeImage.createEmpty();
    if (fs.existsSync(iconPath)) {
      const fromFile = nativeImage.createFromPath(iconPath);
      if (!fromFile.isEmpty()) img = fromFile.resize({ width: 16, height: 16 });
    }
    if (img.isEmpty()) {
      // Build a 16x16 dark-square placeholder programmatically.
      img = nativeImage.createFromBuffer(Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJklEQVR4nO3OAQ0AAAjDsM2/6XHIIxnB" +
        "Pz7sbgHR2QEIIIAAAggggAACCCCAAAIIIIAAAggg8BfwB1RJBQRtsUl4AAAAAElFTkSuQmCC",
        "base64"
      ));
    }
    tray = new Tray(img);
    tray.setToolTip("CodingHarness");
    refreshTray();
    tray.on("click", () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    });
  } catch (e) {
    log.warn("tray init failed:", e.message);
  }
}

function refreshTray() {
  if (!tray) return;
  const status = serverReady ? "● server running on " + chUrl
    : (serverError ? "✗ " + serverError : "○ starting server…");
  const menu = Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: "separator" },
    { label: "Show CodingHarness", click: () => mainWindow?.show() },
    { label: "Goal Mode", click: () => sendMenuCommand("goal") },
    { label: "Command Palette", click: () => sendMenuCommand("command-palette") },
    { label: "Hide", click: () => mainWindow?.hide() },
    { type: "separator" },
    { label: "Open in Browser", click: () => shell.openExternal(chUrl + "/") },
    { label: "Copy Server URL", click: () => { require("electron").clipboard.writeText(chUrl); } },
    { type: "separator" },
    { label: "Check for Updates", click: () => checkForUpdates(true) },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ---------- Auto-updater ----------

let autoUpdater = null;
function setupAutoUpdater() {
  try {
    const { autoUpdater: au } = require("electron-updater");
    autoUpdater = au;
    au.autoDownload = false; // ask first
    au.autoInstallOnAppQuit = true;
    au.logger = log;
    au.on("update-available", (info) => {
      log.info("update available:", info.version);
      const r = dialog.showMessageBoxSync(mainWindow, {
        type: "info",
        title: "Update available",
        message: "CodingHarness v" + info.version + " is available",
        detail: "You are running v" + app.getVersion() + ". Download and install now?",
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (r === 0) au.downloadUpdate();
    });
    au.on("update-downloaded", (info) => {
      log.info("update downloaded:", info.version);
      const r = dialog.showMessageBoxSync(mainWindow, {
        type: "info",
        title: "Update ready",
        message: "v" + info.version + " has been downloaded",
        detail: "Restart CodingHarness to apply the update.",
        buttons: ["Restart", "On Next Launch"],
        defaultId: 0,
        cancelId: 1,
      });
      if (r === 0) {
        quitting = true;
        au.quitAndInstall();
      }
    });
    au.on("error", (e) => log.warn("updater error:", e?.message));
    // Check once at startup, then every 6 hours.
    au.checkForUpdates().catch((e) => log.info("initial update check skipped:", e.message));
    setInterval(() => {
      au.checkForUpdates().catch(() => {});
    }, 6 * 60 * 60 * 1000);
  } catch (e) {
    log.warn("auto-updater setup failed:", e.message);
  }
}

function checkForUpdates(userInitiated) {
  if (!autoUpdater) {
    if (userInitiated) {
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Updates",
        message: "Auto-updates are not configured in this build.",
        detail: "Rebuild with `npm run dist:publish` to enable them.",
      });
    }
    return;
  }
  autoUpdater.checkForUpdates().then(
    () => { if (userInitiated) log.info("update check finished"); },
    (e) => {
      if (userInitiated) {
        dialog.showMessageBox(mainWindow, {
          type: "error",
          title: "Update check failed",
          message: "Could not check for updates",
          detail: e.message,
        });
      }
    }
  );
}

// ---------- Protocol handler ----------

function registerProtocolHandler() {
  // ch://new-session or ch://session/abc123
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient("ch", process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient("ch");
  }
  // macOS deep-link arrives via 'open-url' event.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (mainWindow) {
      mainWindow.webContents.send("deep-link", url);
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
  // Windows / Linux: deep link is in argv.
  const urlArg = process.argv.find((a) => a.startsWith("ch://"));
  if (urlArg) {
    app.whenReady().then(() => {
      if (mainWindow) mainWindow.webContents.send("deep-link", urlArg);
    });
  }
}

// ---------- IPC ----------

ipcMain.handle("ch:info", () => ({
  chPort,
  chUrl,
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  isPackaged: app.isPackaged,
  userData: app.getPath("userData"),
  logsPath: log.transports.file.getFile().path,
}));

ipcMain.on("ch:show-logs", () => {
  shell.openPath(log.transports.file.getFile().path);
});

ipcMain.on("ch:reveal-appdata", () => {
  shell.openPath(app.getPath("userData"));
});

// ---------- App lifecycle ----------

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  if (setupContextMenu) await setupContextMenu();
  registerProtocolHandler();
  buildAppMenu();
  try {
    const port = await startChServer();
    await waitForServer(port);
    chPort = port;
    chUrl = "http://127.0.0.1:" + port;
    createMainWindow();
    buildTray();
    setupAutoUpdater();
  } catch (e) {
    log.error("startup failed:", e);
    const msg = "Failed to start CodingHarness:\n\n" + (e.message || e) + "\n\nLogs: " + log.transports.file.getFile().path;
    dialog.showErrorBox("CodingHarness", msg);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  else mainWindow?.show();
});

app.on("before-quit", () => {
  quitting = true;
  if (chProcess && !chProcess.killed) {
    try { chProcess.kill("SIGTERM"); } catch (_) {}
    setTimeout(() => { try { chProcess?.kill("SIGKILL"); } catch (_) {} }, 1_500);
  }
});
