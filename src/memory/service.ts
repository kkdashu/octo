import type { MessageRow } from "../db";
import {
  addUserMemoryEntry,
  buildUserKey,
  deleteUserMemoryEntry,
  escapeXml,
  listUserMemoryEntries,
  resolveUserMemoryFilePath,
  type MemoryEntry,
  updateUserMemoryEntry,
} from "./files";
import {
  extractTurnMemoryChanges,
  isQuestionLikeMemoryText,
  type MemoryGuardLevel,
} from "./extractor";
import { judgeMemoryCandidate } from "./judge";

const MEMORY_PROCEDURAL_TEXT_RE = /(执行以下命令|run\s+(?:the\s+)?following\s+command|\b(?:cd|npm|pnpm|yarn|node|python|bash|sh|git|curl|wget)\b|\$[A-Z_][A-Z0-9_]*|&&|--[a-z0-9-]+|\/tmp\/|\.sh\b|\.bat\b|\.ps1\b)/i;
const MEMORY_ASSISTANT_STYLE_TEXT_RE = /^(?:使用|use)\s+[A-Za-z0-9._-]+\s*(?:技能|skill)/i;

const DEFAULT_GUARD_LEVEL: MemoryGuardLevel = "standard";
const MAX_USERS_IN_PROMPT = 5;
const MAX_ENTRIES_PER_USER = 6;
const MAX_TOTAL_MEMORY_CHARS = 2200;

export interface MemoryParticipant {
  userKey: string;
  senderId: string;
  senderName: string;
  isCurrent: boolean;
}

export interface MemoryUpdateStats {
  totalChanges: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  rejected: number;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function normalizeMemoryMatchKey(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMeaningfulDeleteFragment(value: string): boolean {
  if (!value) return false;
  const tokens = value.split(/\s+/g).filter(Boolean);
  if (tokens.length >= 2) return true;
  if (/[\u3400-\u9fff]/u.test(value)) return value.length >= 4;
  return value.length >= 6;
}

function includesAsBoundedPhrase(target: string, fragment: string): boolean {
  if (!target || !fragment) return false;
  const paddedTarget = ` ${target} `;
  const paddedFragment = ` ${fragment} `;
  if (paddedTarget.includes(paddedFragment)) {
    return true;
  }
  if (/[\u3400-\u9fff]/u.test(fragment) && !fragment.includes(" ")) {
    return target.includes(fragment);
  }
  return false;
}

function scoreDeleteMatch(targetKey: string, queryKey: string): number {
  if (!targetKey || !queryKey) return 0;
  if (targetKey === queryKey) {
    return 1000 + queryKey.length;
  }

  if (!isMeaningfulDeleteFragment(queryKey)) {
    return 0;
  }

  let score = 0;
  if (includesAsBoundedPhrase(targetKey, queryKey)) {
    score = Math.max(score, 600 + queryKey.length);
  } else if (targetKey.includes(queryKey)) {
    score = Math.max(score, 400 + queryKey.length);
  } else if (queryKey.includes(targetKey) && targetKey.length >= 6) {
    score = Math.max(score, 350 + targetKey.length);
  }

  const targetTokens = new Set(targetKey.split(/\s+/g).filter(Boolean));
  const queryTokens = new Set(queryKey.split(/\s+/g).filter(Boolean));
  let overlap = 0;
  for (const token of queryTokens) {
    if (targetTokens.has(token)) overlap += 1;
  }
  if (overlap > 0) {
    score = Math.max(score, overlap * 50 + Math.min(queryTokens.size, targetTokens.size));
  }

  return score;
}

function validateMemoryToolText(rawText: string): { ok: boolean; text: string; reason?: string } {
  const text = normalizeText(rawText);
  if (!text) {
    return { ok: false, text: "", reason: "text is required" };
  }
  if (isQuestionLikeMemoryText(text)) {
    return { ok: false, text: "", reason: "memory text looks like a question, not a durable fact" };
  }
  if (MEMORY_ASSISTANT_STYLE_TEXT_RE.test(text)) {
    return { ok: false, text: "", reason: "memory text looks like assistant workflow instruction" };
  }
  if (MEMORY_PROCEDURAL_TEXT_RE.test(text)) {
    return { ok: false, text: "", reason: "memory text looks like command/procedural content" };
  }
  return { ok: true, text };
}

function dedupeParticipants(participants: MemoryParticipant[]): MemoryParticipant[] {
  const ordered = [...participants].reverse();
  const seen = new Set<string>();
  const result: MemoryParticipant[] = [];
  for (const participant of ordered) {
    if (seen.has(participant.userKey)) continue;
    seen.add(participant.userKey);
    result.push(participant);
  }
  return result.reverse();
}

export function collectParticipants(channelType: string, messages: MessageRow[]): MemoryParticipant[] {
  const lastSender = [...messages].reverse().find((message) => normalizeText(message.sender))?.sender ?? "";
  const participants = messages
    .filter((message) => normalizeText(message.sender))
    .map((message) => {
      const userKey = buildUserKey(channelType, message.sender);
      return userKey
        ? {
            userKey,
            senderId: message.sender,
            senderName: normalizeText(message.sender_name || message.sender),
            isCurrent: message.sender === lastSender,
          }
        : null;
    })
    .filter((participant): participant is MemoryParticipant => participant !== null);

  return dedupeParticipants(participants);
}

export function buildParticipantMemoryPrefix(
  projectRoot: string,
  channelType: string,
  messages: MessageRow[],
): string {
  const participants = collectParticipants(channelType, messages).slice(-MAX_USERS_IN_PROMPT);
  if (participants.length === 0) return "";

  const lines = [
    "Participant identities and long-term memories are user-scoped.",
    "Do not apply facts from one user to another.",
    "Use memory_user_edits only when a user explicitly asks you to remember, list, update, or delete durable personal memory.",
    "When calling memory_user_edits, pass targetUserKey from the users below.",
    "",
    "<participant_memories>",
  ];

  let totalChars = 0;

  for (const participant of participants) {
    const entries = listUserMemoryEntries(projectRoot, participant.userKey).slice(0, MAX_ENTRIES_PER_USER);
    const userLines = [
      `<user key="${escapeXml(participant.userKey)}" name="${escapeXml(participant.senderName || participant.senderId)}" current="${participant.isCurrent ? "true" : "false"}">`,
    ];

    if (entries.length === 0) {
      userLines.push("- No saved memories yet.");
    } else {
      for (const entry of entries) {
        const text = truncate(entry.text, 180);
        if (totalChars + text.length > MAX_TOTAL_MEMORY_CHARS) break;
        userLines.push(`- ${escapeXml(text)}`);
        totalChars += text.length;
      }
    }
    userLines.push("</user>");
    lines.push(...userLines);
    if (totalChars >= MAX_TOTAL_MEMORY_CHARS) break;
  }

  lines.push("</participant_memories>");
  return lines.join("\n");
}

function findDeleteTarget(projectRoot: string, userKey: string, rawText: string): MemoryEntry | null {
  const queryKey = normalizeMemoryMatchKey(rawText);
  if (!queryKey) return null;

  const candidates = listUserMemoryEntries(projectRoot, userKey);
  let target: MemoryEntry | null = null;
  let bestScore = 0;
  for (const entry of candidates) {
    const entryKey = normalizeMemoryMatchKey(entry.text);
    const score = scoreDeleteMatch(entryKey, queryKey);
    if (score <= bestScore) continue;
    bestScore = score;
    target = entry;
  }

  return target;
}

export function applyAutomaticMemoryUpdates(
  projectRoot: string,
  channelType: string,
  messages: MessageRow[],
  assistantText: string,
  guardLevel: MemoryGuardLevel = DEFAULT_GUARD_LEVEL,
): MemoryUpdateStats {
  const stats: MemoryUpdateStats = {
    totalChanges: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    rejected: 0,
  };

  const normalizedAssistantText = normalizeText(assistantText);
  if (!normalizedAssistantText) {
    return stats;
  }

  for (const message of messages) {
    const userKey = buildUserKey(channelType, message.sender);
    if (!userKey) continue;

    const changes = extractTurnMemoryChanges({
      userText: message.content,
      assistantText: normalizedAssistantText,
      guardLevel,
      maxImplicitAdds: 2,
    });
    stats.totalChanges += changes.length;

    for (const change of changes) {
      if (change.action === "add") {
        const judge = judgeMemoryCandidate({
          text: change.text,
          isExplicit: change.isExplicit,
          guardLevel,
        });
        if (!judge.accepted) {
          stats.rejected += 1;
          stats.skipped += 1;
          continue;
        }

        const before = listUserMemoryEntries(projectRoot, userKey).length;
        addUserMemoryEntry(projectRoot, userKey, change.text, message.sender_name || message.sender);
        const after = listUserMemoryEntries(projectRoot, userKey).length;
        if (after > before) {
          stats.created += 1;
        } else {
          stats.updated += 1;
        }
        continue;
      }

      const target = findDeleteTarget(projectRoot, userKey, change.text);
      if (!target) {
        stats.skipped += 1;
        continue;
      }
      if (deleteUserMemoryEntry(projectRoot, userKey, target.id)) {
        stats.deleted += 1;
      } else {
        stats.skipped += 1;
      }
    }
  }

  return stats;
}

export function runMemoryUserEditsTool(
  projectRoot: string,
  args: {
    action: "list" | "add" | "update" | "delete";
    targetUserKey: string;
    id?: string;
    text?: string;
    query?: string;
  },
): { text: string; isError: boolean } {
  const targetUserKey = normalizeText(args.targetUserKey);
  if (!targetUserKey) {
    return { text: "targetUserKey is required", isError: true };
  }

  if (args.action === "list") {
    const entries = listUserMemoryEntries(projectRoot, targetUserKey, args.query);
    return {
      text: JSON.stringify({
        targetUserKey,
        filePath: resolveUserMemoryFilePath(projectRoot, targetUserKey),
        entries,
      }, null, 2),
      isError: false,
    };
  }

  if (args.action === "add") {
    const validation = validateMemoryToolText(args.text || "");
    if (!validation.ok) {
      return { text: validation.reason || "Invalid memory text", isError: true };
    }
    const entry = addUserMemoryEntry(projectRoot, targetUserKey, validation.text);
    return {
      text: JSON.stringify({
        action: "add",
        targetUserKey,
        entry,
      }, null, 2),
      isError: false,
    };
  }

  if (args.action === "update") {
    if (!args.id) {
      return { text: "id is required for update", isError: true };
    }
    const validation = validateMemoryToolText(args.text || "");
    if (!validation.ok) {
      return { text: validation.reason || "Invalid memory text", isError: true };
    }
    const updated = updateUserMemoryEntry(projectRoot, targetUserKey, args.id, validation.text);
    if (!updated) {
      return { text: "memory entry not found", isError: true };
    }
    return {
      text: JSON.stringify({
        action: "update",
        targetUserKey,
        entry: updated,
      }, null, 2),
      isError: false,
    };
  }

  if (!args.id) {
    return { text: "id is required for delete", isError: true };
  }
  const deleted = deleteUserMemoryEntry(projectRoot, targetUserKey, args.id);
  return deleted
    ? {
        text: JSON.stringify({
          action: "delete",
          targetUserKey,
          id: args.id,
        }, null, 2),
        isError: false,
      }
    : { text: "memory entry not found", isError: true };
}
