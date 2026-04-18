import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelManager } from "../src/channels/manager";
import {
  getGroupByFolder,
  getSessionRef,
  initDatabase,
  registerGroup,
} from "../src/db";
import { FeishuGroupAdapter } from "../src/runtime/feishu-group-adapter";
import type { ImageMessagePreprocessor } from "../src/runtime/image-message-preprocessor";
import type { PiGroupSessionHost } from "../src/runtime/pi-group-runtime-factory";

type FakeSessionEvent = {
  type: string;
  message?: {
    role: string;
    content: Array<{ type: "text"; text: string }>;
    stopReason?: string;
    errorMessage?: string;
  };
};

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "octo-feishu-group-adapter-"));
  mkdirSync(join(dir, "store"), { recursive: true });
  mkdirSync(join(dir, "groups", "main"), { recursive: true });

  const db = initDatabase(join(dir, "store", "messages.db"));
  registerGroup(db, {
    jid: "oc_main",
    name: "Main Group",
    folder: "main",
    channelType: "feishu",
    requiresTrigger: false,
    isMain: true,
    profileKey: "minimax-cn",
  });

  return {
    dir,
    db,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createFakeChannelManager(sent: Array<{ chatJid: string; text: string }>) {
  return {
    send: async (chatJid: string, text: string) => {
      sent.push({ chatJid, text });
    },
    sendImage: async () => {},
    refreshGroupMetadata: async () => [],
  } as unknown as ChannelManager;
}

function createPassthroughImagePreprocessor(): ImageMessagePreprocessor {
  return {
    preprocess: async (text: string) => text,
  };
}

function createDeferredSessionHost(label: string): {
  host: PiGroupSessionHost;
  release(): void;
  releaseWithAssistantError(errorMessage: string): void;
  get calls(): Array<{ mode: string; text: string }>;
  get aborted(): boolean;
  get disposed(): boolean;
} {
  let listener: ((event: FakeSessionEvent) => void) | undefined;
  let streaming = false;
  let aborted = false;
  let disposed = false;
  let releasePrompt = () => {};
  let resolvePrompt: (() => void) | null = null;
  let promptText = "";
  const followUps: string[] = [];
  const calls: Array<{ mode: string; text: string }> = [];
  let sessionFile = `${label}.jsonl`;

  const host: PiGroupSessionHost = {
    session: {
      get sessionFile() {
        return sessionFile;
      },
      get isStreaming() {
        return streaming;
      },
      async prompt(text: string) {
        calls.push({ mode: "prompt", text });
        promptText = text;
        streaming = true;

        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
          releasePrompt = () => {
            const replies = [promptText, ...followUps];
            sessionFile = `${label}-done.jsonl`;
            streaming = false;
            followUps.length = 0;
            for (const reply of replies) {
              listener?.({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: `reply:${reply}` }],
                },
              });
            }
            resolvePrompt = null;
            resolve();
          };
        });
      },
      async followUp(text: string) {
        calls.push({ mode: "follow_up", text });
        followUps.push(text);
      },
      async steer(text: string) {
        calls.push({ mode: "steer", text });
        followUps.push(`steer:${text}`);
      },
      async abort() {
        aborted = true;
        if (streaming) {
          releasePrompt();
        }
      },
      subscribe(next: (event: FakeSessionEvent) => void) {
        listener = next;
        return () => {
          if (listener === next) {
            listener = undefined;
          }
        };
      },
    } as PiGroupSessionHost["session"],
    services: {} as PiGroupSessionHost["services"],
    diagnostics: [],
    cwd: `/tmp/${label}`,
    async dispose() {
      disposed = true;
    },
  };

  return {
    host,
    release() {
      releasePrompt();
    },
    releaseWithAssistantError(errorMessage: string) {
      releasePrompt = () => {
        sessionFile = `${label}-done.jsonl`;
        streaming = false;
        followUps.length = 0;
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage,
          },
        });
        resolvePrompt?.();
        resolvePrompt = null;
      };
      releasePrompt();
    },
    get calls() {
      return calls;
    },
    get aborted() {
      return aborted;
    },
    get disposed() {
      return disposed;
    },
  };
}

describe("FeishuGroupAdapter", () => {
  test("serializes same-group turns, reuses persisted session refs, and sends assistant replies", async () => {
    const workspace = createWorkspace();
    const sent: Array<{ chatJid: string; text: string }> = [];
    const createdHosts: ReturnType<typeof createDeferredSessionHost>[] = [];
    const observedSessionRefs: Array<string | null> = [];

    try {
      const adapter = new FeishuGroupAdapter({
        db: workspace.db,
        channelManager: createFakeChannelManager(sent),
        imageMessagePreprocessor: createPassthroughImagePreprocessor(),
        preparePrompt: async (_groupFolder, text) => `prepared:${text}`,
        createGroupSessionHost: async (groupFolder) => {
          observedSessionRefs.push(getSessionRef(workspace.db, groupFolder));
          const fake = createDeferredSessionHost(`session-${createdHosts.length + 1}`);
          createdHosts.push(fake);
          return {
            host: fake.host,
            group: getGroupByFolder(workspace.db, groupFolder)!,
            sessionRef: fake.host.session.sessionFile!,
          };
        },
        resetGroupSession: async () => "fresh-session.jsonl",
      });

      const firstTurn = adapter.enqueue("main", "hello");
      await flushMicrotasks();

      expect(adapter.isActive("main")).toBe(true);
      expect(
        adapter.pushMessage("main", {
          mode: "follow_up",
          text: "next",
        }),
      ).toBe(true);

      const queuedTurn = adapter.enqueue("main", "after-first");
      await flushMicrotasks();
      expect(createdHosts).toHaveLength(1);

      createdHosts[0]!.release();
      await firstTurn;
      await flushMicrotasks();

      expect(createdHosts).toHaveLength(2);
      expect(observedSessionRefs).toEqual([null, "session-1-done.jsonl"]);
      expect(getSessionRef(workspace.db, "main")).toBe("session-1-done.jsonl");
      expect(sent).toEqual([
        { chatJid: "oc_main", text: "reply:prepared:hello" },
        { chatJid: "oc_main", text: "reply:prepared:next" },
      ]);

      createdHosts[1]!.release();
      await queuedTurn;
      await flushMicrotasks();

      expect(getSessionRef(workspace.db, "main")).toBe("session-2-done.jsonl");
      expect(sent).toEqual([
        { chatJid: "oc_main", text: "reply:prepared:hello" },
        { chatJid: "oc_main", text: "reply:prepared:next" },
        { chatJid: "oc_main", text: "reply:prepared:after-first" },
      ]);
    } finally {
      workspace.cleanup();
    }
  });

  test("clearSession aborts the active runtime and persists the fresh session ref", async () => {
    const workspace = createWorkspace();
    const sent: Array<{ chatJid: string; text: string }> = [];
    const createdHosts: ReturnType<typeof createDeferredSessionHost>[] = [];

    try {
      const adapter = new FeishuGroupAdapter({
        db: workspace.db,
        channelManager: createFakeChannelManager(sent),
        imageMessagePreprocessor: createPassthroughImagePreprocessor(),
        preparePrompt: async (_groupFolder, text) => text,
        createGroupSessionHost: async (groupFolder) => {
          const fake = createDeferredSessionHost(`session-${createdHosts.length + 1}`);
          createdHosts.push(fake);
          return {
            host: fake.host,
            group: getGroupByFolder(workspace.db, groupFolder)!,
            sessionRef: fake.host.session.sessionFile!,
          };
        },
        resetGroupSession: async () => "fresh-session.jsonl",
      });

      const turn = adapter.enqueue("main", "hello");
      await flushMicrotasks();

      const result = await adapter.clearSession("main");
      await turn;
      await flushMicrotasks();

      expect(result).toEqual({
        closedActiveSession: true,
        previousSessionRef: null,
        sessionRef: "fresh-session.jsonl",
        generation: 1,
      });
      expect(createdHosts[0]?.aborted).toBe(true);
      expect(createdHosts[0]?.disposed).toBe(true);
      expect(getSessionRef(workspace.db, "main")).toBe("fresh-session.jsonl");
    } finally {
      workspace.cleanup();
    }
  });

  test("surfaces assistant runtime errors from message_end back to Feishu", async () => {
    const workspace = createWorkspace();
    const sent: Array<{ chatJid: string; text: string }> = [];
    const createdHosts: ReturnType<typeof createDeferredSessionHost>[] = [];

    try {
      const adapter = new FeishuGroupAdapter({
        db: workspace.db,
        channelManager: createFakeChannelManager(sent),
        imageMessagePreprocessor: createPassthroughImagePreprocessor(),
        preparePrompt: async (_groupFolder, text) => text,
        createGroupSessionHost: async (groupFolder) => {
          const fake = createDeferredSessionHost(`session-${createdHosts.length + 1}`);
          createdHosts.push(fake);
          return {
            host: fake.host,
            group: getGroupByFolder(workspace.db, groupFolder)!,
            sessionRef: fake.host.session.sessionFile!,
          };
        },
        resetGroupSession: async () => "fresh-session.jsonl",
      });

      const turn = adapter.enqueue("main", "hello");
      await flushMicrotasks();

      createdHosts[0]!.releaseWithAssistantError(
        "401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid api key\"}}",
      );
      await turn;
      await flushMicrotasks();

      expect(sent).toEqual([
        {
          chatJid: "oc_main",
          text: "AI 运行失败: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid api key\"}}",
        },
      ]);
    } finally {
      workspace.cleanup();
    }
  });

  test("surfaces prompt exceptions back to Feishu", async () => {
    const workspace = createWorkspace();
    const sent: Array<{ chatJid: string; text: string }> = [];

    try {
      const adapter = new FeishuGroupAdapter({
        db: workspace.db,
        channelManager: createFakeChannelManager(sent),
        imageMessagePreprocessor: createPassthroughImagePreprocessor(),
        preparePrompt: async (_groupFolder, text) => text,
        createGroupSessionHost: async (groupFolder) => {
          const fake = createDeferredSessionHost("session-1");
          fake.host.session.prompt = async () => {
            throw new Error("401 invalid api key");
          };
          return {
            host: fake.host,
            group: getGroupByFolder(workspace.db, groupFolder)!,
            sessionRef: fake.host.session.sessionFile!,
          };
        },
        resetGroupSession: async () => "fresh-session.jsonl",
      });

      await adapter.enqueue("main", "hello");
      await flushMicrotasks();

      expect(sent).toEqual([
        {
          chatJid: "oc_main",
          text: "AI 运行失败: 401 invalid api key",
        },
      ]);
    } finally {
      workspace.cleanup();
    }
  });

  test("surfaces follow-up failures back to Feishu", async () => {
    const workspace = createWorkspace();
    const sent: Array<{ chatJid: string; text: string }> = [];
    const createdHosts: ReturnType<typeof createDeferredSessionHost>[] = [];

    try {
      const adapter = new FeishuGroupAdapter({
        db: workspace.db,
        channelManager: createFakeChannelManager(sent),
        imageMessagePreprocessor: createPassthroughImagePreprocessor(),
        preparePrompt: async (_groupFolder, text) => text,
        createGroupSessionHost: async (groupFolder) => {
          const fake = createDeferredSessionHost(`session-${createdHosts.length + 1}`);
          const originalFollowUp = fake.host.session.followUp.bind(fake.host.session);
          fake.host.session.followUp = async (text: string) => {
            if (text === "boom") {
              throw new Error("401 invalid api key");
            }
            await originalFollowUp(text);
          };
          createdHosts.push(fake);
          return {
            host: fake.host,
            group: getGroupByFolder(workspace.db, groupFolder)!,
            sessionRef: fake.host.session.sessionFile!,
          };
        },
        resetGroupSession: async () => "fresh-session.jsonl",
      });

      const turn = adapter.enqueue("main", "hello");
      await flushMicrotasks();

      expect(adapter.pushMessage("main", {
        mode: "follow_up",
        text: "boom",
      })).toBe(true);
      await flushMicrotasks();

      expect(sent).toEqual([
        {
          chatJid: "oc_main",
          text: "AI 运行失败: 401 invalid api key",
        },
      ]);

      createdHosts[0]!.release();
      await turn;
      await flushMicrotasks();
    } finally {
      workspace.cleanup();
    }
  });
});
