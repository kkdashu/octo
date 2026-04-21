import type { Database } from "bun:sqlite";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Channel, ChatInfo } from "./types";
import { getGroupByJid } from "../db";
import { getWorkspaceDirectory } from "../group-workspace";
import { log } from "../logger";
import {
  normalizeLegacyImageSyntax,
  parseMessageParts,
  type MessagePart,
} from "../message-parts";

const TAG = "channel-mgr";

export type OutgoingMessagePart = MessagePart;

export function parseOutgoingMessageParts(text: string): OutgoingMessagePart[] {
  return parseMessageParts(normalizeLegacyImageSyntax(text));
}

function isEscapedPath(baseDir: string, resolvedPath: string): boolean {
  const rel = relative(baseDir, resolvedPath);
  return rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");
}

export class ChannelManager {
  private channels: Map<string, Channel> = new Map();
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  register(channel: Channel) {
    log.info(TAG, `Registering channel: ${channel.type}`);
    this.channels.set(channel.type, channel);
  }

  getChannelForChat(chatJid: string): Channel | undefined {
    const group = getGroupByJid(this.db, chatJid);
    if (group) {
      const ch = this.channels.get(group.channel_type);
      log.debug(TAG, `Resolved channel for chat ${chatJid}`, {
        channelType: group.channel_type,
        found: !!ch,
      });
      return ch;
    }
    // Fallback: return first available channel
    const fallback = this.channels.values().next().value;
    log.debug(TAG, `No registered group for chat ${chatJid}, using fallback channel`, {
      fallbackType: fallback?.type,
    });
    return fallback;
  }

  private resolveOutgoingAssetPath(chatJid: string, assetPath: string): string {
    if (isAbsolute(assetPath)) {
      return assetPath;
    }

    const normalizedPath = assetPath.trim().replace(/\\/g, "/");
    if (!normalizedPath) {
      return assetPath;
    }

    if (
      normalizedPath.startsWith("media/") ||
      normalizedPath.startsWith("groups/") ||
      normalizedPath.startsWith("workspaces/")
    ) {
      return resolve(normalizedPath);
    }

    const group = getGroupByJid(this.db, chatJid);
    if (!group) {
      return resolve(normalizedPath);
    }

    const groupWorkdir = getWorkspaceDirectory(group.folder);
    const resolvedPath = resolve(groupWorkdir, normalizedPath);
    if (isEscapedPath(groupWorkdir, resolvedPath)) {
      throw new Error(
        `Invalid asset path: must stay within current group directory (${assetPath})`,
      );
    }

    return resolvedPath;
  }

  async send(chatJid: string, text: string) {
    log.info(TAG, `Sending message via channel`, {
      chatJid,
      textLength: text.length,
      textPreview: text.substring(0, 100),
    });
    const channel = this.getChannelForChat(chatJid);
    if (channel) {
      const normalizedText = normalizeLegacyImageSyntax(text);
      const parts = parseOutgoingMessageParts(text);
      const hasImages = parts.some((part) => part.type === "image");
      const hasFiles = parts.some((part) => part.type === "file");

      if (!hasImages && !hasFiles) {
        await channel.sendMessage(chatJid, normalizedText);
        return;
      }

      if ((hasImages && !channel.sendImage) || (hasFiles && !channel.sendFile)) {
        log.warn(TAG, `Channel ${channel.type} does not support rich media sending, falling back to raw text`, {
          chatJid,
          hasImages,
          hasFiles,
          textPreview: normalizedText.substring(0, 200),
        });
        await channel.sendMessage(chatJid, normalizedText);
        return;
      }

      for (const part of parts) {
        if (part.type === "text") {
          const chunk = part.value.trim();
          if (!chunk) {
            continue;
          }
          await channel.sendMessage(chatJid, chunk);
          continue;
        }

        if (part.type === "file") {
          try {
            await channel.sendFile!(
              chatJid,
              this.resolveOutgoingAssetPath(chatJid, part.value),
            );
          } catch (err) {
            log.error(TAG, `Failed to send file to chat ${chatJid}`, err);
            const errorMessage = err instanceof Error ? err.message.trim() : "";
            await channel.sendMessage(
              chatJid,
              errorMessage
                ? `文件发送失败: ${errorMessage}`
                : `文件发送失败: ${part.value}`,
            );
          }
          continue;
        }

        try {
          await channel.sendImage!(
            chatJid,
            this.resolveOutgoingAssetPath(chatJid, part.value),
          );
        } catch (err) {
          log.error(TAG, `Failed to send image to chat ${chatJid}`, err);
          const errorMessage = err instanceof Error ? err.message.trim() : "";
          await channel.sendMessage(
            chatJid,
            errorMessage
              ? `图片发送失败: ${errorMessage}`
              : `图片发送失败: ${part.value}`,
          );
        }
      }
    } else {
      log.error(TAG, `No channel found for chat ${chatJid}`);
    }
  }

  async sendImage(chatJid: string, filePath: string) {
    log.info(TAG, "Sending image via channel", {
      chatJid,
      filePath,
    });
    const channel = this.getChannelForChat(chatJid);
    if (!channel) {
      const err = new Error(`No channel found for chat ${chatJid}`);
      log.error(TAG, err.message);
      throw err;
    }

    if (!channel.sendImage) {
      const err = new Error(
        `Channel ${channel.type} does not support image sending`,
      );
      log.error(TAG, err.message, { chatJid, filePath });
      throw err;
    }

    await channel.sendImage(chatJid, filePath);
  }

  async refreshGroupMetadata(): Promise<ChatInfo[]> {
    log.info(TAG, "Refreshing group metadata from all channels");
    const allChats: ChatInfo[] = [];
    for (const channel of this.channels.values()) {
      const chats = await channel.listChats();
      log.info(TAG, `Channel ${channel.type} returned ${chats.length} chats`);
      allChats.push(...chats);
    }
    log.info(TAG, `Total chats fetched: ${allChats.length}`);
    return allChats;
  }

  async startAll() {
    log.info(TAG, `Starting all channels (count: ${this.channels.size})`);
    for (const channel of this.channels.values()) {
      log.info(TAG, `Starting channel: ${channel.type}`);
      await channel.start();
    }
    log.info(TAG, "All channels started");
  }

  async stopAll() {
    log.info(TAG, "Stopping all channels");
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
    log.info(TAG, "All channels stopped");
  }
}

export const __test__ = {
  parseOutgoingMessageParts,
};
