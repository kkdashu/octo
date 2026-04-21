import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChannelManager, __test__ as channelManagerTestHelpers } from "../src/channels/manager";
import type { Channel } from "../src/channels/types";
import { initDatabase, registerGroup } from "../src/db";

function createTestDb(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "octo-channel-manager-"));
  const db = initDatabase(join(dir, "messages.db"));
  return { db, dir };
}

function registerTestGroup(db: Database, jid = "oc_test") {
  registerGroup(db, {
    jid,
    name: "Test Group",
    folder: "test-group",
    channelType: "feishu",
    requiresTrigger: true,
    isMain: false,
    profileKey: "claude",
  });
}

describe("ChannelManager outgoing rich message handling", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("parses custom IMAGE tags and markdown images in order", () => {
    const parts = channelManagerTestHelpers.parseOutgoingMessageParts(
      "前文\n[IMAGE:/tmp/a.png]\n中间\n![screen](/tmp/b.png)\n后文",
    );

    expect(parts).toEqual([
      { type: "text", value: "前文\n" },
      { type: "image", value: "/tmp/a.png" },
      { type: "text", value: "\n中间\n" },
      { type: "image", value: "/tmp/b.png" },
      { type: "text", value: "\n后文" },
    ]);
  });

  test("sends plain text messages without image parsing overhead", async () => {
    const { db, dir } = createTestDb();
    cleanupDirs.push(dir);
    registerTestGroup(db);

    const sentTexts: string[] = [];
    const sentImages: string[] = [];
    const manager = new ChannelManager(db);
    const channel: Channel = {
      type: "feishu",
      start: async () => {},
      stop: async () => {},
      sendMessage: async (_chatId, text) => {
        sentTexts.push(text);
      },
      sendImage: async (_chatId, filePath) => {
        sentImages.push(filePath);
      },
      listChats: async () => [],
    };
    manager.register(channel);

    await manager.send("oc_test", "普通文本");

    expect(sentTexts).toEqual(["普通文本"]);
    expect(sentImages).toEqual([]);
  });

  test("sends text and images in original order", async () => {
    const { db, dir } = createTestDb();
    cleanupDirs.push(dir);
    registerTestGroup(db);

    const sentTexts: string[] = [];
    const sentImages: string[] = [];
    const manager = new ChannelManager(db);
    const channel: Channel = {
      type: "feishu",
      start: async () => {},
      stop: async () => {},
      sendMessage: async (_chatId, text) => {
        sentTexts.push(text);
      },
      sendImage: async (_chatId, filePath) => {
        sentImages.push(filePath);
      },
      listChats: async () => [],
    };
    manager.register(channel);

    await manager.send(
      "oc_test",
      "当前画面：\n\n[IMAGE:/tmp/screen_unlock.png]\n\n需要我做什么其他操作吗？",
    );

    expect(sentTexts).toEqual([
      "当前画面：",
      "需要我做什么其他操作吗？",
    ]);
    expect(sentImages).toEqual(["/tmp/screen_unlock.png"]);
  });

  test("supports markdown image syntax", async () => {
    const { db, dir } = createTestDb();
    cleanupDirs.push(dir);
    registerTestGroup(db);

    const sentTexts: string[] = [];
    const sentImages: string[] = [];
    const manager = new ChannelManager(db);
    const channel: Channel = {
      type: "feishu",
      start: async () => {},
      stop: async () => {},
      sendMessage: async (_chatId, text) => {
        sentTexts.push(text);
      },
      sendImage: async (_chatId, filePath) => {
        sentImages.push(filePath);
      },
      listChats: async () => [],
    };
    manager.register(channel);

    await manager.send("oc_test", "截图如下：\n\n![unlock](/tmp/screen_final.png)\n\n已处理。");

    expect(sentTexts).toEqual(["截图如下：", "已处理。"]);
    expect(sentImages).toEqual(["/tmp/screen_final.png"]);
  });

  test("sends text, images, and files in original order", async () => {
    const { db, dir } = createTestDb();
    cleanupDirs.push(dir);
    registerTestGroup(db);

    const sentTexts: string[] = [];
    const sentImages: string[] = [];
    const sentFiles: string[] = [];
    const manager = new ChannelManager(db);
    const channel: Channel = {
      type: "feishu",
      start: async () => {},
      stop: async () => {},
      sendMessage: async (_chatId, text) => {
        sentTexts.push(text);
      },
      sendImage: async (_chatId, filePath) => {
        sentImages.push(filePath);
      },
      sendFile: async (_chatId, filePath) => {
        sentFiles.push(filePath);
      },
      listChats: async () => [],
    };
    manager.register(channel);

    await manager.send(
      "oc_test",
      [
        "前文",
        "![screen](/tmp/screen_final.png)",
        "[report.pdf](./artifacts/report.pdf)",
        "后文",
      ].join("\n"),
    );

    expect(sentTexts).toEqual(["前文", "后文"]);
    expect(sentImages).toEqual(["/tmp/screen_final.png"]);
    expect(sentFiles).toEqual([
      resolve("workspaces", "test-group", "artifacts/report.pdf"),
    ]);
  });

  test("falls back to raw text when channel does not support images", async () => {
    const { db, dir } = createTestDb();
    cleanupDirs.push(dir);
    registerTestGroup(db);

    const sentTexts: string[] = [];
    const manager = new ChannelManager(db);
    const channel: Channel = {
      type: "feishu",
      start: async () => {},
      stop: async () => {},
      sendMessage: async (_chatId, text) => {
        sentTexts.push(text);
      },
      listChats: async () => [],
    };
    manager.register(channel);

    const rawText = "当前画面：\n\n[IMAGE:/tmp/screen_unlock.png]\n\n继续处理";
    await manager.send("oc_test", rawText);

    expect(sentTexts).toEqual([
      "当前画面：\n\n![image](/tmp/screen_unlock.png)\n\n继续处理",
    ]);
  });

  test("falls back to raw text when channel does not support files", async () => {
    const { db, dir } = createTestDb();
    cleanupDirs.push(dir);
    registerTestGroup(db);

    const sentTexts: string[] = [];
    const manager = new ChannelManager(db);
    const channel: Channel = {
      type: "feishu",
      start: async () => {},
      stop: async () => {},
      sendMessage: async (_chatId, text) => {
        sentTexts.push(text);
      },
      sendImage: async () => {},
      listChats: async () => [],
    };
    manager.register(channel);

    const rawText = "请发送文件：\n\n[report.pdf](./artifacts/report.pdf)\n\n谢谢";
    await manager.send("oc_test", rawText);

    expect(sentTexts).toEqual([rawText]);
  });

  test("continues after image send failure and emits fallback text", async () => {
    const { db, dir } = createTestDb();
    cleanupDirs.push(dir);
    registerTestGroup(db);

    const sentTexts: string[] = [];
    const sentImages: string[] = [];
    const manager = new ChannelManager(db);
    const channel: Channel = {
      type: "feishu",
      start: async () => {},
      stop: async () => {},
      sendMessage: async (_chatId, text) => {
        sentTexts.push(text);
      },
      sendImage: async (_chatId, filePath) => {
        sentImages.push(filePath);
        throw new Error("upload failed");
      },
      listChats: async () => [],
    };
    manager.register(channel);

    await manager.send(
      "oc_test",
      "前文\n[IMAGE:/tmp/failed.png]\n后文",
    );

    expect(sentImages).toEqual(["/tmp/failed.png"]);
    expect(sentTexts).toEqual([
      "前文",
      "图片发送失败: upload failed",
      "后文",
    ]);
  });

  test("falls back to file path when image send failure has no error message", async () => {
    const { db, dir } = createTestDb();
    cleanupDirs.push(dir);
    registerTestGroup(db);

    const sentTexts: string[] = [];
    const sentImages: string[] = [];
    const manager = new ChannelManager(db);
    const channel: Channel = {
      type: "feishu",
      start: async () => {},
      stop: async () => {},
      sendMessage: async (_chatId, text) => {
        sentTexts.push(text);
      },
      sendImage: async (_chatId, filePath) => {
        sentImages.push(filePath);
        throw { code: "unknown" };
      },
      listChats: async () => [],
    };
    manager.register(channel);

    await manager.send("oc_test", "前文\n[IMAGE:/tmp/no-message.png]\n后文");

    expect(sentImages).toEqual(["/tmp/no-message.png"]);
    expect(sentTexts).toEqual([
      "前文",
      "图片发送失败: /tmp/no-message.png",
      "后文",
    ]);
  });

  test("continues after file send failure and emits fallback text", async () => {
    const { db, dir } = createTestDb();
    cleanupDirs.push(dir);
    registerTestGroup(db);

    const sentTexts: string[] = [];
    const sentFiles: string[] = [];
    const manager = new ChannelManager(db);
    const channel: Channel = {
      type: "feishu",
      start: async () => {},
      stop: async () => {},
      sendMessage: async (_chatId, text) => {
        sentTexts.push(text);
      },
      sendFile: async (_chatId, filePath) => {
        sentFiles.push(filePath);
        throw new Error("upload failed");
      },
      listChats: async () => [],
    };
    manager.register(channel);

    await manager.send(
      "oc_test",
      "前文\n[report.pdf](./artifacts/report.pdf)\n后文",
    );

    expect(sentFiles).toEqual([
      resolve("workspaces", "test-group", "artifacts/report.pdf"),
    ]);
    expect(sentTexts).toEqual([
      "前文",
      "文件发送失败: upload failed",
      "后文",
    ]);
  });
});
