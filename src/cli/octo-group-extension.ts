import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { ChatRow, RegisteredGroup } from "../db";
import { GroupService } from "../group-service";
import { log } from "../logger";
import { WorkspaceService } from "../workspace-service";
import {
  formatChatOption,
  formatGroupOption,
  selectCliGroup,
  selectWorkspaceChat,
} from "./group-selector";
import { OctoCliRuntimeHost } from "./octo-cli-runtime-host";

export interface OctoGroupExtensionOptions {
  groupService: GroupService;
  workspaceService: WorkspaceService;
  getRuntimeHost(): OctoCliRuntimeHost | null;
}

const TAG = "octo-group-extension";

function listSortedCliGroups(groupService: GroupService): RegisteredGroup[] {
  return groupService.listCliGroups();
}

function findCliGroup(
  groupService: GroupService,
  rawQuery: string,
): RegisteredGroup | null {
  const query = rawQuery.trim();
  if (!query) {
    return null;
  }

  const groups = listSortedCliGroups(groupService);
  const exactFolder = groups.find((group) => group.folder === query);
  if (exactFolder) {
    return exactFolder;
  }

  const exactName = groups.find((group) => group.name === query);
  if (exactName) {
    return exactName;
  }

  const prefixMatches = groups.filter((group) => group.folder.startsWith(query));
  if (prefixMatches.length === 1) {
    return prefixMatches[0]!;
  }

  return null;
}

function buildGroupCompletions(groupService: GroupService, prefix: string) {
  const normalizedPrefix = prefix.trim();
  return listSortedCliGroups(groupService)
    .filter((group) =>
      normalizedPrefix.length === 0 ||
      group.folder.startsWith(normalizedPrefix) ||
      group.name.startsWith(normalizedPrefix)
    )
    .map((group) => ({
      value: group.folder,
      label: formatGroupOption(group),
    }));
}

function listWorkspaceChats(
  workspaceService: WorkspaceService,
  workspaceId: string,
): ChatRow[] {
  return workspaceService.listChats(workspaceId);
}

function findWorkspaceChat(
  workspaceService: WorkspaceService,
  workspaceId: string,
  rawQuery: string,
): ChatRow | null {
  const query = rawQuery.trim();
  if (!query) {
    return null;
  }

  const chats = listWorkspaceChats(workspaceService, workspaceId);
  const exactId = chats.find((chat) => chat.id === query);
  if (exactId) {
    return exactId;
  }

  const exactTitle = chats.find((chat) => chat.title === query);
  if (exactTitle) {
    return exactTitle;
  }

  const prefixMatches = chats.filter((chat) => chat.id.startsWith(query));
  if (prefixMatches.length === 1) {
    return prefixMatches[0]!;
  }

  return null;
}

function buildChatCompletions(
  workspaceService: WorkspaceService,
  workspaceId: string,
  currentChatId: string,
  prefix: string,
) {
  const normalizedPrefix = prefix.trim();
  return listWorkspaceChats(workspaceService, workspaceId)
    .filter((chat) =>
      normalizedPrefix.length === 0 ||
      chat.id.startsWith(normalizedPrefix) ||
      chat.title.startsWith(normalizedPrefix)
    )
    .map((chat) => ({
      value: chat.id,
      label: formatChatOption(chat, currentChatId),
    }));
}

function getRuntimeHost(
  options: OctoGroupExtensionOptions,
): OctoCliRuntimeHost {
  const runtimeHost = options.getRuntimeHost();
  if (!runtimeHost) {
    throw new Error("Octo CLI runtime host is not ready");
  }

  return runtimeHost;
}

async function resolveSwitchTarget(
  groupService: GroupService,
  runtimeHost: OctoCliRuntimeHost,
  ui: Parameters<ExtensionFactory>[0] extends never ? never : {
    select: (
      title: string,
      options: string[],
      opts?: { timeout?: number; signal?: AbortSignal },
    ) => Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  },
  rawArgs: string,
): Promise<RegisteredGroup | undefined> {
  const query = rawArgs.trim();
  if (query) {
    const directMatch = findCliGroup(groupService, query);
    if (!directMatch) {
      ui.notify(`CLI group not found: ${query}`, "error");
      return undefined;
    }

    return directMatch;
  }

  const selected = await selectCliGroup(
    ui,
    listSortedCliGroups(groupService),
    runtimeHost.getCurrentGroup().folder,
    "Switch CLI Group",
  );

  if (!selected) {
    return undefined;
  }

  return selected;
}

async function resolveChatSwitchTarget(
  workspaceService: WorkspaceService,
  runtimeHost: OctoCliRuntimeHost,
  ui: Parameters<ExtensionFactory>[0] extends never ? never : {
    select: (
      title: string,
      options: string[],
      opts?: { timeout?: number; signal?: AbortSignal },
    ) => Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  },
  rawArgs: string,
): Promise<ChatRow | undefined> {
  const workspace = runtimeHost.getCurrentWorkspace();
  const query = rawArgs.trim();
  if (query) {
    const directMatch = findWorkspaceChat(workspaceService, workspace.id, query);
    if (!directMatch) {
      ui.notify(`Workspace chat not found: ${query}`, "error");
      return undefined;
    }

    return directMatch;
  }

  return selectWorkspaceChat(
    ui,
    listWorkspaceChats(workspaceService, workspace.id),
    runtimeHost.getCurrentChat().id,
    `Chats in ${workspace.name}`,
  );
}

export function createOctoGroupExtension(
  options: OctoGroupExtensionOptions,
): ExtensionFactory {
  return async (pi) => {
    const newWorkspaceCommand = {
      description: "Create a new Octo CLI workspace and switch to its default chat",
      handler: async (args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const requestedName = args.trim() || await ctx.ui.input(
          "New Workspace",
          "Optional workspace name",
        ) || "";

        await ctx.waitForIdle();
        const created = options.groupService.createCliGroup({
          name: requestedName || undefined,
        });
        log.info(TAG, "Created CLI workspace group from command", {
          requestedName: requestedName || null,
          groupFolder: created.folder,
          groupName: created.name,
        });
        const workspace = options.workspaceService.getWorkspaceByFolder(created.folder);
        if (!workspace) {
          throw new Error(`Workspace not found: ${created.folder}`);
        }

        const chat = options.workspaceService.listChats(workspace.id)[0]
          ?? options.workspaceService.createChat(workspace.id, {
            title: created.name,
            requiresTrigger: false,
          });
        await runtimeHost.switchWorkspace(workspace, chat);
        ctx.ui.notify(`Switched to ${workspace.folder}`, "info");
      },
    } satisfies Parameters<Parameters<ExtensionFactory>[0]["registerCommand"]>[1];
    pi.registerCommand("new-workspace", newWorkspaceCommand);
    pi.registerCommand("new-group", newWorkspaceCommand);

    const listWorkspacesCommand = {
      description: "List Octo CLI workspaces and switch via picker",
      handler: async (_args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const selected = await selectCliGroup(
          ctx.ui,
          listSortedCliGroups(options.groupService),
          runtimeHost.getCurrentWorkspace().folder,
          "CLI Workspaces",
        );

        if (!selected) {
          return;
        }

        if (selected.folder === runtimeHost.getCurrentWorkspace().folder) {
          ctx.ui.notify(`Current workspace: ${selected.folder}`, "info");
          return;
        }

        await ctx.waitForIdle();
        await runtimeHost.switchGroup(selected);
        ctx.ui.notify(`Switched to ${selected.folder}`, "info");
      },
    } satisfies Parameters<Parameters<ExtensionFactory>[0]["registerCommand"]>[1];
    pi.registerCommand("workspaces", listWorkspacesCommand);
    pi.registerCommand("groups", listWorkspacesCommand);

    const switchWorkspaceCommand = {
      description: "Switch to another Octo CLI workspace",
      getArgumentCompletions: (prefix) => buildGroupCompletions(options.groupService, prefix),
      handler: async (args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const targetGroup = await resolveSwitchTarget(
          options.groupService,
          runtimeHost,
          ctx.ui,
          args,
        );

        if (!targetGroup) {
          return;
        }

        if (targetGroup.folder === runtimeHost.getCurrentWorkspace().folder) {
          ctx.ui.notify(`Already in ${targetGroup.folder}`, "info");
          return;
        }

        await ctx.waitForIdle();
        await runtimeHost.switchGroup(targetGroup);
        ctx.ui.notify(`Switched to ${targetGroup.folder}`, "info");
      },
    } satisfies Parameters<Parameters<ExtensionFactory>[0]["registerCommand"]>[1];
    pi.registerCommand("switch-workspace", switchWorkspaceCommand);
    pi.registerCommand("switch-group", switchWorkspaceCommand);

    const renameWorkspaceCommand = {
      description: "Rename the current Octo CLI workspace",
      handler: async (args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const currentWorkspace = runtimeHost.getCurrentWorkspace();
        const requestedName = args.trim() || await ctx.ui.input(
          "Rename Workspace",
          currentWorkspace.name,
        );

        if (!requestedName?.trim()) {
          return;
        }

        const renamed = options.groupService.renameGroup(
          currentWorkspace.folder,
          requestedName,
        );
        ctx.ui.notify(`Renamed ${renamed.folder} to ${renamed.name}`, "info");
      },
    } satisfies Parameters<Parameters<ExtensionFactory>[0]["registerCommand"]>[1];
    pi.registerCommand("rename-workspace", renameWorkspaceCommand);
    pi.registerCommand("rename-group", renameWorkspaceCommand);

    pi.registerCommand("new-chat", {
      description: "Create a new chat in the current workspace and switch to it",
      handler: async (args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const workspace = runtimeHost.getCurrentWorkspace();
        const requestedTitle = args.trim() || await ctx.ui.input(
          "New Chat",
          "Optional chat title",
        ) || "";

        await ctx.waitForIdle();
        const chat = options.workspaceService.createChat(workspace.id, {
          title: requestedTitle || undefined,
          requiresTrigger: false,
        });
        log.info(TAG, "Created CLI workspace chat from command", {
          workspaceFolder: workspace.folder,
          chatId: chat.id,
          chatTitle: chat.title,
          sessionRef: chat.session_ref,
        });
        await runtimeHost.switchChat(chat);
        ctx.ui.notify(`Switched to ${chat.title}`, "info");
      },
    });

    pi.registerCommand("chats", {
      description: "List chats in the current workspace and switch via picker",
      handler: async (_args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const selected = await selectWorkspaceChat(
          ctx.ui,
          listWorkspaceChats(
            options.workspaceService,
            runtimeHost.getCurrentWorkspace().id,
          ),
          runtimeHost.getCurrentChat().id,
          `Chats in ${runtimeHost.getCurrentWorkspace().name}`,
        );

        if (!selected) {
          return;
        }

        if (selected.id === runtimeHost.getCurrentChat().id) {
          ctx.ui.notify(`Current chat: ${selected.title}`, "info");
          return;
        }

        await ctx.waitForIdle();
        await runtimeHost.switchChat(selected);
        ctx.ui.notify(`Switched to ${selected.title}`, "info");
      },
    });

    pi.registerCommand("switch-chat", {
      description: "Switch to another chat in the current workspace",
      getArgumentCompletions: (prefix) => {
        const runtimeHost = options.getRuntimeHost();
        if (!runtimeHost) {
          return [];
        }

        return buildChatCompletions(
          options.workspaceService,
          runtimeHost.getCurrentWorkspace().id,
          runtimeHost.getCurrentChat().id,
          prefix,
        );
      },
      handler: async (args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const targetChat = await resolveChatSwitchTarget(
          options.workspaceService,
          runtimeHost,
          ctx.ui,
          args,
        );

        if (!targetChat) {
          return;
        }

        if (targetChat.id === runtimeHost.getCurrentChat().id) {
          ctx.ui.notify(`Already in ${targetChat.title}`, "info");
          return;
        }

        await ctx.waitForIdle();
        log.info(TAG, "Switching CLI workspace chat from command", {
          workspaceFolder: runtimeHost.getCurrentWorkspace().folder,
          fromChatId: runtimeHost.getCurrentChat().id,
          toChatId: targetChat.id,
        });
        await runtimeHost.switchChat(targetChat);
        ctx.ui.notify(`Switched to ${targetChat.title}`, "info");
      },
    });
  };
}

export const __test__ = {
  buildChatCompletions,
  buildGroupCompletions,
  findCliGroup,
  findWorkspaceChat,
};
