import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { InteractiveMode } from "../pi-mono/packages/coding-agent/src/index.ts";
import { FeishuChannel } from "./channels/feishu";
import { ChannelManager } from "./channels/manager";
import { type RegisteredGroup, getGroupByJid, initDatabase } from "./db";
import { GroupService } from "./group-service";
import { log } from "./logger";
import { createPiGroupRuntime } from "./runtime/pi-group-runtime-factory";
import type { PiGroupRuntimeContext } from "./runtime/pi-group-runtime-factory";
import type { MessageSender } from "./tools";
import { CliStateStore } from "./cli/state-store";
import { createOctoGroupExtension } from "./cli/octo-group-extension";
import { OctoCliRuntimeHost } from "./cli/octo-cli-runtime-host";

const TAG = "cli";

export interface CliArgs {
  groupFolder?: string;
  help: boolean;
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

function registerOutboundFeishuChannel(channelManager: ChannelManager): void {
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
    "Usage: bun src/cli.ts [--group <folder>]",
    "",
    "Options:",
    "  --group <folder>  Open a specific CLI group",
    "  -h, --help        Show this help",
  ].join("\n"));
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const args = parseCliArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const db = initDatabase("store/messages.db");
  const groupService = new GroupService(db);
  for (const group of groupService.listGroups()) {
    groupService.ensureWorkspace(group);
  }

  const stateStore = new CliStateStore();
  const initialGroup = resolveInitialCliGroup(
    groupService,
    stateStore,
    args.groupFolder,
  );

  const channelManager = new ChannelManager(db);
  registerOutboundFeishuChannel(channelManager);

  let runtimeHostRef: OctoCliRuntimeHost | null = null;
  const octoGroupExtension = createOctoGroupExtension({
    groupService,
    getRuntimeHost: () => runtimeHostRef,
  });

  const { runtime } = await createPiGroupRuntime({
    db,
    groupFolder: initialGroup.folder,
    rootDir: process.cwd(),
    createMessageSender: createCliMessageSender(db, channelManager),
    getExtensionFactories: async () => [octoGroupExtension],
  });

  const runtimeHost = new OctoCliRuntimeHost(runtime, {
    db,
    groupService,
    stateStore,
    currentGroup: initialGroup,
    rootDir: process.cwd(),
  });
  runtimeHostRef = runtimeHost;

  log.info(TAG, "Starting Octo CLI", {
    groupFolder: initialGroup.folder,
    groupName: initialGroup.name,
    cwd: resolve("groups", initialGroup.folder),
  });

  const interactiveMode = new InteractiveMode(runtimeHost);
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
  registerOutboundFeishuChannel,
};
