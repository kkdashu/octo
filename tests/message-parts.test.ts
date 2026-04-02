import { describe, expect, test } from "bun:test";
import {
  isLocalMarkdownLinkTarget,
  normalizeLegacyImageSyntax,
  parseMessageParts,
} from "../src/message-parts";

describe("message parts helpers", () => {
  test("normalizes legacy IMAGE tags into markdown images", () => {
    const normalized = normalizeLegacyImageSyntax(
      "前文\n[IMAGE:/tmp/a.png]\n后文",
    );

    expect(normalized).toBe("前文\n![image](/tmp/a.png)\n后文");
  });

  test("parses markdown images and preserves text order", () => {
    const parts = parseMessageParts(
      "前文\n![screen](media/oc_test/om_1.png)\n后文",
    );

    expect(parts).toEqual([
      { type: "text", value: "前文\n" },
      { type: "image", value: "media/oc_test/om_1.png" },
      { type: "text", value: "\n后文" },
    ]);
  });

  test("parses local markdown file links as file parts", () => {
    const parts = parseMessageParts(
      "前文\n[report.pdf](./artifacts/report.pdf)\n后文",
    );

    expect(parts).toEqual([
      { type: "text", value: "前文\n" },
      {
        type: "file",
        label: "report.pdf",
        value: "./artifacts/report.pdf",
      },
      { type: "text", value: "\n后文" },
    ]);
  });

  test("does not parse remote markdown links as file parts", () => {
    const parts = parseMessageParts(
      "查看文档 [OpenAI](https://openai.com/docs) 然后继续",
    );

    expect(parts).toEqual([
      {
        type: "text",
        value: "查看文档 [OpenAI](https://openai.com/docs) 然后继续",
      },
    ]);
  });

  test("preserves image and file order when mixed", () => {
    const parts = parseMessageParts(
      "前文\n![screen](media/oc_test/om_1.png)\n[report](./out/report.pdf)\n后文",
    );

    expect(parts).toEqual([
      { type: "text", value: "前文\n" },
      { type: "image", value: "media/oc_test/om_1.png" },
      { type: "text", value: "\n" },
      { type: "file", label: "report", value: "./out/report.pdf" },
      { type: "text", value: "\n后文" },
    ]);
  });

  test("identifies local markdown link targets", () => {
    expect(isLocalMarkdownLinkTarget("./report.pdf")).toBe(true);
    expect(isLocalMarkdownLinkTarget("/tmp/report.pdf")).toBe(true);
    expect(isLocalMarkdownLinkTarget("media/oc_test/om_1.txt")).toBe(true);
    expect(isLocalMarkdownLinkTarget("https://openai.com")).toBe(false);
    expect(isLocalMarkdownLinkTarget("mailto:test@example.com")).toBe(false);
    expect(isLocalMarkdownLinkTarget("#section")).toBe(false);
  });
});
