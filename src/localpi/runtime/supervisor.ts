// Managed-process lifecycle. Borrowed from dutifuldev/localpi (MIT).
// https://github.com/dutifuldev/localpi/blob/main/src/localpi/llama-server.ts
//
// The four invariants:
//   1. Pid + JSON metadata at <stateDir>/server.json
//   2. process.kill(pid, 0) confirms pid is alive (some process, not necessarily ours)
//   3. /proc/<pid>/cmdline (Linux) or `ps -p` (macOS) confirms it's still OUR server
//   4. SIGTERM with 5s grace, then SIGKILL with 2s grace, then delete metadata

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";

export type ServerSpec = {
  readonly serverCommand: string;
  readonly host: string;
  readonly port: number;
  readonly modelId: string;
  readonly modelPath: string;
  readonly contextWindow: number;
  readonly gpuLayers: number;
  readonly parallel: number;
  readonly extraArgs?: readonly string[];
};

export type ServerMetadata = ServerSpec & {
  readonly pid: number;
  readonly baseUrl: string;
  readonly startedAt: string;
};

export type ServerStatus =
  | { kind: "not-running" }
  | { kind: "running"; metadata: ServerMetadata; models: readonly string[] }
  | { kind: "stale-metadata"; metadata: ServerMetadata; reason: string };

export async function ensureServer(
  spec: ServerSpec,
  stateDir: string
): Promise<{ metadata: ServerMetadata; reused: boolean }> {
  const baseUrl = `http://${spec.host}:${spec.port}/v1`;
  const logPath = path.join(stateDir, "server.log");
  await mkdir(stateDir, { recursive: true });

  const active = await readActiveMetadata(stateDir);
  if (active && isProcessAlive(active.pid)) {
    const command = await processCommand(active.pid);
    if (command === undefined || commandMatchesMetadata(command, active)) {
      if (specsEqual(active, spec)) {
        return { metadata: active, reused: true };
      }
      // Spec changed; restart
      await stopServer(stateDir);
    } else {
      // pid reused by another process
      await rm(metadataPath(stateDir), { force: true });
    }
  } else if (active) {
    // metadata says running, but pid is dead
    await rm(metadataPath(stateDir), { force: true });
  }

  const pid = await spawnDetached(spec, logPath);
  const metadata: ServerMetadata = {
    ...spec,
    baseUrl,
    pid,
    startedAt: new Date().toISOString()
  };
  await writeFile(
    metadataPath(stateDir),
    JSON.stringify(metadata, null, 2) + "\n",
    "utf8"
  );
  return { metadata, reused: false };
}

export async function stopServer(stateDir: string): Promise<string> {
  const info = await readActiveMetadata(stateDir);
  if (info === undefined) return "no managed server metadata found";
  if (isProcessAlive(info.pid)) {
    signalProcess(info.pid, "SIGTERM");
    await waitForExit(info.pid, 5000);
  }
  if (isProcessAlive(info.pid)) {
    signalProcess(info.pid, "SIGKILL");
    await waitForExit(info.pid, 2000);
  }
  if (isProcessAlive(info.pid)) {
    throw new Error(`failed to stop managed server pid ${info.pid}`);
  }
  await rm(metadataPath(stateDir), { force: true });
  return `stopped managed server pid ${info.pid}`;
}

export async function serverStatus(stateDir: string): Promise<ServerStatus> {
  const metadata = await readActiveMetadata(stateDir);
  if (metadata === undefined) return { kind: "not-running" };
  if (!isProcessAlive(metadata.pid)) {
    return { kind: "stale-metadata", metadata, reason: "pid not alive" };
  }
  const command = await processCommand(metadata.pid);
  if (command !== undefined && !commandMatchesMetadata(command, metadata)) {
    return { kind: "stale-metadata", metadata, reason: "pid reused by another process" };
  }
  const models = await probeModels(metadata.baseUrl);
  return { kind: "running", metadata, models };
}

function metadataPath(stateDir: string): string {
  return path.join(stateDir, "server.json");
}

async function readActiveMetadata(stateDir: string): Promise<ServerMetadata | undefined> {
  try {
    const raw = await readFile(metadataPath(stateDir), "utf8");
    const value = JSON.parse(raw) as ServerMetadata;
    if (typeof value.pid !== "number" || typeof value.modelId !== "string") {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

async function spawnDetached(spec: ServerSpec, logPath: string): Promise<number> {
  await assertExecutableExists(spec.serverCommand);
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(spec.serverCommand, buildArgs(spec), {
      detached: true,
      stdio: ["ignore", fd, fd]
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("process id unavailable");
    child.unref();
    return pid;
  } finally {
    closeSync(fd);
  }
}

async function assertExecutableExists(command: string): Promise<void> {
  if (command.length === 0) throw new Error("server command is empty");
  if (command.includes("/") || command.includes("\\")) {
    if (!(await canExecute(command))) throw new Error(`executable not found: ${command}`);
    return;
  }
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean)) {
    if (await canExecute(path.join(dir, command))) return;
  }
  throw new Error(`executable not found in PATH: ${command}`);
}

async function canExecute(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // final liveness check decides
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(100);
  }
}

async function processCommand(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
      return raw.replaceAll("\u0000", " ").trim();
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") return undefined;
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "command="],
      { timeout: 1000 },
      (err, stdout) => {
        if (err !== null) return resolve(undefined);
        const c = stdout.trim();
        resolve(c.length === 0 ? undefined : c);
      }
    );
  });
}

function commandMatchesMetadata(command: string, info: ServerMetadata): boolean {
  return (
    command.includes(info.modelPath) &&
    command.includes(path.basename(info.serverCommand) || info.serverCommand)
  );
}

async function probeModels(baseUrl: string): Promise<readonly string[]> {
  try {
    const r = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) return [];
    const j: unknown = await r.json();
    const root = j as { data?: unknown };
    return Array.isArray(root.data)
      ? (root.data as readonly { id?: unknown }[])
          .filter((m) => typeof m.id === "string")
          .map((m) => m.id as string)
      : [];
  } catch {
    return [];
  }
}

function specsEqual(a: ServerSpec, b: ServerSpec): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.modelId === b.modelId &&
    a.modelPath === b.modelPath &&
    a.contextWindow === b.contextWindow &&
    a.gpuLayers === b.gpuLayers &&
    a.parallel === b.parallel &&
    a.serverCommand === b.serverCommand
  );
}

function buildArgs(spec: ServerSpec): readonly string[] {
  return [
    "--host",
    spec.host,
    "--port",
    String(spec.port),
    "--model",
    spec.modelPath,
    "--alias",
    spec.modelId,
    "--ctx-size",
    String(spec.contextWindow),
    "--gpu-layers",
    String(spec.gpuLayers),
    "--parallel",
    String(spec.parallel),
    ...(spec.extraArgs ?? [])
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
