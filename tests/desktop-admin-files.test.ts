import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGroupDirectory,
  DesktopAdminFileError,
  listGroupDirectory,
  readGroupTextFile,
  resolveGroupPath,
  writeGroupTextFile,
} from "../src/desktop/admin-files";

function createWorkspace() {
  const dir = join(tmpdir(), `octo-desktop-admin-files-${crypto.randomUUID()}`);
  mkdirSync(join(dir, "groups", "test-group"), { recursive: true });
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

describe("desktop admin group file helpers", () => {
  test("lists and reads files inside the group root", () => {
    const rootDir = createWorkspace();
    cleanupDirs.push(rootDir);
    writeFileSync(join(rootDir, "groups", "test-group", "AGENTS.md"), "# Hello\n", "utf-8");

    const listing = listGroupDirectory("test-group", ".", rootDir);
    const file = readGroupTextFile("test-group", "AGENTS.md", rootDir);

    expect(listing.path).toBe(".");
    expect(listing.entries).toEqual([
      { kind: "file", name: "AGENTS.md", path: "AGENTS.md", size: 8 },
    ]);
    expect(file.content).toBe("# Hello\n");
  });

  test("rejects directory traversal outside group root", () => {
    const rootDir = createWorkspace();
    cleanupDirs.push(rootDir);

    expect(() => resolveGroupPath("test-group", "../outside.txt", rootDir)).toThrow(DesktopAdminFileError);
  });

  test("rejects reading a directory as a file", () => {
    const rootDir = createWorkspace();
    cleanupDirs.push(rootDir);
    mkdirSync(join(rootDir, "groups", "test-group", "nested"), { recursive: true });

    expect(() => readGroupTextFile("test-group", "nested", rootDir)).toThrow(DesktopAdminFileError);
  });

  test("writes files only inside the group root", () => {
    const rootDir = createWorkspace();
    cleanupDirs.push(rootDir);
    writeGroupTextFile("test-group", "notes/todo.md", "line 1", {
      createParents: true,
      rootDir,
    });

    const file = readGroupTextFile("test-group", "notes/todo.md", rootDir);
    expect(file.content).toBe("line 1");

    expect(() => writeGroupTextFile("test-group", "../hack.txt", "bad", {
      createParents: true,
      rootDir,
    })).toThrow(DesktopAdminFileError);
  });

  test("creates directories and rejects non-utf8 files", () => {
    const rootDir = createWorkspace();
    cleanupDirs.push(rootDir);

    const created = createGroupDirectory("test-group", "docs/specs", rootDir);
    expect(created.path).toBe("docs/specs");

    writeFileSync(
      join(rootDir, "groups", "test-group", "binary.bin"),
      Buffer.from([0xff, 0xfe, 0xfd]),
    );

    expect(() => readGroupTextFile("test-group", "binary.bin", rootDir)).toThrow(DesktopAdminFileError);
  });
});
