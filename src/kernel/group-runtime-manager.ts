import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  AgentSessionEvent,
  AgentSessionRuntime,
  ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { ConversationMessageInput } from "../providers/types";
import {
  appendRunEvent,
  createRun,
  getChatById,
  getChatBySessionRef,
  getGroupByFolder,
  getRunById,
  getWorkspaceRuntimeState,
  updateChat,
  updateRun,
  upsertWorkspaceRuntimeState,
  type ChatRow,
  type RunRow,
  type WorkspaceRow,
} from "../db";
import { getWorkspaceDirectory } from "../group-workspace";
import type { MessageSender } from "../tools";
import type { PiGroupRuntimeContext } from "../runtime/pi-group-runtime-factory";
import {
  createPiGroupRuntime,
  getGroupFolderFromWorkingDirectory,
} from "../runtime/pi-group-runtime-factory";
import {
  checkoutWorkspaceBranch,
  createWorkspaceBranch,
  getCurrentWorkspaceBranch,
  isWorkspaceDirty,
  listWorkspaceBranches,
  workspaceBranchExists,
} from "../workspace-git";
import { calculateWorkspaceUnloadAfter } from "../workspace-runtime-state";
import { WorkspaceService } from "../workspace-service";
import {
  buildRenderableMessages,
  toRenderableAssistantDelta,
  toRenderableMessage,
} from "./renderable-message";
import { getSessionHeader } from "./session-file";
import type {
  GroupRuntimeEvent,
  GroupRuntimeListener,
  GroupRuntimeOperationResult,
  GroupRuntimeSnapshot,
  GroupRuntimeSnapshotController,
  GroupRuntimeSummary,
} from "./types";

type CreateChatRuntimeResult = {
  workspace: WorkspaceRow;
  chat: ChatRow;
  runtime: AgentSessionRuntime;
  sessionRef: string | null;
};

type ManagedChatRuntime = {
  workspace: WorkspaceRow;
  chat: ChatRow;
  runtime: AgentSessionRuntime;
  unsubscribeSession: () => void;
  pendingFollowUp: string[];
  pendingSteering: string[];
  streamingMessageId: string | null;
  currentRunId: string | null;
};

export interface GroupRuntimeManagerOptions {
  db: Database;
  workspaceService?: WorkspaceService;
  rootDir?: string;
  createMessageSender: (
    context: PiGroupRuntimeContext,
  ) => MessageSender;
  getExtensionFactories?: (
    context: PiGroupRuntimeContext,
  ) => ExtensionFactory[] | Promise<ExtensionFactory[]>;
  createChatRuntime?: (
    chatId: string,
  ) => Promise<CreateChatRuntimeResult>;
  createGroupRuntime?: (
    groupFolder: string,
  ) => Promise<{
    group: {
      folder: string;
    };
    runtime: AgentSessionRuntime;
    sessionRef: string;
  }>;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? "", null, 2);
  } catch {
    return String(value);
  }
}

export class GroupRuntimeManager implements GroupRuntimeSnapshotController {
  private readonly rootDir: string;
  private readonly workspaceService: WorkspaceService;
  private readonly listeners = new Map<string, Set<GroupRuntimeListener>>();
  private readonly runtimes = new Map<string, ManagedChatRuntime>();
  private readonly pendingLoads = new Map<string, Promise<ManagedChatRuntime>>();
  private readonly createChatRuntime: (
    chatId: string,
  ) => Promise<CreateChatRuntimeResult>;

  constructor(private readonly options: GroupRuntimeManagerOptions) {
    this.rootDir = options.rootDir ?? process.cwd();
    this.workspaceService = options.workspaceService
      ?? new WorkspaceService(options.db, { rootDir: this.rootDir });
    const legacyCreateGroupRuntime = options.createGroupRuntime;
    this.createChatRuntime = options.createChatRuntime
      ?? (legacyCreateGroupRuntime
        ? async (chatId) => {
          const chat = this.resolveChat(chatId);
          const workspace = this.getWorkspaceForChat(chat);
          const created = await legacyCreateGroupRuntime(workspace.folder);
          return {
            workspace,
            chat,
            runtime: created.runtime,
            sessionRef: created.sessionRef,
          };
        }
        : undefined)
      ?? (async (chatId) => {
        const chat = this.workspaceService.getChatById(chatId);
        if (!chat) {
          throw new Error(`Chat not found: ${chatId}`);
        }

        const workspace = this.workspaceService.getWorkspaceById(chat.workspace_id);
        if (!workspace) {
          throw new Error(`Workspace not found: ${chat.workspace_id}`);
        }

        const { runtime, sessionRef } = await createPiGroupRuntime({
          db: options.db,
          rootDir: this.rootDir,
          groupFolder: workspace.folder,
          createMessageSender: options.createMessageSender,
          getExtensionFactories: options.getExtensionFactories,
          sessionRefOverride: chat.session_ref,
          persistSessionRef: false,
        });

        return {
          workspace,
          chat,
          runtime,
          sessionRef,
        };
      });
  }

  listGroups(): GroupRuntimeSummary[] {
    return this.workspaceService
      .listWorkspaces()
      .flatMap((workspace) =>
        this.workspaceService.listChats(workspace.id).map((chat) =>
          this.toSummary(workspace, chat),
        ));
  }

  async ensureRuntime(chatId: string): Promise<AgentSessionRuntime> {
    return (await this.ensureManagedRuntime(chatId)).runtime;
  }

  getLoadedRuntime(chatId: string): AgentSessionRuntime | null {
    return this.runtimes.get(chatId)?.runtime ?? null;
  }

  async getSnapshot(chatId: string): Promise<GroupRuntimeSnapshot> {
    const managed = await this.ensureManagedRuntime(chatId);
    return this.buildSnapshot(managed);
  }

  async prompt(
    chatId: string,
    input: ConversationMessageInput,
  ): Promise<GroupRuntimeSnapshot> {
    const managed = await this.ensureManagedRuntime(chatId);
    const shouldStartRun = !managed.runtime.session.isStreaming;
    let startedRun: RunRow | null = null;

    if (shouldStartRun) {
      startedRun = this.startRun(managed, input.mode);
    }

    try {
      await this.sendInput(managed, input);
    } catch (error) {
      if (startedRun) {
        this.finishRun(managed, "failed", formatErrorMessage(error));
      }
      throw error;
    }

    this.touchChat(managed);
    const snapshot = this.buildSnapshot(managed);
    this.emit(managed.chat.id, { type: "snapshot", snapshot });
    return snapshot;
  }

  async abort(chatId: string): Promise<GroupRuntimeSnapshot> {
    const managed = await this.ensureManagedRuntime(chatId);
    await managed.runtime.session.abort();
    if (managed.currentRunId) {
      this.finishRun(managed, "cancelled");
    }
    const snapshot = this.buildSnapshot(managed);
    this.emit(managed.chat.id, { type: "snapshot", snapshot });
    return snapshot;
  }

  async newSession(chatId: string): Promise<GroupRuntimeSnapshot> {
    const result = await this.createNewSession(chatId);
    return result.snapshot;
  }

  async createNewSession(
    chatId: string,
    options?: Parameters<AgentSessionRuntime["newSession"]>[0],
  ): Promise<GroupRuntimeOperationResult> {
    const managed = await this.ensureManagedRuntime(chatId);
    const result = await managed.runtime.newSession(options);
    return this.afterRuntimeOperation(managed, result.cancelled);
  }

  async fork(
    chatId: string,
    entryId: string,
  ): Promise<GroupRuntimeOperationResult> {
    const managed = await this.ensureManagedRuntime(chatId);
    const result = await managed.runtime.fork(entryId);
    return this.afterRuntimeOperation(managed, result.cancelled);
  }

  async importFromJsonl(
    chatId: string,
    inputPath: string,
  ): Promise<GroupRuntimeOperationResult> {
    const managed = await this.ensureManagedRuntime(chatId);
    const result = await managed.runtime.importFromJsonl(
      inputPath,
      managed.runtime.cwd,
    );
    return this.afterRuntimeOperation(managed, result.cancelled);
  }

  async switchChat(chatId: string): Promise<GroupRuntimeOperationResult> {
    const managed = await this.ensureManagedRuntime(chatId);
    const snapshot = this.buildSnapshot(managed);
    return {
      cancelled: false,
      group: getGroupByFolder(this.options.db, managed.workspace.folder),
      workspace: managed.workspace,
      chat: managed.chat,
      runtime: managed.runtime,
      snapshot,
    };
  }

  async switchGroup(groupFolder: string): Promise<GroupRuntimeOperationResult> {
    return this.switchChat(groupFolder);
  }

  async switchSession(
    _currentChatId: string,
    sessionPath: string,
    cwdOverride?: string,
  ): Promise<GroupRuntimeOperationResult> {
    const targetCwd = cwdOverride ?? getSessionHeader(sessionPath)?.cwd;
    if (!targetCwd) {
      throw new Error(`Cannot resolve session cwd: ${sessionPath}`);
    }

    const folder = getGroupFolderFromWorkingDirectory(targetCwd, this.rootDir);
    if (!folder) {
      throw new Error(`Session is outside Octo registered workspaces: ${sessionPath}`);
    }

    const workspace = this.workspaceService.getWorkspaceByFolder(folder);
    if (!workspace) {
      throw new Error(`Workspace not found for session cwd: ${targetCwd}`);
    }

    let chat = getChatBySessionRef(this.options.db, sessionPath);
    if (!chat) {
      chat = this.workspaceService.createChat(workspace.id, {
        title: `Imported ${workspace.name}`,
        activeBranch: workspace.default_branch,
      });
      updateChat(this.options.db, chat.id, {
        sessionRef: sessionPath,
      });
      chat = this.workspaceService.getChatById(chat.id);
      if (!chat) {
        throw new Error(`Failed to materialize chat for session: ${sessionPath}`);
      }
    }

    const managed = await this.ensureManagedRuntime(chat.id);
    const result = await managed.runtime.switchSession(sessionPath, targetCwd);
    if (!result.cancelled) {
      this.persistSessionRef(managed, sessionPath);
      this.bindSession(managed);
    }

    const snapshot = this.buildSnapshot(managed);
    if (!result.cancelled) {
      this.emit(chat.id, { type: "snapshot", snapshot });
    }

    return {
      cancelled: result.cancelled,
      group: getGroupByFolder(this.options.db, managed.workspace.folder),
      workspace: managed.workspace,
      chat: managed.chat,
      runtime: managed.runtime,
      snapshot,
    };
  }

  listBranches(chatId: string): {
    currentBranch: string;
    branches: string[];
    isDirty: boolean;
  } {
    const chat = this.resolveChat(chatId);

    const workspace = this.workspaceService.getWorkspaceById(chat.workspace_id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chat.workspace_id}`);
    }

    const workspaceDir = getWorkspaceDirectory(workspace.folder, {
      rootDir: this.rootDir,
    });
    return {
      currentBranch: getCurrentWorkspaceBranch(workspaceDir),
      branches: listWorkspaceBranches(workspaceDir),
      isDirty: isWorkspaceDirty(workspaceDir),
    };
  }

  async switchBranch(
    chatId: string,
    branch: string,
    options: {
      confirm: boolean;
      allowDirty?: boolean;
    },
  ): Promise<GroupRuntimeSnapshot> {
    if (!options.confirm) {
      throw new Error("Branch switch requires explicit confirmation");
    }

    const managed = await this.ensureManagedRuntime(chatId);
    this.ensureWorkspaceNotRunning(managed.workspace.id, chatId);
    const workspaceDir = getWorkspaceDirectory(managed.workspace.folder, {
      rootDir: this.rootDir,
    });

    if (!workspaceBranchExists(workspaceDir, branch)) {
      throw new Error(`Branch not found: ${branch}`);
    }

    if (isWorkspaceDirty(workspaceDir) && !options.allowDirty) {
      throw new Error("Workspace has uncommitted changes; confirmation is required");
    }

    checkoutWorkspaceBranch(workspaceDir, branch);
    const changedAt = new Date();
    upsertWorkspaceRuntimeState(this.options.db, {
      workspaceId: managed.workspace.id,
      checkedOutBranch: branch,
      status: managed.currentRunId ? "running" : "idle",
      activeRunId: managed.currentRunId,
      lastActivityAt: changedAt.toISOString(),
      unloadAfter: managed.currentRunId ? null : calculateWorkspaceUnloadAfter(changedAt),
    });
    const previousBranch = managed.chat.active_branch;
    managed.chat = this.workspaceService.updateChat(chatId, {
      activeBranch: branch,
    });
    this.recordWorkspaceOperation(
      managed,
      "branch_switch",
      "branch_switched",
      {
        branch,
        previousBranch,
      },
      changedAt,
    );

    const snapshot = this.buildSnapshot(managed);
    this.emit(chatId, { type: "snapshot", snapshot });
    return snapshot;
  }

  async forkBranch(
    chatId: string,
    branch: string,
    options: {
      confirm: boolean;
      fromBranch?: string;
      allowDirty?: boolean;
    },
  ): Promise<GroupRuntimeSnapshot> {
    if (!options.confirm) {
      throw new Error("Branch fork requires explicit confirmation");
    }

    const managed = await this.ensureManagedRuntime(chatId);
    this.ensureWorkspaceNotRunning(managed.workspace.id, chatId);
    const workspaceDir = getWorkspaceDirectory(managed.workspace.folder, {
      rootDir: this.rootDir,
    });

    if (isWorkspaceDirty(workspaceDir) && !options.allowDirty) {
      throw new Error("Workspace has uncommitted changes; confirmation is required");
    }

    const fromBranch = options.fromBranch ?? getCurrentWorkspaceBranch(workspaceDir);
    createWorkspaceBranch(
      workspaceDir,
      branch,
      fromBranch,
    );
    checkoutWorkspaceBranch(workspaceDir, branch);
    const changedAt = new Date();
    upsertWorkspaceRuntimeState(this.options.db, {
      workspaceId: managed.workspace.id,
      checkedOutBranch: branch,
      status: managed.currentRunId ? "running" : "idle",
      activeRunId: managed.currentRunId,
      lastActivityAt: changedAt.toISOString(),
      unloadAfter: managed.currentRunId ? null : calculateWorkspaceUnloadAfter(changedAt),
    });
    managed.chat = this.workspaceService.updateChat(chatId, {
      activeBranch: branch,
    });
    this.recordWorkspaceOperation(
      managed,
      "branch_fork",
      "branch_forked",
      {
        branch,
        fromBranch,
      },
      changedAt,
    );

    const snapshot = this.buildSnapshot(managed);
    this.emit(chatId, { type: "snapshot", snapshot });
    return snapshot;
  }

  subscribe(chatId: string, listener: GroupRuntimeListener): () => void {
    const resolvedChatId = this.resolveChat(chatId).id;
    const listeners = this.listeners.get(resolvedChatId) ?? new Set<GroupRuntimeListener>();
    listeners.add(listener);
    this.listeners.set(resolvedChatId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(resolvedChatId);
      }
    };
  }

  async dispose(): Promise<void> {
    const managedRuntimes = [...this.runtimes.values()];
    this.runtimes.clear();
    this.pendingLoads.clear();

    for (const managed of managedRuntimes) {
      managed.unsubscribeSession();
      await managed.runtime.dispose();
    }
  }

  private toSummary(
    workspace: WorkspaceRow,
    chat: ChatRow,
  ): GroupRuntimeSummary {
    const runtime = this.runtimes.get(chat.id);
    const group = getGroupByFolder(this.options.db, workspace.folder);
    return {
      workspaceId: workspace.id,
      workspaceFolder: workspace.folder,
      workspaceName: workspace.name,
      chatId: chat.id,
      chatTitle: chat.title,
      activeBranch: chat.active_branch,
      channelType: group?.channel_type ?? "workspace",
      isMain: workspace.is_main === 1,
      profileKey: workspace.profile_key,
      sessionRef: chat.session_ref,
      isStreaming: runtime?.runtime.session.isStreaming ?? false,
      folder: workspace.folder,
      name: workspace.name,
    };
  }

  private resolveChat(chatOrWorkspaceId: string): ChatRow {
    const directChat = this.workspaceService.getChatById(chatOrWorkspaceId);
    if (directChat) {
      return directChat;
    }

    const workspace = this.workspaceService.getWorkspaceById(chatOrWorkspaceId)
      ?? this.workspaceService.getWorkspaceByFolder(chatOrWorkspaceId);
    if (workspace) {
      const defaultChat = this.workspaceService.listChats(workspace.id)[0] ?? null;
      if (defaultChat) {
        return defaultChat;
      }
    }

    throw new Error(`Chat not found: ${chatOrWorkspaceId}`);
  }

  private getWorkspaceForChat(chat: ChatRow): WorkspaceRow {
    const workspace = this.workspaceService.getWorkspaceById(chat.workspace_id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chat.workspace_id}`);
    }

    return workspace;
  }

  private async ensureManagedRuntime(
    chatOrWorkspaceId: string,
  ): Promise<ManagedChatRuntime> {
    const chatId = this.resolveChat(chatOrWorkspaceId).id;
    const existing = this.runtimes.get(chatId);
    if (existing) {
      return existing;
    }

    const pending = this.pendingLoads.get(chatId);
    if (pending) {
      return pending;
    }

    const task = this.createManagedRuntime(chatId);
    this.pendingLoads.set(chatId, task);

    try {
      const managed = await task;
      this.runtimes.set(chatId, managed);
      return managed;
    } finally {
      this.pendingLoads.delete(chatId);
    }
  }

  private async createManagedRuntime(
    chatId: string,
  ): Promise<ManagedChatRuntime> {
    const created = await this.createChatRuntime(chatId);
    const managed: ManagedChatRuntime = {
      workspace: created.workspace,
      chat: created.chat,
      runtime: created.runtime,
      unsubscribeSession: () => undefined,
      pendingFollowUp: [],
      pendingSteering: [],
      streamingMessageId: null,
      currentRunId: null,
    };

    this.bindSession(managed);
    this.persistSessionRef(managed, created.sessionRef);
    return managed;
  }

  private bindSession(managed: ManagedChatRuntime): void {
    managed.unsubscribeSession();
    managed.pendingFollowUp = [];
    managed.pendingSteering = [];
    managed.streamingMessageId = null;
    managed.unsubscribeSession = managed.runtime.session.subscribe((event) => {
      this.handleSessionEvent(managed, event);
    });
  }

  private handleSessionEvent(
    managed: ManagedChatRuntime,
    event: AgentSessionEvent,
  ): void {
    const baseEvent = this.buildEventBase(managed);

    if (event.type === "queue_update") {
      managed.pendingSteering = [...event.steering];
      managed.pendingFollowUp = [...event.followUp];
      this.appendRuntimeEvent(managed, "queue_update", {
        steering: managed.pendingSteering,
        followUp: managed.pendingFollowUp,
      });
      this.emit(managed.chat.id, {
        type: "queue_update",
        ...baseEvent,
        steering: [...event.steering],
        followUp: [...event.followUp],
      });
      return;
    }

    if (event.type === "message_start") {
      const messageId = managed.streamingMessageId ?? randomUUID();
      managed.streamingMessageId = messageId;
      const message = toRenderableMessage(messageId, event.message);
      if (message) {
        this.appendRuntimeEvent(managed, "message_start", message);
        this.emit(managed.chat.id, {
          type: "message_start",
          ...baseEvent,
          message,
        });
      }
      return;
    }

    if (event.type === "message_update") {
      const delta = toRenderableAssistantDelta(event.assistantMessageEvent);
      const messageId = managed.streamingMessageId ?? randomUUID();
      managed.streamingMessageId = messageId;
      const message = toRenderableMessage(messageId, event.message);
      if (delta && message) {
        this.appendRuntimeEvent(managed, "message_delta", {
          message,
          delta,
        });
        this.emit(managed.chat.id, {
          type: "message_delta",
          ...baseEvent,
          message,
          delta,
        });
      }
      return;
    }

    if (event.type === "message_end") {
      const messageId = managed.streamingMessageId ?? randomUUID();
      const message = toRenderableMessage(messageId, event.message);
      managed.streamingMessageId = null;
      this.persistSessionRef(managed, null);
      if (message) {
        this.appendRuntimeEvent(managed, "message_end", message);
        this.emit(managed.chat.id, {
          type: "message_end",
          ...baseEvent,
          message,
        });
      }
      this.emit(managed.chat.id, {
        type: "snapshot",
        snapshot: this.buildSnapshot(managed),
      });
      return;
    }

    if (event.type === "tool_execution_start") {
      this.appendRuntimeEvent(managed, "tool_start", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argsText: stringifyUnknown(event.args),
      });
      this.emit(managed.chat.id, {
        type: "tool_start",
        ...baseEvent,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argsText: stringifyUnknown(event.args),
      });
      return;
    }

    if (event.type === "tool_execution_update") {
      this.appendRuntimeEvent(managed, "tool_update", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResultText: stringifyUnknown(event.partialResult),
      });
      this.emit(managed.chat.id, {
        type: "tool_update",
        ...baseEvent,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResultText: stringifyUnknown(event.partialResult),
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      this.appendRuntimeEvent(managed, "tool_end", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultText: stringifyUnknown(event.result),
        isError: event.isError,
      });
      this.emit(managed.chat.id, {
        type: "tool_end",
        ...baseEvent,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        resultText: stringifyUnknown(event.result),
        isError: event.isError,
      });
      return;
    }

    if (event.type === "agent_end") {
      this.persistSessionRef(managed, null);
      this.finishRun(managed, "completed");
      this.emit(managed.chat.id, {
        type: "agent_end",
        ...baseEvent,
      });
      this.emit(managed.chat.id, {
        type: "snapshot",
        snapshot: this.buildSnapshot(managed),
      });
      return;
    }

    if (event.type === "compaction_end" && event.errorMessage) {
      this.appendRuntimeEvent(managed, "error", {
        message: event.errorMessage,
      });
      this.emit(managed.chat.id, {
        type: "error",
        ...baseEvent,
        message: event.errorMessage,
      });
      return;
    }

    if (
      event.type === "auto_retry_start"
      || event.type === "auto_retry_end"
    ) {
      const message = event.type === "auto_retry_start"
        ? event.errorMessage
        : event.finalError;
      if (message) {
        this.appendRuntimeEvent(managed, "error", {
          message,
        });
        this.emit(managed.chat.id, {
          type: "error",
          ...baseEvent,
          message,
        });
      }
    }
  }

  private buildSnapshot(managed: ManagedChatRuntime): GroupRuntimeSnapshot {
    return {
      workspaceId: managed.workspace.id,
      workspaceFolder: managed.workspace.folder,
      workspaceName: managed.workspace.name,
      chatId: managed.chat.id,
      chatTitle: managed.chat.title,
      activeBranch: managed.chat.active_branch,
      profileKey: managed.workspace.profile_key,
      sessionRef: managed.runtime.session.sessionFile ?? managed.chat.session_ref,
      currentRunId: managed.currentRunId,
      isStreaming: managed.runtime.session.isStreaming,
      pendingFollowUp: [...managed.pendingFollowUp],
      pendingSteering: [...managed.pendingSteering],
      messages: buildRenderableMessages(managed.runtime.session.sessionManager),
      groupFolder: managed.workspace.folder,
      groupName: managed.workspace.name,
    };
  }

  private async sendInput(
    managed: ManagedChatRuntime,
    input: ConversationMessageInput,
  ): Promise<void> {
    if (input.mode === "prompt") {
      if (managed.runtime.session.isStreaming) {
        throw new Error(
          "Cannot send mode=prompt while the Pi session is streaming. Use follow_up or steer.",
        );
      }

      await managed.runtime.session.prompt(input.text);
      return;
    }

    if (input.mode === "follow_up") {
      if (managed.runtime.session.isStreaming) {
        await managed.runtime.session.followUp(input.text);
        return;
      }

      await managed.runtime.session.prompt(input.text);
      return;
    }

    if (managed.runtime.session.isStreaming) {
      await managed.runtime.session.steer(input.text);
      return;
    }

    await managed.runtime.session.prompt(input.text);
  }

  private async afterRuntimeOperation(
    managed: ManagedChatRuntime,
    cancelled: boolean,
  ): Promise<GroupRuntimeOperationResult> {
    if (!cancelled) {
      this.bindSession(managed);
      this.persistSessionRef(managed, null);
    }

    const snapshot = this.buildSnapshot(managed);
    if (!cancelled) {
      this.emit(managed.chat.id, {
        type: "snapshot",
        snapshot,
      });
    }

    return {
      cancelled,
      group: getGroupByFolder(this.options.db, managed.workspace.folder),
      workspace: managed.workspace,
      chat: managed.chat,
      runtime: managed.runtime,
      snapshot,
    };
  }

  private persistSessionRef(
    managed: ManagedChatRuntime,
    sessionRef: string | null,
  ): void {
    const resolved = managed.runtime.session.sessionFile ?? sessionRef;
    updateChat(this.options.db, managed.chat.id, {
      sessionRef: resolved,
      lastActivityAt: new Date().toISOString(),
    });
    const updated = getChatById(this.options.db, managed.chat.id);
    if (updated) {
      managed.chat = updated;
    }
  }

  private touchChat(managed: ManagedChatRuntime): void {
    updateChat(this.options.db, managed.chat.id, {
      lastActivityAt: new Date().toISOString(),
    });
    const updated = getChatById(this.options.db, managed.chat.id);
    if (updated) {
      managed.chat = updated;
    }
  }

  private ensureWorkspaceNotRunning(
    workspaceId: string,
    currentChatId: string,
  ): void {
    for (const runtime of this.runtimes.values()) {
      if (
        runtime.workspace.id === workspaceId
        && runtime.chat.id !== currentChatId
        && runtime.currentRunId
      ) {
        throw new Error(`Workspace already has an active run: ${workspaceId}`);
      }
    }

    const state = getWorkspaceRuntimeState(this.options.db, workspaceId);
    if (state?.active_run_id) {
      const run = getRunById(this.options.db, state.active_run_id);
      if (run && run.chat_id !== currentChatId && run.status === "running") {
        throw new Error(`Workspace already has an active run: ${workspaceId}`);
      }
    }
  }

  private ensureWorkspaceOnChatBranch(managed: ManagedChatRuntime): void {
    const workspaceDir = getWorkspaceDirectory(managed.workspace.folder, {
      rootDir: this.rootDir,
    });
    const currentBranch = getCurrentWorkspaceBranch(workspaceDir);
    if (currentBranch !== managed.chat.active_branch) {
      checkoutWorkspaceBranch(workspaceDir, managed.chat.active_branch);
    }
  }

  private startRun(
    managed: ManagedChatRuntime,
    triggerSource: string,
  ): RunRow {
    this.ensureWorkspaceNotRunning(managed.workspace.id, managed.chat.id);
    this.ensureWorkspaceOnChatBranch(managed);
    const now = new Date().toISOString();
    const run = createRun(this.options.db, {
      workspaceId: managed.workspace.id,
      chatId: managed.chat.id,
      status: "running",
      branch: managed.chat.active_branch,
      triggerSource,
      startedAt: now,
    });
    managed.currentRunId = run.id;
    upsertWorkspaceRuntimeState(this.options.db, {
      workspaceId: managed.workspace.id,
      checkedOutBranch: managed.chat.active_branch,
      activeRunId: run.id,
      status: "running",
      lastActivityAt: now,
      unloadAfter: null,
    });
    appendRunEvent(this.options.db, {
      runId: run.id,
      chatId: managed.chat.id,
      eventType: "run_started",
      payload: JSON.stringify({
        triggerSource,
        branch: managed.chat.active_branch,
      }),
      createdAt: now,
    });
    return run;
  }

  private finishRun(
    managed: ManagedChatRuntime,
    status: "completed" | "failed" | "cancelled",
    error?: string,
  ): void {
    if (!managed.currentRunId) {
      return;
    }

    const now = new Date().toISOString();
    updateRun(this.options.db, managed.currentRunId, {
      status,
      endedAt: now,
      error: error ?? null,
    });
    appendRunEvent(this.options.db, {
      runId: managed.currentRunId,
      chatId: managed.chat.id,
      eventType: `run_${status}`,
      payload: JSON.stringify({
        error: error ?? null,
      }),
      createdAt: now,
    });
    upsertWorkspaceRuntimeState(this.options.db, {
      workspaceId: managed.workspace.id,
      checkedOutBranch: managed.chat.active_branch,
      activeRunId: null,
      status: status === "failed" ? "error" : "idle",
      lastActivityAt: now,
      unloadAfter: calculateWorkspaceUnloadAfter(new Date(now)),
      lastError: status === "failed" ? error ?? null : null,
    });
    managed.currentRunId = null;
  }

  private recordWorkspaceOperation(
    managed: ManagedChatRuntime,
    triggerSource: string,
    eventType: string,
    payload: Record<string, unknown>,
    createdAt = new Date(),
  ): void {
    const timestamp = createdAt.toISOString();
    const run = createRun(this.options.db, {
      workspaceId: managed.workspace.id,
      chatId: managed.chat.id,
      status: "running",
      branch: managed.chat.active_branch,
      triggerSource,
      startedAt: timestamp,
    });
    appendRunEvent(this.options.db, {
      runId: run.id,
      chatId: managed.chat.id,
      eventType: "run_started",
      payload: JSON.stringify({
        triggerSource,
        branch: managed.chat.active_branch,
      }),
      createdAt: timestamp,
    });
    appendRunEvent(this.options.db, {
      runId: run.id,
      chatId: managed.chat.id,
      eventType,
      payload: JSON.stringify(payload),
      createdAt: timestamp,
    });
    updateRun(this.options.db, run.id, {
      status: "completed",
      endedAt: timestamp,
    });
    appendRunEvent(this.options.db, {
      runId: run.id,
      chatId: managed.chat.id,
      eventType: "run_completed",
      payload: JSON.stringify({
        triggerSource,
      }),
      createdAt: timestamp,
    });
  }

  private appendRuntimeEvent(
    managed: ManagedChatRuntime,
    eventType: string,
    payload: unknown,
  ): void {
    if (!managed.currentRunId) {
      return;
    }

    appendRunEvent(this.options.db, {
      runId: managed.currentRunId,
      chatId: managed.chat.id,
      eventType,
      payload: JSON.stringify(payload),
    });
  }

  private buildEventBase(managed: ManagedChatRuntime): {
    workspaceId: string;
    workspaceFolder: string;
    chatId: string;
    groupFolder: string;
    runId: string | null;
  } {
    return {
      workspaceId: managed.workspace.id,
      workspaceFolder: managed.workspace.folder,
      chatId: managed.chat.id,
      groupFolder: managed.workspace.folder,
      runId: managed.currentRunId,
    };
  }

  private emit(chatId: string, event: GroupRuntimeEvent): void {
    const listeners = this.listeners.get(chatId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        const fallbackMessage = formatErrorMessage(error);
        const snapshotListeners = this.listeners.get(chatId);
        if (!snapshotListeners) {
          continue;
        }

        for (const nextListener of snapshotListeners) {
          if (nextListener === listener) {
            continue;
          }

          const fallbackBase = this.runtimes.has(chatId)
            ? this.buildEventBase(this.runtimes.get(chatId)!)
            : {
                workspaceId: "",
                workspaceFolder: "",
                chatId,
                groupFolder: "",
                runId: null,
              };

          nextListener({
            type: "error",
            ...fallbackBase,
            message: fallbackMessage,
          });
        }
      }
    }
  }
}
