// Cron scheduling. We support a deliberately simple model:
//   - interval: every N minutes/hours
//   - daily-at: at HH:MM every day
//   - one-shot: at a specific ISO timestamp
//   - cron: a real cron expression (parsed by a tiny built-in parser)
//
// Each job, when it fires, runs a prompt through a fresh Runtime and
// (optionally) writes the output to a file. v1 does NOT do platform
// delivery (Telegram/Discord etc) — that's a much bigger lift.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { paths } from "../config/paths.js";
import { log } from "../util/logger.js";

function jobsFile(): string { return join(paths.cron, "jobs.json"); }

export type Schedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily-at"; hour: number; minute: number }
  | { kind: "at"; iso: string }
  | { kind: "cron"; expr: string };

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  /** When the job last fired. */
  lastRun?: number;
  /** When the job is next due. */
  nextRun?: number;
  /** If set, write output to this path (relative to cwd). */
  outputFile?: string;
  /** If true, do not stream output to stdout. */
  silent?: boolean;
  /** Created timestamp. */
  createdAt: number;
}

export function newId(): string { return randomBytes(4).toString("hex"); }

export class CronStore {
  list(): CronJob[] {
    if (!existsSync(jobsFile())) return [];
    try { return JSON.parse(readFileSync(jobsFile(), "utf-8")) as CronJob[]; }
    catch { return []; }
  }
  save(jobs: CronJob[]): void {
    writeFileSync(jobsFile(), JSON.stringify(jobs, null, 2) + "\n", "utf-8");
  }
  add(job: Omit<CronJob, "id" | "createdAt">): CronJob {
    const jobs = this.list();
    const created: CronJob = { ...job, id: newId(), createdAt: Date.now() };
    jobs.push(created);
    this.save(jobs);
    return created;
  }
  remove(id: string): boolean {
    const jobs = this.list();
    const i = jobs.findIndex((j) => j.id === id);
    if (i === -1) return false;
    jobs.splice(i, 1);
    this.save(jobs);
    return true;
  }
  update(id: string, patch: Partial<CronJob>): CronJob | null {
    const jobs = this.list();
    const j = jobs.find((j) => j.id === id);
    if (!j) return null;
    Object.assign(j, patch);
    this.save(jobs);
    return j;
  }
  get(id: string): CronJob | null {
    return this.list().find((j) => j.id === id) ?? null;
  }
}

/** Compute the next run time for a schedule, given "now". */
export function nextRun(s: Schedule, now: Date = new Date()): number {
  switch (s.kind) {
    case "interval": {
      const ms = Math.max(1, s.minutes) * 60_000;
      return now.getTime() + ms;
    }
    case "daily-at": {
      const d = new Date(now);
      d.setHours(s.hour, s.minute, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    case "at": {
      const t = Date.parse(s.iso);
      return Number.isFinite(t) ? t : 0;
    }
    case "cron": {
      try {
        const t = cronNext(s.expr, now);
        return t ?? 0;
      } catch (e) {
        log.warn("cron: bad expr " + s.expr + ": " + (e as Error).message);
        return 0;
      }
    }
  }
}

/** Tiny cron expression parser. Supports the standard 5-field form:
 *  minute hour day-of-month month day-of-week
 *  Each field can be: * | N | N,N,... | N-M | star-slash-N
 *  Returns the next matching timestamp, or null if no match in the next year. */
export function cronNext(expr: string, after: Date = new Date()): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron expression must have 5 fields");
  const [minF, hourF, domF, monF, dowF] = parts as [string, string, string, string, string];
  const min = parseField(minF, 0, 59);
  const hour = parseField(hourF, 0, 23);
  const dom = parseField(domF, 1, 31);
  const mon = parseField(monF, 1, 12);
  const dow = parseField(dowF, 0, 6); // 0=Sun
  const start = new Date(after.getTime() + 60_000);
  start.setSeconds(0, 0);
  const end = new Date(after.getFullYear() + 1, 0, 1).getTime();
  for (let t = start.getTime(); t < end; t += 60_000) {
    const d = new Date(t);
    if (!min.has(d.getMinutes())) continue;
    if (!hour.has(d.getHours())) continue;
    if (!mon.has(d.getMonth() + 1)) continue;
    const jsDow = d.getDay();
    if (!dow.has(jsDow)) continue;
    if (domF !== "*" && !dom.has(d.getDate())) continue;
    if (dowF !== "*" && domF === "*" && !dow.has(jsDow)) continue;
    return t;
  }
  return null;
}

function parseField(f: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const piece of f.split(",")) {
    let step = 1;
    let body = piece;
    const slash = piece.indexOf("/");
    if (slash >= 0) {
      step = parseInt(piece.slice(slash + 1), 10);
      if (!Number.isFinite(step) || step < 1) throw new Error("bad step: " + piece);
      body = piece.slice(0, slash);
    }
    let start: number, end: number;
    if (body === "*") { start = lo; end = hi; }
    else if (body.includes("-")) {
      const parts = body.split("-").map((s) => parseInt(s, 10));
      const a = parts[0] ?? NaN;
      const b = parts[1] ?? NaN;
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("bad range: " + piece);
      start = a; end = b;
    } else {
      const n = parseInt(body, 10);
      if (!Number.isFinite(n)) throw new Error("bad field: " + piece);
      start = n; end = n;
    }
    for (let i = start; i <= end; i += step) out.add(i);
  }
  return out;
}

/** Format a schedule for display. */
export function formatSchedule(s: Schedule): string {
  switch (s.kind) {
    case "interval": return "every " + s.minutes + " min";
    case "daily-at": return "daily at " + String(s.hour).padStart(2, "0") + ":" + String(s.minute).padStart(2, "0");
    case "at": return "once at " + s.iso;
    case "cron": return "cron(" + s.expr + ")";
  }
}

/** Parse a human schedule into a Schedule. Accepts:
 *  "every 30 min", "every 2h", "daily 09:30", "at 2026-12-31T23:59", or a raw cron expr. */
export function parseHumanSchedule(s: string): Schedule {
  const t = s.trim();
  let m = t.match(/^every\s+(\d+)\s*m(in)?(ute)?s?$/i);
  if (m) return { kind: "interval", minutes: parseInt(m[1]!, 10) };
  m = t.match(/^every\s+(\d+)\s*h(our)?s?$/i);
  if (m) return { kind: "interval", minutes: parseInt(m[1]!, 10) * 60 };
  m = t.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (m) return { kind: "daily-at", hour: parseInt(m[1]!, 10), minute: parseInt(m[2]!, 10) };
  m = t.match(/^at\s+(.+)$/i);
  if (m) return { kind: "at", iso: m[1]! };
  if (/^[\s\d\*\/\-,]+$/.test(t) && t.split(/\s+/).length === 5) return { kind: "cron", expr: t };
  throw new Error("could not parse schedule: " + s);
}
