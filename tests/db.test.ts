import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager } from "../src/channels/manager";
import type { Channel } from "../src/channels/types";
import { getUnprocessedMessages, initDatabase, insertMessage, registerGroup } from "../src/db";

const tempDirs: string[] = [];

function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "octo-db-test-"));
  tempDirs.push(dir);
  return join(dir, "messages.db");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("message role migration", () => {
  test("backfills assistant role for legacy bot-authored rows", () => {
    const dbPath = makeTempDbPath();
    const legacyDb = new Database(dbPath, { create: true, strict: true });

    legacyDb.run(`
      CREATE TABLE messages (
        id TEXT,
        chat_jid TEXT,
        sender TEXT,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        is_bot_message INTEGER DEFAULT 0,
        mentions_me INTEGER DEFAULT 0,
        PRIMARY KEY (id, chat_jid)
      )
    `);
    legacyDb.run(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, mentions_me)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "legacy-1",
        "oc_legacy",
        "assistant:feishu",
        "Octo",
        "legacy assistant reply",
        "2026-03-24T10:00:00.000Z",
        1,
        1,
        0,
      ],
    );
    legacyDb.close();

    const migratedDb = initDatabase(dbPath);
    const rows = migratedDb
      .query("SELECT role, content FROM messages WHERE id = 'legacy-1'")
      .all() as Array<{ role: string; content: string }>;

    expect(rows).toEqual([
      {
        role: "assistant",
        content: "legacy assistant reply",
      },
    ]);
  });
});

describe("message role filtering", () => {
  test("getUnprocessedMessages only returns user messages", () => {
    const db = initDatabase(makeTempDbPath());

    insertMessage(db, {
      id: "assistant-1",
      chatId: "oc_chat",
      sender: "assistant:feishu",
      senderName: "Octo",
      content: "hello from octo",
      timestamp: "2026-03-24T10:00:00.000Z",
      role: "assistant",
      isFromMe: true,
      isBotMessage: true,
      mentionsMe: false,
    });
    insertMessage(db, {
      id: "user-1",
      chatId: "oc_chat",
      sender: "ou_123",
      senderName: "Alice",
      content: "hello from user",
      timestamp: "2026-03-24T10:01:00.000Z",
      role: "user",
      isFromMe: false,
      isBotMessage: false,
      mentionsMe: false,
    });

    const messages = getUnprocessedMessages(db, "oc_chat", "1970-01-01T00:00:00.000Z");
    expect(messages.map((message) => ({ id: message.id, role: message.role, content: message.content }))).toEqual([
      {
        id: "user-1",
        role: "user",
        content: "hello from user",
      },
    ]);
  });

  test("ChannelManager.send records outbound assistant messages with role", async () => {
    const db = initDatabase(makeTempDbPath());
    registerGroup(db, {
      jid: "oc_chat",
      name: "Test Group",
      folder: "test-group",
      channelType: "feishu",
      requiresTrigger: false,
      isMain: false,
    });

    const sent: Array<{ chatId: string; text: string }> = [];
    const channel: Channel = {
      type: "feishu",
      start: async () => {},
      stop: async () => {},
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      listChats: async () => [],
    };

    const manager = new ChannelManager(db);
    manager.register(channel);

    await manager.send("oc_chat", "assistant reply");

    expect(sent).toEqual([{ chatId: "oc_chat", text: "assistant reply" }]);

    const rows = db
      .query(`
        SELECT role, sender, sender_name, content, is_from_me, is_bot_message
        FROM messages
        WHERE chat_jid = 'oc_chat'
      `)
      .all() as Array<{
      role: string;
      sender: string;
      sender_name: string;
      content: string;
      is_from_me: number;
      is_bot_message: number;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "assistant",
      sender: "assistant:feishu",
      sender_name: "Octo",
      content: "assistant reply",
      is_from_me: 1,
      is_bot_message: 1,
    });

    expect(getUnprocessedMessages(db, "oc_chat", "1970-01-01T00:00:00.000Z")).toEqual([]);
  });
});
