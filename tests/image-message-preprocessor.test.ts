import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildImageUnderstandingCacheKey,
  IMAGE_UNDERSTANDING_PROMPT,
  preprocessMessageImages,
} from "../src/runtime/image-message-preprocessor";
import { initDatabase, upsertImageUnderstandingCache } from "../src/db";

function createTempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "octo-image-preprocessor-"));
}

describe("image message preprocessor", () => {
  test("replaces markdown images with structured text and caches the result", async () => {
    const workspaceDir = createTempWorkspace();
    const db = initDatabase(join(workspaceDir, "store", "messages.db"));
    const imageRelativePath = "media/oc_test/om_test.png";
    const imageAbsolutePath = join(workspaceDir, imageRelativePath);
    const calls: string[] = [];

    try {
      mkdirSync(join(workspaceDir, "media", "oc_test"), { recursive: true });
      writeFileSync(imageAbsolutePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const deps = {
        db,
        now: () => "2026-03-29T12:00:00.000Z",
        analyzeImage: {
          understandImage: async ({
            imagePath,
            prompt,
          }: {
            imagePath: string;
            prompt: string;
          }) => {
            calls.push(imagePath);
            expect(imagePath).toBe(imageAbsolutePath.replace(/\\/g, "/"));
            expect(prompt).toBe(IMAGE_UNDERSTANDING_PROMPT);
            return [
              "客观描述: 一只白猫趴在地上",
              "OCR文本: 无",
              "关键信息: 画面中没有票据或聊天界面",
            ].join("\n");
          },
        },
      };

      const first = await preprocessMessageImages(
        db,
        `前文\n![image](${imageRelativePath})\n后文`,
        workspaceDir,
        deps,
      );
      const second = await preprocessMessageImages(
        db,
        `前文\n![image](${imageRelativePath})\n后文`,
        workspaceDir,
        deps,
      );

      const expected = [
        "前文",
        "[图片理解结果]",
        `路径: ${imageRelativePath}`,
        "客观描述: 一只白猫趴在地上",
        "OCR文本: 无",
        "关键信息: 画面中没有票据或聊天界面",
        "[/图片理解结果]",
        "后文",
      ].join("\n");

      expect(first).toBe(expected);
      expect(second).toBe(expected);
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("normalizes legacy image syntax and ignores cache entries from older prompt versions", async () => {
    const workspaceDir = createTempWorkspace();
    const db = initDatabase(join(workspaceDir, "store", "messages.db"));
    const imageRelativePath = "media/oc_test/om_legacy.png";
    const imageAbsolutePath = join(workspaceDir, imageRelativePath);
    let callCount = 0;

    try {
      mkdirSync(join(workspaceDir, "media", "oc_test"), { recursive: true });
      const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x48]);
      writeFileSync(imageAbsolutePath, fileBytes);

      const fileSha256 = createHash("sha256").update(fileBytes).digest("hex");
      upsertImageUnderstandingCache(db, {
        cache_key: buildImageUnderstandingCacheKey(fileSha256, "v0"),
        image_path: imageRelativePath,
        file_sha256: fileSha256,
        prompt_version: "v0",
        analysis_text: "stale",
        created_at: "2026-03-29T11:59:00.000Z",
        updated_at: "2026-03-29T11:59:00.000Z",
      });

      const result = await preprocessMessageImages(
        db,
        `旧格式图片：[IMAGE:${imageRelativePath}]`,
        workspaceDir,
        {
          db,
          analyzeImage: {
            understandImage: async () => {
              callCount += 1;
              return [
                "客观描述: 白猫头戴彩色圈",
                "OCR文本: 无",
                "关键信息: 画面主体是猫，没有小票",
              ].join("\n");
            },
          },
        },
      );

      expect(result).toBe(
        [
          "旧格式图片：[图片理解结果]",
          `路径: ${imageRelativePath}`,
          "客观描述: 白猫头戴彩色圈",
          "OCR文本: 无",
          "关键信息: 画面主体是猫，没有小票",
          "[/图片理解结果]",
        ].join("\n"),
      );
      expect(callCount).toBe(1);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("returns read failure for non-media paths and missing files without calling recognizer", async () => {
    const workspaceDir = createTempWorkspace();
    const db = initDatabase(join(workspaceDir, "store", "messages.db"));
    let callCount = 0;

    try {
      const invalidPathResult = await preprocessMessageImages(
        db,
        "非法路径：![image](groups/test/image.png)",
        workspaceDir,
        {
          db,
          analyzeImage: {
            understandImage: async () => {
              callCount += 1;
              return "客观描述: 不应被调用";
            },
          },
        },
      );

      const missingFileResult = await preprocessMessageImages(
        db,
        "缺失文件：![image](media/oc_test/missing.png)",
        workspaceDir,
        {
          db,
          analyzeImage: {
            understandImage: async () => {
              callCount += 1;
              return "客观描述: 不应被调用";
            },
          },
        },
      );

      expect(invalidPathResult).toBe("非法路径：[图片读取失败: groups/test/image.png]");
      expect(missingFileResult).toBe("缺失文件：[图片读取失败: media/oc_test/missing.png]");
      expect(callCount).toBe(0);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("retries recognition after failures because failed results are not cached", async () => {
    const workspaceDir = createTempWorkspace();
    const db = initDatabase(join(workspaceDir, "store", "messages.db"));
    const imageRelativePath = "media/oc_test/om_fail.png";
    let callCount = 0;

    try {
      mkdirSync(join(workspaceDir, "media", "oc_test"), { recursive: true });
      writeFileSync(join(workspaceDir, imageRelativePath), Buffer.from([1, 2, 3]));

      const deps = {
        db,
        analyzeImage: {
          understandImage: async () => {
            callCount += 1;
            throw new Error("mcp failed");
          },
        },
      };

      const first = await preprocessMessageImages(
        db,
        `失败图片：![image](${imageRelativePath})`,
        workspaceDir,
        deps,
      );
      const second = await preprocessMessageImages(
        db,
        `失败图片：![image](${imageRelativePath})`,
        workspaceDir,
        deps,
      );

      expect(first).toBe(`失败图片：[图片理解失败: ${imageRelativePath}]`);
      expect(second).toBe(`失败图片：[图片理解失败: ${imageRelativePath}]`);
      expect(callCount).toBe(2);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("invalidates cache when file content changes under the same path", async () => {
    const workspaceDir = createTempWorkspace();
    const db = initDatabase(join(workspaceDir, "store", "messages.db"));
    const imageRelativePath = "media/oc_test/om_changed.png";
    const imageAbsolutePath = join(workspaceDir, imageRelativePath);
    let callCount = 0;

    try {
      mkdirSync(join(workspaceDir, "media", "oc_test"), { recursive: true });
      writeFileSync(imageAbsolutePath, Buffer.from([1, 2, 3]));

      const deps = {
        db,
        analyzeImage: {
          understandImage: async () => {
            callCount += 1;
            return [
              `客观描述: 第${callCount}版`,
              "OCR文本: 无",
              "关键信息: 无",
            ].join("\n");
          },
        },
      };

      const first = await preprocessMessageImages(
        db,
        `图片：![image](${imageRelativePath})`,
        workspaceDir,
        deps,
      );

      writeFileSync(imageAbsolutePath, Buffer.from([4, 5, 6]));

      const second = await preprocessMessageImages(
        db,
        `图片：![image](${imageRelativePath})`,
        workspaceDir,
        deps,
      );

      expect(first).toContain("客观描述: 第1版");
      expect(second).toContain("客观描述: 第2版");
      expect(callCount).toBe(2);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
