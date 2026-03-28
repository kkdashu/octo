import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  getImageUnderstandingCache,
  upsertImageUnderstandingCache,
} from "../db";
import { log } from "../logger";
import { normalizeLegacyImageSyntax, parseMessageParts } from "../message-parts";
import type { ImageUnderstandingClient } from "./minimax-token-plan-mcp";

const TAG = "image-message-preprocessor";

export const IMAGE_UNDERSTANDING_PROMPT_VERSION = "v1";
export const IMAGE_UNDERSTANDING_PROMPT = `
你是图片理解预处理器。你的任务是只基于图片本身输出客观信息，禁止猜测对话意图、拍摄背景、用户目的或图片外信息。

请严格按以下格式输出：
客观描述: <一句到两句，描述画面主体、布局、可见对象，不做推断>
OCR文本: <逐行列出图片中清晰可读的文字；如果没有则写“无”>
关键信息: <只列出与图片本身直接相关的可观察事实，例如时间、状态、按钮、票据字段、界面元素、异常提示；如果没有则写“无”>

规则：
1. 看不清的内容写“无法辨认”，不要猜。
2. 不要总结用户意图，不要解释图片“想表达什么”。
3. 不要使用“看起来像是在提醒”“似乎表示”这类推断句式。
4. 输出必须简洁、客观、稳定。
`.trim();

export interface ResolvedImagePath {
  relativePath: string;
  absolutePath: string;
}

export interface ParsedImageUnderstanding {
  objectiveDescription: string;
  ocrText: string;
  keyInformation: string;
}

export interface ImageMessagePreprocessorDeps {
  analyzeImage: ImageUnderstandingClient;
  db: Database;
  now?: () => string;
}

export interface ImageMessagePreprocessor {
  preprocess(text: string, rootDir: string): Promise<string>;
}

const IMAGE_OUTPUT_LABELS = ["客观描述", "OCR文本", "关键信息"] as const;

export class DatabaseImageMessagePreprocessor implements ImageMessagePreprocessor {
  constructor(
    private readonly deps: ImageMessagePreprocessorDeps,
  ) {}

  preprocess(text: string, rootDir: string): Promise<string> {
    return preprocessMessageImages(this.deps.db, text, rootDir, this.deps);
  }
}

export function buildImageUnderstandingCacheKey(
  fileSha256: string,
  promptVersion: string,
): string {
  return `${fileSha256}:${promptVersion}`;
}

export function normalizeMediaRelativePath(imagePath: string): string | null {
  const normalizedPath = imagePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");

  if (!normalizedPath.startsWith("media/")) {
    return null;
  }

  return normalizedPath;
}

export function resolveMediaImagePath(
  imagePath: string,
  rootDir: string,
): ResolvedImagePath | null {
  const normalizedRelativePath = normalizeMediaRelativePath(imagePath);
  if (!normalizedRelativePath) {
    return null;
  }

  const absolutePath = resolve(rootDir, normalizedRelativePath);
  const resolvedRelativePath = relative(rootDir, absolutePath).replace(/\\/g, "/");
  if (
    !resolvedRelativePath ||
    isAbsolute(resolvedRelativePath) ||
    resolvedRelativePath.startsWith("..") ||
    !resolvedRelativePath.startsWith("media/")
  ) {
    return null;
  }

  return {
    relativePath: resolvedRelativePath,
    absolutePath: absolutePath.replace(/\\/g, "/"),
  };
}

export function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  return fenced?.[1]?.trim() ?? trimmed;
}

export function parseImageUnderstandingResponse(
  rawText: string,
): ParsedImageUnderstanding {
  const cleanedText = stripMarkdownCodeFence(rawText).replace(/\r\n/g, "\n").trim();

  const objectiveDescription = extractStructuredField(cleanedText, "客观描述")
    ?? normalizeStructuredValue(cleanedText);

  return {
    objectiveDescription: objectiveDescription || "无",
    ocrText: extractStructuredField(cleanedText, "OCR文本") ?? "无",
    keyInformation: extractStructuredField(cleanedText, "关键信息") ?? "无",
  };
}

export function formatImageUnderstandingBlock(
  imagePath: string,
  rawText: string,
): string {
  const parsed = parseImageUnderstandingResponse(rawText);

  return [
    "[图片理解结果]",
    `路径: ${imagePath}`,
    `客观描述: ${parsed.objectiveDescription}`,
    `OCR文本: ${parsed.ocrText}`,
    `关键信息: ${parsed.keyInformation}`,
    "[/图片理解结果]",
  ].join("\n");
}

export function formatImageReadFailure(imagePath: string): string {
  return `[图片读取失败: ${imagePath}]`;
}

export function formatImageUnderstandingFailure(imagePath: string): string {
  return `[图片理解失败: ${imagePath}]`;
}

export async function preprocessMessageImages(
  db: Database,
  text: string,
  rootDir: string,
  deps: ImageMessagePreprocessorDeps,
): Promise<string> {
  const normalizedText = normalizeLegacyImageSyntax(text);
  const parts = parseMessageParts(normalizedText);
  const hasImages = parts.some((part) => part.type === "image");

  if (!hasImages) {
    return normalizedText;
  }

  const blocks: string[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      blocks.push(part.value);
      continue;
    }

    blocks.push(await preprocessImagePart(db, part.value, rootDir, deps));
  }

  return blocks.join("");
}

async function preprocessImagePart(
  db: Database,
  imagePath: string,
  rootDir: string,
  deps: ImageMessagePreprocessorDeps,
): Promise<string> {
  const resolvedPath = resolveMediaImagePath(imagePath, rootDir);
  if (!resolvedPath) {
    log.warn(TAG, "Rejected non-media image path", { imagePath });
    return formatImageReadFailure(imagePath);
  }

  let fileBytes: Uint8Array;
  try {
    fileBytes = await readFile(resolvedPath.absolutePath);
  } catch (error) {
    log.warn(TAG, "Failed to read image file", {
      imagePath: resolvedPath.relativePath,
      absolutePath: resolvedPath.absolutePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return formatImageReadFailure(resolvedPath.relativePath);
  }

  const fileSha256 = createHash("sha256").update(fileBytes).digest("hex");
  const cacheKey = buildImageUnderstandingCacheKey(
    fileSha256,
    IMAGE_UNDERSTANDING_PROMPT_VERSION,
  );
  const cached = getImageUnderstandingCache(db, cacheKey);

  if (cached) {
    log.debug(TAG, "Image understanding cache hit", {
      imagePath: resolvedPath.relativePath,
      cacheKey,
    });
    return cached.analysis_text;
  }

  try {
    const rawAnalysis = await deps.analyzeImage.understandImage({
      imagePath: resolvedPath.absolutePath,
      prompt: IMAGE_UNDERSTANDING_PROMPT,
    });
    const analysisText = formatImageUnderstandingBlock(
      resolvedPath.relativePath,
      rawAnalysis,
    );
    const now = deps.now?.() ?? new Date().toISOString();

    upsertImageUnderstandingCache(db, {
      cache_key: cacheKey,
      image_path: resolvedPath.relativePath,
      file_sha256: fileSha256,
      prompt_version: IMAGE_UNDERSTANDING_PROMPT_VERSION,
      analysis_text: analysisText,
      created_at: now,
      updated_at: now,
    });

    log.info(TAG, "Image understanding cache stored", {
      imagePath: resolvedPath.relativePath,
      cacheKey,
    });

    return analysisText;
  } catch (error) {
    log.error(TAG, "Failed to understand image", {
      imagePath: resolvedPath.relativePath,
      absolutePath: resolvedPath.absolutePath,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Error) {
      log.error(TAG, "Image understanding error details", error);
    }
    return formatImageUnderstandingFailure(resolvedPath.relativePath);
  }
}

function extractStructuredField(
  text: string,
  label: (typeof IMAGE_OUTPUT_LABELS)[number],
): string | null {
  const labelPattern = IMAGE_OUTPUT_LABELS.map((item) => escapeRegExp(item)).join("|");
  const regex = new RegExp(
    `(?:^|\\n)${escapeRegExp(label)}\\s*[:：]\\s*([\\s\\S]*?)(?=(?:\\n(?:${labelPattern})\\s*[:：])|$)`,
  );
  const match = text.match(regex);
  const value = match?.[1]?.trim();

  return value ? normalizeStructuredValue(value) : null;
}

function normalizeStructuredValue(value: string): string {
  const normalizedLines = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);

  if (normalizedLines.length === 0) {
    return "无";
  }

  return normalizedLines.join(" | ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const __test__ = {
  IMAGE_UNDERSTANDING_PROMPT,
  IMAGE_UNDERSTANDING_PROMPT_VERSION,
  buildImageUnderstandingCacheKey,
  formatImageReadFailure,
  formatImageUnderstandingBlock,
  formatImageUnderstandingFailure,
  parseImageUnderstandingResponse,
  resolveMediaImagePath,
};
