#!/usr/bin/env node
// Copy the web UI assets to dist/web/ so the compiled server can find them.

import { mkdirSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcWeb = join(root, "src", "web");
const distWeb = join(root, "dist", "web");

if (!existsSync(srcWeb)) {
  console.error(`copy-web: ${srcWeb} not found`);
  process.exit(1);
}

mkdirSync(distWeb, { recursive: true });
cpSync(srcWeb, distWeb, { recursive: true });
console.log(`copy-web: ${srcWeb} -> ${distWeb}`);
