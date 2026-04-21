import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { InteractiveMode } from "@mariozechner/pi-coding-agent";
import { FeishuChannel } from "./channels/feishu";
import { ChannelManager } from "./channels/manager";
import {
  type ChatRow,
  type WorkspaceRow,
  getChatByBinding,
  initDatabase,
} from "./db";
import type { PiGroupRuntimeContext } from "./runtime/pi-group-runtime-factory";
import { ensureAgentProfilesPath } from "./runtime/profile-config";
import type { MessageSender } from "./tools";
import { CliStateStore } from "./cli/state-store";
import { createOctoGroupExtension } from "./cli/octo-group-extension";
import { OctoCliRuntimeHost } from "./cli/octo-cli-runtime-host";
import { GroupRuntimeManager } from "./kernel/group-runtime-manager";
import { log } from "./logger";
import { DatabaseImageMessagePreprocessor } from "./runtime/image-message-preprocessor";
import {
  MiniMaxTokenPlanMcpClient,
  resolveMiniMaxTokenPlanMcpConfig,
} from "./runtime/minimax-token-plan-mcp";
import { WorkspaceService } from "./workspace-service";
import { createRuntimeInputPreprocessor } from "./runtime/runtime-input-preprocessor";

export interface CliArgs {
  workspace?: string;
  chatId?: string;
  help: boolean;
}

export interface CliSelection {
  workspace: WorkspaceRow;
  chat: ChatRow;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      args.help = true;
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
  workspaceService: WorkspaceService,
  stateStore: CliStateStore,
  options: {
    workspace?: string;
    chatId?: string;
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

    return { workspace, chat };
  }

  if (options.workspace) {
    const workspace = resolveWorkspaceByInput(workspaceService, options.workspace);
    if (!workspace) {
      throw new Error(`Workspace not found: ${options.workspace}`);
    }

    return {
      workspace,
      chat: getOrCreateDefaultChat(workspaceService, workspace),
    };
  }

  const lastUsedChatId = stateStore.getCurrentChatId();
  if (lastUsedChatId) {
    const chat = workspaceService.getChatById(lastUsedChatId);
    if (chat) {
      const workspace = workspaceService.getWorkspaceById(chat.workspace_id);
      if (workspace) {
        return { workspace, chat };
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
      };
    }
  }

  const created = workspaceService.createCliWorkspace();
  return created;
}

export function createCliMessageSender(
  db: Database,
  channelManager: ChannelManager,
) {
  return (context: PiGroupRuntimeContext): MessageSender => ({
    send: async (externalChatId, text) => {
      const targetChat = getChatByBinding(db, "cli", externalChatId);
      if (targetChat) {
        throw new Error(
          `send_message to CLI chats is unsupported from ${context.workspace.folder}; reply in the current session instead`,
        );
      }

      await channelManager.send(externalChatId, text);
    },
    sendImage: async (externalChatId, filePath) => {
      const targetChat = getChatByBinding(db, "cli", externalChatId);
      if (targetChat) {
        throw new Error(
          `send_image to CLI chats is unsupported from ${context.workspace.folder}`,
        );
      }

      await channelManager.sendImage(externalChatId, filePath);
    },
    refreshChatMetadata: async () => ({
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
    "  -h, --help               Show this help",
  ].join("\n"));
}

function ensureCliAgentProfilesPath(rootDir: string): void {
  ensureAgentProfilesPath(rootDir);
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

  const db = initDatabase(resolve(rootDir, "store/messages.db"));
  const workspaceService = new WorkspaceService(db, { rootDir });
  for (const workspace of workspaceService.listWorkspaces()) {
    workspaceService.ensureWorkspaceDirectory(workspace);
  }

  const stateStore = new CliStateStore(resolve(rootDir, "store/cli-state.json"));
  const channelManager = new ChannelManager(db, { rootDir });
  registerOutboundFeishuChannel(channelManager);
  let runtimeHost: OctoCliRuntimeHost | null = null;
  const minimaxTokenPlanConfig = resolveMiniMaxTokenPlanMcpConfig();
  if (!minimaxTokenPlanConfig.apiKey) {
    log.warn("cli", "MINIMAX_API_KEY not set, image preprocessing will downgrade to failure placeholders");
  }
  const minimaxTokenPlanClient = new MiniMaxTokenPlanMcpClient(minimaxTokenPlanConfig);
  const imageMessagePreprocessor = new DatabaseImageMessagePreprocessor({
    analyzeImage: minimaxTokenPlanClient,
    db,
  });
  const runtimeInputPreprocessor = createRuntimeInputPreprocessor({
    db,
    rootDir,
    workspaceService,
    imageMessagePreprocessor,
  });

  const manager = new GroupRuntimeManager({
    db,
    workspaceService,
    rootDir,
    createMessageSender: createCliMessageSender(db, channelManager),
    preparePrompt: runtimeInputPreprocessor.prepare,
    getExtensionFactories: () => [
      createOctoGroupExtension({
        workspaceService,
        getRuntimeHost: () => runtimeHost,
      }),
    ],
  });

  const initial = resolveInitialCliTarget(
    workspaceService,
    stateStore,
    {
      workspace: args.workspace,
      chatId: args.chatId,
    },
  );
  const runtime = await manager.ensureRuntime(initial.chat.id);
  runtimeHost = new OctoCliRuntimeHost({
    manager,
    stateStore,
    currentWorkspace: initial.workspace,
    currentChat: initial.chat,
    runtime,
  });

  const interactiveMode = new InteractiveMode(runtimeHost);
  runtimeHost.setExternalSwitchHandler(async () => {
    await syncInteractiveModeRuntime(interactiveMode);
  });

  try {
    await interactiveMode.run();
  } finally {
    await minimaxTokenPlanClient.close();
    await channelManager.stopAll();
    await manager.dispose();
    db.close(false);
  }
}

export const __test__ = {
  ensureCliAgentProfilesPath,
};

if (import.meta.main) {
  await runCli().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
