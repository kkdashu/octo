import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { InteractiveMode } from "@mariozechner/pi-coding-agent";
import { FeishuChannel } from "./channels/feishu";
import { ChannelManager } from "./channels/manager";
import {
  type ChatRow,
  type RegisteredGroup,
  type WorkspaceRow,
  getGroupByJid,
  initDatabase,
} from "./db";
import { GroupService } from "./group-service";
import { log } from "./logger";
import type { PiGroupRuntimeContext } from "./runtime/pi-group-runtime-factory";
import type { MessageSender } from "./tools";
import { CliStateStore } from "./cli/state-store";
import { createOctoGroupExtension } from "./cli/octo-group-extension";
import { OctoCliRuntimeHost } from "./cli/octo-cli-runtime-host";
import { getWorkspaceDirectory } from "./group-workspace";
import { GroupRuntimeManager } from "./kernel/group-runtime-manager";
import { WorkspaceService } from "./workspace-service";

const TAG = "cli";

export interface CliArgs {
  workspace?: string;
  chatId?: string;
  groupFolder?: string;
  help: boolean;
}

export interface CliSelection {
  workspace: WorkspaceRow;
  chat: ChatRow;
  group: RegisteredGroup | null;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (token === "--group") {
      const value = argv[index + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --group");
      }
      args.groupFolder = value;
      index += 1;
      continue;
    }

    if (token === "--workspace") {
      const value = argv[index + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --workspace");
      }
      args.workspace = value;
      index += 1;
      continue;
    }

    if (token === "--chat") {
      const value = argv[index + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --chat");
      }
      args.chatId = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown CLI argument: ${token}`);
  }

  return args;
}

export function resolveInitialCliGroup(
  groupService: GroupService,
  stateStore: CliStateStore,
  requestedGroupFolder?: string,
): RegisteredGroup {
  if (requestedGroupFolder) {
    const requested = groupService.getGroupByFolder(requestedGroupFolder);
    if (!requested || requested.channel_type !== "cli") {
      throw new Error(`CLI group not found: ${requestedGroupFolder}`);
    }

    return requested;
  }

  const lastUsedFolder = stateStore.getCurrentGroupFolder();
  if (lastUsedFolder) {
    const lastUsed = groupService.getGroupByFolder(lastUsedFolder);
    if (lastUsed && lastUsed.channel_type === "cli") {
      return lastUsed;
    }
  }

  return groupService.createCliGroup();
}

function getOrCreateDefaultChat(
  workspaceService: WorkspaceService,
  workspace: WorkspaceRow,
): ChatRow {
  const existing = workspaceService.listChats(workspace.id)[0];
  if (existing) {
    return existing;
  }

  return workspaceService.createChat(workspace.id, {
    title: workspace.name,
    requiresTrigger: false,
  });
}

function resolveWorkspaceByInput(
  workspaceService: WorkspaceService,
  workspaceInput: string,
): WorkspaceRow | null {
  return workspaceService.getWorkspaceById(workspaceInput)
    ?? workspaceService.getWorkspaceByFolder(workspaceInput);
}

export function resolveInitialCliTarget(
  groupService: GroupService,
  workspaceService: WorkspaceService,
  stateStore: CliStateStore,
  options: {
    workspace?: string;
    chatId?: string;
    groupFolder?: string;
  } = {},
): CliSelection {
  if (options.chatId) {
    const chat = workspaceService.getChatById(options.chatId);
    if (!chat) {
      throw new Error(`CLI chat not found: ${options.chatId}`);
    }

    if (options.workspace) {
      const workspace = resolveWorkspaceByInput(workspaceService, options.workspace);
      if (!workspace) {
        throw new Error(`Workspace not found: ${options.workspace}`);
      }

      if (chat.workspace_id !== workspace.id) {
        throw new Error(`Chat ${options.chatId} does not belong to workspace ${options.workspace}`);
      }
    }

    const workspace = workspaceService.getWorkspaceById(chat.workspace_id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chat.workspace_id}`);
    }

    return {
      workspace,
      chat,
      group: groupService.getGroupByFolder(workspace.folder),
    };
  }

  if (options.workspace) {
    const workspace = resolveWorkspaceByInput(workspaceService, options.workspace);
    if (!workspace) {
      throw new Error(`Workspace not found: ${options.workspace}`);
    }

    return {
      workspace,
      chat: getOrCreateDefaultChat(workspaceService, workspace),
      group: groupService.getGroupByFolder(workspace.folder),
    };
  }

  if (options.groupFolder) {
    const group = resolveInitialCliGroup(
      groupService,
      stateStore,
      options.groupFolder,
    );
    const workspace = workspaceService.getWorkspaceByFolder(group.folder);
    if (!workspace) {
      throw new Error(`Workspace not found: ${group.folder}`);
    }

    return {
      workspace,
      chat: getOrCreateDefaultChat(workspaceService, workspace),
      group,
    };
  }

  const lastUsedChatId = stateStore.getCurrentChatId();
  if (lastUsedChatId) {
    const chat = workspaceService.getChatById(lastUsedChatId);
    if (chat) {
      const workspace = workspaceService.getWorkspaceById(chat.workspace_id);
      if (workspace) {
        return {
          workspace,
          chat,
          group: groupService.getGroupByFolder(workspace.folder),
        };
      }
    }
  }

  const lastUsedWorkspaceFolder = stateStore.getCurrentWorkspaceFolder();
  if (lastUsedWorkspaceFolder) {
    const workspace = workspaceService.getWorkspaceByFolder(lastUsedWorkspaceFolder);
    if (workspace) {
      return {
        workspace,
        chat: getOrCreateDefaultChat(workspaceService, workspace),
        group: groupService.getGroupByFolder(workspace.folder),
      };
    }
  }

  const createdGroup = groupService.createCliGroup();
  const workspace = workspaceService.getWorkspaceByFolder(createdGroup.folder);
  if (!workspace) {
    throw new Error(`Workspace not found: ${createdGroup.folder}`);
  }

  return {
    workspace,
    chat: getOrCreateDefaultChat(workspaceService, workspace),
    group: createdGroup,
  };
}

export function createCliMessageSender(
  db: Database,
  channelManager: ChannelManager,
) {
  return (context: PiGroupRuntimeContext): MessageSender => ({
    send: async (chatJid, text) => {
      const targetGroup = getGroupByJid(db, chatJid);
      if (targetGroup?.channel_type === "cli") {
        throw new Error(
          `send_message to CLI groups is unsupported from ${context.group.folder}; reply in the current session instead`,
        );
      }

      await channelManager.send(chatJid, text);
    },
    sendImage: async (chatJid, filePath) => {
      const targetGroup = getGroupByJid(db, chatJid);
      if (targetGroup?.channel_type === "cli") {
        throw new Error(
          `send_image to CLI groups is unsupported from ${context.group.folder}`,
        );
      }

      await channelManager.sendImage(chatJid, filePath);
    },
    refreshGroupMetadata: async () => ({
      count: (await channelManager.refreshGroupMetadata()).length,
    }),
  });
}

export function registerOutboundFeishuChannel(channelManager: ChannelManager): void {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    return;
  }

  channelManager.register(new FeishuChannel(
    {
      appId,
      appSecret,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY,
      port: Number(process.env.PORT || 3000),
      webhookPath: "/webhook/feishu",
    },
    {
      onMessage: () => undefined,
    },
  ));
}

function printHelp(): void {
  console.log([
    "Usage: bun src/cli.ts [--workspace <id|folder>] [--chat <chatId>]",
    "",
    "Options:",
    "  --workspace <id|folder>  Open a specific workspace",
    "  --chat <chatId>          Open a specific chat",
    "  --group <folder>         Legacy alias for opening a CLI workspace",
    "  -h, --help               Show this help",
  ].join("\n"));
}

function ensureCliAgentProfilesPath(rootDir: string): void {
  const configured = process.env.AGENT_PROFILES_PATH?.trim();
  const resolvedConfigured = configured ? resolve(rootDir, configured) : null;
  if (resolvedConfigured && existsSync(resolvedConfigured)) {
    process.env.AGENT_PROFILES_PATH = resolvedConfigured;
    return;
  }

  const fallbackCandidates = [
    resolve(rootDir, "config/agent-profiles.json"),
    resolve(rootDir, "config/agent-profiles.example.json"),
  ];
  const fallbackPath = fallbackCandidates.find((candidate) => existsSync(candidate))
    ?? fallbackCandidates[0]!;
  if (configured) {
    log.warn(TAG, "AGENT_PROFILES_PATH is invalid for CLI, falling back to root config", {
      configuredPath: resolvedConfigured,
      fallbackPath,
    });
  }

  process.env.AGENT_PROFILES_PATH = fallbackPath;
}

async function syncInteractiveModeRuntime(mode: InteractiveMode): Promise<void> {
  const internal = mode as unknown as {
    handleRuntimeSessionChange?: () => Promise<void>;
    renderCurrentSessionState?: () => void;
    ui?: {
      requestRender?: () => void;
    };
  };

  if (
    typeof internal.handleRuntimeSessionChange !== "function"
    || typeof internal.renderCurrentSessionState !== "function"
  ) {
    throw new Error("InteractiveMode runtime sync API is unavailable");
  }

  await internal.handleRuntimeSessionChange();
  internal.renderCurrentSessionState();
  internal.ui?.requestRender?.();
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const rootDir = process.cwd();
  const args = parseCliArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  ensureCliAgentProfilesPath(rootDir);

  const db = initDatabase("store/messages.db");
  const groupService = new GroupService(db, { rootDir });
  const workspaceService = new WorkspaceService(db, { rootDir });
  for (const group of groupService.listGroups()) {
    groupService.ensureWorkspace(group);
  }

  const stateStore = new CliStateStore();
  const initial = resolveInitialCliTarget(
    groupService,
    workspaceService,
    stateStore,
    {
      workspace: args.workspace,
      chatId: args.chatId,
      groupFolder: args.groupFolder,
    },
  );

  const channelManager = new ChannelManager(db);
  registerOutboundFeishuChannel(channelManager);

  let runtimeHostRef: OctoCliRuntimeHost | null = null;
  const octoGroupExtension = createOctoGroupExtension({
    groupService,
    workspaceService,
    getRuntimeHost: () => runtimeHostRef,
  });

  const runtimeManager = new GroupRuntimeManager({
    db,
    workspaceService,
    rootDir,
    createMessageSender: createCliMessageSender(db, channelManager),
    getExtensionFactories: async () => [octoGroupExtension],
  });
  const runtime = await runtimeManager.ensureRuntime(initial.chat.id);

  const runtimeHost = new OctoCliRuntimeHost({
    manager: runtimeManager,
    stateStore,
    currentWorkspace: initial.workspace,
    currentChat: initial.chat,
    currentGroup: initial.group,
    runtime,
  });
  runtimeHostRef = runtimeHost;

  log.info(TAG, "Starting Octo CLI", {
    workspaceFolder: initial.workspace.folder,
    workspaceName: initial.workspace.name,
    chatId: initial.chat.id,
    chatTitle: initial.chat.title,
    cwd: getWorkspaceDirectory(initial.workspace.folder, { rootDir }),
  });

  const interactiveMode = new InteractiveMode(runtimeHost);
  runtimeHost.setExternalSwitchHandler(async () => {
    await syncInteractiveModeRuntime(interactiveMode);
  });
  await interactiveMode.run();
}

if (import.meta.main) {
  await runCli().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

export const __test__ = {
  ensureCliAgentProfilesPath,
  registerOutboundFeishuChannel,
  resolveInitialCliTarget,
};
