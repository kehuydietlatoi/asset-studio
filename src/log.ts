/**
 * Studio log: one plain-text file shared by every studio process (dev server, watcher, `fix` runs), at
 * `.asset-studio/logs/studio.log`. One line per event:
 *   2026-11-21T15:43:01.123Z INFO  dev#1234 [unit/ad_u_11/s1] queued 20261121-154300 (1 in queue)
 * Rotates to studio.1.log at 5 MB. Logging never throws: a full disk must not break a fix.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export type Level = "info" | "warn" | "error";

export interface Logger {
  readonly file: string;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** Same log, every line tagged with `[scope]` (usually the asset id). */
  scope(scope: string): Logger;
}

const MAX_BYTES = 5 * 1024 * 1024;

export function logFile(dataDir: string): string {
  return join(dataDir, "logs", "studio.log");
}

export interface LoggerOptions {
  /** Process name in each line (`dev`, `watch`, `fix`, ...). */
  source?: string;
  /** Also print to the console (without the timestamp). Default true. */
  echo?: boolean;
}

export function createLogger(dataDir: string, opts: LoggerOptions = {}, scopeName?: string): Logger {
  const file = logFile(dataDir);
  const who = `${opts.source ?? "studio"}#${process.pid}`;
  const write = (level: Level, msg: string) => {
    const tag = scopeName ? ` [${scopeName}]` : "";
    if (opts.echo !== false) (level === "error" ? console.error : console.log)(`${tag ? tag.trim() + " " : ""}${msg}`);
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${who}${tag} ${msg.replace(/\r?\n/g, " ⏎ ")}\n`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file.replace(/\.log$/, ".1.log"));
      appendFileSync(file, line);
    } catch {
      /* never let logging break the studio */
    }
  };
  return {
    file,
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
    scope: (s) => createLogger(dataDir, opts, s),
  };
}

/** Last `n` lines of the studio log (empty string if there is none yet). */
export function tailLog(dataDir: string, n: number): string {
  const file = logFile(dataDir);
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  return lines.slice(-n).join("\n");
}

/** "1m 05s" style duration. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
