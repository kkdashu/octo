import type { ChatRow, WorkspaceRow } from "../db";

export interface WorkspaceSelectorUI {
  select(
    title: string,
    options: string[],
    opts?: { timeout?: number; signal?: AbortSignal },
  ): Promise<string | undefined>;
}

export function formatWorkspaceOption(
  workspace: WorkspaceRow,
  currentWorkspaceFolder?: string,
): string {
  const currentMark = workspace.folder === currentWorkspaceFolder ? "* " : "  ";
  return `${currentMark}${workspace.folder}  ${workspace.name}`;
}

export async function selectWorkspace(
  ui: WorkspaceSelectorUI,
  workspaces: WorkspaceRow[],
  currentWorkspaceFolder?: string,
  title = "Workspaces",
): Promise<WorkspaceRow | undefined> {
  if (workspaces.length === 0) {
    return undefined;
  }

  const options = workspaces.map((workspace) =>
    formatWorkspaceOption(workspace, currentWorkspaceFolder)
  );
  const byOption = new Map(options.map((option, index) => [option, workspaces[index]!]));
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
  ui: WorkspaceSelectorUI,
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
