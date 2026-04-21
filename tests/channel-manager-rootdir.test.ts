import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ChannelManager } from "../src/channels/manager";
import type { Channel } from "../src/channels/types";
import {
  createChat,
  createWorkspace,
  initDatabase,
  upsertChatBinding,
} from "../src/db";

function bindTestChat(
  db: Database,
  jid = "oc_test",
  folder = "test-workspace",
) {
  const workspace = createWorkspace(db, {
    name: "Test Workspace",
    folder,
    defaultBranch: "main",
    profileKey: "claude",
    isMain: false,
  });
  const chat = createChat(db, {
    workspaceId: workspace.id,
    title: "Test Chat",
    activeBranch: "main",
    requiresTrigger: false,
    sessionRef: null,
  });
  upsertChatBinding(db, {
    chatId: chat.id,
    platform: "feishu",
    externalChatId: jid,
  });
}

describe("ChannelManager rootDir support", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("resolves workspace-relative file paths against the configured rootDir", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-channel-manager-rootdir-"));
    cleanupDirs.push(rootDir);
    const db = initDatabase(join(rootDir, "messages.db"));
    bindTestChat(db);

    const sentFiles: string[] = [];
    const manager = new ChannelManager(db, { rootDir });
    const channel: Channel = {
      type: "feishu",
      start: async () => {},
      stop: async () => {},
      sendMessage: async () => {},
      sendFile: async (_chatId, filePath) => {
        sentFiles.push(filePath);
      },
      listChats: async () => [],
    };
    manager.register(channel);

    await manager.send("oc_test", "[report.pdf](./artifacts/report.pdf)");

    expect(sentFiles).toEqual([
      join(rootDir, "workspaces", "test-workspace", "artifacts", "report.pdf"),
    ]);
  });
});
