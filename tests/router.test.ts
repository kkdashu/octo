import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, getRouterState, insertMessage, registerGroup } from "../src/db";
import { __test__ as routerTestHelpers } from "../src/router";

describe("router /clear command", () => {
  test("handles an exact /clear message without routing through the agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octo-router-clear-"));

    try {
      mkdirSync(join(dir, "store"), { recursive: true });
      const db = initDatabase(join(dir, "store", "messages.db"));
      registerGroup(db, {
        jid: "oc_main",
        name: "Main Group",
        folder: "main",
        channelType: "feishu",
        requiresTrigger: false,
        isMain: true,
        profileKey: "claude",
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
        enqueue: () => {
          enqueueCount += 1;
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

      routerTestHelpers.processMessages(
        db,
        channelManager as never,
        groupQueue as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

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
});
