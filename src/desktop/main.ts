import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ChannelManager } from "../channels/manager";
import { createCliMessageSender, registerOutboundFeishuChannel } from "../cli";
import { createDesktopAdminApiRouter, type DesktopAdminApiRouter } from "./admin-api";
import { createDesktopApiRouter, type DesktopApiRouter } from "./api";
import { startDesktopServer } from "./server";
import { initDatabase } from "../db";
import { GroupService } from "../group-service";
import { GroupRuntimeManager } from "../kernel/group-runtime-manager";
import { log } from "../logger";
import { WorkspaceService } from "../workspace-service";

const TAG = "desktop-main";

export interface DesktopSidecarOptions {
  rootDir?: string;
  dbPath?: string;
  hostname?: string;
  port?: number;
}

export interface DesktopSidecarHandle {
  rootDir: string;
  db: Database;
  groupService: GroupService;
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

function ensureAgentProfilesPath(rootDir: string): void {
  const configured = process.env.AGENT_PROFILES_PATH?.trim();
  const resolvedConfigured = configured ? resolve(configured) : null;
  if (resolvedConfigured && existsSync(resolvedConfigured)) {
    process.env.AGENT_PROFILES_PATH = resolvedConfigured;
    return;
  }

  const fallbackPath = resolve(rootDir, "config/agent-profiles.json");
  if (configured) {
    log.warn(TAG, "AGENT_PROFILES_PATH is invalid for desktop sidecar, falling back to root config", {
      configuredPath: resolve(configured),
      fallbackPath,
    });
  }

  process.env.AGENT_PROFILES_PATH = fallbackPath;
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
  const groupService = new GroupService(db, { rootDir });
  const workspaceService = new WorkspaceService(db, { rootDir });
  for (const group of groupService.listGroups()) {
    groupService.ensureWorkspace(group);
  }

  const channelManager = new ChannelManager(db);
  registerOutboundFeishuChannel(channelManager);

  const manager = new GroupRuntimeManager({
    db,
    workspaceService,
    rootDir,
    createMessageSender: createCliMessageSender(db, channelManager),
  });

  const api = createDesktopApiRouter(manager, {
    workspaceService,
    createCliWorkspace: async ({ name }) => {
      const created = groupService.createCliGroup({
        name,
      });
      log.info(TAG, "Created desktop CLI group", {
        folder: created.folder,
        name: created.name,
        profileKey: created.profile_key,
      });
      const workspace = workspaceService.getWorkspaceByFolder(created.folder);
      if (!workspace) {
        throw new Error(`Failed to expose newly created workspace: ${created.folder}`);
      }
      const chat = workspaceService.listChats(workspace.id)[0] ?? null;
      if (!chat) {
        throw new Error(`Failed to expose newly created chat: ${created.folder}`);
      }
      const summary = manager.listGroups().find((item) => item.chatId === chat.id);
      if (!summary) {
        throw new Error(`Failed to expose newly created chat summary: ${chat.id}`);
      }
      const snapshot = await manager.getSnapshot(chat.id);
      return {
        workspace,
        chat,
        summary,
        group: summary,
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

  let stopped = false;
  return {
    rootDir,
    db,
    groupService,
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
      server.stop(true);
      await manager.dispose();
      await channelManager.stopAll();
      db.close(false);
    },
  };
}

function attachShutdownHandlers(handle: DesktopSidecarHandle): void {
  const shutdown = async (signal: string) => {
    log.info(TAG, `Shutting down desktop sidecar`, {
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
