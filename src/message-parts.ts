export type MessagePart =
  | { type: "text"; value: string }
  | { type: "image"; value: string };

const LEGACY_IMAGE_TAG_RE = /\[IMAGE:([^\]]+)\]/g;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\n]+)\)/g;

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

export function parseMessageParts(text: string): MessagePart[] {
  if (!text) {
    return [];
  }

  const parts: MessagePart[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const start = match.index ?? 0;
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

    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({
      type: "text",
      value: text.slice(lastIndex),
    });
  }

  return parts;
}
