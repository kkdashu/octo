import type { Database } from "bun:sqlite";
import type { ChannelManager } from "./channels/manager";
import {
  createTurnRequest,
  getInboundDispatcherCursor,
  listChatBindingsForChat,
  listPendingInboundMessagesForChat,
  type ChatRow,
  type InboundMessageRow,
  upsertInboundDispatcherCursor,
} from "./db";
import { log } from "./logger";
import type {
  EnqueueRuntimeResult,
  GroupRuntimeController,
} from "./runtime/group-runtime-controller";
import { WorkspaceService } from "./workspace-service";

const TAG = "router";
const DEFAULT_INBOUND_DISPATCHER = "default_inbound_dispatcher";

export function shouldTrigger(
  chat: ChatRow,
  message: InboundMessageRow,
): boolean {
  if (!chat.requires_trigger) {
    return true;
  }

  if (message.mentions_me) {
    return true;
  }

  if (
    chat.trigger_pattern
    && message.content_text.includes(chat.trigger_pattern)
  ) {
    return true;
  }

  return false;
}

export function formatMessagesAsPrompt(messages: InboundMessageRow[]): string {
  return messages
    .map(
      (message) =>
        `[${message.message_timestamp}] ${message.sender_name || message.sender_id}: ${message.content_text}`,
    )
    .join("\n");
}

export function isClearSessionCommand(message: InboundMessageRow): boolean {
  return message.content_text.trim() === "/clear";
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

      const cursor = getInboundDispatcherCursor(
        db,
        DEFAULT_INBOUND_DISPATCHER,
        chat.id,
      );
      const lastTimestamp = cursor?.last_message_timestamp ?? "1970-01-01T00:00:00.000Z";
      const messages = listPendingInboundMessagesForChat(
        db,
        chat.id,
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

        upsertInboundDispatcherCursor(db, {
          consumer: DEFAULT_INBOUND_DISPATCHER,
          chatId: chat.id,
          lastInboundMessageId: lastMessage.id,
          lastMessageTimestamp: lastMessage.message_timestamp,
        });
        continue;
      }

      const triggerMessages = messages.filter((message) => shouldTrigger(chat, message));
      if (triggerMessages.length === 0) {
        continue;
      }

      const prompt = formatMessagesAsPrompt(messages);
      const turnRequest = createTurnRequest(db, {
        workspaceId: workspace.id,
        chatId: chat.id,
        sourceType: "channel_inbound",
        sourceRef: JSON.stringify({
          inboundMessageIds: messages.map((message) => message.id),
          platform: binding.platform,
          externalChatId: binding.external_chat_id,
        }),
        inputMode: groupQueue.isActive(chat.id) ? "follow_up" : "prompt",
        requestText: prompt,
      });
      const result = await groupQueue.executeTurnRequest(turnRequest.id);
      if (!shouldAdvanceCursor(result)) {
        continue;
      }

      const lastProcessed = messages[messages.length - 1]!;
      upsertInboundDispatcherCursor(db, {
        consumer: DEFAULT_INBOUND_DISPATCHER,
        chatId: chat.id,
        lastInboundMessageId: lastProcessed.id,
        lastMessageTimestamp: lastProcessed.message_timestamp,
      });
    }
  }
}

export const __test__ = {
  buildClearSessionSystemReply,
  isClearSessionCommand,
  processMessages,
};
