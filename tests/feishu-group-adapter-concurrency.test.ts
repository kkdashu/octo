import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelManager } from "../src/channels/manager";
import { initDatabase } from "../src/db";
import { FeishuGroupAdapter } from "../src/runtime/feishu-group-adapter";
import type { ImageMessagePreprocessor } from "../src/runtime/image-message-preprocessor";
import type { PiGroupSessionHost } from "../src/runtime/pi-group-runtime-factory";
import { WorkspaceService } from "../src/workspace-service";

type FakeSessionEvent = {
  type: string;
  message?: {
    role: string;
    content: Array<{ type: "text"; text: string }>;
  };
};

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createPassthroughImagePreprocessor(): ImageMessagePreprocessor {
  return {
    preprocess: async (text: string) => text,
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

function createBlockingSessionHost(
  label: string,
  onPromptStart: () => void,
  onPromptEnd: () => void,
): {
  host: PiGroupSessionHost;
  release(): void;
} {
  let listener: ((event: FakeSessionEvent) => void) | undefined;
  let releasePrompt = () => {};

  const host: PiGroupSessionHost = {
    session: {
      sessionFile: `${label}.jsonl`,
      isStreaming: false,
      async prompt(text: string) {
        onPromptStart();
        listener?.({ type: "turn_start" });

        await new Promise<void>((resolve) => {
          releasePrompt = () => {
            onPromptEnd();
            listener?.({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: `reply:${text}` }],
              },
            });
            listener?.({ type: "turn_end" });
            resolve();
          };
        });
      },
      async followUp() {},
      async steer() {},
      async abort() {},
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
    async dispose() {},
  };

  return {
    host,
    release() {
      releasePrompt();
    },
  };
}

describe("FeishuGroupAdapter concurrency", () => {
  test("does not exceed the global concurrency limit across workspaces", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-feishu-adapter-concurrency-"));
    const sent: Array<{ chatJid: string; text: string }> = [];

    try {
      mkdirSync(join(rootDir, "store"), { recursive: true });
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const mainWorkspace = workspaceService.createWorkspace({
        name: "Main",
        folder: "main",
        profileKey: "claude",
        isMain: true,
      });
      const mainChat = workspaceService.createChat(mainWorkspace.id, {
        title: "Main",
        requiresTrigger: false,
        externalBinding: {
          platform: "feishu",
          externalChatId: "oc_main",
        },
      });
      const sideWorkspace = workspaceService.createWorkspace({
        name: "Side",
        folder: "side",
        profileKey: "claude",
      });
      const sideChat = workspaceService.createChat(sideWorkspace.id, {
        title: "Side",
        requiresTrigger: false,
        externalBinding: {
          platform: "feishu",
          externalChatId: "oc_side",
        },
      });

      let activePrompts = 0;
      let maxActivePrompts = 0;
      const createdHosts: Array<ReturnType<typeof createBlockingSessionHost>> = [];
      const hostByChatId = new Map<string, ReturnType<typeof createBlockingSessionHost>>();

      const adapter = new FeishuGroupAdapter({
        db,
        rootDir,
        workspaceService,
        concurrencyLimit: 1,
        channelManager: createFakeChannelManager(sent),
        imageMessagePreprocessor: createPassthroughImagePreprocessor(),
        preparePrompt: async (_chatId, text) => text,
        createChatSessionHost: async (chatId) => {
          const host = createBlockingSessionHost(
            `session-${createdHosts.length + 1}`,
            () => {
              activePrompts += 1;
              maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
            },
            () => {
              activePrompts = Math.max(0, activePrompts - 1);
            },
          );
          createdHosts.push(host);
          hostByChatId.set(chatId, host);
          const chat = workspaceService.getChatById(chatId)!;
          const workspace = workspaceService.getWorkspaceById(chat.workspace_id)!;
          return {
            host: host.host,
            workspace,
            chat,
            sessionRef: host.host.session.sessionFile!,
          };
        },
      });

      const firstTurn = adapter.enqueue(mainChat.id, "hello-main");
      await flushMicrotasks();
      const secondTurn = adapter.enqueue(sideChat.id, "hello-side");
      await flushMicrotasks();
      await flushMicrotasks();

      expect(createdHosts).toHaveLength(1);
      expect(maxActivePrompts).toBe(1);

      hostByChatId.get(mainChat.id)!.release();
      await firstTurn;
      await flushMicrotasks();
      await flushMicrotasks();

      expect(createdHosts).toHaveLength(2);
      expect(maxActivePrompts).toBe(1);

      hostByChatId.get(sideChat.id)!.release();
      await secondTurn;
      await flushMicrotasks();

      expect(maxActivePrompts).toBe(1);
      expect(sent).toEqual([
        { chatJid: "oc_main", text: "reply:hello-main" },
        { chatJid: "oc_side", text: "reply:hello-side" },
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
