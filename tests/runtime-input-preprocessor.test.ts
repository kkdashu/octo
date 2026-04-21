import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../src/db";
import type { ImageMessagePreprocessor } from "../src/runtime/image-message-preprocessor";
import { createRuntimeInputPreprocessor } from "../src/runtime/runtime-input-preprocessor";
import { WorkspaceService } from "../src/workspace-service";

describe("runtime input preprocessor", () => {
  test("uses the chat workspace directory when normalizing local file links", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-runtime-input-preprocessor-"));

    try {
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const workspace = workspaceService.createWorkspace({
        name: "Main",
        folder: "main",
        profileKey: "claude",
        isMain: true,
      });
      const chat = workspaceService.createChat(workspace.id, {
        title: "Main",
        requiresTrigger: false,
      });
      mkdirSync(join(rootDir, "workspaces", "main", "docs"), { recursive: true });

      const calls: Array<{ text: string; rootDir: string }> = [];
      const imageMessagePreprocessor: ImageMessagePreprocessor = {
        preprocess: async (text: string, nextRootDir: string) => {
          calls.push({ text, rootDir: nextRootDir });
          return "请阅读 [guide.md](docs/guide.md)";
        },
      };

      const preprocessor = createRuntimeInputPreprocessor({
        db,
        rootDir,
        workspaceService,
        imageMessagePreprocessor,
      });

      const normalized = await preprocessor.prepare(chat.id, "原始输入");

      expect(calls).toEqual([{ text: "原始输入", rootDir }]);
      expect(normalized).toBe(
        "请阅读 [guide.md](docs/guide.md)\n可读路径: ./docs/guide.md",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
