import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type ModelLogRouteType = "anthropic_direct" | "openai_proxy";

export type ModelLogStage =
  | "sdk_request"
  | "upstream_request"
  | "upstream_response"
  | "upstream_stream_chunk"
  | "proxy_response"
  | "error";

export interface ModelInteractionLogEntry {
  ts?: string;
  requestId: string;
  routeType: ModelLogRouteType;
  stage: ModelLogStage;
  profileKey: string;
  provider?: string;
  model?: string;
  workspaceFolder: string;
  url: string;
  method: string;
  status?: number;
  stream: boolean;
  headers?: Record<string, unknown>;
  body?: unknown;
  meta?: Record<string, unknown>;
}

export const MAX_MODEL_LOG_BYTES = 80 * 1024 * 1024;

const DEFAULT_LOG_DIR = "store/logs";
const MODEL_LOG_DIR = "model";
const UNKNOWN_WORKSPACE_FOLDER = "_unknown";

function getLogDir(): string {
  return process.env.LOG_DIR ?? DEFAULT_LOG_DIR;
}

function normalizeWorkspaceFolder(workspaceFolder: string): string {
  const trimmed = workspaceFolder.trim();
  if (!trimmed) {
    return UNKNOWN_WORKSPACE_FOLDER;
  }

  return trimmed.replace(/[\\/]/g, "_");
}

function getDatePart(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function getBaseFileName(now: Date): string {
  return `octo-model-${getDatePart(now)}`;
}

function getFileSize(filePath: string): number {
  if (!existsSync(filePath)) {
    return 0;
  }

  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function ensureModelLogDir(workspaceFolder: string): string {
  const workspaceDir = join(getLogDir(), MODEL_LOG_DIR, normalizeWorkspaceFolder(workspaceFolder));
  mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}

function isSensitiveHeaderName(headerName: string): boolean {
  const normalized = headerName.trim().toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "x-api-key" ||
    normalized === "anthropic-api-key" ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("api-key") ||
    normalized.includes("api_key")
  );
}

function maskSecretValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  const bearerPrefix = /^Bearer\s+/i.exec(trimmed)?.[0] ?? "";
  const rawValue = bearerPrefix ? trimmed.slice(bearerPrefix.length).trim() : trimmed;

  if (!rawValue) {
    return trimmed;
  }

  const start = rawValue.slice(0, Math.min(6, rawValue.length));
  const end = rawValue.length > 4 ? rawValue.slice(-4) : "";
  const masked = end ? `${start}***${end}` : `${start}***`;

  return bearerPrefix ? `${bearerPrefix}${masked}` : masked;
}

function normalizeSerializableValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (value instanceof Headers) {
    return Object.fromEntries(value.entries());
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf-8");
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeSerializableValue(item, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = normalizeSerializableValue(item, seen);
    }
    seen.delete(value);
    return result;
  }

  return String(value);
}

export function toSerializableBody(value: unknown): unknown {
  return normalizeSerializableValue(value);
}

export function redactHeaders(headers: unknown): Record<string, unknown> {
  const normalized = normalizeSerializableValue(headers);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (isSensitiveHeaderName(key)) {
      if (Array.isArray(value)) {
        result[key] = value.map((item) => maskSecretValue(String(item)));
      } else {
        result[key] = maskSecretValue(String(value ?? ""));
      }
      continue;
    }

    result[key] = value;
  }

  return result;
}

export function resolveModelLogFilePath(
  workspaceFolder: string,
  line: string,
  now: Date = new Date(),
): string {
  const workspaceDir = ensureModelLogDir(workspaceFolder);
  const baseName = getBaseFileName(now);
  const lineBytes = Buffer.byteLength(line + "\n");

  for (let index = 0; ; index += 1) {
    const suffix = index === 0 ? "" : `.${index}`;
    const filePath = join(workspaceDir, `${baseName}${suffix}.jsonl`);
    const nextSize = getFileSize(filePath) + lineBytes;
    if (nextSize <= MAX_MODEL_LOG_BYTES) {
      return filePath;
    }
  }
}

export function serializeModelLogEntry(
  entry: ModelInteractionLogEntry,
  now: Date = new Date(),
): string {
  const normalized: ModelInteractionLogEntry = {
    ...entry,
    ts: entry.ts ?? now.toISOString(),
    workspaceFolder: entry.workspaceFolder || UNKNOWN_WORKSPACE_FOLDER,
    headers: entry.headers ? redactHeaders(entry.headers) : undefined,
    body: entry.body === undefined ? undefined : toSerializableBody(entry.body),
    meta: entry.meta === undefined ? undefined : toSerializableBody(entry.meta) as Record<string, unknown>,
  };

  return JSON.stringify(normalized);
}

export function writeModelLog(
  entry: ModelInteractionLogEntry,
  now: Date = new Date(),
): void {
  try {
    const line = serializeModelLogEntry(entry, now);
    const filePath = resolveModelLogFilePath(entry.workspaceFolder, line, now);
    appendFileSync(filePath, line + "\n");
  } catch {
    // Ignore model log write failures to avoid breaking the request path.
  }
}

export const __test__ = {
  getDatePart,
  normalizeWorkspaceFolder,
};
