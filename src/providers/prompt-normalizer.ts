import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { log } from "../logger";
import {
  isLocalMarkdownLinkTarget,
  normalizeLegacyImageSyntax,
} from "../message-parts";
import type { ImageMessagePreprocessor } from "../runtime/image-message-preprocessor";

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function filterInternalContent(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, "").trim();
}

export function resolveAgentReadablePath(
  rawPath: string,
  rootDir: string,
  workingDirectory: string,
): string {
  if (isAbsolute(rawPath)) {
    return toPosixPath(rawPath);
  }

  const normalizedPath = rawPath.trim().replace(/\\/g, "/");
  if (!normalizedPath) {
    return rawPath;
  }

  const absolutePath =
    normalizedPath.startsWith("media/") || normalizedPath.startsWith("groups/")
      ? resolve(rootDir, normalizedPath)
      : resolve(workingDirectory, normalizedPath);
  const relativePath = relative(workingDirectory, absolutePath);
  const normalizedRelativePath = toPosixPath(relativePath || ".");

  return normalizedRelativePath.startsWith(".")
    ? normalizedRelativePath
    : `./${normalizedRelativePath}`;
}

function formatAnnotatedFileLink(
  label: string,
  rawPath: string,
  agentReadablePath: string,
): string {
  const normalizedLabel = label.trim() || basename(rawPath) || "file";
  const markdownLink = `[${normalizedLabel}](${rawPath})`;
  if (agentReadablePath === rawPath) {
    return markdownLink;
  }

  return `${markdownLink}\n可读路径: ${agentReadablePath}`;
}

function isExistingLocalFilePath(
  rawPath: string,
  rootDir: string,
  workingDirectory: string,
): boolean {
  if (!isLocalMarkdownLinkTarget(rawPath)) {
    return false;
  }

  const normalizedPath = rawPath.trim().replace(/\\/g, "/");
  if (!normalizedPath) {
    return false;
  }

  const absolutePath = isAbsolute(normalizedPath)
    ? normalizedPath
    : normalizedPath.startsWith("media/") || normalizedPath.startsWith("groups/")
      ? resolve(rootDir, normalizedPath)
      : resolve(workingDirectory, normalizedPath);

  if (!existsSync(absolutePath)) {
    return false;
  }

  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

export function annotateStandaloneLocalFilePathsForAgent(
  text: string,
  rootDir: string,
  workingDirectory: string,
): string {
  const lines = text.split("\n");
  let changed = false;

  const annotatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("![")) {
      return line;
    }

    if (!isExistingLocalFilePath(trimmed, rootDir, workingDirectory)) {
      return line;
    }

    changed = true;
    return formatAnnotatedFileLink(
      basename(trimmed),
      trimmed,
      resolveAgentReadablePath(trimmed, rootDir, workingDirectory),
    );
  });

  return changed ? annotatedLines.join("\n") : text;
}

export function annotateLocalFileLinksForAgent(
  text: string,
  rootDir: string,
  workingDirectory: string,
): string {
  if (!text) {
    return text;
  }

  const linkRe = /\[([^\]]*)\]\(([^)\n]+)\)/g;
  let result = "";
  let lastIndex = 0;

  for (const match of text.matchAll(linkRe)) {
    const start = match.index ?? 0;
    const matchedText = match[0] ?? "";
    if (start > 0 && text[start - 1] === "!") {
      continue;
    }

    const label = (match[1] ?? "").trim();
    const rawPath = (match[2] ?? "").trim();
    if (!rawPath || !isLocalMarkdownLinkTarget(rawPath)) {
      continue;
    }

    result += text.slice(lastIndex, start);
    result += formatAnnotatedFileLink(
      label,
      rawPath,
      resolveAgentReadablePath(rawPath, rootDir, workingDirectory),
    );
    lastIndex = start + matchedText.length;
  }

  if (lastIndex === 0) {
    return text;
  }

  result += text.slice(lastIndex);
  return annotateStandaloneLocalFilePathsForAgent(
    result,
    rootDir,
    workingDirectory,
  );
}

export async function normalizePromptForAgent(
  text: string,
  rootDir: string,
  workingDirectory: string,
  imageMessagePreprocessor: ImageMessagePreprocessor,
  logTag: string,
): Promise<string> {
  let processedContent = normalizeLegacyImageSyntax(text);

  try {
    processedContent = await imageMessagePreprocessor.preprocess(text, rootDir);
  } catch (error) {
    log.error(logTag, "Image preprocessing failed, falling back to normalized text", {
      rootDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return annotateLocalFileLinksForAgent(
    processedContent,
    rootDir,
    workingDirectory,
  );
}

type AssistantTextContent = { type: "text"; text: string };
type AssistantMessageLike = {
  role?: string;
  content?: unknown;
};

export function collectAssistantText(message: AssistantMessageLike): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return "";
  }

  const blocks = message.content
    .filter((block): block is AssistantTextContent => {
      return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
    })
    .map((block) => filterInternalContent(block.text))
    .filter((text) => text.length > 0);

  return blocks.join("\n\n");
}
