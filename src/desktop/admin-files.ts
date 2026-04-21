import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type {
  DesktopAdminDirectoryEntryDto,
  DesktopAdminDirectoryListingDto,
  DesktopAdminFileContentDto,
} from "./admin-types";
import { getWorkspaceDirectory } from "../group-workspace";

export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

type WorkspaceFileErrorCode =
  | "invalid_path"
  | "not_found"
  | "not_file"
  | "not_directory"
  | "already_exists"
  | "not_text"
  | "file_too_large";

export class DesktopAdminFileError extends Error {
  code: WorkspaceFileErrorCode;
  status: number;

  constructor(code: WorkspaceFileErrorCode, message: string, status: number) {
    super(message);
    this.name = "DesktopAdminFileError";
    this.code = code;
    this.status = status;
  }
}

function sanitizeInputPath(targetPath: string): string {
  const normalized = targetPath.replaceAll("\\", "/").trim();
  return normalized || ".";
}

function toDisplayPath(workspaceRoot: string, absolutePath: string): string {
  const rel = relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
  return rel === "" ? "." : rel;
}

export function getWorkspaceRoot(
  workspaceFolder: string,
  rootDir = process.cwd(),
): string {
  return getWorkspaceDirectory(workspaceFolder, { rootDir });
}

export function resolveWorkspacePath(
  workspaceFolder: string,
  targetPath = ".",
  rootDir = process.cwd(),
): string {
  const workspaceRoot = getWorkspaceRoot(workspaceFolder, rootDir);
  const absolutePath = resolve(workspaceRoot, sanitizeInputPath(targetPath));
  const rel = relative(workspaceRoot, absolutePath);

  if (rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..${"\\"}`)) {
    throw new DesktopAdminFileError("invalid_path", "Path escapes workspace root", 400);
  }

  return absolutePath;
}

function joinRelativePath(basePath: string, name: string): string {
  return basePath === "." ? name : `${basePath}/${name}`;
}

export function listWorkspaceDirectory(
  workspaceFolder: string,
  targetPath = ".",
  rootDir = process.cwd(),
): DesktopAdminDirectoryListingDto {
  const workspaceRoot = getWorkspaceRoot(workspaceFolder, rootDir);
  const absolutePath = resolveWorkspacePath(workspaceFolder, targetPath, rootDir);

  if (!existsSync(absolutePath)) {
    throw new DesktopAdminFileError("not_found", `Path not found: ${targetPath}`, 404);
  }

  const stats = statSync(absolutePath);
  if (!stats.isDirectory()) {
    throw new DesktopAdminFileError("not_directory", `Path is not a directory: ${targetPath}`, 400);
  }

  const displayPath = toDisplayPath(workspaceRoot, absolutePath);
  const entries = readdirSync(absolutePath, { withFileTypes: true })
    .map((entry): DesktopAdminDirectoryEntryDto => {
      const childAbsolutePath = resolve(absolutePath, entry.name);
      const childDisplayPath = joinRelativePath(displayPath, entry.name);
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: childDisplayPath,
          kind: "directory",
        };
      }

      const childStats = statSync(childAbsolutePath);
      return {
        name: entry.name,
        path: childDisplayPath,
        kind: "file",
        size: childStats.size,
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });

  return {
    path: displayPath,
    entries,
  };
}

export function readWorkspaceTextFile(
  workspaceFolder: string,
  targetPath: string,
  rootDir = process.cwd(),
): DesktopAdminFileContentDto {
  const workspaceRoot = getWorkspaceRoot(workspaceFolder, rootDir);
  const absolutePath = resolveWorkspacePath(workspaceFolder, targetPath, rootDir);

  if (!existsSync(absolutePath)) {
    throw new DesktopAdminFileError("not_found", `File not found: ${targetPath}`, 404);
  }

  const stats = statSync(absolutePath);
  if (!stats.isFile()) {
    throw new DesktopAdminFileError("not_file", `Path is not a file: ${targetPath}`, 400);
  }

  if (stats.size > MAX_TEXT_FILE_BYTES) {
    throw new DesktopAdminFileError(
      "file_too_large",
      `File is too large to open in desktop admin: ${targetPath}`,
      413,
    );
  }

  const buffer = readFileSync(absolutePath);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new DesktopAdminFileError("not_text", `File is not valid UTF-8 text: ${targetPath}`, 415);
  }

  return {
    path: toDisplayPath(workspaceRoot, absolutePath),
    content,
    size: stats.size,
  };
}

export function writeWorkspaceTextFile(
  workspaceFolder: string,
  targetPath: string,
  content: string,
  options?: {
    createParents?: boolean;
    overwrite?: boolean;
    rootDir?: string;
  },
): DesktopAdminFileContentDto {
  const rootDir = options?.rootDir ?? process.cwd();
  const absolutePath = resolveWorkspacePath(workspaceFolder, targetPath, rootDir);
  const exists = existsSync(absolutePath);

  if (exists && !options?.overwrite) {
    throw new DesktopAdminFileError("already_exists", `File already exists: ${targetPath}`, 409);
  }

  if (exists && !statSync(absolutePath).isFile()) {
    throw new DesktopAdminFileError("not_file", `Path is not a file: ${targetPath}`, 400);
  }

  if (!exists && options?.createParents) {
    mkdirSync(dirname(absolutePath), { recursive: true });
  }

  if (!exists && !existsSync(dirname(absolutePath))) {
    throw new DesktopAdminFileError("not_found", `Parent directory not found: ${targetPath}`, 404);
  }

  writeFileSync(absolutePath, content, "utf-8");
  return readWorkspaceTextFile(workspaceFolder, targetPath, rootDir);
}

export function createWorkspaceDirectory(
  workspaceFolder: string,
  targetPath: string,
  rootDir = process.cwd(),
): DesktopAdminDirectoryListingDto {
  const absolutePath = resolveWorkspacePath(workspaceFolder, targetPath, rootDir);
  if (existsSync(absolutePath)) {
    throw new DesktopAdminFileError("already_exists", `Path already exists: ${targetPath}`, 409);
  }

  mkdirSync(absolutePath, { recursive: true });
  return listWorkspaceDirectory(workspaceFolder, targetPath, rootDir);
}
