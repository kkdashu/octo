import * as lark from "@larksuiteoapi/node-sdk";
import { createReadStream, statSync } from "node:fs";
import type {
  Channel,
  ChannelOptions,
  ChatInfo,
  IncomingMessage,
  MessageHandler,
} from "./types";
import { log } from "../logger";

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  port: number;
  webhookPath: string;
}

const TAG = "feishu";

type FeishuMessagePayload = {
  message_type?: string;
  content?: string;
  message_id?: string;
  mentions?: unknown;
};

type FeishuPostContent = {
  title?: unknown;
  content?: unknown;
};

type FeishuPostElement = Record<string, unknown>;
type FeishuMention = Record<string, unknown>;

function normalizeExtractedContent(text: string): string | null {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized ? normalized : null;
}

function parseFeishuMessageContent(message: FeishuMessagePayload): unknown {
  if (!message.content) {
    return null;
  }

  return JSON.parse(message.content) as unknown;
}

function formatMentionDisplayName(name: string): string {
  return name.startsWith("@") ? name : `@${name}`;
}

function replaceMentionKeysWithNames(
  text: string,
  mentions: unknown,
): string {
  if (!Array.isArray(mentions) || mentions.length === 0) {
    return text;
  }

  let normalized = text;
  for (const mention of mentions) {
    if (!mention || typeof mention !== "object" || Array.isArray(mention)) {
      continue;
    }

    const typedMention = mention as FeishuMention;
    const key = typeof typedMention.key === "string" ? typedMention.key : "";
    const name = typeof typedMention.name === "string"
      ? typedMention.name.trim()
      : "";
    if (!key || !name) {
      continue;
    }

    normalized = normalized.split(key).join(formatMentionDisplayName(name));
  }

  return normalized;
}

function extractTextMessageContent(message: FeishuMessagePayload): string | null {
  const parsed = parseFeishuMessageContent(message) as Record<string, unknown> | null;
  const text = typeof parsed?.text === "string" ? parsed.text : "";
  return normalizeExtractedContent(
    replaceMentionKeysWithNames(text, message.mentions),
  );
}

function renderPostElement(element: FeishuPostElement): string {
  const tag = typeof element.tag === "string" ? element.tag : "";

  if (tag === "text") {
    return typeof element.text === "string" ? element.text : "";
  }

  if (tag === "a") {
    const text = typeof element.text === "string" ? element.text : "";
    const href = typeof element.href === "string" ? element.href : "";
    return text || href;
  }

  if (tag === "at") {
    const name = typeof element.user_name === "string"
      ? element.user_name
      : typeof element.name === "string"
        ? element.name
        : "";
    return name ? `@${name}` : "";
  }

  if (tag === "code_block") {
    const code = typeof element.text === "string" ? element.text.trimEnd() : "";
    if (!code) {
      return "";
    }

    const language = typeof element.language === "string"
      ? element.language.trim()
      : "";
    return language
      ? `\`\`\`${language}\n${code}\n\`\`\``
      : `\`\`\`\n${code}\n\`\`\``;
  }

  return "";
}

function renderPostParagraph(paragraph: unknown): string {
  if (!Array.isArray(paragraph)) {
    return "";
  }

  const blocks: string[] = [];
  let inlineText = "";

  for (const item of paragraph) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const element = item as FeishuPostElement;
    const tag = typeof element.tag === "string" ? element.tag : "";
    const rendered = renderPostElement(element);
    if (!rendered) {
      continue;
    }

    if (tag === "code_block") {
      const normalizedInline = normalizeExtractedContent(inlineText);
      if (normalizedInline) {
        blocks.push(normalizedInline);
      }
      blocks.push(rendered);
      inlineText = "";
      continue;
    }

    inlineText += rendered;
  }

  const normalizedInline = normalizeExtractedContent(inlineText);
  if (normalizedInline) {
    blocks.push(normalizedInline);
  }

  return blocks.join("\n");
}

function extractPostMessageContent(message: FeishuMessagePayload): string | null {
  const parsed = parseFeishuMessageContent(message) as FeishuPostContent | null;
  const blocks: string[] = [];

  if (typeof parsed?.title === "string" && parsed.title.trim()) {
    blocks.push(parsed.title.trim());
  }

  if (Array.isArray(parsed?.content)) {
    for (const paragraph of parsed.content) {
      const rendered = renderPostParagraph(paragraph);
      if (rendered) {
        blocks.push(rendered);
      }
    }
  }

  return normalizeExtractedContent(blocks.join("\n"));
}

function extractFeishuMessageContent(message: FeishuMessagePayload): string | null {
  if (message.message_type === "text") {
    return extractTextMessageContent(message);
  }

  if (message.message_type === "post") {
    return extractPostMessageContent(message);
  }

  return null;
}

export class FeishuChannel implements Channel {
  readonly type = "feishu";

  private client: InstanceType<typeof lark.Client>;
  private eventDispatcher: InstanceType<typeof lark.EventDispatcher>;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private onMessage: MessageHandler;
  private config: FeishuChannelConfig;

  constructor(config: FeishuChannelConfig, options: ChannelOptions) {
    this.config = config;
    this.onMessage = options.onMessage;

    log.info(TAG, "Initializing Feishu client", {
      appId: config.appId,
      port: config.port,
      webhookPath: config.webhookPath,
    });

    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
    });

    this.eventDispatcher = new lark.EventDispatcher({
      verificationToken: config.verificationToken,
      encryptKey: config.encryptKey,
    }).register({
      "im.message.receive_v1": async (event: any) => {
        await this.handleMessageEvent(event);
      },
    });
    const wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret
    });
    wsClient.start({eventDispatcher: this.eventDispatcher});
  }

  async start() {
    const config = this.config;
    const eventDispatcher = this.eventDispatcher;

    this.server = Bun.serve({
      port: config.port,
      routes: {
        [config.webhookPath]: {
          POST: async (req: Request) => {
            const body = (await req.json()) as Record<string, any>;

            log.debug(TAG, "Webhook POST received", {
              type: body.type,
              hasChallenge: !!body.challenge,
              hasEvent: !!body.event,
              headers: Object.fromEntries(req.headers),
              body,
            });

            // Handle URL verification challenge
            if (body.type === "url_verification") {
              log.info(TAG, "URL verification challenge received, responding with challenge");
              return Response.json({ challenge: body.challenge });
            }

            const data = {
              headers: Object.fromEntries(req.headers),
              body,
            };

            // Respond immediately, process asynchronously
            eventDispatcher.invoke(data).catch((err: unknown) => {
              log.error(TAG, "EventDispatcher.invoke() error", err);
            });

            return new Response("OK", { status: 200 });
          },
        },
      },
    });

    log.info(TAG, `Webhook server started on port ${config.port} at ${config.webhookPath}`);
  }

  async stop() {
    log.info(TAG, "Stopping Feishu webhook server");
    this.server?.stop();
    this.server = null;
  }

  async sendMessage(chatId: string, text: string) {
    log.info(TAG, `Sending message to chat ${chatId}`, {
      chatId,
      textLength: text.length,
      textPreview: text.substring(0, 200),
    });

    try {
      const res = await this.client.im.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
      });
      log.debug(TAG, "Message sent successfully", {
        chatId,
        response: res,
      });
    } catch (err) {
      log.error(TAG, `Failed to send message to chat ${chatId}`, err);
      throw err;
    }
  }

  async sendImage(chatId: string, filePath: string) {
    log.info(TAG, `Sending image to chat ${chatId}`, {
      chatId,
      filePath,
    });

    try {
      const fileSize = statSync(filePath).size;
      if (fileSize <= 0) {
        throw new Error(`Image file is empty: ${filePath}`);
      }

      const uploadRes = await this.client.im.image.create({
        data: {
          image_type: "message",
          image: createReadStream(filePath),
        },
      });
      const imageKey = uploadRes?.image_key;
      if (!imageKey) {
        throw new Error(`Failed to get image_key after upload: ${filePath}`);
      }

      await this.client.im.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ image_key: imageKey }),
          msg_type: "image",
        },
      });

      log.debug(TAG, "Image sent successfully", {
        chatId,
        filePath,
        imageKey,
      });
    } catch (err) {
      log.error(TAG, `Failed to send image to chat ${chatId}`, err);
      throw err;
    }
  }

  async listChats(): Promise<ChatInfo[]> {
    log.info(TAG, "Fetching chat list from Feishu");
    const chats: ChatInfo[] = [];
    try {
      for await (const items of await this.client.im.chat.listWithIterator({
        params: { page_size: 100 },
      })) {
        if (items) {
          for (const chat of items as any[]) {
            chats.push({
              chatId: chat.chat_id!,
              name: chat.name || "",
              type: chat.chat_type === "group" ? "group" : "p2p",
            });
          }
        }
      }
      log.info(TAG, `Fetched ${chats.length} chats from Feishu`, chats);
    } catch (err) {
      log.error(TAG, "Failed to fetch chat list", err);
      throw err;
    }
    return chats;
  }

  private async handleMessageEvent(event: any) {
    log.info(TAG, "=== Incoming Feishu message event ===");
    log.debug(TAG, "Raw event data", event);

    const { message, sender } = event;

    log.debug(TAG, "Event details", {
      messageId: message?.message_id,
      chatId: message?.chat_id,
      messageType: message?.message_type,
      senderType: sender?.sender_type,
      senderId: sender?.sender_id,
      createTime: message?.create_time,
      content: message?.content,
      mentions: message?.mentions,
    });

    // Skip messages from bot itself
    if (sender?.sender_type === "app") {
      log.debug(TAG, "Skipping bot's own message", {
        messageId: message?.message_id,
      });
      return;
    }

    // Parse text content
    const content = this.extractTextContent(message);
    if (!content) {
      log.debug(TAG, "Skipping non-text or empty message", {
        messageId: message?.message_id,
        messageType: message?.message_type,
      });
      return;
    }

    const mentionsMe = this.checkMentionsMe(message);

    const incomingMessage: IncomingMessage = {
      id: message.message_id,
      chatId: message.chat_id,
      sender: sender?.sender_id?.open_id || "",
      senderName: sender?.sender_id?.name || "",
      content,
      timestamp: new Date(
        parseInt(message.create_time),
      ).toISOString(),
      isFromMe: false,
      mentionsMe,
      raw: event,
    };

    log.info(TAG, "Parsed incoming message", {
      id: incomingMessage.id,
      chatId: incomingMessage.chatId,
      sender: incomingMessage.sender,
      senderName: incomingMessage.senderName,
      content: incomingMessage.content,
      timestamp: incomingMessage.timestamp,
      mentionsMe: incomingMessage.mentionsMe,
    });

    this.onMessage(this, incomingMessage);
  }

  private extractTextContent(message: any): string | null {
    try {
      return extractFeishuMessageContent(message);
    } catch {
      log.warn(TAG, "Failed to parse message content JSON", {
        messageId: message.message_id,
        content: message.content,
      });
      return null;
    }
  }

  private checkMentionsMe(message: any): boolean {
    if (!message.mentions) return false;
    const result = message.mentions.some(
      (m: any) => m.id?.open_id && m.name,
    );
    log.debug(TAG, "Mention check", {
      messageId: message.message_id,
      mentions: message.mentions,
      mentionsMe: result,
    });
    return result;
  }
}

export const __test__ = {
  extractFeishuMessageContent,
  normalizeExtractedContent,
  replaceMentionKeysWithNames,
  renderPostParagraph,
};
