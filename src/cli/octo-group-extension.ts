import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { ChatRow } from "../db";
import { log } from "../logger";
import { WorkspaceService } from "../workspace-service";
import {
  formatChatOption,
  formatWorkspaceOption,
  selectWorkspace,
  selectWorkspaceChat,
} from "./group-selector";
import { OctoCliRuntimeHost } from "./octo-cli-runtime-host";

export interface OctoGroupExtensionOptions {
  workspaceService: WorkspaceService;
  getRuntimeHost(): OctoCliRuntimeHost | null;
}

const TAG = "octo-group-extension";

function listCliWorkspaces(workspaceService: WorkspaceService) {
  return workspaceService
    .listWorkspaces()
    .filter((workspace) => workspace.folder.startsWith("cli_"))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

function findCliWorkspace(
  workspaceService: WorkspaceService,
  rawQuery: string,
) {
  const query = rawQuery.trim();
  if (!query) {
    return null;
  }

  const workspaces = listCliWorkspaces(workspaceService);
  const exactFolder = workspaces.find((workspace) => workspace.folder === query);
  if (exactFolder) {
    return exactFolder;
  }

  const exactName = workspaces.find((workspace) => workspace.name === query);
  if (exactName) {
    return exactName;
  }

  const prefixMatches = workspaces.filter((workspace) => workspace.folder.startsWith(query));
  if (prefixMatches.length === 1) {
    return prefixMatches[0]!;
  }

  return null;
}

function buildWorkspaceCompletions(workspaceService: WorkspaceService, prefix: string) {
  const normalizedPrefix = prefix.trim();
  return listCliWorkspaces(workspaceService)
    .filter((workspace) =>
      normalizedPrefix.length === 0
      || workspace.folder.startsWith(normalizedPrefix)
      || workspace.name.startsWith(normalizedPrefix)
    )
    .map((workspace) => ({
      value: workspace.folder,
      label: formatWorkspaceOption(workspace),
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
      normalizedPrefix.length === 0
      || chat.id.startsWith(normalizedPrefix)
      || chat.title.startsWith(normalizedPrefix)
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
        const { workspace, chat } = options.workspaceService.createCliWorkspace({
          name: requestedName || undefined,
        });
        log.info(TAG, "Created CLI workspace from command", {
          workspaceFolder: workspace.folder,
          workspaceName: workspace.name,
          chatId: chat.id,
        });
        await runtimeHost.switchWorkspace(workspace, chat);
        ctx.ui.notify(`Switched to ${workspace.folder}`, "info");
      },
    } satisfies Parameters<Parameters<ExtensionFactory>[0]["registerCommand"]>[1];
    pi.registerCommand("new-workspace", newWorkspaceCommand);

    pi.registerCommand("workspaces", {
      description: "List Octo CLI workspaces and switch via picker",
      handler: async (_args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const selected = await selectWorkspace(
          ctx.ui,
          listCliWorkspaces(options.workspaceService),
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
        await runtimeHost.switchWorkspace(selected);
        ctx.ui.notify(`Switched to ${selected.folder}`, "info");
      },
    });

    pi.registerCommand("switch-workspace", {
      description: "Switch to another Octo CLI workspace",
      getArgumentCompletions: (prefix) =>
        buildWorkspaceCompletions(options.workspaceService, prefix),
      handler: async (args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const targetWorkspace = args.trim()
          ? findCliWorkspace(options.workspaceService, args)
          : await selectWorkspace(
            ctx.ui,
            listCliWorkspaces(options.workspaceService),
            runtimeHost.getCurrentWorkspace().folder,
            "Switch Workspace",
          );

        if (!targetWorkspace) {
          if (args.trim()) {
            ctx.ui.notify(`Workspace not found: ${args.trim()}`, "error");
          }
          return;
        }

        if (targetWorkspace.folder === runtimeHost.getCurrentWorkspace().folder) {
          ctx.ui.notify(`Already in ${targetWorkspace.folder}`, "info");
          return;
        }

        await ctx.waitForIdle();
        await runtimeHost.switchWorkspace(targetWorkspace);
        ctx.ui.notify(`Switched to ${targetWorkspace.folder}`, "info");
      },
    });

    pi.registerCommand("rename-workspace", {
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

        const renamed = options.workspaceService.renameWorkspace(
          currentWorkspace.id,
          requestedName,
        );
        ctx.ui.notify(`Renamed ${renamed.folder} to ${renamed.name}`, "info");
      },
    });

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
      getArgumentCompletions: (prefix) => buildChatCompletions(
        options.workspaceService,
        getRuntimeHost(options).getCurrentWorkspace().id,
        getRuntimeHost(options).getCurrentChat().id,
        prefix,
      ),
      handler: async (args, ctx) => {
        const runtimeHost = getRuntimeHost(options);
        const targetChat = args.trim()
          ? findWorkspaceChat(
            options.workspaceService,
            runtimeHost.getCurrentWorkspace().id,
            args,
          )
          : await selectWorkspaceChat(
            ctx.ui,
            listWorkspaceChats(
              options.workspaceService,
              runtimeHost.getCurrentWorkspace().id,
            ),
            runtimeHost.getCurrentChat().id,
            `Chats in ${runtimeHost.getCurrentWorkspace().name}`,
          );

        if (!targetChat) {
          if (args.trim()) {
            ctx.ui.notify(`Workspace chat not found: ${args.trim()}`, "error");
          }
          return;
        }

        if (targetChat.id === runtimeHost.getCurrentChat().id) {
          ctx.ui.notify(`Already in ${targetChat.title}`, "info");
          return;
        }

        await ctx.waitForIdle();
        await runtimeHost.switchChat(targetChat);
        ctx.ui.notify(`Switched to ${targetChat.title}`, "info");
      },
    });
  };
}
