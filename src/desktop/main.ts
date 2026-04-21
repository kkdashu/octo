import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { ChannelManager } from "../channels/manager";
import { createCliMessageSender, registerOutboundFeishuChannel } from "../cli";
import { createDesktopAdminApiRouter, type DesktopAdminApiRouter } from "./admin-api";
import { createDesktopApiRouter, type DesktopApiRouter } from "./api";
import { startDesktopServer } from "./server";
import { initDatabase } from "../db";
import { GroupRuntimeManager } from "../kernel/group-runtime-manager";
import { log } from "../logger";
import { DatabaseImageMessagePreprocessor } from "../runtime/image-message-preprocessor";
import {
  MiniMaxTokenPlanMcpClient,
  resolveMiniMaxTokenPlanMcpConfig,
} from "../runtime/minimax-token-plan-mcp";
import { ensureAgentProfilesPath } from "../runtime/profile-config";
import { createRuntimeInputPreprocessor } from "../runtime/runtime-input-preprocessor";
import { WorkspaceService } from "../workspace-service";

const TAG = "desktop-main";
const IDLE_RUNTIME_PRUNE_INTERVAL_MS = 60_000;

export interface DesktopSidecarOptions {
  rootDir?: string;
  dbPath?: string;
  hostname?: string;
  port?: number;
}

export interface DesktopSidecarHandle {
  rootDir: string;
  db: Database;
  workspaceService: WorkspaceService;
  channelManager: ChannelManager;
  manager: GroupRuntimeManager;
  api: DesktopApiRouter;
  adminApi: DesktopAdminApiRouter;
  server: ReturnType<typeof Bun.serve>;
  stop(): Promise<void>;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`Invalid DESKTOP_PORT: ${value}`);
  }

  return port;
}

export function resolveDesktopSidecarOptionsFromEnv(): DesktopSidecarOptions {
  return {
    rootDir: process.env.OCTO_ROOT_DIR?.trim() || undefined,
    dbPath: process.env.OCTO_DB_PATH?.trim() || undefined,
    hostname: process.env.DESKTOP_HOSTNAME?.trim() || undefined,
    port: parsePort(process.env.DESKTOP_PORT),
  };
}

export async function startDesktopSidecar(
  options: DesktopSidecarOptions = {},
): Promise<DesktopSidecarHandle> {
  const rootDir = options.rootDir ?? process.cwd();
  const dbPath = resolve(rootDir, options.dbPath ?? "store/messages.db");

  log.info(TAG, "Initializing desktop sidecar", {
    rootDir,
    dbPath,
    hostname: options.hostname,
    port: options.port,
  });

  ensureAgentProfilesPath(rootDir);

  const db = initDatabase(dbPath);
  const workspaceService = new WorkspaceService(db, { rootDir });
  for (const workspace of workspaceService.listWorkspaces()) {
    workspaceService.ensureWorkspaceDirectory(workspace);
  }

  const channelManager = new ChannelManager(db, { rootDir });
  registerOutboundFeishuChannel(channelManager);
  const minimaxTokenPlanConfig = resolveMiniMaxTokenPlanMcpConfig();
  if (!minimaxTokenPlanConfig.apiKey) {
    log.warn(TAG, "MINIMAX_API_KEY not set, image preprocessing will downgrade to failure placeholders");
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
  });

  const api = createDesktopApiRouter(manager, {
    workspaceService,
    createCliWorkspace: async ({ name }) => {
      const created = workspaceService.createCliWorkspace({ name });
      const summary = manager.listChats().find((item) => item.chatId === created.chat.id);
      if (!summary) {
        throw new Error(`Failed to expose newly created chat summary: ${created.chat.id}`);
      }
      const snapshot = await manager.getSnapshot(created.chat.id);
      return {
        workspace: created.workspace,
        chat: created.chat,
        summary,
        snapshot,
      };
    },
  });
  const adminApi = createDesktopAdminApiRouter(db, { rootDir });
  const server = startDesktopServer({
    api,
    adminApi,
    hostname: options.hostname,
    port: options.port,
  });
  const idleRuntimePruneTimer = setInterval(() => {
    void manager.pruneIdleRuntimes().catch((error) => {
      log.error(TAG, "Idle runtime prune failed", error);
    });
  }, IDLE_RUNTIME_PRUNE_INTERVAL_MS);

  let stopped = false;
  return {
    rootDir,
    db,
    workspaceService,
    channelManager,
    manager,
    api,
    adminApi,
    server,
    async stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      clearInterval(idleRuntimePruneTimer);
      server.stop(true);
      await minimaxTokenPlanClient.close();
      await manager.dispose();
      await channelManager.stopAll();
      db.close(false);
    },
  };
}

function attachShutdownHandlers(handle: DesktopSidecarHandle): void {
  const shutdown = async (signal: string) => {
    log.info(TAG, "Shutting down desktop sidecar", {
      signal,
      url: handle.server.url.toString(),
    });
    await handle.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

export async function runDesktopSidecar(
  options: DesktopSidecarOptions = {},
): Promise<DesktopSidecarHandle> {
  const handle = await startDesktopSidecar(options);
  attachShutdownHandlers(handle);

  log.info(TAG, "Desktop sidecar ready", {
    url: handle.server.url.toString(),
    rootDir: handle.rootDir,
  });
  return handle;
}

if (import.meta.main) {
  await runDesktopSidecar(resolveDesktopSidecarOptionsFromEnv()).catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
