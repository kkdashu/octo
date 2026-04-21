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
import { WorkspaceService } from "../src/workspace-service";
import type {
  AgentRuntime,
  ConversationMessageInput,
  OpenConversationInput,
} from "../src/providers/types";

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
    profileKey: "claude",
  });
  registerGroup(db, {
    jid: "oc_english",
    name: "English Group",
    folder: "english-group",
    channelType: "feishu",
    requiresTrigger: true,
    isMain: false,
    profileKey: "claude",
  });
  registerGroup(db, {
    jid: "oc_other",
    name: "Other Group",
    folder: "other-group",
    channelType: "feishu",
    requiresTrigger: true,
    isMain: false,
    profileKey: "claude",
  });

  return { dir, db };
}

function updateChatSessionRef(
  db: Database,
  rootDir: string,
  folder: string,
  sessionRef: string | null,
): void {
  const workspaceService = new WorkspaceService(db, { rootDir });
  const workspace = workspaceService.getWorkspaceByFolder(folder);
  if (!workspace) {
    throw new Error(`Workspace missing for ${folder}`);
  }
  const chat = workspaceService.listChats(workspace.id)[0];
  if (!chat) {
    throw new Error(`Chat missing for ${folder}`);
  }
  workspaceService.updateChat(chat.id, { sessionRef });
}

function getChatSessionRef(
  db: Database,
  rootDir: string,
  folder: string,
): string | null {
  const workspaceService = new WorkspaceService(db, { rootDir });
  const workspace = workspaceService.getWorkspaceByFolder(folder);
  if (!workspace) {
    throw new Error(`Workspace missing for ${folder}`);
  }
  return workspaceService.listChats(workspace.id)[0]?.session_ref ?? null;
}

function clearAllChatSessionRefs(db: Database, rootDir: string): number {
  const workspaceService = new WorkspaceService(db, { rootDir });
  let count = 0;
  for (const workspace of workspaceService.listWorkspaces()) {
    for (const chat of workspaceService.listChats(workspace.id)) {
      if (chat.session_ref) {
        count += 1;
        workspaceService.updateChat(chat.id, { sessionRef: null });
      }
    }
  }
  return count;
}

function createFakeChannelManager(): ChannelManager {
  return {
    send: async () => {},
    sendImage: async () => {},
    refreshGroupMetadata: async () => [],
  } as unknown as ChannelManager;
}

function createCapturingRuntime() {
  let resolveOpenConfig!: (config: OpenConversationInput) => void;
  const opened = new Promise<OpenConversationInput>((resolve) => {
    resolveOpenConfig = resolve;
  });

  let resolveFirstSend!: (input: ConversationMessageInput) => void;
  const firstSend = new Promise<ConversationMessageInput>((resolve) => {
    resolveFirstSend = resolve;
  });

  let firstSendResolved = false;
  let releaseCompletion!: () => void;
  const completionReady = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });

  const runtime: AgentRuntime = {
    name: "mock",
    openConversation: async (config) => {
      resolveOpenConfig(config);
      return {
        conversation: {
          send: async (input) => {
            if (!firstSendResolved) {
              firstSendResolved = true;
              resolveFirstSend(input);
              releaseCompletion();
            }
          },
          close: () => {},
        },
        events: (async function* () {
          await completionReady;
          yield { type: "completed" as const, sessionRef: "mock-session-1" };
        })(),
      };
    },
    resetSession: async () => ({ sessionRef: "cleared-session" }),
  };

  return { runtime, opened, firstSend };
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
    expect(BUILTIN_GROUP_MEMORY_KEYS).not.toContain("study_goal");
    expect(BUILTIN_GROUP_MEMORY_KEYS).not.toContain("difficulty_level");
    expect(isBuiltinGroupMemoryKey("topic_context")).toBe(true);
    expect(isBuiltinGroupMemoryKey("study_goal")).toBe(false);
    expect(isBuiltinGroupMemoryKey("teacher_persona")).toBe(false);
    expect(isValidCustomGroupMemoryKey("study_goal")).toBe(true);
    expect(isValidCustomGroupMemoryKey("teacher_persona")).toBe(true);
    expect(isValidCustomGroupMemoryKey("teacher-persona")).toBe(false);
    expect(isSupportedGroupMemoryKey("study_goal")).toBe(true);
    expect(isSupportedGroupMemoryKey("teacher_persona")).toBe(true);
    expect(isSupportedGroupMemoryKey("teacher-persona")).toBe(false);
    expect(validateGroupMemoryKey("topic_context", "builtin")).toBeNull();
    expect(validateGroupMemoryKey("study_goal", "builtin")).toContain(
      "Invalid builtin key",
    );
    expect(validateGroupMemoryKey("study_goal", "custom")).toBeNull();
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

  test("clears persisted session ids when forcing fresh startup sessions", () => {
    const { dir, db } = createWorkspace();
    cleanupDirs.push(dir);

    updateChatSessionRef(db, dir, "main", "session-main");
    updateChatSessionRef(db, dir, "english-group", "session-english");

    expect(clearAllChatSessionRefs(db, dir)).toBe(2);
    expect(getChatSessionRef(db, dir, "main")).toBeNull();
    expect(getChatSessionRef(db, dir, "english-group")).toBeNull();
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

    expect(regularRemember?.description).toContain("prefer mapping it to a builtin key first");
    expect(regularRemember?.schema).toMatchObject({
      properties: {
        keyType: {
          description: "Choose builtin whenever possible. Use custom only when no builtin key fits.",
        },
      },
    });

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
    const mainClearSession = mainTools.find((tool) => tool.name === "clear_session");
    const mainClearContext = mainTools.find((tool) => tool.name === "clear_context");
    const mainRemember = mainTools.find((tool) => tool.name === "remember_group_memory");
    const mainList = mainTools.find((tool) => tool.name === "list_group_memory");
    const mainForget = mainTools.find((tool) => tool.name === "forget_group_memory");
    const mainClear = mainTools.find((tool) => tool.name === "clear_group_memory");

    expect(mainClearSession?.description).toContain("Clear only the AI session");
    expect(mainClearContext?.description).toContain("Compatibility alias");

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

    const clearSender = {
      ...sender,
      clearSession: async () => ({
        closedActiveSession: true,
        previousSessionRef: "old-session",
        sessionRef: "fresh-session",
        generation: 2,
      }),
    };
    const clearTools = createGroupToolDefs("main", true, db, clearSender, dir);
    const clearSession = clearTools.find((tool) => tool.name === "clear_session");
    const clearContext = clearTools.find((tool) => tool.name === "clear_context");

    await expect(
      clearSession!.handler({ targetGroupFolder: "other-group" }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: 'Session cleared for group "Other Group" (other-group). A fresh AI session (fresh-session) is ready, and the previous active session was closed. This only clears the AI session.',
        },
      ],
    });

    await expect(
      clearContext!.handler({ targetGroupFolder: "other-group" }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: 'Session cleared for group "Other Group" (other-group). A fresh AI session (fresh-session) is ready, and the previous active session was closed. This only clears the AI session.',
        },
      ],
    });
  });
});

describe("group memory prompt injection", () => {
  test("injects memory policy even when the group has no stored memory yet", async () => {
    const { dir, db } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    const { runtime, firstSend } = createCapturingRuntime();
    const groupQueue = new GroupQueue(
      db,
      createFakeChannelManager(),
      runtime,
      1,
    );

    await groupQueue.enqueue(
      "main",
      "[2026-03-29T07:16:02.252Z] Alice: 记住：你要输出英文",
    );

    const firstTurn = await firstSend;
    expect(firstTurn.mode).toBe("prompt");
    expect(firstTurn.text).toContain("Group memory policy:");
    expect(firstTurn.text).toContain("remember_group_memory before replying");
    expect(firstTurn.text).toContain("response_language = English");
    expect(firstTurn.text).toContain("Current input:");
    expect(firstTurn.text).toContain("记住：你要输出英文");
  });

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

    const { runtime, firstSend } = createCapturingRuntime();
    const groupQueue = new GroupQueue(
      db,
      createFakeChannelManager(),
      runtime,
      1,
    );

    await groupQueue.enqueue(
      "english-group",
      "[2026-03-29T08:00:00.000Z] Alice: 请给我一组今天的英语口语练习",
    );

    const firstTurn = await firstSend;
    expect(firstTurn.mode).toBe("prompt");
    expect(firstTurn.text).toContain("Group memory policy:");
    expect(firstTurn.text).toContain("Group memory:");
    expect(firstTurn.text).toContain("Topic context: 这个群主要用于英语学习");
    expect(firstTurn.text).toContain(
      "Custom correction_policy: 用户发英文时优先纠错再解释",
    );
    expect(firstTurn.text).toContain("Current input:");
    expect(firstTurn.text).toContain("请给我一组今天的英语口语练习");
  });

  test("scheduler reuses the same session-start path so due tasks also get memory", async () => {
    const { dir, db } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    upsertGroupMemory(db, {
      groupFolder: "english-group",
      key: "study_goal",
      keyType: "custom",
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

    const { runtime, firstSend } = createCapturingRuntime();
    const groupQueue = new GroupQueue(
      db,
      createFakeChannelManager(),
      runtime,
      1,
    );

    schedulerTestHelpers.pollAndExecute(
      db,
      createFakeChannelManager(),
      groupQueue,
    );

    const firstTurn = await firstSend;
    expect(firstTurn.mode).toBe("prompt");
    expect(firstTurn.text).toContain("Group memory policy:");
    expect(firstTurn.text).toContain("Group memory:");
    expect(firstTurn.text).toContain("Custom study_goal: 重点提升英语口语");
    expect(firstTurn.text).toContain("[Scheduled Task");
    expect(firstTurn.text).toContain("请发送今日英语练习");
  });
});

describe("clear session concurrency protection", () => {
  test("does not let a stale run overwrite the freshly cleared session ref", async () => {
    const { dir, db } = createWorkspace();
    cleanupDirs.push(dir);
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    let releaseResult!: () => void;
    const resultReleased = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });

    const runtime: AgentRuntime = {
      name: "mock",
      openConversation: async () => ({
        conversation: {
          send: async () => {},
          close: () => {},
        },
        events: (async function* () {
          await resultReleased;
          yield { type: "completed" as const, sessionRef: "stale-session" };
        })(),
      }),
      resetSession: async () => ({ sessionRef: "fresh-session" }),
    };

    const groupQueue = new GroupQueue(
      db,
      createFakeChannelManager(),
      runtime,
      1,
    );

    await groupQueue.enqueue(
      "main",
      "[2026-04-10T10:00:00.000Z] Alice: 你好",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clearResult = await groupQueue.clearSession("main");
    expect(clearResult.sessionRef).toBe("fresh-session");
    expect(getChatSessionRef(db, dir, "main")).toBe("fresh-session");

    releaseResult();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getChatSessionRef(db, dir, "main")).toBe("fresh-session");
  });
});
