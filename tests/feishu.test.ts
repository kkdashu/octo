import { describe, expect, test } from "bun:test";
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
