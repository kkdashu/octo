import type { Database } from "bun:sqlite";
import type { Channel, ChatInfo } from "./types";
import { getGroupByJid } from "../db";
import { log } from "../logger";

const TAG = "channel-mgr";

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

  async send(chatJid: string, text: string) {
    log.info(TAG, `Sending message via channel`, {
      chatJid,
      textLength: text.length,
      textPreview: text.substring(0, 100),
    });
    const channel = this.getChannelForChat(chatJid);
    if (channel) {
      await channel.sendMessage(chatJid, text);
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
