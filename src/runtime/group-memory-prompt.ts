import type { GroupMemoryRow } from "../db";

const BUILTIN_GROUP_MEMORY_PROMPT_LABELS: Record<string, string> = {
  topic_context: "Topic context",
  response_language: "Preferred explanation language",
  response_style: "Preferred response style",
  interaction_rule: "Interaction rule",
};

const GROUP_MEMORY_VALUE_LIMIT = 240;
const GROUP_MEMORY_BLOCK_LIMIT = 1200;
const GROUP_MEMORY_POLICY_LINES = [
  "Group memory policy:",
  "- When the user asks you to remember a stable preference, long-term rule, recurring context, or default behavior for this group, save it with remember_group_memory before replying.",
  "- Prefer builtin keys first: topic_context, response_language, response_style, interaction_rule.",
  "- Only use a custom key when no builtin key fits the memory.",
  "- Example: if the user says future replies should be in English, save response_language = English.",
  "- When the user wants to inspect, update, delete, or clear group memory, use list_group_memory, remember_group_memory, forget_group_memory, or clear_group_memory.",
] as const;

function normalizeGroupMemoryValue(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= GROUP_MEMORY_VALUE_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, GROUP_MEMORY_VALUE_LIMIT - 3).trimEnd()}...`;
}

export function buildGroupMemoryPromptBlock(
  memories: GroupMemoryRow[],
): string | null {
  if (memories.length === 0) {
    return null;
  }

  const lines = ["Group memory:"];

  for (const memory of memories) {
    const label =
      memory.key_type === "builtin"
        ? (BUILTIN_GROUP_MEMORY_PROMPT_LABELS[memory.key] ?? memory.key)
        : `Custom ${memory.key}`;
    const line = `- ${label}: ${normalizeGroupMemoryValue(memory.value)}`;
    const nextBlock = [...lines, line].join("\n");

    if (nextBlock.length > GROUP_MEMORY_BLOCK_LIMIT) {
      lines.push("- Additional memory omitted to keep context concise.");
      break;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

export function buildGroupMemoryPolicyBlock(): string {
  return GROUP_MEMORY_POLICY_LINES.join("\n");
}

export function buildSessionInitialPrompt(
  initialPrompt: string,
  memories: GroupMemoryRow[],
  shouldInjectMemoryContext: boolean,
): string {
  if (!shouldInjectMemoryContext) {
    return initialPrompt;
  }

  const sections = [buildGroupMemoryPolicyBlock()];
  const memoryBlock = buildGroupMemoryPromptBlock(memories);
  if (memoryBlock) {
    sections.push(memoryBlock);
  }
  sections.push(`Current input:\n${initialPrompt}`);

  return sections.join("\n\n");
}

export function buildGroupMemoryAppendSystemPrompt(
  memories: GroupMemoryRow[],
): string[] {
  const blocks = [buildGroupMemoryPolicyBlock()];
  const memoryBlock = buildGroupMemoryPromptBlock(memories);
  if (memoryBlock) {
    blocks.push(memoryBlock);
  }

  return blocks;
}
