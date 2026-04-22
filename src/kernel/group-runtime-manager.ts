import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  AgentSessionEvent,
  AgentSessionRuntime,
  ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { ConversationMessageInput } from "../providers/types";
import {
  createTurnRequest,
  getChatById,
  getRunById,
  getWorkspaceRuntimeState,
  updateTurnRequest,
  updateChat,
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
} from "../runtime/pi-group-runtime-factory";
import {
  createWorkspaceBranch,
  getCurrentWorkspaceBranch,
  isWorkspaceDirty,
  listWorkspaceBranches,
  workspaceBranchExists,
} from "../workspace-git";
import { calculateWorkspaceUnloadAfter } from "../workspace-runtime-state";
import { WorkspaceService } from "../workspace-service";
import {
  appendPersistedRuntimeEvent,
  ensureWorkspaceOnChatBranch as ensureWorkspaceBranchMatch,
  finishPersistedRun,
  persistChatSessionRef,
  startPersistedRun,
} from "../runtime/run-lifecycle";
import {
  buildRenderableMessages,
  toRenderableAssistantDelta,
  toRenderableMessage,
} from "./renderable-message";
import type {
  RuntimeEvent,
  RuntimeListener,
  RuntimeOperationResult,
  RuntimeSnapshot,
  RuntimeSnapshotController,
  RuntimeSummary,
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
  preparePrompt?: (
    chatId: string,
    text: string,
  ) => Promise<string>;
  createChatRuntime?: (
    chatId: string,
  ) => Promise<CreateChatRuntimeResult>;
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

export class GroupRuntimeManager implements RuntimeSnapshotController {
  private readonly rootDir: string;
  private readonly workspaceService: WorkspaceService;
  private readonly listeners = new Map<string, Set<RuntimeListener>>();
  private readonly runtimes = new Map<string, ManagedChatRuntime>();
  private readonly pendingLoads = new Map<string, Promise<ManagedChatRuntime>>();
  private readonly preparePrompt: (
    chatId: string,
    text: string,
  ) => Promise<string>;
  private readonly createChatRuntime: (
    chatId: string,
  ) => Promise<CreateChatRuntimeResult>;

  constructor(private readonly options: GroupRuntimeManagerOptions) {
    this.rootDir = options.rootDir ?? process.cwd();
    this.workspaceService = options.workspaceService
      ?? new WorkspaceService(options.db, { rootDir: this.rootDir });
    this.preparePrompt = options.preparePrompt
      ?? (async (_chatId, text) => text);
    this.createChatRuntime = options.createChatRuntime
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
          chatId: chat.id,
          workspaceFolder: workspace.folder,
          createMessageSender: options.createMessageSender,
          getExtensionFactories: options.getExtensionFactories,
          sessionRefOverride: chat.session_ref,
        });

        return {
          workspace,
          chat,
          runtime,
          sessionRef,
        };
      });
  }

  listChats(): RuntimeSummary[] {
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

  async getSnapshot(chatId: string): Promise<RuntimeSnapshot> {
    const managed = await this.ensureManagedRuntime(chatId);
    return this.buildSnapshot(managed);
  }

  async prompt(
    chatId: string,
    input: ConversationMessageInput,
    options?: {
      sourceType?: "cli" | "desktop" | "system";
      sourceRef?: string;
    },
  ): Promise<RuntimeSnapshot> {
    const managed = await this.ensureManagedRuntime(chatId);
    const shouldStartRun = !managed.runtime.session.isStreaming;
    const now = new Date().toISOString();
    const turnRequest = createTurnRequest(this.options.db, {
      workspaceId: managed.workspace.id,
      chatId: managed.chat.id,
      sourceType: options?.sourceType ?? "system",
      sourceRef: options?.sourceRef,
      inputMode: input.mode,
      requestText: input.text,
      createdAt: now,
    });
    let startedRun: RunRow | null = null;

    try {
      if (shouldStartRun) {
        startedRun = this.startRun(managed, input.mode, turnRequest.id);
        updateTurnRequest(this.options.db, turnRequest.id, {
          status: "running",
          startedAt: now,
          completedAt: null,
          error: null,
        });
      } else {
        updateTurnRequest(this.options.db, turnRequest.id, {
          status: "running",
          startedAt: now,
          completedAt: null,
          error: null,
        });
      }

      await this.sendInput(managed, input);
    } catch (error) {
      if (startedRun) {
        this.finishRun(managed, "failed", formatErrorMessage(error));
      } else {
        updateTurnRequest(this.options.db, turnRequest.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: formatErrorMessage(error),
        });
      }
      throw error;
    }

    if (
      startedRun
      && managed.currentRunId === startedRun.id
      && !managed.runtime.session.isStreaming
    ) {
      this.finishRun(managed, "completed");
    }

    if (!startedRun) {
      updateTurnRequest(this.options.db, turnRequest.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        error: null,
      });
    }

    this.touchChat(managed);
    const snapshot = this.buildSnapshot(managed);
    this.emit(managed.chat.id, { type: "snapshot", snapshot });
    return snapshot;
  }

  async abort(chatId: string): Promise<RuntimeSnapshot> {
    const managed = await this.ensureManagedRuntime(chatId);
    await managed.runtime.session.abort();
    if (managed.currentRunId) {
      this.finishRun(managed, "cancelled");
    }
    const snapshot = this.buildSnapshot(managed);
    this.emit(managed.chat.id, { type: "snapshot", snapshot });
    return snapshot;
  }

  async newSession(chatId: string): Promise<RuntimeSnapshot> {
    const result = await this.createNewSession(chatId);
    return result.snapshot;
  }

  async createNewSession(
    chatId: string,
    options?: Parameters<AgentSessionRuntime["newSession"]>[0],
  ): Promise<RuntimeOperationResult> {
    const managed = await this.ensureManagedRuntime(chatId);
    const result = await managed.runtime.newSession(options);
    return this.afterRuntimeOperation(managed, result.cancelled);
  }

  async fork(
    chatId: string,
    entryId: string,
  ): Promise<RuntimeOperationResult> {
    const managed = await this.ensureManagedRuntime(chatId);
    const result = await managed.runtime.fork(entryId);
    return this.afterRuntimeOperation(managed, result.cancelled);
  }

  async importFromJsonl(
    chatId: string,
    inputPath: string,
  ): Promise<RuntimeOperationResult> {
    const managed = await this.ensureManagedRuntime(chatId);
    const result = await managed.runtime.importFromJsonl(
      inputPath,
      managed.runtime.cwd,
    );
    return this.afterRuntimeOperation(managed, result.cancelled);
  }

  async switchChat(chatId: string): Promise<RuntimeOperationResult> {
    const managed = await this.ensureManagedRuntime(chatId);
    const snapshot = this.buildSnapshot(managed);
    return {
      cancelled: false,
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
  ): Promise<RuntimeSnapshot> {
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
  ): Promise<RuntimeSnapshot> {
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

  subscribe(chatId: string, listener: RuntimeListener): () => void {
    const resolvedChatId = this.resolveChat(chatId).id;
    const listeners = this.listeners.get(resolvedChatId) ?? new Set<RuntimeListener>();
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

  async pruneIdleRuntimes(now = new Date()): Promise<void> {
    const timestamp = now.getTime();
    const entries = [...this.runtimes.entries()];

    for (const [chatId, managed] of entries) {
      if (managed.currentRunId) {
        continue;
      }

      if (managed.runtime.session.isStreaming) {
        continue;
      }

      if (managed.pendingFollowUp.length > 0 || managed.pendingSteering.length > 0) {
        continue;
      }

      if ((this.listeners.get(chatId)?.size ?? 0) > 0) {
        continue;
      }

      const state = getWorkspaceRuntimeState(this.options.db, managed.workspace.id);
      if (!state?.unload_after) {
        continue;
      }

      const unloadAt = new Date(state.unload_after).getTime();
      if (!Number.isFinite(unloadAt) || unloadAt > timestamp) {
        continue;
      }

      managed.unsubscribeSession();
      await managed.runtime.dispose();
      this.runtimes.delete(chatId);
    }
  }

  private toSummary(
    workspace: WorkspaceRow,
    chat: ChatRow,
  ): RuntimeSummary {
    const runtime = this.runtimes.get(chat.id);
    const bindingPlatform = this.options.db
      .query(
        `SELECT platform FROM chat_bindings
         WHERE chat_id = $chatId
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get({ chatId: chat.id }) as { platform: string } | null;
    return {
      workspaceId: workspace.id,
      workspaceFolder: workspace.folder,
      workspaceName: workspace.name,
      chatId: chat.id,
      chatTitle: chat.title,
      activeBranch: chat.active_branch,
      platform: bindingPlatform?.platform ?? "workspace",
      profileKey: workspace.profile_key,
      sessionRef: chat.session_ref,
      isStreaming: runtime?.runtime.session.isStreaming ?? false,
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

  private buildSnapshot(managed: ManagedChatRuntime): RuntimeSnapshot {
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
    };
  }

  private async sendInput(
    managed: ManagedChatRuntime,
    input: ConversationMessageInput,
  ): Promise<void> {
    const normalizedText = await this.preparePrompt(managed.chat.id, input.text);

    if (input.mode === "prompt") {
      if (managed.runtime.session.isStreaming) {
        throw new Error(
          "Cannot send mode=prompt while the Pi session is streaming. Use follow_up or steer.",
        );
      }

      await managed.runtime.session.prompt(normalizedText);
      return;
    }

    if (input.mode === "follow_up") {
      if (managed.runtime.session.isStreaming) {
        await managed.runtime.session.followUp(normalizedText);
        return;
      }

      await managed.runtime.session.prompt(normalizedText);
      return;
    }

    if (managed.runtime.session.isStreaming) {
      await managed.runtime.session.steer(normalizedText);
      return;
    }

    await managed.runtime.session.prompt(normalizedText);
  }

  private async afterRuntimeOperation(
    managed: ManagedChatRuntime,
    cancelled: boolean,
  ): Promise<RuntimeOperationResult> {
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
    const updated = persistChatSessionRef(
      this.options.db,
      managed.chat.id,
      resolved,
    );
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
    ensureWorkspaceBranchMatch(managed.workspace, managed.chat, {
      rootDir: this.rootDir,
    });
  }

  private startRun(
    managed: ManagedChatRuntime,
    triggerSource: string,
    turnRequestId?: string | null,
  ): RunRow {
    this.ensureWorkspaceNotRunning(managed.workspace.id, managed.chat.id);
    this.ensureWorkspaceOnChatBranch(managed);
    const run = startPersistedRun(this.options.db, {
      workspace: managed.workspace,
      chat: managed.chat,
      turnRequestId: turnRequestId ?? null,
      triggerSource,
    });
    managed.currentRunId = run.id;
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

    finishPersistedRun(this.options.db, {
      workspace: managed.workspace,
      chat: managed.chat,
      runId: managed.currentRunId,
      status,
      error: error ?? null,
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
    const run = startPersistedRun(this.options.db, {
      workspace: managed.workspace,
      chat: managed.chat,
      triggerSource,
      startedAt: timestamp,
    });
    appendPersistedRuntimeEvent(this.options.db, {
      runId: run.id,
      chatId: managed.chat.id,
      eventType,
      payload,
      createdAt: timestamp,
    });
    finishPersistedRun(this.options.db, {
      workspace: managed.workspace,
      chat: managed.chat,
      runId: run.id,
      status: "completed",
      completedAt: timestamp,
    });
  }

  private appendRuntimeEvent(
    managed: ManagedChatRuntime,
    eventType: string,
    payload: unknown,
  ): void {
    appendPersistedRuntimeEvent(this.options.db, {
      runId: managed.currentRunId,
      chatId: managed.chat.id,
      eventType,
      payload,
    });
  }

  private buildEventBase(managed: ManagedChatRuntime): {
    workspaceId: string;
    workspaceFolder: string;
    chatId: string;
    runId: string | null;
  } {
    return {
      workspaceId: managed.workspace.id,
      workspaceFolder: managed.workspace.folder,
      chatId: managed.chat.id,
      runId: managed.currentRunId,
    };
  }

  private emit(chatId: string, event: RuntimeEvent): void {
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
