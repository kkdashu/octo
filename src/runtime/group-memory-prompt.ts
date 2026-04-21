import type { WorkspaceMemoryRow } from "../db";

const BUILTIN_WORKSPACE_MEMORY_PROMPT_LABELS: Record<string, string> = {
  topic_context: "Topic context",
  response_language: "Preferred explanation language",
  response_style: "Preferred response style",
  interaction_rule: "Interaction rule",
};

const WORKSPACE_MEMORY_VALUE_LIMIT = 240;
const WORKSPACE_MEMORY_BLOCK_LIMIT = 1200;
const WORKSPACE_MEMORY_POLICY_LINES = [
  "Workspace memory policy:",
  "- When the user asks you to remember a stable preference, long-term rule, recurring context, or default behavior for this workspace, save it with remember_workspace_memory before replying.",
  "- Prefer builtin keys first: topic_context, response_language, response_style, interaction_rule.",
  "- Only use a custom key when no builtin key fits the memory.",
  "- Example: if the user says future replies should be in English, save response_language = English.",
  "- When the user wants to inspect, update, delete, or clear workspace memory, use list_workspace_memory, remember_workspace_memory, forget_workspace_memory, or clear_workspace_memory.",
] as const;

function normalizeWorkspaceMemoryValue(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= WORKSPACE_MEMORY_VALUE_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, WORKSPACE_MEMORY_VALUE_LIMIT - 3).trimEnd()}...`;
}

export function buildWorkspaceMemoryPromptBlock(
  memories: WorkspaceMemoryRow[],
): string | null {
  if (memories.length === 0) {
    return null;
  }

  const lines = ["Workspace memory:"];

  for (const memory of memories) {
    const label =
      memory.key_type === "builtin"
        ? (BUILTIN_WORKSPACE_MEMORY_PROMPT_LABELS[memory.key] ?? memory.key)
        : `Custom ${memory.key}`;
    const line = `- ${label}: ${normalizeWorkspaceMemoryValue(memory.value)}`;
    const nextBlock = [...lines, line].join("\n");

    if (nextBlock.length > WORKSPACE_MEMORY_BLOCK_LIMIT) {
      lines.push("- Additional memory omitted to keep context concise.");
      break;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

export function buildWorkspaceMemoryPolicyBlock(): string {
  return WORKSPACE_MEMORY_POLICY_LINES.join("\n");
}

export function buildSessionInitialPrompt(
  initialPrompt: string,
  memories: WorkspaceMemoryRow[],
  shouldInjectMemoryContext: boolean,
): string {
  if (!shouldInjectMemoryContext) {
    return initialPrompt;
  }

  const sections = [buildWorkspaceMemoryPolicyBlock()];
  const memoryBlock = buildWorkspaceMemoryPromptBlock(memories);
  if (memoryBlock) {
    sections.push(memoryBlock);
  }
  sections.push(`Current input:\n${initialPrompt}`);

  return sections.join("\n\n");
}

export function buildWorkspaceMemoryAppendSystemPrompt(
  memories: WorkspaceMemoryRow[],
): string[] {
  const blocks = [buildWorkspaceMemoryPolicyBlock()];
  const memoryBlock = buildWorkspaceMemoryPromptBlock(memories);
  if (memoryBlock) {
    blocks.push(memoryBlock);
  }

  return blocks;
}
