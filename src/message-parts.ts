export type MessagePart =
  | { type: "text"; value: string }
  | { type: "image"; value: string }
  | { type: "file"; label: string; value: string };

const LEGACY_IMAGE_TAG_RE = /\[IMAGE:([^\]]+)\]/g;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\n]+)\)/g;
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)\n]+)\)/g;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:/;

export function normalizeLegacyImageSyntax(text: string): string {
  if (!text) {
    return "";
  }

  return text.replace(LEGACY_IMAGE_TAG_RE, (_match, rawPath: string) => {
    const imagePath = rawPath.trim();
    if (!imagePath) {
      return _match;
    }

    return `![image](${imagePath})`;
  });
}

export function isLocalMarkdownLinkTarget(target: string): boolean {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    return false;
  }

  if (
    normalizedTarget.startsWith("#") ||
    normalizedTarget.startsWith("//")
  ) {
    return false;
  }

  if (WINDOWS_ABSOLUTE_PATH_RE.test(normalizedTarget)) {
    return true;
  }

  return !URL_SCHEME_RE.test(normalizedTarget);
}

export function parseMessageParts(text: string): MessagePart[] {
  if (!text) {
    return [];
  }

  const parts: MessagePart[] = [];
  let lastIndex = 0;
  const tokenRe = new RegExp(
    `${MARKDOWN_IMAGE_RE.source}|${MARKDOWN_LINK_RE.source}`,
    "g",
  );

  for (const match of text.matchAll(tokenRe)) {
    const start = match.index ?? 0;
    const matchedText = match[0] ?? "";

    if (matchedText.startsWith("![")) {
      if (start > lastIndex) {
        parts.push({
          type: "text",
          value: text.slice(lastIndex, start),
        });
      }

      const imagePath = (match[1] ?? "").trim();
      if (imagePath) {
        parts.push({
          type: "image",
          value: imagePath,
        });
      }

      lastIndex = start + matchedText.length;
      continue;
    }

    const label = (match[2] ?? "").trim();
    const filePath = (match[3] ?? "").trim();
    if (!filePath || !isLocalMarkdownLinkTarget(filePath)) {
      continue;
    }

    if (start > lastIndex) {
      parts.push({
        type: "text",
        value: text.slice(lastIndex, start),
      });
    }

    parts.push({
      type: "file",
      label,
      value: filePath,
    });
    lastIndex = start + matchedText.length;
  }

  if (lastIndex < text.length) {
    parts.push({
      type: "text",
      value: text.slice(lastIndex),
    });
  }

  return parts;
}
