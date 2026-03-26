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
  AdminDirectoryEntryDto,
  AdminDirectoryListingDto,
  AdminFileContentDto,
} from "./types";

export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

type GroupFileErrorCode =
  | "invalid_path"
  | "not_found"
  | "not_file"
  | "not_directory"
  | "already_exists"
  | "not_text"
  | "file_too_large";

export class GroupFileError extends Error {
  code: GroupFileErrorCode;
  status: number;

  constructor(code: GroupFileErrorCode, message: string, status: number) {
    super(message);
    this.name = "GroupFileError";
    this.code = code;
    this.status = status;
  }
}

function sanitizeInputPath(targetPath: string): string {
  const normalized = targetPath.replaceAll("\\", "/").trim();
  return normalized || ".";
}

function toDisplayPath(groupRoot: string, absolutePath: string): string {
  const rel = relative(groupRoot, absolutePath).replaceAll("\\", "/");
  return rel === "" ? "." : rel;
}

export function getGroupRoot(
  groupFolder: string,
  rootDir = process.cwd(),
): string {
  return resolve(rootDir, "groups", groupFolder);
}

export function resolveGroupPath(
  groupFolder: string,
  targetPath = ".",
  rootDir = process.cwd(),
): string {
  const groupRoot = getGroupRoot(groupFolder, rootDir);
  const absolutePath = resolve(groupRoot, sanitizeInputPath(targetPath));
  const rel = relative(groupRoot, absolutePath);

  if (rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..${"\\"}`)) {
    throw new GroupFileError("invalid_path", "Path escapes group root", 400);
  }

  return absolutePath;
}

function joinRelativePath(basePath: string, name: string): string {
  return basePath === "." ? name : `${basePath}/${name}`;
}

export function listGroupDirectory(
  groupFolder: string,
  targetPath = ".",
  rootDir = process.cwd(),
): AdminDirectoryListingDto {
  const groupRoot = getGroupRoot(groupFolder, rootDir);
  const absolutePath = resolveGroupPath(groupFolder, targetPath, rootDir);

  if (!existsSync(absolutePath)) {
    throw new GroupFileError("not_found", `Path not found: ${targetPath}`, 404);
  }

  const stats = statSync(absolutePath);
  if (!stats.isDirectory()) {
    throw new GroupFileError("not_directory", `Path is not a directory: ${targetPath}`, 400);
  }

  const displayPath = toDisplayPath(groupRoot, absolutePath);
  const entries = readdirSync(absolutePath, { withFileTypes: true })
    .map((entry): AdminDirectoryEntryDto => {
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

export function readGroupTextFile(
  groupFolder: string,
  targetPath: string,
  rootDir = process.cwd(),
): AdminFileContentDto {
  const groupRoot = getGroupRoot(groupFolder, rootDir);
  const absolutePath = resolveGroupPath(groupFolder, targetPath, rootDir);

  if (!existsSync(absolutePath)) {
    throw new GroupFileError("not_found", `File not found: ${targetPath}`, 404);
  }

  const stats = statSync(absolutePath);
  if (!stats.isFile()) {
    throw new GroupFileError("not_file", `Path is not a file: ${targetPath}`, 400);
  }

  if (stats.size > MAX_TEXT_FILE_BYTES) {
    throw new GroupFileError(
      "file_too_large",
      `File is too large to open in admin UI: ${targetPath}`,
      413,
    );
  }

  const buffer = readFileSync(absolutePath);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new GroupFileError("not_text", `File is not valid UTF-8 text: ${targetPath}`, 415);
  }

  return {
    path: toDisplayPath(groupRoot, absolutePath),
    content,
    size: stats.size,
  };
}

export function writeGroupTextFile(
  groupFolder: string,
  targetPath: string,
  content: string,
  options?: {
    createParents?: boolean;
    overwrite?: boolean;
    rootDir?: string;
  },
): AdminFileContentDto {
  const rootDir = options?.rootDir ?? process.cwd();
  const absolutePath = resolveGroupPath(groupFolder, targetPath, rootDir);
  const exists = existsSync(absolutePath);

  if (exists && !options?.overwrite) {
    throw new GroupFileError("already_exists", `File already exists: ${targetPath}`, 409);
  }

  if (exists && !statSync(absolutePath).isFile()) {
    throw new GroupFileError("not_file", `Path is not a file: ${targetPath}`, 400);
  }

  if (!exists && options?.createParents) {
    mkdirSync(dirname(absolutePath), { recursive: true });
  }

  if (!exists && !existsSync(dirname(absolutePath))) {
    throw new GroupFileError("not_found", `Parent directory not found: ${targetPath}`, 404);
  }

  writeFileSync(absolutePath, content, "utf-8");
  return readGroupTextFile(groupFolder, targetPath, rootDir);
}

export function createGroupDirectory(
  groupFolder: string,
  targetPath: string,
  rootDir = process.cwd(),
): AdminDirectoryListingDto {
  const absolutePath = resolveGroupPath(groupFolder, targetPath, rootDir);
  if (existsSync(absolutePath)) {
    throw new GroupFileError("already_exists", `Path already exists: ${targetPath}`, 409);
  }

  mkdirSync(absolutePath, { recursive: true });
  return listGroupDirectory(groupFolder, targetPath, rootDir);
}
