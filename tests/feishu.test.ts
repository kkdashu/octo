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
