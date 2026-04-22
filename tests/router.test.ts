import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getInboundDispatcherCursor,
  initDatabase,
  insertInboundMessage,
} from "../src/db";
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
      });
      workspaceService.createChat(workspace.id, {
        title: "Main Group",
        requiresTrigger: false,
        externalBinding: {
          platform: "feishu",
          externalChatId: "oc_main",
        },
      });

      insertInboundMessage(db, {
        id: "msg-1",
        platform: "feishu",
        workspaceId: workspace.id,
        chatId: workspaceService.listChats(workspace.id)[0]!.id,
        externalMessageId: "msg-1",
        externalChatId: "oc_main",
        senderId: "u1",
        senderName: "Alice",
        contentText: "/clear",
        rawPayload: "{\"text\":\"/clear\"}",
        messageTimestamp: "2026-04-10T10:00:00.000Z",
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
        executeTurnRequest: async () => ({
          status: "completed",
          failureNotified: false,
        }),
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
      expect(getInboundDispatcherCursor(db, "default_inbound_dispatcher", workspaceService.listChats(workspace.id)[0]!.id)?.last_message_timestamp).toBe(
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

      insertInboundMessage(db, {
        id: "msg-direct",
        platform: "feishu",
        workspaceId: workspace.id,
        chatId: chat.id,
        externalMessageId: "msg-direct",
        externalChatId: "oc_direct",
        senderId: "u1",
        senderName: "Alice",
        contentText: "直接回复我",
        rawPayload: "{\"text\":\"直接回复我\"}",
        messageTimestamp: "2026-04-21T10:00:00.000Z",
      });

      let executeCount = 0;
      let lastTurnRequestId = "";
      let lastPrompt = "";
      const groupQueue = {
        isActive: () => false,
        enqueue: async () => ({
          status: "completed",
          failureNotified: false,
        }),
        executeTurnRequest: async (turnRequestId: string) => {
          executeCount += 1;
          lastTurnRequestId = turnRequestId;
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
      expect(executeCount).toBe(1);
      const createdTurnRequest = db
        .query("SELECT request_text FROM turn_requests WHERE id = $id")
        .get({ id: lastTurnRequestId }) as { request_text: string } | null;
      lastPrompt = createdTurnRequest?.request_text ?? "";
      expect(lastPrompt).toContain("直接回复我");
      expect(getInboundDispatcherCursor(db, "default_inbound_dispatcher", chat.id)?.last_message_timestamp).toBe(
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

      insertInboundMessage(db, {
        id: "msg-retry",
        platform: "feishu",
        workspaceId: workspace.id,
        chatId: chat.id,
        externalMessageId: "msg-retry",
        externalChatId: "oc_retry",
        senderId: "u1",
        senderName: "Alice",
        contentText: "重试我",
        rawPayload: "{\"text\":\"重试我\"}",
        messageTimestamp: "2026-04-21T10:05:00.000Z",
      });

      let executeCount = 0;
      const groupQueue = {
        isActive: () => false,
        enqueue: async () => ({
          status: "failed",
          failureMessage: "AI 运行失败: Connection error.",
          failureNotified: false,
        }),
        executeTurnRequest: async () => {
          executeCount += 1;
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

      expect(executeCount).toBe(1);
      expect(getInboundDispatcherCursor(db, "default_inbound_dispatcher", chat.id)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
