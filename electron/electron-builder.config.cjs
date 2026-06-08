// electron-builder configuration for CodingHarness desktop app.
// Modeled on anomalyco/opencode/packages/desktop/electron-builder.config.ts:
// channel-based app ID (dev/beta/prod) so all three can coexist on
// the same machine, GitHub publishing for auto-updates, hard target
// list per OS.
//
// The actual desktop main process is in electron/main.cjs (CommonJS,
// loaded by Electron directly). This file is consumed by the
// `electron-builder` CLI when packaging distributables.

"use strict";

const path = require("node:path");

/** Release channel. "prod" is the user-facing app, "beta" and "dev" are
 *  side-by-side installs for testing. Reads OPENCODE_CHANNEL for
 *  parity with the opencode project (also accepts CH_CHANNEL). */
function channel() {
  const raw = process.env.OPENCODE_CHANNEL || process.env.CH_CHANNEL;
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw;
  return "prod";
}

const base = {
  artifactName: "codingharness-${os}-${arch}.${ext}",
  directories: {
    output: "release",
    buildResources: "build",
  },
  files: [
    "bin/**",
    "dist/**",
    "electron/**",
    "package.json",
    "!node_modules/**",
  ],
  extraResources: [
    { from: "bin/", to: "bin/" },
  ],
  protocols: [
    { name: "CodingHarness", schemes: ["ch"] },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: "build/icon.icns",
    hardenedRuntime: true,
    entitlements: "build/entitlements.plist",
    entitlementsInherit: "build/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  win: {
    icon: "build/icon.ico",
    target: ["nsis", "portable"],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: "build/icon.ico",
    installerHeaderIcon: "build/icon.ico",
  },
  linux: {
    icon: "build/icons",
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
};

function getConfig() {
  const ch = channel();
  if (ch === "dev") {
    return Object.assign({}, base, {
      appId: "com.codingharness.dev",
      productName: "CodingHarness Dev",
      publish: null, // dev builds never auto-update
    });
  }
  if (ch === "beta") {
    return Object.assign({}, base, {
      appId: "com.codingharness.beta",
      productName: "CodingHarness Beta",
      publish: { provider: "github", owner: "Franzferdinan51", repo: "Custom-Code-Harness", channel: "beta" },
    });
  }
  // prod
  return Object.assign({}, base, {
    appId: "com.codingharness.app",
    productName: "CodingHarness",
    publish: { provider: "github", owner: "Franzferdinan51", repo: "Custom-Code-Harness", channel: "latest" },
  });
}

module.exports = getConfig();
