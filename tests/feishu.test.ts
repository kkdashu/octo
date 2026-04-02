import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __test__ as feishuTestHelpers,
  FeishuChannel,
} from "../src/channels/feishu";

describe("Feishu message content extraction", () => {
  test("extracts plain text messages", () => {
    const content = feishuTestHelpers.extractFeishuMessageContent({
      message_type: "text",
      content: JSON.stringify({ text: "hello world" }),
    });

    expect(content).toBe("hello world");
  });

  test("replaces text mention placeholders with display names", () => {
    const content = feishuTestHelpers.extractFeishuMessageContent({
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 使用adb命令查询一下你连接了哪些手机" }),
      mentions: [
        {
          key: "@_user_1",
          name: "octo",
        },
      ],
    });

    expect(content).toBe("@octo 使用adb命令查询一下你连接了哪些手机");
  });

  test("replaces multiple text mention placeholders", () => {
    const content = feishuTestHelpers.extractFeishuMessageContent({
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 帮我找 @_user_2" }),
      mentions: [
        {
          key: "@_user_1",
          name: "octo",
        },
        {
          key: "@_user_2",
          name: "王蒙",
        },
      ],
    });

    expect(content).toBe("@octo 帮我找 @王蒙");
  });

  test("keeps raw mention placeholder when display name is missing", () => {
    const content = feishuTestHelpers.extractFeishuMessageContent({
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 在吗" }),
      mentions: [
        {
          key: "@_user_1",
        },
      ],
    });

    expect(content).toBe("@_user_1 在吗");
  });

  test("extracts post messages with multiple paragraphs", () => {
    const content = feishuTestHelpers.extractFeishuMessageContent({
      message_type: "post",
      content: JSON.stringify({
        title: "",
        content: [
          [{ tag: "text", text: "第一段" }],
          [{ tag: "text", text: "第二段" }],
        ],
      }),
    });

    expect(content).toBe("第一段\n第二段");
  });

  test("extracts post code blocks as fenced code", () => {
    const content = feishuTestHelpers.extractFeishuMessageContent({
      message_type: "post",
      content: JSON.stringify({
        title: "需求说明",
        content: [
          [{ tag: "text", text: "例如" }],
          [{
            tag: "code_block",
            language: "PLAIN_TEXT",
            text: "console.log('hi');\nconsole.log('bye');\n",
          }],
        ],
      }),
    });

    expect(content).toBe(
      "需求说明\n例如\n```PLAIN_TEXT\nconsole.log('hi');\nconsole.log('bye');\n```",
    );
  });

  test("returns null when post message has only unsupported tags", () => {
    const content = feishuTestHelpers.extractFeishuMessageContent({
      message_type: "post",
      content: JSON.stringify({
        title: "",
        content: [
          [{ tag: "emotion", emoji_type: "SMILE" }],
        ],
      }),
    });

    expect(content).toBeNull();
  });

  test("returns null for invalid json payload", () => {
    expect(() =>
      feishuTestHelpers.extractFeishuMessageContent({
        message_type: "post",
        content: "{invalid json}",
      }),
    ).toThrow();
  });

  test("normalizes repeated blank lines", () => {
    const normalized = feishuTestHelpers.normalizeExtractedContent(
      "\n\n第一段\n\n\n\n第二段\n\n",
    );

    expect(normalized).toBe("第一段\n\n第二段");
  });
});

describe("Feishu image upload helpers", () => {
  const originalFetch = globalThis.fetch;
  const cleanupDirs: string[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("gets tenant access token via fetch", async () => {
    globalThis.fetch = (async (input) => {
      expect(String(input)).toBe(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      );
      return new Response(
        JSON.stringify({
          code: 0,
          tenant_access_token: "tenant-token",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const token = await feishuTestHelpers.getTenantAccessToken({
      appId: "app-id",
      appSecret: "app-secret",
    });

    expect(token).toBe("tenant-token");
  });

  test("uploads image with fetch and returns image key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octo-feishu-upload-"));
    cleanupDirs.push(dir);
    const filePath = join(dir, "screen.png");
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init });

      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: "tenant-token",
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          code: 0,
          data: { image_key: "img_v3_key" },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const imageKey = await feishuTestHelpers.uploadImageWithFetch(
      {
        appId: "app-id",
        appSecret: "app-secret",
      },
      filePath,
    );

    expect(imageKey).toBe("img_v3_key");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://open.feishu.cn/open-apis/im/v1/images");
    expect(calls[1]?.init?.headers).toEqual({
      Authorization: "Bearer tenant-token",
    });
    expect(calls[1]?.init?.body).toBeInstanceOf(FormData);

    const body = calls[1]?.init?.body as FormData;
    expect(body.get("image_type")).toBe("message");
    expect(body.get("image")).toBeInstanceOf(File);
  });

  test("surfaces upload failure details", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octo-feishu-upload-"));
    cleanupDirs.push(dir);
    const filePath = join(dir, "screen.png");
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: "tenant-token",
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          code: 99991663,
          msg: "invalid image",
        }),
        { status: 400 },
      );
    }) as typeof fetch;

    await expect(
      feishuTestHelpers.uploadImageWithFetch(
        {
          appId: "app-id",
          appSecret: "app-secret",
        },
        filePath,
      ),
    ).rejects.toThrow("Failed to upload image: code=99991663, msg=invalid image");
  });
});

describe("Feishu file upload helpers", () => {
  const originalFetch = globalThis.fetch;
  const cleanupDirs: string[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("uploads file with fetch and returns file key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octo-feishu-file-upload-"));
    cleanupDirs.push(dir);
    const filePath = join(dir, "report.pdf");
    writeFileSync(filePath, Buffer.from("%PDF"));

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init });

      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: "tenant-token",
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          code: 0,
          data: { file_key: "file_v3_key" },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const fileKey = await feishuTestHelpers.uploadFileWithFetch(
      {
        appId: "app-id",
        appSecret: "app-secret",
      },
      filePath,
    );

    expect(fileKey).toBe("file_v3_key");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://open.feishu.cn/open-apis/im/v1/files");
    expect(calls[1]?.init?.headers).toEqual({
      Authorization: "Bearer tenant-token",
    });
    expect(calls[1]?.init?.body).toBeInstanceOf(FormData);

    const body = calls[1]?.init?.body as FormData;
    expect(body.get("file_type")).toBe("pdf");
    expect(body.get("file_name")).toBe("report.pdf");
    expect(body.get("file")).toBeInstanceOf(File);
  });

  test("surfaces file upload failure details", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octo-feishu-file-upload-"));
    cleanupDirs.push(dir);
    const filePath = join(dir, "report.pdf");
    writeFileSync(filePath, Buffer.from("%PDF"));

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: "tenant-token",
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          code: 99991664,
          msg: "invalid file",
        }),
        { status: 400 },
      );
    }) as typeof fetch;

    await expect(
      feishuTestHelpers.uploadFileWithFetch(
        {
          appId: "app-id",
          appSecret: "app-secret",
        },
        filePath,
      ),
    ).rejects.toThrow("Failed to upload file: code=99991664, msg=invalid file");
  });

  test("infers feishu file type from extension", () => {
    expect(feishuTestHelpers.inferFeishuFileType("/tmp/report.pdf")).toBe("pdf");
    expect(feishuTestHelpers.inferFeishuFileType("/tmp/report.docx")).toBe("doc");
    expect(feishuTestHelpers.inferFeishuFileType("/tmp/sheet.xlsx")).toBe("xls");
    expect(feishuTestHelpers.inferFeishuFileType("/tmp/slides.pptx")).toBe("ppt");
    expect(feishuTestHelpers.inferFeishuFileType("/tmp/notes.md")).toBe("stream");
    expect(feishuTestHelpers.inferFeishuFileType("/tmp/build.log")).toBe("stream");
    expect(feishuTestHelpers.inferFeishuFileType("/tmp/README")).toBe("stream");
  });
});

describe("Feishu incoming image helpers", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("extracts image key from image messages", () => {
    const imageKey = feishuTestHelpers.extractImageKeyFromMessage({
      message_type: "image",
      content: JSON.stringify({ image_key: "img_v3_123" }),
    });

    expect(imageKey).toBe("img_v3_123");
  });

  test("extracts file payload from file messages", () => {
    const payload = feishuTestHelpers.extractFilePayloadFromMessage({
      message_type: "file",
      content: JSON.stringify({
        file_key: "file_v3_123",
        file_name: "report.pdf",
      }),
    });

    expect(payload).toEqual({
      fileKey: "file_v3_123",
      fileName: "report.pdf",
    });
  });

  test("downloads incoming image resources into media directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octo-feishu-incoming-"));
    cleanupDirs.push(dir);

    let requestedPayload:
      | {
          params: { type: string };
          path: { message_id: string; file_key: string };
        }
      | undefined;

    const relativeFilePath = await feishuTestHelpers.downloadIncomingImageResource(
      {
        get: async (payload) => {
          requestedPayload = payload;
          return {
            headers: {
              "content-type": "image/webp; charset=binary",
            },
            writeFile: async (filePath: string) => {
              writeFileSync(filePath, Buffer.from("RIFF", "utf-8"));
            },
          };
        },
      },
      {
        messageId: "om_test",
        imageKey: "img_v3_test",
        chatId: "oc_test",
        rootDir: dir,
      },
    );

    expect(requestedPayload).toEqual({
      path: {
        message_id: "om_test",
        file_key: "img_v3_test",
      },
      params: {
        type: "image",
      },
    });
    expect(relativeFilePath).toBe("media/oc_test/om_test.webp");
    expect(
      readFileSync(join(dir, "media", "oc_test", "om_test.webp"), "utf-8"),
    ).toBe("RIFF");
  });

  test("downloads incoming file resources into media directory with sanitized file name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octo-feishu-incoming-file-"));
    cleanupDirs.push(dir);

    let requestedPayload:
      | {
          params: { type: string };
          path: { message_id: string; file_key: string };
        }
      | undefined;

    const relativeFilePath = await feishuTestHelpers.downloadIncomingMessageResource(
      {
        get: async (payload) => {
          requestedPayload = payload;
          return {
            headers: {
              "content-type": "application/pdf",
            },
            writeFile: async (filePath: string) => {
              writeFileSync(filePath, Buffer.from("%PDF"));
            },
          };
        },
      },
      {
        messageId: "om_file",
        fileKey: "file_v3_test",
        chatId: "oc_test",
        resourceType: "file",
        preferredFileName: "财务/报告.pdf",
        rootDir: dir,
      },
    );

    expect(requestedPayload).toEqual({
      path: {
        message_id: "om_file",
        file_key: "file_v3_test",
      },
      params: {
        type: "file",
      },
    });
    expect(relativeFilePath).toBe("media/oc_test/om_file-财务_报告.pdf");
    expect(
      readFileSync(join(dir, "media", "oc_test", "om_file-财务_报告.pdf"), "utf-8"),
    ).toBe("%PDF");
  });

  test("extracts feishu business error details from message resource failures", () => {
    const requestSummary = feishuTestHelpers.buildMessageResourceRequestSummary(
      "om_test",
      "img_v3_test",
    );

    const details = feishuTestHelpers.extractMessageResourceErrorDetails(
      {
        message: "Request failed with status code 400",
        response: {
          status: 400,
          statusText: "Bad Request",
          data: {
            code: 234003,
            msg: "File not in message.",
          },
        },
      },
      requestSummary,
    );

    expect(details).toMatchObject({
      message: "Request failed with status code 400",
      httpStatus: 400,
      httpStatusText: "Bad Request",
      feishuCode: 234003,
      feishuMsg: "File not in message.",
      requestSummary,
    });
    expect(details.responseDataPreview).toContain('"code":234003');
    expect(details.diagnosisHints).toEqual(
      expect.arrayContaining([
        "file_key 不属于当前 message_id，重点检查两者是否完全匹配",
      ]),
    );
  });

  test("wraps message resource request failures with structured details", async () => {
    let thrown: unknown;

    try {
      await feishuTestHelpers.downloadIncomingImageResource(
        {
          get: async () => {
            throw {
              message: "Request failed with status code 400",
              response: {
                status: 400,
                statusText: "Bad Request",
                data: {
                  code: 234043,
                  msg: "Unsupported message type.",
                },
              },
            };
          },
        },
        {
          messageId: "om_test",
          imageKey: "img_v3_test",
          chatId: "oc_test",
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({
      name: "FeishuMessageResourceDownloadError",
      details: {
        httpStatus: 400,
        feishuCode: 234043,
        requestSummary: {
          message_id: "om_test",
          file_key: "img_v3_test",
          type: "image",
        },
        diagnosisHints: expect.arrayContaining([
          "消息类型不受支持，重点检查是否为合并转发子消息或卡片消息",
        ]),
      },
    });
  });

  test("formats downloaded image paths as markdown", () => {
    expect(
      feishuTestHelpers.buildMarkdownImage("media/oc_test/om_test.png"),
    ).toBe("![image](media/oc_test/om_test.png)");
  });

  test("formats downloaded file paths as markdown links", () => {
    expect(
      feishuTestHelpers.buildMarkdownFileLink(
        "report.pdf",
        "media/oc_test/om_file-report.pdf",
      ),
    ).toBe("[report.pdf](media/oc_test/om_file-report.pdf)");
  });

  test("formats file download failure text with file name when available", () => {
    expect(
      feishuTestHelpers.buildFileDownloadFailureText("file_v3_test", "report.pdf"),
    ).toBe("[文件下载失败:file_key=file_v3_test,file_name=report.pdf]");
  });

  test("sanitizes incoming file names for local storage", () => {
    expect(
      feishuTestHelpers.sanitizeIncomingFileName("财务/报告?.pdf"),
    ).toBe("财务_报告_.pdf");
    expect(feishuTestHelpers.sanitizeIncomingFileName("   ")).toBe("unnamed.bin");
  });

  test("extracts post messages with image tags and text", async () => {
    const content = await feishuTestHelpers.extractPostMessageContentWithImages(
      {
        message_type: "post",
        content: JSON.stringify({
          title: "",
          content: [
            [{ tag: "img", image_key: "img_v3_123" }],
            [{ tag: "text", text: "这是什么" }],
          ],
        }),
      },
      async (imageKey: string) => `![image](media/oc_test/${imageKey}.png)`,
    );

    expect(content).toBe("![image](media/oc_test/img_v3_123.png)\n这是什么");
  });

  test("renders image download failure text when post image resolver fails", async () => {
    const content = await feishuTestHelpers.extractPostMessageContentWithImages(
      {
        message_type: "post",
        content: JSON.stringify({
          title: "",
          content: [
            [{ tag: "img", image_key: "img_v3_123" }],
          ],
        }),
      },
      async () => "[图片下载失败:image_key=img_v3_123]",
    );

    expect(content).toBe("[图片下载失败:image_key=img_v3_123]");
  });

  test("falls back to png extension when content type is unknown", () => {
    expect(feishuTestHelpers.inferImageExtension(null)).toBe(".png");
    expect(
      feishuTestHelpers.inferImageExtension("application/octet-stream"),
    ).toBe(".png");
  });

  test("falls back to local diagnostic hints when error only has a message", () => {
    const requestSummary = feishuTestHelpers.buildMessageResourceRequestSummary(
      "om_test",
      "img_v3_test",
    );

    const details = feishuTestHelpers.extractMessageResourceErrorDetails(
      new Error("disk full"),
      requestSummary,
    );

    expect(details).toMatchObject({
      message: "disk full",
      httpStatus: null,
      httpStatusText: null,
      feishuCode: null,
      feishuMsg: null,
      requestSummary,
    });
    expect(details.diagnosisHints).toEqual(
      expect.arrayContaining([
        "未拿到飞书响应体，请检查本地 media 目录写入权限、磁盘状态，或重试关注网络异常",
      ]),
    );
  });

  test("keeps file request type in structured error details", () => {
    const requestSummary = feishuTestHelpers.buildMessageResourceRequestSummary(
      "om_test",
      "file_v3_test",
      "file",
    );

    const details = feishuTestHelpers.extractMessageResourceErrorDetails(
      {
        message: "Request failed with status code 400",
        response: {
          status: 400,
          statusText: "Bad Request",
          data: {
            code: 234003,
            msg: "File not in message.",
          },
        },
      },
      requestSummary,
    );

    expect(details.requestSummary.type).toBe("file");
    expect(details.diagnosisHints).toEqual(
      expect.arrayContaining([
        "若消息是 file，确认使用的是该消息内容中的 file_key",
      ]),
    );
  });
});

describe("Feishu quoted file message helpers", () => {
  test("prefers parent_id when reading quoted message id", () => {
    expect(
      feishuTestHelpers.readQuotedMessageId({
        message_id: "om_current",
        parent_id: " om_parent ",
        root_id: "om_root",
      }),
    ).toBe("om_parent");
  });

  test("falls back to root_id when parent_id is missing", () => {
    expect(
      feishuTestHelpers.readQuotedMessageId({
        message_id: "om_current",
        root_id: " om_root ",
      }),
    ).toBe("om_root");
  });

  test("returns null when quoted id equals current message id", () => {
    expect(
      feishuTestHelpers.readQuotedMessageId({
        message_id: "om_same",
        parent_id: "om_same",
      }),
    ).toBeNull();
  });

  test("normalizes fetched referenced file messages", () => {
    expect(
      feishuTestHelpers.normalizeReferencedMessage(
        {
          message_id: "om_parent",
          chat_id: "oc_test",
          msg_type: "file",
          body: {
            content: JSON.stringify({
              file_key: "file_v3_parent",
              file_name: "report.pdf",
            }),
          },
        },
      ),
    ).toEqual({
      message_id: "om_parent",
      chat_id: "oc_test",
      message_type: "file",
      content: JSON.stringify({
        file_key: "file_v3_parent",
        file_name: "report.pdf",
      }),
    });
  });

  test("uses fallback chat_id when fetched message omits chat_id", () => {
    expect(
      feishuTestHelpers.normalizeReferencedMessage(
        {
          message_id: "om_parent",
          msg_type: "file",
          body: {
            content: JSON.stringify({
              file_key: "file_v3_parent",
              file_name: "report.pdf",
            }),
          },
        },
        "oc_fallback",
      ),
    ).toEqual({
      message_id: "om_parent",
      chat_id: "oc_fallback",
      message_type: "file",
      content: JSON.stringify({
        file_key: "file_v3_parent",
        file_name: "report.pdf",
      }),
    });
  });

  test("fetches referenced message and maps it into webhook-like payload", async () => {
    const message = await feishuTestHelpers.fetchReferencedMessage(
      {
        get: async ({ path }) => {
          expect(path).toEqual({ message_id: "om_parent" });
          return {
            data: {
              items: [
                {
                  message_id: "om_parent",
                  chat_id: "oc_test",
                  msg_type: "file",
                  body: {
                    content: "{\"file_key\":\"file_v3_parent\",\"file_name\":\"report.pdf\"}",
                  },
                },
              ],
            },
          };
        },
      },
      "om_parent",
    );

    expect(message).toEqual({
      message_id: "om_parent",
      chat_id: "oc_test",
      message_type: "file",
      content: "{\"file_key\":\"file_v3_parent\",\"file_name\":\"report.pdf\"}",
    });
  });

  test("returns null when referenced message query has no items", async () => {
    await expect(
      feishuTestHelpers.fetchReferencedMessage(
        {
          get: async () => ({
            data: {
              items: [],
            },
          }),
        },
        "om_parent",
      ),
    ).resolves.toBeNull();
  });

  test("builds referenced file message content with current text", () => {
    expect(
      feishuTestHelpers.buildReferencedFileMessageContent({
        referencedFileMarkdown: "[report.pdf](media/oc_test/om_parent-report.pdf)",
        currentText: "@octo 帮我转成Markdown",
      }),
    ).toBe(
      "引用文件：\n[report.pdf](media/oc_test/om_parent-report.pdf)\n\n当前消息：\n@octo 帮我转成Markdown",
    );
  });

  test("builds referenced file message content without current text", () => {
    expect(
      feishuTestHelpers.buildReferencedFileMessageContent({
        referencedFileMarkdown: "[report.pdf](media/oc_test/om_parent-report.pdf)",
        currentText: "   ",
      }),
    ).toBe("引用文件：\n[report.pdf](media/oc_test/om_parent-report.pdf)");
  });
});

describe("Feishu quoted file message flow", () => {
  test("enhances text messages with referenced file markdown", async () => {
    const content = await (FeishuChannel.prototype as unknown as {
      extractIncomingContent: (
        this: {
          extractTextContent: (message: unknown) => string | null;
          resolveReferencedFileContent: (message: unknown) => Promise<string | null>;
        },
        message: unknown,
      ) => Promise<string | null>;
    }).extractIncomingContent.call(
      {
        extractTextContent: (message) =>
          feishuTestHelpers.extractFeishuMessageContent(
            message as {
              message_type?: string;
              content?: string;
              mentions?: unknown;
            },
          ),
        resolveReferencedFileContent: async () =>
          "[report.pdf](media/oc_test/om_parent-report.pdf)",
      },
      {
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 帮我转成Markdown" }),
        mentions: [
          {
            key: "@_user_1",
            name: "octo",
          },
        ],
      },
    );

    expect(content).toBe(
      "引用文件：\n[report.pdf](media/oc_test/om_parent-report.pdf)\n\n当前消息：\n@octo 帮我转成Markdown",
    );
  });

  test("falls back to current text when referenced file resolution fails", async () => {
    const content = await (FeishuChannel.prototype as unknown as {
      extractIncomingContent: (
        this: {
          extractTextContent: (message: unknown) => string | null;
          resolveReferencedFileContent: (message: unknown) => Promise<string | null>;
        },
        message: unknown,
      ) => Promise<string | null>;
    }).extractIncomingContent.call(
      {
        extractTextContent: (message) =>
          feishuTestHelpers.extractFeishuMessageContent(
            message as {
              message_type?: string;
              content?: string;
              mentions?: unknown;
            },
          ),
        resolveReferencedFileContent: async () => null,
      },
      {
        message_type: "text",
        content: JSON.stringify({ text: "帮我转成Markdown" }),
      },
    );

    expect(content).toBe("帮我转成Markdown");
  });

  test("resolves referenced file messages via message.get and extractFileContent", async () => {
    const referencedFileMarkdown = await (FeishuChannel.prototype as unknown as {
      resolveReferencedFileContent: (
        this: {
          client: {
            im: {
              message: {
                get: (payload: { path: { message_id: string } }) => Promise<unknown>;
              };
            };
          };
          extractFileContent: (message: unknown) => Promise<string | null>;
        },
        message: unknown,
      ) => Promise<string | null>;
    }).resolveReferencedFileContent.call(
      {
        client: {
          im: {
            message: {
              get: async ({ path }) => {
                expect(path).toEqual({ message_id: "om_parent" });
                return {
                  data: {
                    items: [
                      {
                        message_id: "om_parent",
                        chat_id: "oc_test",
                        msg_type: "file",
                        body: {
                          content: JSON.stringify({
                            file_key: "file_v3_parent",
                            file_name: "report.pdf",
                          }),
                        },
                      },
                    ],
                  },
                };
              },
            },
          },
        },
        extractFileContent: async (message) => {
          expect(message).toEqual({
            message_id: "om_parent",
            chat_id: "oc_test",
            message_type: "file",
            content: JSON.stringify({
              file_key: "file_v3_parent",
              file_name: "report.pdf",
            }),
          });
          return "[report.pdf](media/oc_test/om_parent-report.pdf)";
        },
      },
      {
        message_id: "om_current",
        chat_id: "oc_test",
        message_type: "text",
        content: JSON.stringify({ text: "帮我转成Markdown" }),
        parent_id: "om_parent",
      },
    );

    expect(referencedFileMarkdown).toBe(
      "[report.pdf](media/oc_test/om_parent-report.pdf)",
    );
  });

  test("returns null when referenced message is not a file", async () => {
    const referencedFileMarkdown = await (FeishuChannel.prototype as unknown as {
      resolveReferencedFileContent: (
        this: {
          client: {
            im: {
              message: {
                get: (payload: { path: { message_id: string } }) => Promise<unknown>;
              };
            };
          };
          extractFileContent: (message: unknown) => Promise<string | null>;
        },
        message: unknown,
      ) => Promise<string | null>;
    }).resolveReferencedFileContent.call(
      {
        client: {
          im: {
            message: {
              get: async () => ({
                data: {
                  items: [
                    {
                      message_id: "om_parent",
                      chat_id: "oc_test",
                      msg_type: "text",
                      body: {
                        content: JSON.stringify({
                          text: "普通文本",
                        }),
                      },
                    },
                  ],
                },
              }),
            },
          },
        },
        extractFileContent: async () => {
          throw new Error("should not be called");
        },
      },
      {
        message_id: "om_current",
        chat_id: "oc_test",
        message_type: "text",
        content: JSON.stringify({ text: "帮我转成Markdown" }),
        parent_id: "om_parent",
      },
    );

    expect(referencedFileMarkdown).toBeNull();
  });
});
