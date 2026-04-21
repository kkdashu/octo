import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, getRouterState, insertMessage } from "../src/db";
import { __test__ as routerTestHelpers } from "../src/router";
import { WorkspaceService } from "../src/workspace-service";

describe("router /clear command", () => {
  test("handles an exact /clear message without routing through the agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octo-router-clear-"));

    try {
      mkdirSync(join(dir, "store"), { recursive: true });
      const db = initDatabase(join(dir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir: dir });
      const workspace = workspaceService.createWorkspace({
        name: "Main Group",
        folder: "main",
        profileKey: "claude",
        isMain: true,
      });
      workspaceService.createChat(workspace.id, {
        title: "Main Group",
        requiresTrigger: false,
        externalBinding: {
          platform: "feishu",
          externalChatId: "oc_main",
        },
      });

      insertMessage(db, {
        id: "msg-1",
        chatId: "oc_main",
        sender: "u1",
        senderName: "Alice",
        content: "/clear",
        timestamp: "2026-04-10T10:00:00.000Z",
        isFromMe: false,
      });

      const sentMessages: Array<{ chatJid: string; text: string }> = [];
      let clearCount = 0;
      let enqueueCount = 0;
      let pushCount = 0;

      const channelManager = {
        send: async (chatJid: string, text: string) => {
          sentMessages.push({ chatJid, text });
        },
      };
      const groupQueue = {
        isActive: () => false,
        enqueue: async () => {
          enqueueCount += 1;
          return {
            status: "completed",
            failureNotified: false,
          };
        },
        pushMessage: () => {
          pushCount += 1;
          return false;
        },
        clearSession: async () => {
          clearCount += 1;
          return {
            closedActiveSession: false,
            previousSessionRef: "old-session",
            sessionRef: "new-session",
            generation: 1,
          };
        },
      };

      await routerTestHelpers.processMessages(
        db,
        channelManager as never,
        groupQueue as never,
      );

      expect(clearCount).toBe(1);
      expect(enqueueCount).toBe(0);
      expect(pushCount).toBe(0);
      expect(sentMessages).toEqual([
        {
          chatJid: "oc_main",
          text: routerTestHelpers.buildClearSessionSystemReply(),
        },
      ]);
      expect(getRouterState(db, "last_timestamp:oc_main")).toBe(
        "2026-04-10T10:00:00.000Z",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("routes unmentioned Feishu messages when the chat allows direct replies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octo-router-feishu-direct-"));

    try {
      mkdirSync(join(dir, "store"), { recursive: true });
      const db = initDatabase(join(dir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir: dir });
      const workspace = workspaceService.ensureFeishuWorkspace("cli_test_app", {
        profileKey: "claude",
      });
      const chat = workspaceService.ensureFeishuChat(workspace.id, "oc_direct");

      insertMessage(db, {
        id: "msg-direct",
        chatId: "oc_direct",
        sender: "u1",
        senderName: "Alice",
        content: "直接回复我",
        timestamp: "2026-04-21T10:00:00.000Z",
        isFromMe: false,
      });

      let enqueueCount = 0;
      let lastPrompt = "";
      const groupQueue = {
        isActive: () => false,
        enqueue: async (_chatId: string, prompt: string) => {
          enqueueCount += 1;
          lastPrompt = prompt;
          return {
            status: "completed",
            failureNotified: false,
          };
        },
        pushMessage: () => false,
        clearSession: async () => ({
          closedActiveSession: false,
          previousSessionRef: "old-session",
          sessionRef: "new-session",
          generation: 1,
        }),
      };

      await routerTestHelpers.processMessages(
        db,
        { send: async () => {} } as never,
        groupQueue as never,
        workspaceService,
      );

      expect(chat.requires_trigger).toBe(0);
      expect(enqueueCount).toBe(1);
      expect(lastPrompt).toContain("直接回复我");
      expect(getRouterState(db, `last_timestamp:${chat.id}`)).toBe(
        "2026-04-21T10:00:00.000Z",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not advance the cursor when enqueue fails without notifying the chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octo-router-feishu-retry-"));

    try {
      mkdirSync(join(dir, "store"), { recursive: true });
      const db = initDatabase(join(dir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir: dir });
      const workspace = workspaceService.ensureFeishuWorkspace("cli_test_app", {
        profileKey: "claude",
      });
      const chat = workspaceService.ensureFeishuChat(workspace.id, "oc_retry");

      insertMessage(db, {
        id: "msg-retry",
        chatId: "oc_retry",
        sender: "u1",
        senderName: "Alice",
        content: "重试我",
        timestamp: "2026-04-21T10:05:00.000Z",
        isFromMe: false,
      });

      let enqueueCount = 0;
      const groupQueue = {
        isActive: () => false,
        enqueue: async () => {
          enqueueCount += 1;
          return {
            status: "failed",
            failureMessage: "AI 运行失败: Connection error.",
            failureNotified: false,
          };
        },
        pushMessage: () => false,
        clearSession: async () => ({
          closedActiveSession: false,
          previousSessionRef: "old-session",
          sessionRef: "new-session",
          generation: 1,
        }),
      };

      await routerTestHelpers.processMessages(
        db,
        { send: async () => {} } as never,
        groupQueue as never,
        workspaceService,
      );

      expect(enqueueCount).toBe(1);
      expect(getRouterState(db, `last_timestamp:${chat.id}`)).toBeNull();
      expect(getRouterState(db, "last_timestamp:oc_retry")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
