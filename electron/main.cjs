// CodingHarness desktop app — Electron main process.
//
// What it does:
//   1. Spawns `ch serve` as a child process on a random port
//   2. Waits for the server to be reachable
//   3. Opens a BrowserWindow pointing at http://localhost:<port>/
//   4. Puts a tray icon for show/hide + quit
//   5. On window close: hide (mac convention); on quit: kill child
//
// Run:   ./node_modules/.bin/electron .
// Distribute via electron-builder (configured in package.json).

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join, dirname } = require("node:path");
const http = require("node:http");
const net = require("node:net");

const isDev = !app.isPackaged;
const APP_ROOT = isDev
  ? join(__dirname, "..", "..")
  : join(__dirname, "..");
const CH_BIN = process.env.CH_BIN || join(APP_ROOT, "bin", "ch");

let chProcess = null;
let chPort = 0;
let mainWindow = null;
let tray = null;
let quitting = false;

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
    if (!existsSync(CH_BIN)) {
      reject(new Error("ch binary not found at " + CH_BIN));
      return;
    }
    findFreePort().then((port) => {
      chPort = port;
      const child = spawn(
        CH_BIN,
        ["serve", "--port", String(port), "--host", "127.0.0.1"],
        {
          env: {
            ...process.env,
            CH_WEB_DIR: join(APP_ROOT, "dist", "web"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      chProcess = child;
      let resolved = false;
      const onLine = (line) => {
        if (line.includes("listening on")) {
          if (!resolved) {
            resolved = true;
            setTimeout(() => resolve(port), 100);
          }
        }
      };
      child.stdout?.on("data", (b) => onLine(b.toString()));
      child.stderr?.on("data", (b) => process.stderr.write("[ch] " + b));
      child.on("exit", (code) => {
        console.log("[ch] server exited with code", code);
        if (!resolved) reject(new Error("ch server exited before listening"));
        chProcess = null;
        if (!quitting) app.quit();
      });
    }).catch(reject);
  });
}

function waitForServer(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  function attempt() {
    return new Promise((ok) => {
      const req = http.get(`http://127.0.0.1:${port}/v1/status`, (res) => {
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    title: "CodingHarness",
    backgroundColor: "#0e1116",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${chPort}/`);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Open external links in the user's browser, not in our window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("close", (e) => {
    if (!quitting && process.platform === "darwin") {
      // mac convention: hide instead of close.
      e.preventDefault();
      mainWindow?.hide();
    } else {
      // Trigger full quit.
      quitting = true;
    }
  });
}

function buildTray() {
  // Use a tiny generated PNG as the tray icon. (Real apps would ship
  // a proper .icns/.png set; for v1 this is a fallback.)
  try {
    const iconPath = join(APP_ROOT, "build", "tray-icon.png");
    if (existsSync(iconPath)) {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) {
        tray = new Tray(img.resize({ width: 16, height: 16 }));
      }
    }
  } catch (_) { /* ignore */ }
  if (!tray) {
    try { tray = new Tray(nativeImage.createEmpty()); } catch (_) { /* give up */ }
  }
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: "Show CodingHarness", click: () => { mainWindow?.show(); } },
    { label: "Hide", click: () => { mainWindow?.hide(); } },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setToolTip("CodingHarness");
  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
}

// IPC: allow the renderer to read basic info.
ipcMain.handle("ch:info", () => ({
  chPort,
  version: app.getVersion(),
  platform: process.platform,
}));

app.whenReady().then(async () => {
  try {
    const port = await startChServer();
    await waitForServer(port);
    chPort = port;
    buildTray();
    createWindow();
  } catch (e) {
    console.error("Fatal:", e);
    process.stderr.write("Failed to start: " + (e.message || e) + "\n");
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow?.show();
});

app.on("before-quit", () => {
  quitting = true;
  if (chProcess && !chProcess.killed) {
    try { chProcess.kill("SIGTERM"); } catch (_) {}
    setTimeout(() => { try { chProcess?.kill("SIGKILL"); } catch (_) {} }, 1500);
  }
});
