import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test__ as feishuTestHelpers } from "../src/channels/feishu";

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
          [{ tag: "img", image_key: "img_123" }],
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
