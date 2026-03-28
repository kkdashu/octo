import { describe, expect, test } from "bun:test";
import {
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
});
