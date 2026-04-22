import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  createChat as insertChat,
  createWorkspace as insertWorkspace,
  getChatByBinding,
  getChatById,
  getWorkspaceByBinding,
  getWorkspaceByFolder,
  getWorkspaceById,
  listChatsForWorkspace,
  listWorkspaces,
  type ChatRow,
  type WorkspaceRow,
  upsertChatBinding,
  upsertWorkspaceBinding,
  updateChat as updateChatRecord,
  updateWorkspace as updateWorkspaceRecord,
} from "./db";
import {
  createPiSessionManager,
  materializePiSessionRef,
} from "./providers/pi-session-ref";
import { loadAgentProfilesConfig } from "./runtime/profile-config";
import {
  getWorkspaceDirectory,
  setupWorkspaceDirectory,
} from "./group-workspace";

export interface WorkspaceServiceOptions {
  rootDir?: string;
  now?: () => Date;
}

export interface CreateWorkspaceOptions {
  name: string;
  folder: string;
  defaultBranch?: string;
  profileKey?: string;
}

export interface CreateChatOptions {
  title?: string;
  activeBranch?: string;
  triggerPattern?: string;
  requiresTrigger?: boolean;
  externalBinding?: {
    platform: string;
    externalChatId: string;
    externalThreadId?: string | null;
  };
}

function formatTimestampForFolder(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  const seconds = `${date.getSeconds()}`.padStart(2, "0");
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

function generateCliWorkspaceFolder(date: Date): string {
  return `cli_${formatTimestampForFolder(date)}_${randomUUID().slice(0, 6)}`;
}

function getDefaultProfileKey(): string {
  return loadAgentProfilesConfig().defaultProfile;
}

export function buildCliChatBindingId(folder: string): string {
  return `cli:${folder}`;
}

export class WorkspaceService {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    options: WorkspaceServiceOptions = {},
  ) {
    this.rootDir = options.rootDir ?? process.cwd();
    this.now = options.now ?? (() => new Date());
  }

  listWorkspaces(): WorkspaceRow[] {
    return listWorkspaces(this.db);
  }

  getWorkspaceById(workspaceId: string): WorkspaceRow | null {
    return getWorkspaceById(this.db, workspaceId);
  }

  getWorkspaceByFolder(folder: string): WorkspaceRow | null {
    return getWorkspaceByFolder(this.db, folder);
  }

  getWorkspaceByBinding(platform: string, externalId: string): WorkspaceRow | null {
    return getWorkspaceByBinding(this.db, platform, externalId);
  }

  listChats(workspaceId: string): ChatRow[] {
    return listChatsForWorkspace(this.db, workspaceId);
  }

  getChatById(chatId: string): ChatRow | null {
    return getChatById(this.db, chatId);
  }

  getChatByBinding(platform: string, externalChatId: string): ChatRow | null {
    return getChatByBinding(this.db, platform, externalChatId);
  }

  ensureWorkspaceDirectory(workspace: WorkspaceRow): void {
    setupWorkspaceDirectory(workspace.folder, {
      rootDir: this.rootDir,
    });
  }

  createWorkspace(options: CreateWorkspaceOptions): WorkspaceRow {
    const workspace = insertWorkspace(this.db, {
      name: options.name,
      folder: options.folder,
      defaultBranch: options.defaultBranch ?? "main",
      profileKey: options.profileKey ?? getDefaultProfileKey(),
    });
    this.ensureWorkspaceDirectory(workspace);
    upsertWorkspaceBinding(this.db, {
      workspaceId: workspace.id,
      platform: "workspace_folder",
      externalId: workspace.folder,
    });
    return workspace;
  }

  renameWorkspace(workspaceId: string, name: string): WorkspaceRow {
    const workspace = this.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const nextName = name.trim();
    if (!nextName) {
      throw new Error("Workspace name cannot be empty");
    }

    updateWorkspaceRecord(this.db, workspaceId, { name: nextName });
    return this.getWorkspaceById(workspaceId)!;
  }

  createChat(workspaceId: string, options: CreateChatOptions = {}): ChatRow {
    const workspace = this.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    this.ensureWorkspaceDirectory(workspace);
    const workingDirectory = getWorkspaceDirectory(workspace.folder, {
      rootDir: this.rootDir,
    });
    const sessionManager = createPiSessionManager(workingDirectory);
    const sessionRef = materializePiSessionRef(sessionManager);
    const chat = insertChat(this.db, {
      workspaceId,
      title: options.title?.trim() || `Chat ${this.listChats(workspaceId).length + 1}`,
      activeBranch: options.activeBranch?.trim() || workspace.default_branch,
      sessionRef,
      triggerPattern: options.triggerPattern,
      requiresTrigger: options.requiresTrigger,
    });

    if (options.externalBinding) {
      upsertChatBinding(this.db, {
        chatId: chat.id,
        platform: options.externalBinding.platform,
        externalChatId: options.externalBinding.externalChatId,
        externalThreadId: options.externalBinding.externalThreadId,
      });
    }

    return this.getChatById(chat.id)!;
  }

  updateChat(chatId: string, patch: Parameters<typeof updateChatRecord>[2]): ChatRow {
    updateChatRecord(this.db, chatId, patch);
    const updated = this.getChatById(chatId);
    if (!updated) {
      throw new Error(`Chat not found after update: ${chatId}`);
    }
    return updated;
  }

  createCliWorkspace(options: {
    name?: string;
    profileKey?: string;
  } = {}): {
    workspace: WorkspaceRow;
    chat: ChatRow;
  } {
    const folder = generateCliWorkspaceFolder(this.now());
    const workspace = this.createWorkspace({
      name: options.name?.trim() || `CLI ${folder}`,
      folder,
      profileKey: options.profileKey?.trim() || getDefaultProfileKey(),
    });
    const chat = this.createChat(workspace.id, {
      title: workspace.name,
      activeBranch: workspace.default_branch,
      requiresTrigger: false,
      externalBinding: {
        platform: "cli",
        externalChatId: buildCliChatBindingId(folder),
      },
    });

    upsertWorkspaceBinding(this.db, {
      workspaceId: workspace.id,
      platform: "cli_workspace",
      externalId: folder,
    });

    return { workspace, chat };
  }

  ensureFeishuWorkspace(appId: string, options?: {
    name?: string;
    profileKey?: string;
  }): WorkspaceRow {
    const existing = this.getWorkspaceByBinding("feishu_app", appId);
    if (existing) {
      this.ensureWorkspaceDirectory(existing);
      return existing;
    }

    const workspace = this.createWorkspace({
      name: options?.name?.trim() || `Feishu ${appId}`,
      folder: `feishu_${appId}`,
      profileKey: options?.profileKey?.trim() || getDefaultProfileKey(),
    });
    upsertWorkspaceBinding(this.db, {
      workspaceId: workspace.id,
      platform: "feishu_app",
      externalId: appId,
    });
    return this.getWorkspaceById(workspace.id)!;
  }

  ensureFeishuChat(
    workspaceId: string,
    externalChatId: string,
    options?: {
      title?: string;
      requiresTrigger?: boolean;
      triggerPattern?: string;
    },
  ): ChatRow {
    const existing = this.getChatByBinding("feishu", externalChatId);
    if (existing) {
      return existing;
    }

    return this.createChat(workspaceId, {
      title: options?.title?.trim() || `Auto (${externalChatId})`,
      requiresTrigger: options?.requiresTrigger ?? false,
      triggerPattern: options?.triggerPattern,
      externalBinding: {
        platform: "feishu",
        externalChatId,
      },
    });
  }

  touchChat(chatId: string): void {
    updateChatRecord(this.db, chatId, {
      lastActivityAt: this.now().toISOString(),
    });
  }
}
