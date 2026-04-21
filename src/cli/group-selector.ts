import type { ChatRow, RegisteredGroup } from "../db";

export interface GroupSelectorUI {
  select(
    title: string,
    options: string[],
    opts?: { timeout?: number; signal?: AbortSignal },
  ): Promise<string | undefined>;
}

export function formatGroupOption(
  group: RegisteredGroup,
  currentGroupFolder?: string,
): string {
  const currentMark = group.folder === currentGroupFolder ? "* " : "  ";
  const mainMark = group.is_main === 1 ? " [main]" : "";
  return `${currentMark}${group.folder}  ${group.name}${mainMark}`;
}

export async function selectCliGroup(
  ui: GroupSelectorUI,
  groups: RegisteredGroup[],
  currentGroupFolder?: string,
  title = "CLI Groups",
): Promise<RegisteredGroup | undefined> {
  if (groups.length === 0) {
    return undefined;
  }

  const options = groups.map((group) => formatGroupOption(group, currentGroupFolder));
  const byOption = new Map(options.map((option, index) => [option, groups[index]!]));
  const selected = await ui.select(title, options);
  return selected ? byOption.get(selected) : undefined;
}

export function formatChatOption(
  chat: ChatRow,
  currentChatId?: string,
): string {
  const currentMark = chat.id === currentChatId ? "* " : "  ";
  return `${currentMark}${chat.title}  [${chat.active_branch}]  ${chat.id}`;
}

export async function selectWorkspaceChat(
  ui: GroupSelectorUI,
  chats: ChatRow[],
  currentChatId?: string,
  title = "Workspace Chats",
): Promise<ChatRow | undefined> {
  if (chats.length === 0) {
    return undefined;
  }

  const options = chats.map((chat) => formatChatOption(chat, currentChatId));
  const byOption = new Map(options.map((option, index) => [option, chats[index]!]));
  const selected = await ui.select(title, options);
  return selected ? byOption.get(selected) : undefined;
}
