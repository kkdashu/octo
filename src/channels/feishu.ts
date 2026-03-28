import * as lark from "@larksuiteoapi/node-sdk";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, posix, resolve } from "node:path";
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
type FetchLike = typeof fetch;
type FeishuTokenResponse = {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
};
type FeishuImageUploadResponse = {
  code?: number;
  msg?: string;
  data?: {
    image_key?: string;
  };
};
type FeishuImageContent = {
  image_key?: unknown;
};
type FeishuResponseHeaderValue = string | string[] | undefined;
type FeishuResponseHeaders = Record<string, FeishuResponseHeaderValue>;
type FeishuMessageResourceResponse = {
  writeFile: (filePath: string) => Promise<unknown>;
  headers: FeishuResponseHeaders;
};
type FeishuMessageResourceClient = {
  get: (payload: {
    params: {
      type: string;
    };
    path: {
      message_id: string;
      file_key: string;
    };
  }) => Promise<FeishuMessageResourceResponse>;
};
type FeishuMessageResourceRequestSummary = {
  message_id: string;
  file_key: string;
  type: "image";
};
type FeishuAxiosLikeResponse = {
  status?: unknown;
  statusText?: unknown;
  data?: unknown;
};
type FeishuMessageResourceErrorDetails = {
  message: string;
  httpStatus: number | null;
  httpStatusText: string | null;
  feishuCode: number | null;
  feishuMsg: string | null;
  responseDataPreview: string | null;
  requestSummary: FeishuMessageResourceRequestSummary;
  diagnosisHints: string[];
};

const MESSAGE_RESOURCE_ERROR_PREVIEW_LIMIT = 500;

class FeishuMessageResourceDownloadError extends Error {
  readonly details: FeishuMessageResourceErrorDetails;

  constructor(details: FeishuMessageResourceErrorDetails) {
    super(details.message);
    this.name = "FeishuMessageResourceDownloadError";
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readStringValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

function readNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || !/^-?\d+$/.test(normalized)) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function truncatePreview(text: string): string {
  return text.length > MESSAGE_RESOURCE_ERROR_PREVIEW_LIMIT
    ? `${text.slice(0, MESSAGE_RESOURCE_ERROR_PREVIEW_LIMIT)}...`
    : text;
}

function formatErrorPreviewValue(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? truncatePreview(normalized) : null;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  if (value instanceof Uint8Array) {
    return `[binary data length=${value.byteLength}]`;
  }

  if (isRecord(value) && typeof value.pipe === "function") {
    return "[stream response body]";
  }

  try {
    return truncatePreview(JSON.stringify(value));
  } catch {
    return "[unserializable response body]";
  }
}

function buildMessageResourceRequestSummary(
  messageId: string,
  fileKey: string,
): FeishuMessageResourceRequestSummary {
  return {
    message_id: messageId,
    file_key: fileKey,
    type: "image",
  };
}

function buildMessageResourceDiagnosisHints(
  feishuCode: number | null,
  hasRemoteResponse: boolean,
): string[] {
  switch (feishuCode) {
    case 230110:
      return ["消息已被删除，需确认 message_id 对应的原始消息仍然存在"];
    case 234001:
      return [
        "检查 message_id、file_key、type 是否符合接口文档要求",
        "若资源来自富文本消息，确认 file_key 使用的是 img 标签中的 image_key",
      ];
    case 234003:
      return [
        "file_key 不属于当前 message_id，重点检查两者是否完全匹配",
        "若消息是富文本 post，确认使用的是该消息内容中的 image_key",
      ];
    case 234004:
      return ["应用不在目标消息所在会话中，需检查 message_id 是否来自当前机器人可见会话"];
    case 234009:
      return ["当前接口不支持在外部群执行资源下载，请确认消息是否来自外部群"];
    case 234019:
      return ["飞书未获取到应用权限信息，请重试并检查应用发布、安装与授权状态"];
    case 234037:
      return ["资源文件超过 100 MB，当前接口不支持下载"];
    case 234038:
      return ["目标消息处于保密或防泄密模式，当前接口不允许下载其中资源"];
    case 234040:
      return ["当前操作者对该消息不可见，请检查历史消息可见性或群成员身份"];
    case 234041:
      return ["租户加密密钥异常，需联系租户管理员排查"];
    case 234042:
      return ["租户存储异常，需联系租户管理员或技术支持排查"];
    case 234043:
      return ["消息类型不受支持，重点检查是否为合并转发子消息或卡片消息"];
    default:
      if (!hasRemoteResponse) {
        return [
          "未拿到飞书响应体，请检查本地 media 目录写入权限、磁盘状态，或重试关注网络异常",
        ];
      }

      return [
        "检查机器人能力是否开启，并确认机器人与目标消息位于同一会话",
        "检查应用是否具备 im:message / im:message:readonly / im:message.history:readonly 之一",
        "检查 message_id、file_key、type 是否符合接口文档要求",
      ];
  }
}

function extractMessageResourceErrorDetails(
  err: unknown,
  requestSummary: FeishuMessageResourceRequestSummary,
): FeishuMessageResourceErrorDetails {
  if (err instanceof FeishuMessageResourceDownloadError) {
    return err.details;
  }

  const errorRecord = isRecord(err) ? err : null;
  const response = isRecord(errorRecord?.response)
    ? errorRecord.response as FeishuAxiosLikeResponse
    : null;
  const responseData = response?.data;
  const responseDataRecord = isRecord(responseData) ? responseData : null;
  const message = readStringValue(errorRecord?.message)
    ?? readStringValue(responseDataRecord?.msg)
    ?? "Unknown Feishu message resource error";
  const httpStatus = readNumberValue(response?.status);
  const httpStatusText = readStringValue(response?.statusText);
  const feishuCode = readNumberValue(responseDataRecord?.code);
  const feishuMsg = readStringValue(responseDataRecord?.msg);
  const responseDataPreview = formatErrorPreviewValue(responseData);
  const hasRemoteResponse = httpStatus !== null || responseDataPreview !== null;

  return {
    message,
    httpStatus,
    httpStatusText,
    feishuCode,
    feishuMsg,
    responseDataPreview,
    requestSummary,
    diagnosisHints: buildMessageResourceDiagnosisHints(
      feishuCode,
      hasRemoteResponse,
    ),
  };
}

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

async function renderPostParagraphWithImages(
  paragraph: unknown,
  resolveImageMarkdown: (imageKey: string) => Promise<string | null>,
): Promise<string> {
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

    if (tag === "img") {
      const normalizedInline = normalizeExtractedContent(inlineText);
      if (normalizedInline) {
        blocks.push(normalizedInline);
      }
      inlineText = "";

      const imageKey = typeof element.image_key === "string"
        ? element.image_key.trim()
        : "";
      if (!imageKey) {
        continue;
      }

      const imageMarkdown = await resolveImageMarkdown(imageKey);
      if (imageMarkdown) {
        blocks.push(imageMarkdown);
      }
      continue;
    }

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

async function extractPostMessageContentWithImages(
  message: FeishuMessagePayload,
  resolveImageMarkdown: (imageKey: string) => Promise<string | null>,
): Promise<string | null> {
  const parsed = parseFeishuMessageContent(message) as FeishuPostContent | null;
  const blocks: string[] = [];

  if (typeof parsed?.title === "string" && parsed.title.trim()) {
    blocks.push(parsed.title.trim());
  }

  if (Array.isArray(parsed?.content)) {
    for (const paragraph of parsed.content) {
      const rendered = await renderPostParagraphWithImages(
        paragraph,
        resolveImageMarkdown,
      );
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

function extractImageKeyFromMessage(message: FeishuMessagePayload): string | null {
  const parsed = parseFeishuMessageContent(message) as FeishuImageContent | null;
  const imageKey = typeof parsed?.image_key === "string"
    ? parsed.image_key.trim()
    : "";
  return imageKey || null;
}

function buildMarkdownImage(imagePath: string): string {
  return `![image](${imagePath})`;
}

function buildImageDownloadFailureText(imageKey: string): string {
  return `[图片下载失败:image_key=${imageKey}]`;
}

function inferImageExtension(contentType: string | null): string {
  const normalizedType = (contentType ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();

  switch (normalizedType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/bmp":
      return ".bmp";
    case "image/tiff":
      return ".tiff";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return ".ico";
    default:
      return ".png";
  }
}

function readHeaderValue(
  headers: FeishuResponseHeaders,
  name: string,
): string | null {
  const normalizedName = name.toLowerCase();

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() !== normalizedName) {
      continue;
    }

    if (typeof headerValue === "string") {
      return headerValue;
    }

    if (Array.isArray(headerValue)) {
      return headerValue[0] ?? null;
    }
  }

  return null;
}

async function downloadIncomingImageResource(
  messageResourceClient: FeishuMessageResourceClient,
  params: {
    messageId: string;
    imageKey: string;
    chatId: string;
    rootDir?: string;
  },
): Promise<string> {
  const rootDir = params.rootDir ?? process.cwd();
  const requestSummary = buildMessageResourceRequestSummary(
    params.messageId,
    params.imageKey,
  );
  let response: FeishuMessageResourceResponse;

  try {
    response = await messageResourceClient.get({
      path: {
        message_id: params.messageId,
        file_key: params.imageKey,
      },
      params: {
        type: "image",
      },
    });
  } catch (err) {
    throw new FeishuMessageResourceDownloadError(
      extractMessageResourceErrorDetails(err, requestSummary),
    );
  }

  const extension = inferImageExtension(
    readHeaderValue(response.headers, "content-type"),
  );
  const relativeDirectory = posix.join("media", params.chatId);
  const relativeFilePath = posix.join(
    relativeDirectory,
    `${params.messageId}${extension}`,
  );
  const absoluteDirectory = resolve(rootDir, relativeDirectory);
  const absoluteFilePath = resolve(rootDir, relativeFilePath);

  mkdirSync(absoluteDirectory, { recursive: true });
  await response.writeFile(absoluteFilePath);

  return relativeFilePath;
}

async function parseJsonResponse<T>(
  response: Response,
  endpoint: string,
): Promise<T> {
  const rawText = await response.text();
  try {
    return JSON.parse(rawText) as T;
  } catch {
    throw new Error(
      `Failed to parse Feishu ${endpoint} response as JSON (status=${response.status}): ${rawText.slice(0, 300)}`,
    );
  }
}

function inferImageMimeType(filePath: string): string {
  const normalizedPath = filePath.toLowerCase();
  if (normalizedPath.endsWith(".png")) return "image/png";
  if (normalizedPath.endsWith(".jpg") || normalizedPath.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (normalizedPath.endsWith(".webp")) return "image/webp";
  if (normalizedPath.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

async function getTenantAccessToken(
  config: Pick<FeishuChannelConfig, "appId" | "appSecret">,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const response = await fetchImpl(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret,
      }),
    },
  );

  const payload = await parseJsonResponse<FeishuTokenResponse>(
    response,
    "tenant_access_token/internal",
  );
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(
      `Failed to get tenant_access_token: code=${payload.code ?? "unknown"}, msg=${payload.msg ?? "unknown"}`,
    );
  }

  return payload.tenant_access_token;
}

async function uploadImageWithFetch(
  config: Pick<FeishuChannelConfig, "appId" | "appSecret">,
  filePath: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const token = await getTenantAccessToken(config, fetchImpl);
  const imageBuffer = readFileSync(filePath);
  const form = new FormData();
  form.append("image_type", "message");
  form.append(
    "image",
    new Blob([imageBuffer], { type: inferImageMimeType(filePath) }),
    basename(filePath) || "image",
  );

  const response = await fetchImpl(
    "https://open.feishu.cn/open-apis/im/v1/images",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: form,
    },
  );

  const payload = await parseJsonResponse<FeishuImageUploadResponse>(
    response,
    "im/v1/images",
  );
  const imageKey = payload.data?.image_key;
  if (payload.code !== 0 || !imageKey) {
    throw new Error(
      `Failed to upload image: code=${payload.code ?? "unknown"}, msg=${payload.msg ?? "unknown"}, filePath=${filePath}`,
    );
  }

  return imageKey;
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
    // const eventDispatcher = this.eventDispatcher;

    // this.server = Bun.serve({
    //   port: config.port,
    //   routes: {
    //     [config.webhookPath]: {
    //       POST: async (req: Request) => {
    //         const body = (await req.json()) as Record<string, any>;

    //         log.debug(TAG, "Webhook POST received", {
    //           type: body.type,
    //           hasChallenge: !!body.challenge,
    //           hasEvent: !!body.event,
    //           headers: Object.fromEntries(req.headers),
    //           body,
    //         });

    //         // Handle URL verification challenge
    //         if (body.type === "url_verification") {
    //           log.info(TAG, "URL verification challenge received, responding with challenge");
    //           return Response.json({ challenge: body.challenge });
    //         }

    //         const data = {
    //           headers: Object.fromEntries(req.headers),
    //           body,
    //         };

    //         // Respond immediately, process asynchronously
    //         eventDispatcher.invoke(data).catch((err: unknown) => {
    //           log.error(TAG, "EventDispatcher.invoke() error", err);
    //         });

    //         return new Response("OK", { status: 200 });
    //       },
    //     },
    //   },
    // });

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

      const imageKey = await uploadImageWithFetch(this.config, filePath);

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

    const content = await this.extractIncomingContent(message);
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

  private async extractIncomingContent(
    message: {
      message_id?: string;
      chat_id?: string;
      message_type?: string;
      content?: string;
      mentions?: unknown;
    },
  ): Promise<string | null> {
    if (message?.message_type === "image") {
      return this.extractImageContent(message);
    }

    if (message?.message_type === "post") {
      return this.extractPostContent(message);
    }

    return this.extractTextContent(message);
  }

  private async extractPostContent(
    message: {
      message_id?: string;
      chat_id?: string;
      content?: string;
      mentions?: unknown;
    },
  ): Promise<string | null> {
    try {
      return await extractPostMessageContentWithImages(
        message,
        async (imageKey) => {
          const messageId = typeof message.message_id === "string"
            ? message.message_id.trim()
            : "";
          const chatId = typeof message.chat_id === "string"
            ? message.chat_id.trim()
            : "";
          if (!messageId || !chatId) {
            return buildImageDownloadFailureText(imageKey);
          }

          const requestSummary = buildMessageResourceRequestSummary(
            messageId,
            imageKey,
          );

          try {
            const relativeFilePath = await downloadIncomingImageResource(
              this.client.im.messageResource as FeishuMessageResourceClient,
              {
                messageId,
                imageKey,
                chatId,
              },
            );
            return buildMarkdownImage(relativeFilePath);
          } catch (err) {
            log.error(TAG, "Failed to download post image resource", {
              ...extractMessageResourceErrorDetails(err, requestSummary),
              chatId,
            });
            return buildImageDownloadFailureText(imageKey);
          }
        },
      );
    } catch {
      log.warn(TAG, "Failed to parse post message content JSON", {
        messageId: message.message_id,
        content: message.content,
      });
      return null;
    }
  }

  private async extractImageContent(
    message: {
      message_id?: string;
      chat_id?: string;
      content?: string;
    },
  ): Promise<string | null> {
    const messageId = typeof message.message_id === "string"
      ? message.message_id.trim()
      : "";
    const chatId = typeof message.chat_id === "string"
      ? message.chat_id.trim()
      : "";

    if (!messageId || !chatId) {
      log.warn(TAG, "Image message missing message_id or chat_id", {
        messageId: message.message_id,
        chatId: message.chat_id,
      });
      return null;
    }

    let imageKey: string | null = null;
    try {
      imageKey = extractImageKeyFromMessage(message);
    } catch {
      log.warn(TAG, "Failed to parse image message content JSON", {
        messageId,
        content: message.content,
      });
      return null;
    }

    if (!imageKey) {
      log.warn(TAG, "Image message missing image_key", {
        messageId,
        chatId,
        content: message.content,
      });
      return null;
    }

    const requestSummary = buildMessageResourceRequestSummary(
      messageId,
      imageKey,
    );

    try {
      const relativeFilePath = await downloadIncomingImageResource(
        this.client.im.messageResource as FeishuMessageResourceClient,
        {
          messageId,
          imageKey,
          chatId,
        },
      );

      return buildMarkdownImage(relativeFilePath);
    } catch (err) {
      log.error(TAG, "Failed to download incoming image message", {
        ...extractMessageResourceErrorDetails(err, requestSummary),
        chatId,
      });
      return buildImageDownloadFailureText(imageKey);
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
  buildImageDownloadFailureText,
  buildMarkdownImage,
  buildMessageResourceDiagnosisHints,
  buildMessageResourceRequestSummary,
  downloadIncomingImageResource,
  extractImageKeyFromMessage,
  extractMessageResourceErrorDetails,
  extractFeishuMessageContent,
  extractPostMessageContentWithImages,
  getTenantAccessToken,
  inferImageExtension,
  normalizeExtractedContent,
  renderPostParagraphWithImages,
  replaceMentionKeysWithNames,
  renderPostParagraph,
  uploadImageWithFetch,
};
