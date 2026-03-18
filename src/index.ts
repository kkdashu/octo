import { mkdirSync, existsSync, copyFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { initDatabase, insertMessage, registerGroup, getGroupByJid, listGroups } from "./db";
import { ChannelManager } from "./channels/manager";
import { FeishuChannel } from "./channels/feishu";
import { GroupQueue } from "./group-queue";
import { ProviderRegistry } from "./providers/registry";
import { ClaudeProvider } from "./providers/claude";
import { CodexProvider } from "./providers/codex";
import { KimiProvider } from "./providers/kimi";
import { startMessageLoop } from "./router";
import { startScheduler } from "./task-scheduler";
import { copyDirRecursive } from "./utils";
import { log } from "./logger";

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

const MAIN_TEMPLATE = "groups/MAIN_CLAUDE.md";
const GROUP_TEMPLATE = "groups/GROUP_CLAUDE.md";

function ensureClaudeMd(folder: string, isMain: boolean) {
  const target = `groups/${folder}/CLAUDE.md`;
  if (existsSync(target)) return;
  const template = isMain ? MAIN_TEMPLATE : GROUP_TEMPLATE;
  if (existsSync(template)) {
    copyFileSync(template, target);
    log.info(TAG, `Copied ${template} → ${target}`);
  } else {
    log.warn(TAG, `Template not found: ${template}, skipping CLAUDE.md for ${folder}`);
  }
}

const SYSTEM_SKILLS_DIR = "skills/system";

function syncSystemSkills(folder: string) {
  if (!existsSync(SYSTEM_SKILLS_DIR)) return;
  const targetSkillsDir = `groups/${folder}/.claude/skills`;
  for (const skillName of readdirSync(SYSTEM_SKILLS_DIR)) {
    const src = join(SYSTEM_SKILLS_DIR, skillName);
    if (!statSync(src).isDirectory()) continue;
    const dest = join(targetSkillsDir, skillName);
    copyDirRecursive(src, dest);
  }
  log.info(TAG, `Synced system skills → groups/${folder}/.claude/skills/`);
}

function setupGroup(folder: string, isMain: boolean) {
  mkdirSync(`groups/${folder}`, { recursive: true });
  ensureClaudeMd(folder, isMain);
  // Symlink AGENTS.md → CLAUDE.md so Codex reads the same instructions
  const agentsMd = `groups/${folder}/AGENTS.md`;
  if (!existsSync(agentsMd)) {
    try {
      symlinkSync("CLAUDE.md", agentsMd);
      log.info(TAG, `Symlinked ${agentsMd} → CLAUDE.md`);
    } catch {
      // ignore if symlink already exists or fails
    }
  }
  syncSystemSkills(folder);
  // Symlink .agents/skills → .claude/skills so Codex discovers the same skills
  const agentsSkillsDir = `groups/${folder}/.agents`;
  const agentsSkillsLink = `${agentsSkillsDir}/skills`;
  if (!existsSync(agentsSkillsLink)) {
    mkdirSync(agentsSkillsDir, { recursive: true });
    try {
      symlinkSync("../.claude/skills", agentsSkillsLink);
      log.info(TAG, `Symlinked ${agentsSkillsLink} → .claude/skills`);
    } catch {
      // ignore if symlink already exists or fails
    }
  }
}

function autoRegisterChat(chatId: string) {
  if (getGroupByJid(db, chatId)) return; // already registered

  const groups = listGroups(db);
  const hasMain = groups.some((g) => g.is_main === 1);

  if (!hasMain) {
    // First group ever → register as main (no trigger required)
    const folder = "main";
    setupGroup(folder, true);
    registerGroup(db, {
      jid: chatId,
      name: "Main (auto)",
      folder,
      channelType: "feishu",
      requiresTrigger: false,
      isMain: true,
    });
    log.info(TAG, `Auto-registered as MAIN group: ${chatId} → groups/${folder}`);
  } else {
    // Subsequent groups → register as regular (trigger required)
    const folder = `feishu_${chatId}`;
    setupGroup(folder, false);
    registerGroup(db, {
      jid: chatId,
      name: `Auto (${chatId})`,
      folder,
      channelType: "feishu",
      requiresTrigger: true,
      isMain: false,
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
mkdirSync("groups/main", { recursive: true });
ensureClaudeMd("main", true);
syncSystemSkills("main");

const mainChatId = process.env.MAIN_GROUP_CHAT_ID;
if (mainChatId && !getGroupByJid(db, mainChatId)) {
  registerGroup(db, {
    jid: mainChatId,
    name: "Main",
    folder: "main",
    channelType: "feishu",
    requiresTrigger: false,
    isMain: true,
  });
  log.info(TAG, `Main group registered: ${mainChatId}`);
} else if (mainChatId) {
  log.info(TAG, `Main group already registered: ${mainChatId}`);
} else {
  log.warn(TAG, "MAIN_GROUP_CHAT_ID not set, will auto-register on first message");
}

// Ensure all registered groups have CLAUDE.md and system skills
for (const group of listGroups(db)) {
  setupGroup(group.folder, group.is_main === 1);
}

// ---------------------------------------------------------------------------
// 5. Start internal API for MCP stdio servers (send_message, send_image)
// ---------------------------------------------------------------------------
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 9800);
Bun.serve({
  port: INTERNAL_PORT,
  routes: {
    "/internal/send": {
      POST: async (req: Request) => {
        const { chatJid, text } = (await req.json()) as { chatJid: string; text: string };
        await channelManager.send(chatJid, text);
        return Response.json({ ok: true });
      },
    },
    "/internal/send-image": {
      POST: async (req: Request) => {
        const { chatJid, filePath } = (await req.json()) as { chatJid: string; filePath: string };
        await channelManager.sendImage(chatJid, filePath);
        return Response.json({ ok: true });
      },
    },
    "/internal/refresh-groups": {
      POST: async () => {
        const chats = await channelManager.refreshGroupMetadata();
        return Response.json({ count: chats.length });
      },
    },
  },
});
log.info(TAG, `Internal API started on port ${INTERNAL_PORT}`);

// ---------------------------------------------------------------------------
// 6. Initialize provider registry
// ---------------------------------------------------------------------------
const providers = new ProviderRegistry();
providers.register(new ClaudeProvider());
providers.register(new CodexProvider());
providers.register(new KimiProvider());
log.info(TAG, `Providers registered: ${providers.list().join(", ")}`);

// ---------------------------------------------------------------------------
// 6. Create group queue
// ---------------------------------------------------------------------------
const groupQueue = new GroupQueue(db, channelManager, providers);

// ---------------------------------------------------------------------------
// 7. Start channels, message loop, and scheduler
// ---------------------------------------------------------------------------
await channelManager.startAll();
startMessageLoop(db, channelManager, groupQueue);
startScheduler(db, channelManager, groupQueue);

log.info(TAG, `=== Octo started on port ${process.env.PORT || 3000} ===`);
