import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) ?? "debug";

const LOG_DIR = process.env.LOG_DIR ?? "store/logs";
mkdirSync(LOG_DIR, { recursive: true });

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOG_DIR, `octo-${date}.log`);
}

function ts(): string {
  return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function fmt(level: string, tag: string, msg: string, data?: unknown): string {
  const base = `[${ts()}] [${level.toUpperCase()}] [${tag}] ${msg}`;
  if (data !== undefined) {
    if (data instanceof Error) {
      return `${base}\n${data.stack ?? data.message}`;
    }
    return `${base}\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`;
  }
  return base;
}

function writeToFile(line: string) {
  try {
    appendFileSync(getLogFilePath(), line + "\n");
  } catch {
    // Silently ignore file write errors to avoid cascading failures
  }
}

export const log = {
  debug(tag: string, msg: string, data?: unknown) {
    if (!shouldLog("debug")) return;
    const line = fmt("debug", tag, msg, data);
    console.log(line);
    writeToFile(line);
  },
  info(tag: string, msg: string, data?: unknown) {
    if (!shouldLog("info")) return;
    const line = fmt("info", tag, msg, data);
    console.log(line);
    writeToFile(line);
  },
  warn(tag: string, msg: string, data?: unknown) {
    if (!shouldLog("warn")) return;
    const line = fmt("warn", tag, msg, data);
    console.warn(line);
    writeToFile(line);
  },
  error(tag: string, msg: string, data?: unknown) {
    if (!shouldLog("error")) return;
    const line = fmt("error", tag, msg, data);
    console.error(line);
    writeToFile(line);
  },
};
