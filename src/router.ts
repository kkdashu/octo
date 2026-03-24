import type { Database } from "bun:sqlite";
import type { ChannelManager } from "./channels/manager";
import type { GroupQueue } from "./group-queue";
import {
  listGroups,
  getUnprocessedMessages,
  getRouterState,
  setRouterState,
  type RegisteredGroup,
  type MessageRow,
} from "./db";
import { log } from "./logger";

const TAG = "router";

// ---------------------------------------------------------------------------
// Trigger logic
// ---------------------------------------------------------------------------

export function shouldTrigger(
  group: RegisteredGroup,
  message: MessageRow,
): boolean {
  if (!group.requires_trigger) return true;

  // @mention triggers
  if (message.mentions_me) return true;

  // Keyword trigger
  if (
    group.trigger_pattern &&
    message.content.includes(group.trigger_pattern)
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

export function formatMessagesAsPrompt(messages: MessageRow[]): string {
  return messages
    .map(
      (m) =>
        `[${m.timestamp}] ${m.sender_name || m.sender}: ${m.content}`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

export function startMessageLoop(
  db: Database,
  channelManager: ChannelManager,
  groupQueue: GroupQueue,
  intervalMs = 2000,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      processMessages(db, channelManager, groupQueue);
    } catch (err) {
      log.error(TAG, "Message loop error", err);
    }
  }, intervalMs);

  log.info(TAG, `Message loop started (interval: ${intervalMs}ms)`);
  return timer;
}

function processMessages(
  db: Database,
  _channelManager: ChannelManager,
  groupQueue: GroupQueue,
) {
  const groups = listGroups(db);
  if (groups.length === 0) return;

  for (const group of groups) {
    const cursorKey = `last_timestamp:${group.jid}`;
    const lastTimestamp = getRouterState(db, cursorKey) ?? "1970-01-01T00:00:00.000Z";

    const messages = getUnprocessedMessages(db, group.jid, lastTimestamp);
    if (messages.length === 0) continue;

    log.info(TAG, `Found ${messages.length} new messages for group ${group.folder} (${group.jid})`, {
      groupFolder: group.folder,
      groupJid: group.jid,
      messageCount: messages.length,
      sinceTimestamp: lastTimestamp,
      messages: messages.map((m) => ({
        id: m.id,
        sender: m.sender_name || m.sender,
        contentPreview: m.content.substring(0, 100),
        timestamp: m.timestamp,
      })),
    });

    // Find trigger messages
    const triggerMessages = messages.filter((m) =>
      shouldTrigger(group, m),
    );

    log.debug(TAG, `Trigger check for group ${group.folder}`, {
      totalMessages: messages.length,
      triggerCount: triggerMessages.length,
      requiresTrigger: group.requires_trigger,
      triggerPattern: group.trigger_pattern,
    });

    if (triggerMessages.length === 0) {
      // No trigger — do NOT advance cursor.
      // Messages accumulate as context until a trigger arrives.
      log.debug(TAG, `No trigger messages for group ${group.folder}, keeping cursor (messages accumulate as context)`);
      continue;
    }

    // Format ALL accumulated messages as prompt context (including non-trigger ones)
    const prompt = formatMessagesAsPrompt(messages);
    const input = {
      prompt,
      messages,
    };

    log.info(TAG, `Triggering agent for group ${group.folder}`, {
      triggerMessageCount: triggerMessages.length,
      totalContextMessages: messages.length,
      promptLength: prompt.length,
      promptPreview: prompt.substring(0, 300),
      isActiveSession: groupQueue.isActive(group.folder),
    });

    if (groupQueue.isActive(group.folder)) {
      log.info(TAG, `Pushing follow-up to active session: ${group.folder}`);
      groupQueue.pushMessage(group.folder, input);
    } else {
      log.info(TAG, `Starting new agent session for: ${group.folder}`);
      groupQueue.enqueue(group.folder, input);
    }

    // Only advance cursor AFTER messages are sent to agent
    const lastMsg = messages[messages.length - 1]!;
    setRouterState(db, cursorKey, lastMsg.timestamp);
    log.debug(TAG, `Cursor updated for group ${group.folder}`, {
      newTimestamp: lastMsg.timestamp,
    });
  }
}
