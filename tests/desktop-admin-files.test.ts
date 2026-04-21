import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceDirectory,
  DesktopAdminFileError,
  listWorkspaceDirectory,
  readWorkspaceTextFile,
  resolveWorkspacePath,
  writeWorkspaceTextFile,
} from "../src/desktop/admin-files";

function createRootDir() {
  const dir = join(tmpdir(), `octo-desktop-admin-files-${crypto.randomUUID()}`);
  mkdirSync(join(dir, "workspaces", "test-workspace"), { recursive: true });
  return dir;
}

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("desktop admin workspace file helpers", () => {
  test("lists and reads files inside the workspace root", () => {
    const rootDir = createRootDir();
    cleanupDirs.push(rootDir);
    writeFileSync(join(rootDir, "workspaces", "test-workspace", "AGENTS.md"), "# Hello\n", "utf-8");

    const listing = listWorkspaceDirectory("test-workspace", ".", rootDir);
    const file = readWorkspaceTextFile("test-workspace", "AGENTS.md", rootDir);

    expect(listing.path).toBe(".");
    expect(listing.entries).toEqual([
      { kind: "file", name: "AGENTS.md", path: "AGENTS.md", size: 8 },
    ]);
    expect(file.content).toBe("# Hello\n");
  });

  test("rejects directory traversal outside workspace root", () => {
    const rootDir = createRootDir();
    cleanupDirs.push(rootDir);

    expect(() => resolveWorkspacePath("test-workspace", "../outside.txt", rootDir)).toThrow(
      DesktopAdminFileError,
    );
  });

  test("rejects reading a directory as a file", () => {
    const rootDir = createRootDir();
    cleanupDirs.push(rootDir);
    mkdirSync(join(rootDir, "workspaces", "test-workspace", "nested"), { recursive: true });

    expect(() => readWorkspaceTextFile("test-workspace", "nested", rootDir)).toThrow(
      DesktopAdminFileError,
    );
  });

  test("writes files only inside the workspace root", () => {
    const rootDir = createRootDir();
    cleanupDirs.push(rootDir);
    writeWorkspaceTextFile("test-workspace", "notes/todo.md", "line 1", {
      createParents: true,
      rootDir,
    });

    const file = readWorkspaceTextFile("test-workspace", "notes/todo.md", rootDir);
    expect(file.content).toBe("line 1");

    expect(() => writeWorkspaceTextFile("test-workspace", "../hack.txt", "bad", {
      createParents: true,
      rootDir,
    })).toThrow(DesktopAdminFileError);
  });

  test("creates directories and rejects non-utf8 files", () => {
    const rootDir = createRootDir();
    cleanupDirs.push(rootDir);

    const created = createWorkspaceDirectory("test-workspace", "docs/specs", rootDir);
    expect(created.path).toBe("docs/specs");

    writeFileSync(
      join(rootDir, "workspaces", "test-workspace", "binary.bin"),
      Buffer.from([0xff, 0xfe, 0xfd]),
    );

    expect(() => readWorkspaceTextFile("test-workspace", "binary.bin", rootDir)).toThrow(
      DesktopAdminFileError,
    );
  });
});
