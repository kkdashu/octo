import {
  getGroupByJid,
  initDatabase,
  insertMessage,
  listGroups,
  registerGroup,
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
import { createAdminApiRouter } from "./admin/api";
import { DEFAULT_ADMIN_PORT, startAdminServer } from "./admin/server";
import { setupGroupWorkspace } from "./group-workspace";

const TAG = "main";

// ---------------------------------------------------------------------------
// 1. Initialize database
// ---------------------------------------------------------------------------
log.info(TAG, "Initializing database at store/messages.db");
const db = initDatabase("store/messages.db");
log.info(TAG, "Database initialized successfully");

// ---------------------------------------------------------------------------
// 2. Create channel manager
// ---------------------------------------------------------------------------
const channelManager = new ChannelManager(db);

// ---------------------------------------------------------------------------
// 3. Create and register Feishu channel
// ---------------------------------------------------------------------------
log.info(TAG, "Creating Feishu channel", {
  appId: process.env.FEISHU_APP_ID,
  port: process.env.PORT || 3000,
});

function getDefaultProfileKey(): string {
  return loadAgentProfilesConfig().defaultProfile;
}

function autoRegisterChat(chatId: string) {
  if (getGroupByJid(db, chatId)) return; // already registered

  const groups = listGroups(db);
  const hasMain = groups.some((g) => g.is_main === 1);

  if (!hasMain) {
    // First group ever → register as main (no trigger required)
    const folder = "main";
    setupGroupWorkspace(folder, true);
    registerGroup(db, {
      jid: chatId,
      name: "Main (auto)",
      folder,
      channelType: "feishu",
      requiresTrigger: false,
      isMain: true,
      profileKey: getDefaultProfileKey(),
    });
    log.info(TAG, `Auto-registered as MAIN group: ${chatId} → groups/${folder}`);
  } else {
    // Subsequent groups → register as regular (trigger required)
    const folder = `feishu_${chatId}`;
    setupGroupWorkspace(folder, false);
    registerGroup(db, {
      jid: chatId,
      name: `Auto (${chatId})`,
      folder,
      channelType: "feishu",
      requiresTrigger: true,
      isMain: false,
      profileKey: getDefaultProfileKey(),
    });
    log.info(TAG, `Auto-registered as regular group: ${chatId} → groups/${folder}`);
  }
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
      log.info(TAG, "onMessage callback: inserting message into database", {
        id: message.id,
        chatId: message.chatId,
        sender: message.sender,
        senderName: message.senderName,
        content: message.content,
        timestamp: message.timestamp,
        mentionsMe: message.mentionsMe,
      });
      insertMessage(db, message);
      log.debug(TAG, "Message inserted into database successfully");

      // Auto-register unregistered chats
      autoRegisterChat(message.chatId);
    },
  },
);
channelManager.register(feishu);

// ---------------------------------------------------------------------------
// 4. Ensure main group directory and registration
// ---------------------------------------------------------------------------
setupGroupWorkspace("main", true);

const mainChatId = process.env.MAIN_GROUP_CHAT_ID;
if (mainChatId && !getGroupByJid(db, mainChatId)) {
  registerGroup(db, {
    jid: mainChatId,
    name: "Main",
    folder: "main",
    channelType: "feishu",
    requiresTrigger: false,
    isMain: true,
    profileKey: getDefaultProfileKey(),
  });
  log.info(TAG, `Main group registered: ${mainChatId}`);
} else if (mainChatId) {
  log.info(TAG, `Main group already registered: ${mainChatId}`);
} else {
  log.warn(TAG, "MAIN_GROUP_CHAT_ID not set, will auto-register on first message");
}

// Ensure all registered groups have AGENTS.md and system skills
for (const group of listGroups(db)) {
  setupGroupWorkspace(group.folder, group.is_main === 1);
}

// ---------------------------------------------------------------------------
// 5. Build shared Pi-native group runtime host
// ---------------------------------------------------------------------------
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
  channelManager,
  imageMessagePreprocessor,
});
log.info(TAG, "Shared Pi-native group runtime host initialized");

// ---------------------------------------------------------------------------
// 6. Start channels, message loop, and scheduler
// ---------------------------------------------------------------------------
await channelManager.startAll();
startMessageLoop(db, channelManager, groupQueue);
startScheduler(db, channelManager, groupQueue);

// ---------------------------------------------------------------------------
// 7. Start local admin UI
// ---------------------------------------------------------------------------
const adminPort = Number(process.env.ADMIN_PORT || DEFAULT_ADMIN_PORT);
startAdminServer({
  port: adminPort,
  api: createAdminApiRouter(db),
});

log.info(TAG, `=== Octo started on port ${process.env.PORT || 3000} ===`);
