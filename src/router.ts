import type { Database } from "bun:sqlite";
import type { ChannelManager } from "./channels/manager";
import {
  getRouterState,
  getUnprocessedMessages,
  listChatBindingsForChat,
  setRouterState,
  type ChatRow,
  type MessageRow,
} from "./db";
import { log } from "./logger";
import type {
  EnqueueRuntimeResult,
  GroupRuntimeController,
} from "./runtime/group-runtime-controller";
import { WorkspaceService } from "./workspace-service";

const TAG = "router";

export function shouldTrigger(
  chat: ChatRow,
  message: MessageRow,
): boolean {
  if (!chat.requires_trigger) {
    return true;
  }

  if (message.mentions_me) {
    return true;
  }

  if (
    chat.trigger_pattern
    && message.content.includes(chat.trigger_pattern)
  ) {
    return true;
  }

  return false;
}

export function formatMessagesAsPrompt(messages: MessageRow[]): string {
  return messages
    .map(
      (message) =>
        `[${message.timestamp}] ${message.sender_name || message.sender}: ${message.content}`,
    )
    .join("\n");
}

export function isClearSessionCommand(message: MessageRow): boolean {
  return message.content.trim() === "/clear";
}

function buildClearSessionSystemReply(): string {
  return "Session 已清理。仅清理 AI session；workspace memory、待处理消息和文件不会被清理。";
}

export function startMessageLoop(
  db: Database,
  channelManager: ChannelManager,
  groupQueue: GroupRuntimeController,
  workspaceService?: WorkspaceService,
  intervalMs = 2000,
): ReturnType<typeof setInterval> {
  let isProcessing = false;
  const timer = setInterval(() => {
    if (isProcessing) {
      return;
    }

    isProcessing = true;
    void processMessages(db, channelManager, groupQueue, workspaceService)
      .catch((error) => {
        log.error(TAG, "Message loop error", error);
      })
      .finally(() => {
        isProcessing = false;
      });
  }, intervalMs);

  log.info(TAG, `Message loop started (interval: ${intervalMs}ms)`);
  return timer;
}

function shouldAdvanceCursor(result: EnqueueRuntimeResult): boolean {
  return result.status === "completed" || result.failureNotified;
}

async function processMessages(
  db: Database,
  channelManager: ChannelManager,
  groupQueue: GroupRuntimeController,
  workspaceService = new WorkspaceService(db),
): Promise<void> {
  for (const workspace of workspaceService.listWorkspaces()) {
    for (const chat of workspaceService.listChats(workspace.id)) {
      const binding = listChatBindingsForChat(db, chat.id)[0] ?? null;
      if (!binding) {
        continue;
      }

      const cursorKey = `last_timestamp:${chat.id}`;
      const legacyCursorKey = `last_timestamp:${binding.external_chat_id}`;
      const lastTimestamp = getRouterState(db, cursorKey)
        ?? getRouterState(db, legacyCursorKey)
        ?? "1970-01-01T00:00:00.000Z";
      const messages = getUnprocessedMessages(
        db,
        binding.external_chat_id,
        lastTimestamp,
      );
      if (messages.length === 0) {
        continue;
      }

      const lastMessage = messages[messages.length - 1]!;
      if (isClearSessionCommand(lastMessage)) {
        void groupQueue.clearSession(chat.id)
          .then(() =>
            channelManager.send(
              binding.external_chat_id,
              buildClearSessionSystemReply(),
            ))
          .catch((error) => {
            log.error(TAG, `Failed to handle /clear for chat ${chat.id}`, error);
            return channelManager.send(
              binding.external_chat_id,
              "Session 清理失败，请稍后重试。",
            );
          });

        setRouterState(db, cursorKey, lastMessage.timestamp);
        setRouterState(db, legacyCursorKey, lastMessage.timestamp);
        continue;
      }

      const triggerMessages = messages.filter((message) => shouldTrigger(chat, message));
      if (triggerMessages.length === 0) {
        continue;
      }

      const prompt = formatMessagesAsPrompt(messages);
      if (groupQueue.isActive(chat.id)) {
        const accepted = groupQueue.pushMessage(chat.id, {
          mode: "follow_up",
          text: prompt,
        });
        if (!accepted) {
          const result = await groupQueue.enqueue(chat.id, prompt);
          if (!shouldAdvanceCursor(result)) {
            continue;
          }
        }
      } else {
        const result = await groupQueue.enqueue(chat.id, prompt);
        if (!shouldAdvanceCursor(result)) {
          continue;
        }
      }

      const lastProcessed = messages[messages.length - 1]!;
      setRouterState(db, cursorKey, lastProcessed.timestamp);
      setRouterState(db, legacyCursorKey, lastProcessed.timestamp);
    }
  }
}

export const __test__ = {
  buildClearSessionSystemReply,
  isClearSessionCommand,
  processMessages,
};
