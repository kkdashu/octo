import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelManager } from "../src/channels/manager";
import {
  BUILTIN_GROUP_MEMORY_KEYS,
  clearGroupMemories,
  createTask,
  deleteGroupMemory,
  initDatabase,
  isBuiltinGroupMemoryKey,
  isSupportedGroupMemoryKey,
  isValidCustomGroupMemoryKey,
  listGroupMemories,
  registerGroup,
  upsertGroupMemory,
  validateGroupMemoryKey,
} from "../src/db";
import { GroupQueue } from "../src/group-queue";
import { __test__ as schedulerTestHelpers } from "../src/task-scheduler";
import { createGroupToolDefs } from "../src/tools";
import type { AgentProvider, SessionConfig } from "../src/providers/types";

const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

function createWorkspace(): { dir: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), "octo-group-memory-"));
  mkdirSync(join(dir, "store"), { recursive: true });
  mkdirSync(join(dir, "groups", "main"), { recursive: true });
  mkdirSync(join(dir, "groups", "english-group"), { recursive: true });
  mkdirSync(join(dir, "groups", "other-group"), { recursive: true });

  const db = initDatabase(join(dir, "store", "messages.db"));
  registerGroup(db, {
    jid: "oc_main",
    name: "Main Group",
    folder: "main",
    channelType: "feishu",
    requiresTrigger: false,
    isMain: true,
    agentProvider: "claude",
  });
  registerGroup(db, {
    jid: "oc_english",
    name: "English Group",
    folder: "english-group",
    channelType: "feishu",
    requiresTrigger: true,
    isMain: false,
    agentProvider: "claude",
  });
  registerGroup(db, {
    jid: "oc_other",
    name: "Other Group",
    folder: "other-group",
    channelType: "feishu",
    requiresTrigger: true,
    isMain: false,
    agentProvider: "claude",
  });

  return { dir, db };
}

function createFakeChannelManager(): ChannelManager {
  return {
    send: async () => {},
    sendImage: async () => {},
    refreshGroupMetadata: async () => [],
  } as unknown as ChannelManager;
}

function createCapturingProvider() {
  let resolveStartConfig!: (config: SessionConfig) => void;
  const started = new Promise<SessionConfig>((resolve) => {
    resolveStartConfig = resolve;
  });

  const provider: AgentProvider = {
    name: "mock",
    startSession: async (config) => {
      resolveStartConfig(config);
      return {
        session: {
          push: () => {},
          close: () => {},
        },
        events: (async function* () {
          yield { type: "result" as const, sessionId: "mock-session-1" };
        })(),
      };
    },
    clearContext: async () => ({ sessionId: "cleared-session" }),
  };

  return { provider, started };
}

const cleanupDirs: string[] = [];

afterEach(() => {
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
  }

  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("group memory data layer", () => {
  test("stores, updates, lists, deletes, and clears group memories", () => {
    const { dir, db } = createWorkspace();
    cleanupDirs.push(dir);

    expect(BUILTIN_GROUP_MEMORY_KEYS).toContain("topic_context");
    expect(isBuiltinGroupMemoryKey("topic_context")).toBe(true);
    expect(isBuiltinGroupMemoryKey("teacher_persona")).toBe(false);
    expect(isValidCustomGroupMemoryKey("teacher_persona")).toBe(true);
    expect(isValidCustomGroupMemoryKey("teacher-persona")).toBe(false);
    expect(isSupportedGroupMemoryKey("teacher_persona")).toBe(true);
    expect(isSupportedGroupMemoryKey("teacher-persona")).toBe(false);
    expect(validateGroupMemoryKey("topic_context", "builtin")).toBeNull();
    expect(validateGroupMemoryKey("teacher-persona", "custom")).toContain(
      "lowercase letters and underscores",
    );

    upsertGroupMemory(db, {
      groupFolder: "english-group",
      key: "topic_context",
      keyType: "builtin",
      value: "这个群主要用于英语学习",
      source: "tool",
    });
    upsertGroupMemory(db, {
      groupFolder: "english-group",
      key: "teacher_persona",
      keyType: "custom",
      value: "像耐心的一对一家教",
      source: "tool",
    });
    upsertGroupMemory(db, {
      groupFolder: "english-group",
      key: "topic_context",
      keyType: "builtin",
      value: "这个群专门用于英语学习",
      source: "tool",
    });

    const memories = listGroupMemories(db, "english-group");
    expect(memories).toHaveLength(2);
    expect(memories.map((memory) => `${memory.key_type}:${memory.key}`)).toEqual([
      "builtin:topic_context",
      "custom:teacher_persona",
    ]);
    expect(memories[0]?.value).toBe("这个群专门用于英语学习");

    expect(deleteGroupMemory(db, "english-group", "topic_context")).toBe(true);
    expect(deleteGroupMemory(db, "english-group", "topic_context")).toBe(false);
    expect(clearGroupMemories(db, "english-group")).toBe(1);
    expect(clearGroupMemories(db, "english-group")).toBe(0);
    expect(listGroupMemories(db, "english-group")).toEqual([]);
  });
});

describe("group memory tools", () => {
  test("enforces regular-group permissions and allows main-group cross-group management", async () => {
    const { dir, db } = createWorkspace();
    cleanupDirs.push(dir);

    const sender = {
      send: async () => {},
      sendImage: async () => {},
      refreshGroupMetadata: async () => ({ count: 0 }),
    };

    const regularTools = createGroupToolDefs("english-group", false, db, sender, dir);
    const regularRemember = regularTools.find((tool) => tool.name === "remember_group_memory");
    const regularList = regularTools.find((tool) => tool.name === "list_group_memory");

    await expect(
      regularRemember!.handler({
        targetGroupFolder: "other-group",
        key: "topic_context",
        value: "不应该成功",
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Permission denied: cannot manage memory for other groups" }],
    });

    await expect(
      regularRemember!.handler({
        keyType: "custom",
        key: "teacher-persona",
        value: "bad key",
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Invalid custom key: teacher-persona. Use lowercase letters and underscores only." }],
    });

    const ownRemember = await regularRemember!.handler({
      key: "topic_context",
      value: "这个群主要用于英语学习",
    });
    expect(ownRemember).toEqual({
      content: [{ type: "text", text: 'Saved group memory for "English Group" (english-group): topic_context = 这个群主要用于英语学习' }],
    });

    const ownList = await regularList!.handler({});
    expect(ownList.content[0]?.text).toContain("Group memory for");
    expect(ownList.content[0]?.text).toContain("topic_context");

    const mainTools = createGroupToolDefs("main", true, db, sender, dir);
    const mainRemember = mainTools.find((tool) => tool.name === "remember_group_memory");
    const mainList = mainTools.find((tool) => tool.name === "list_group_memory");
    const mainForget = mainTools.find((tool) => tool.name === "forget_group_memory");
    const mainClear = mainTools.find((tool) => tool.name === "clear_group_memory");

    await mainRemember!.handler({
      targetGroupFolder: "other-group",
      key: "response_style",
      value: "像老师一样循序渐进",
    });
    await mainRemember!.handler({
      targetGroupFolder: "other-group",
      keyType: "custom",
      key: "correction_policy",
      value: "用户发英文时优先纠错再解释",
    });

    const listed = await mainList!.handler({ targetGroupFolder: "other-group" });
    expect(listed.content[0]?.text).toContain('"Other Group" (other-group)');
    expect(listed.content[0]?.text).toContain("Builtin:");
    expect(listed.content[0]?.text).toContain("Custom:");
    expect(listed.content[0]?.text).toContain("correction_policy");

    await expect(
      mainForget!.handler({
        targetGroupFolder: "other-group",
        key: "response_style",
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: 'Deleted group memory "response_style" from "Other Group" (other-group).' }],
    });

    await expect(
      mainClear!.handler({ targetGroupFolder: "other-group" }),
    ).resolves.toEqual({
      content: [{ type: "text", text: 'Cleared 1 group memory item(s) for "Other Group" (other-group).' }],
    });
  });
});

describe("group memory prompt injection", () => {
  test("injects group memory into a fresh group session prompt", async () => {
    const { dir, db } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    upsertGroupMemory(db, {
      groupFolder: "english-group",
      key: "topic_context",
      keyType: "builtin",
      value: "这个群主要用于英语学习",
      source: "tool",
    });
    upsertGroupMemory(db, {
      groupFolder: "english-group",
      key: "correction_policy",
      keyType: "custom",
      value: "用户发英文时优先纠错再解释",
      source: "tool",
    });

    const { provider, started } = createCapturingProvider();
    const groupQueue = new GroupQueue(
      db,
      createFakeChannelManager(),
      provider,
      1,
    );

    await groupQueue.enqueue(
      "english-group",
      "[2026-03-29T08:00:00.000Z] Alice: 请给我一组今天的英语口语练习",
    );

    const sessionConfig = await started;
    expect(sessionConfig.initialPrompt).toContain("Group memory:");
    expect(sessionConfig.initialPrompt).toContain("Topic context: 这个群主要用于英语学习");
    expect(sessionConfig.initialPrompt).toContain(
      "Custom correction_policy: 用户发英文时优先纠错再解释",
    );
    expect(sessionConfig.initialPrompt).toContain("Current input:");
    expect(sessionConfig.initialPrompt).toContain("请给我一组今天的英语口语练习");
  });

  test("scheduler reuses the same session-start path so due tasks also get memory", async () => {
    const { dir, db } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    upsertGroupMemory(db, {
      groupFolder: "english-group",
      key: "study_goal",
      keyType: "builtin",
      value: "重点提升英语口语",
      source: "tool",
    });

    createTask(db, {
      groupFolder: "english-group",
      chatJid: "oc_english",
      prompt: "请发送今日英语练习",
      scheduleType: "cron",
      scheduleValue: "* * * * *",
      nextRun: "2020-01-01T00:00:00.000Z",
    });

    const { provider, started } = createCapturingProvider();
    const groupQueue = new GroupQueue(
      db,
      createFakeChannelManager(),
      provider,
      1,
    );

    schedulerTestHelpers.pollAndExecute(
      db,
      createFakeChannelManager(),
      groupQueue,
    );

    const sessionConfig = await started;
    expect(sessionConfig.initialPrompt).toContain("Group memory:");
    expect(sessionConfig.initialPrompt).toContain("Study goal: 重点提升英语口语");
    expect(sessionConfig.initialPrompt).toContain("[Scheduled Task");
    expect(sessionConfig.initialPrompt).toContain("请发送今日英语练习");
  });
});
