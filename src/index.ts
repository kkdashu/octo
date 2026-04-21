import {
  initDatabase,
  insertMessage,
} from "./db";
import { ChannelManager } from "./channels/manager";
import { FeishuChannel } from "./channels/feishu";
import { DatabaseImageMessagePreprocessor } from "./runtime/image-message-preprocessor";
import { FeishuGroupAdapter } from "./runtime/feishu-group-adapter";
import {
  MiniMaxTokenPlanMcpClient,
  resolveMiniMaxTokenPlanMcpConfig,
} from "./runtime/minimax-token-plan-mcp";
import { loadAgentProfilesConfig } from "./runtime/profile-config";
import { startMessageLoop } from "./router";
import { startScheduler } from "./task-scheduler";
import { log } from "./logger";
import { WorkspaceService } from "./workspace-service";

const TAG = "main";

log.info(TAG, "Initializing database at store/messages.db");
const db = initDatabase("store/messages.db");
const workspaceService = new WorkspaceService(db);

for (const workspace of workspaceService.listWorkspaces()) {
  workspaceService.ensureWorkspaceDirectory(workspace);
}

const channelManager = new ChannelManager(db);

log.info(TAG, "Creating Feishu channel", {
  appId: process.env.FEISHU_APP_ID,
  port: process.env.PORT || 3000,
});

function getDefaultProfileKey(): string {
  return loadAgentProfilesConfig().defaultProfile;
}

function ensureFeishuRuntimeWorkspace() {
  const appId = process.env.FEISHU_APP_ID?.trim();
  if (!appId) {
    throw new Error("FEISHU_APP_ID is required");
  }

  const workspace = workspaceService.ensureFeishuWorkspace(appId, {
    profileKey: getDefaultProfileKey(),
  });
  workspaceService.ensureWorkspaceDirectory(workspace);
  return workspace;
}

function ensureFeishuChatBinding(chatId: string) {
  const workspace = ensureFeishuRuntimeWorkspace();
  const isMainChat = process.env.MAIN_GROUP_CHAT_ID?.trim() === chatId;
  const chat = workspaceService.ensureFeishuChat(workspace.id, chatId, {
    title: isMainChat ? "Main" : `Auto (${chatId})`,
    requiresTrigger: false,
  });

  workspaceService.updateChat(chat.id, {
    title: isMainChat ? "Main" : chat.title,
    requiresTrigger: false,
  });
}

const feishu = new FeishuChannel(
  {
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY,
    port: Number(process.env.PORT || 3000),
    webhookPath: "/webhook/feishu",
  },
  {
    onMessage: (_channel, message) => {
      insertMessage(db, message);
      ensureFeishuChatBinding(message.chatId);
    },
  },
);
channelManager.register(feishu);

const appId = process.env.FEISHU_APP_ID?.trim();
if (appId) {
  const workspace = ensureFeishuRuntimeWorkspace();
  const mainChatId = process.env.MAIN_GROUP_CHAT_ID?.trim();
  if (mainChatId) {
    const chat = workspaceService.ensureFeishuChat(workspace.id, mainChatId, {
      title: "Main",
      requiresTrigger: false,
    });
    workspaceService.updateChat(chat.id, {
      title: "Main",
      requiresTrigger: false,
    });
  }
}

const minimaxTokenPlanConfig = resolveMiniMaxTokenPlanMcpConfig();
if (!minimaxTokenPlanConfig.apiKey) {
  log.warn(TAG, "MINIMAX_API_KEY not set, image preprocessing will downgrade to failure placeholders");
}
const minimaxTokenPlanClient = new MiniMaxTokenPlanMcpClient(minimaxTokenPlanConfig);
const imageMessagePreprocessor = new DatabaseImageMessagePreprocessor({
  analyzeImage: minimaxTokenPlanClient,
  db,
});
const groupQueue = new FeishuGroupAdapter({
  db,
  workspaceService,
  channelManager,
  imageMessagePreprocessor,
});

await channelManager.startAll();
startMessageLoop(db, channelManager, groupQueue, workspaceService);
startScheduler(db, channelManager, groupQueue);

log.info(TAG, `=== Octo started on port ${process.env.PORT || 3000} ===`);
