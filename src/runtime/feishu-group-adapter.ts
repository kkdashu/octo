import type { Database } from "bun:sqlite";
import {
  appendRunEvent,
  createRun,
  getChatById,
  listChatBindingsForChat,
  updateChat,
  updateRun,
  upsertWorkspaceRuntimeState,
  type ChatRow,
  type WorkspaceRow,
} from "../db";
import { getWorkspaceDirectory } from "../group-workspace";
import { log } from "../logger";
import {
  collectAssistantText,
  normalizePromptForAgent,
} from "../providers/prompt-normalizer";
import type { ConversationMessageInput } from "../providers/types";
import type { ImageMessagePreprocessor } from "./image-message-preprocessor";
import type {
  ClearGroupSessionResult,
  GroupRuntimeController,
} from "./group-runtime-controller";
import type {
  PiGroupRuntimeContext,
  PiGroupSessionHost,
} from "./pi-group-runtime-factory";
import {
  createPiGroupRuntime,
  createPiGroupSessionHost,
} from "./pi-group-runtime-factory";
import type { ChannelManager } from "../channels/manager";
import { WorkspaceService } from "../workspace-service";
import {
  checkoutWorkspaceBranch,
  getCurrentWorkspaceBranch,
} from "../workspace-git";
import { calculateWorkspaceUnloadAfter } from "../workspace-runtime-state";

const TAG = "feishu-group-adapter";

type SessionEvent = {
  type: string;
  message?: unknown;
  name?: unknown;
};

type AssistantMessageLike = Parameters<typeof collectAssistantText>[0] & {
  stopReason?: unknown;
  errorMessage?: unknown;
};

type ActiveChatSession = {
  host: PiGroupSessionHost;
  workspace: WorkspaceRow;
  chat: ChatRow;
  generation: number;
  unsubscribe: () => void;
  reportedRuntimeFailures: Set<string>;
  pendingInitialInputs: ConversationMessageInput[];
  initialInputPending: boolean;
  initialInputFlush: Promise<void> | null;
  closed: boolean;
  runId: string;
};

type CreateChatSessionHostResult = {
  host: PiGroupSessionHost;
  workspace: WorkspaceRow;
  chat: ChatRow;
  sessionRef: string;
};

export interface FeishuGroupAdapterOptions {
  db: Database;
  workspaceService?: WorkspaceService;
  channelManager: ChannelManager;
  imageMessagePreprocessor: ImageMessagePreprocessor;
  concurrencyLimit?: number;
  rootDir?: string;
  createChatSessionHost?: (
    chatId: string,
  ) => Promise<CreateChatSessionHostResult>;
  resetChatSession?: (chatId: string) => Promise<string>;
  preparePrompt?: (chatId: string, text: string) => Promise<string>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeRuntimeFailureText(message: string): string {
  const normalized = message.trim();
  if (!normalized) {
    return "AI 运行失败: 未知错误";
  }

  return normalized.startsWith("AI 运行失败:")
    ? normalized
    : `AI 运行失败: ${normalized}`;
}

function formatRuntimeFailureMessage(error: unknown): string {
  if (typeof error === "string") {
    return normalizeRuntimeFailureText(error);
  }

  if (error instanceof Error) {
    return normalizeRuntimeFailureText(error.message);
  }

  return normalizeRuntimeFailureText(String(error));
}

function extractAssistantRuntimeFailure(
  message: AssistantMessageLike,
): string | null {
  if (message.role !== "assistant" || message.stopReason !== "error") {
    return null;
  }

  if (typeof message.errorMessage !== "string") {
    return null;
  }

  const normalized = message.errorMessage.trim();
  return normalized || null;
}

export class FeishuGroupAdapter implements GroupRuntimeController {
  private readonly workspaceService: WorkspaceService;
  private readonly concurrencyLimit: number;
  private readonly rootDir: string;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly activeSessions = new Map<string, ActiveChatSession>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly outboundLocks = new Map<string, Promise<void>>();
  private activeTasks = 0;
  private readonly createChatSessionHost: (
    chatId: string,
  ) => Promise<CreateChatSessionHostResult>;
  private readonly resetChatSession: (chatId: string) => Promise<string>;
  private readonly preparePrompt: (chatId: string, text: string) => Promise<string>;

  constructor(private readonly options: FeishuGroupAdapterOptions) {
    this.workspaceService = options.workspaceService
      ?? new WorkspaceService(options.db, { rootDir: options.rootDir ?? process.cwd() });
    this.concurrencyLimit = options.concurrencyLimit ?? 3;
    this.rootDir = options.rootDir ?? process.cwd();
    this.createChatSessionHost = options.createChatSessionHost
      ?? (async (chatId) => {
        const chat = this.resolveChat(chatId);
        const workspace = this.getWorkspaceForChat(chat);
        const { host, sessionRef } = await createPiGroupSessionHost({
          db: options.db,
          rootDir: this.rootDir,
          chatId: chat.id,
          workspaceFolder: workspace.folder,
          createMessageSender: (context) => this.createMessageSender(context),
          sessionRefOverride: chat.session_ref,
        });

        return {
          host,
          workspace,
          chat,
          sessionRef,
        };
      });
    this.resetChatSession = options.resetChatSession
      ?? (async (chatId) => {
        const chat = this.resolveChat(chatId);
        const workspace = this.getWorkspaceForChat(chat);
        const { runtime, sessionRef } = await createPiGroupRuntime({
          db: options.db,
          rootDir: this.rootDir,
          chatId: chat.id,
          workspaceFolder: workspace.folder,
          createMessageSender: (context) => this.createMessageSender(context),
          sessionRefOverride: chat.session_ref,
        });

        try {
          await runtime.newSession();
          const nextSessionRef = runtime.session.sessionFile ?? sessionRef;
          this.persistSessionRef(chat.id, nextSessionRef);
          return nextSessionRef;
        } finally {
          await runtime.dispose();
        }
      });
    this.preparePrompt = options.preparePrompt
      ?? ((chatId, text) => {
        const chat = this.resolveChat(chatId);
        const workspace = this.getWorkspaceForChat(chat);
        return normalizePromptForAgent(
          text,
          this.rootDir,
          getWorkspaceDirectory(workspace.folder, { rootDir: this.rootDir }),
          options.imageMessagePreprocessor,
          TAG,
        );
      });

    log.info(TAG, "FeishuGroupAdapter initialized", {
      concurrencyLimit: this.concurrencyLimit,
      rootDir: this.rootDir,
    });
  }

  pushMessage(chatId: string, input: ConversationMessageInput): boolean {
    const chat = this.resolveChat(chatId);
    const activeSession = this.activeSessions.get(chat.workspace_id);
    if (!activeSession || activeSession.chat.id !== chat.id) {
      return false;
    }

    if (activeSession.initialInputPending) {
      activeSession.pendingInitialInputs.push(input);
      return true;
    }

    void this.sendInput(activeSession, input).catch((error) => {
      log.error(TAG, `Failed to push ${input.mode} message to ${chat.id}`, error);
      void this.reportRuntimeFailure(activeSession, error);
    });
    return true;
  }

  isActive(chatId: string): boolean {
    const chat = this.resolveChat(chatId);
    const activeSession = this.activeSessions.get(chat.workspace_id);
    return activeSession?.chat.id === chat.id;
  }

  async enqueue(chatId: string, initialPrompt: string): Promise<void> {
    const chat = this.resolveChat(chatId);
    const existing = this.locks.get(chat.workspace_id);
    const task = (existing ?? Promise.resolve()).then(() =>
      this.runTurn(chat.id, initialPrompt),
    );
    const lockPromise = task.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(chat.workspace_id, lockPromise);

    task.finally(() => {
      if (this.locks.get(chat.workspace_id) === lockPromise) {
        this.locks.delete(chat.workspace_id);
      }
    });

    return task;
  }

  async clearSession(chatId: string): Promise<ClearGroupSessionResult> {
    const chat = this.resolveChat(chatId);
    const workspace = this.getWorkspaceForChat(chat);
    const previousSessionRef = chat.session_ref;
    const generation = this.bumpSessionGeneration(chat.id);
    const activeSession = this.activeSessions.get(workspace.id);
    const closedActiveSession = activeSession?.chat.id === chat.id;

    if (activeSession && activeSession.chat.id === chat.id) {
      activeSession.closed = true;
      this.activeSessions.delete(workspace.id);
      try {
        await activeSession.host.session.abort();
      } catch (error) {
        log.warn(TAG, `Abort failed while clearing session for ${chat.id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      activeSession.unsubscribe();
      await activeSession.host.dispose().catch((error) => {
        log.warn(TAG, `Dispose failed while clearing session for ${chat.id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    const sessionRef = await this.resetChatSession(chat.id);
    this.persistSessionRef(chat.id, sessionRef);

    return {
      closedActiveSession: Boolean(closedActiveSession),
      previousSessionRef,
      sessionRef,
      generation,
    };
  }

  private resolveChat(chatId: string): ChatRow {
        const directChat = this.workspaceService.getChatById(chatId);
    if (directChat) {
      return directChat;
    }

    const workspace = this.workspaceService.getWorkspaceById(chatId)
      ?? this.workspaceService.getWorkspaceByFolder(chatId);
    if (workspace) {
      const firstChat = this.workspaceService.listChats(workspace.id)[0] ?? null;
      if (firstChat) {
        return firstChat;
      }
    }

    throw new Error(`Chat not found: ${chatId}`);
  }

  private getWorkspaceForChat(chat: ChatRow): WorkspaceRow {
    const workspace = this.workspaceService.getWorkspaceById(chat.workspace_id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chat.workspace_id}`);
    }

    return workspace;
  }

  private getSessionGeneration(chatId: string): number {
    return this.sessionGenerations.get(chatId) ?? 0;
  }

  private bumpSessionGeneration(chatId: string): number {
    const nextGeneration = this.getSessionGeneration(chatId) + 1;
    this.sessionGenerations.set(chatId, nextGeneration);
    return nextGeneration;
  }

  private createMessageSender(_context: PiGroupRuntimeContext) {
    return {
      send: (externalChatId: string, text: string) =>
        this.options.channelManager.send(externalChatId, text),
      sendImage: (externalChatId: string, filePath: string) =>
        this.options.channelManager.sendImage(externalChatId, filePath),
      refreshChatMetadata: async () => {
        const chats = await this.options.channelManager.refreshGroupMetadata();
        return { count: chats.length };
      },
      clearSession: async (chatId: string) => this.clearSession(chatId),
    };
  }

  private async runTurn(chatId: string, initialPrompt: string): Promise<void> {
    const initialChat = this.resolveChat(chatId);
    const initialWorkspace = this.getWorkspaceForChat(initialChat);
    await this.waitForConcurrencySlot(initialWorkspace.id);
    this.activeTasks += 1;

    const sessionGeneration = this.getSessionGeneration(initialChat.id);
    let activeSession: ActiveChatSession | null = null;

    try {
      const created = await this.createChatSessionHost(initialChat.id);
      if (sessionGeneration !== this.getSessionGeneration(created.chat.id)) {
        await created.host.dispose();
        return;
      }

      this.ensureWorkspaceOnChatBranch(created.workspace, created.chat);
      const now = new Date().toISOString();
      const run = createRun(this.options.db, {
        workspaceId: created.workspace.id,
        chatId: created.chat.id,
        status: "running",
        branch: created.chat.active_branch,
        triggerSource: "router",
        startedAt: now,
      });
      upsertWorkspaceRuntimeState(this.options.db, {
        workspaceId: created.workspace.id,
        checkedOutBranch: created.chat.active_branch,
        activeRunId: run.id,
        status: "running",
        lastActivityAt: now,
        unloadAfter: null,
      });
      appendRunEvent(this.options.db, {
        runId: run.id,
        chatId: created.chat.id,
        eventType: "run_started",
        payload: JSON.stringify({
          branch: created.chat.active_branch,
        }),
        createdAt: now,
      });

      activeSession = {
        host: created.host,
        workspace: created.workspace,
        chat: created.chat,
        generation: sessionGeneration,
        unsubscribe: () => undefined,
        reportedRuntimeFailures: new Set(),
        pendingInitialInputs: [],
        initialInputPending: true,
        initialInputFlush: null,
        closed: false,
        runId: run.id,
      };

      activeSession.unsubscribe = created.host.session.subscribe((event: SessionEvent) => {
        this.handleSessionEvent(activeSession!, event);
      });
      this.activeSessions.set(created.workspace.id, activeSession);

      await this.sendInput(activeSession, {
        mode: "prompt",
        text: initialPrompt,
      }, {
        onPromptDispatched: () => {
          if (activeSession?.host.session.isStreaming) {
            void this.releasePendingInitialInputs(activeSession);
          }
        },
      });
      await this.releasePendingInitialInputs(activeSession, { wait: true });
      await this.waitForOutboundDrain(activeSession.chat.id);

      if (sessionGeneration === this.getSessionGeneration(activeSession.chat.id)) {
        const sessionRef = created.host.session.sessionFile ?? created.sessionRef;
        this.persistSessionRef(activeSession.chat.id, sessionRef);
      }

      this.finishRun(activeSession, "completed");
    } catch (error) {
      log.error(TAG, `Failed to run turn for chat ${initialChat.id}`, error);
      if (activeSession) {
        this.finishRun(activeSession, "failed", toError(error).message);
        await this.reportRuntimeFailure(activeSession, error);
      }
    } finally {
      if (
        activeSession
        && this.activeSessions.get(activeSession.workspace.id)?.generation === sessionGeneration
      ) {
        this.activeSessions.delete(activeSession.workspace.id);
      }
      if (activeSession) {
        activeSession.closed = true;
        activeSession.unsubscribe();
        await activeSession.host.dispose().catch((error) => {
          log.warn(TAG, `Failed to dispose runtime for ${activeSession.chat.id}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      this.activeTasks = Math.max(0, this.activeTasks - 1);
    }
  }

  private async sendInput(
    activeSession: ActiveChatSession,
    input: ConversationMessageInput,
    options?: {
      onPromptDispatched?(): void;
    },
  ): Promise<void> {
    const normalizedPrompt = await this.preparePrompt(
      activeSession.chat.id,
      input.text,
    );

    if (input.mode === "prompt") {
      if (activeSession.host.session.isStreaming) {
        throw new Error(
          "Cannot send mode=prompt while the Pi session is streaming. Use follow_up or steer.",
        );
      }

      const promptTask = activeSession.host.session.prompt(normalizedPrompt);
      options?.onPromptDispatched?.();
      await promptTask;
      return;
    }

    if (input.mode === "follow_up") {
      if (activeSession.host.session.isStreaming) {
        await activeSession.host.session.followUp(normalizedPrompt);
        return;
      }

      const promptTask = activeSession.host.session.prompt(normalizedPrompt);
      options?.onPromptDispatched?.();
      await promptTask;
      return;
    }

    if (activeSession.host.session.isStreaming) {
      await activeSession.host.session.steer(normalizedPrompt);
      return;
    }

    const promptTask = activeSession.host.session.prompt(normalizedPrompt);
    options?.onPromptDispatched?.();
    await promptTask;
  }

  private handleSessionEvent(
    activeSession: ActiveChatSession,
    event: SessionEvent,
  ): void {
    const currentGeneration = this.getSessionGeneration(activeSession.chat.id);
    if (activeSession.generation !== currentGeneration) {
      return;
    }

    if (event.type === "message_end") {
      const message = (event.message ?? {}) as AssistantMessageLike;
      const text = collectAssistantText(message);

      if (text) {
        this.appendRuntimeEvent(activeSession, "assistant_text", { text });
        void this.enqueueOutboundMessage(activeSession.chat, text);
      }

      const runtimeFailure = extractAssistantRuntimeFailure(message);
      if (runtimeFailure) {
        void this.reportRuntimeFailure(activeSession, runtimeFailure);
      }
      return;
    }

    if (
      event.type === "turn_start"
      || event.type === "turn_end"
      || event.type === "auto_compaction_start"
      || event.type === "auto_compaction_end"
      || event.type === "auto_retry_start"
      || event.type === "auto_retry_end"
    ) {
      this.appendRuntimeEvent(activeSession, event.type, {});
      if (event.type === "turn_start") {
        void this.releasePendingInitialInputs(activeSession);
      }
    }
  }

  private async reportRuntimeFailure(
    activeSession: ActiveChatSession,
    error: unknown,
  ): Promise<void> {
    const formatted = formatRuntimeFailureMessage(error);
    if (activeSession.reportedRuntimeFailures.has(formatted)) {
      return;
    }

    activeSession.reportedRuntimeFailures.add(formatted);
    this.appendRuntimeEvent(activeSession, "error", {
      message: formatted,
    });
    await this.enqueueOutboundMessage(activeSession.chat, formatted);
  }

  private async enqueueOutboundMessage(
    chat: ChatRow,
    text: string,
  ): Promise<void> {
    const binding = listChatBindingsForChat(this.options.db, chat.id)
      .find((item) => item.platform === "feishu")
      ?? listChatBindingsForChat(this.options.db, chat.id)[0]
      ?? null;
    if (!binding) {
      throw new Error(`Chat binding not found: ${chat.id}`);
    }

    const existing = this.outboundLocks.get(chat.id);
    const task = (existing ?? Promise.resolve()).then(async () => {
      await this.options.channelManager.send(binding.external_chat_id, text);
    });
    const lockPromise = task.then(
      () => undefined,
      () => undefined,
    );

    this.outboundLocks.set(chat.id, lockPromise);
    task.catch((error) => {
      log.error(TAG, `Failed to send assistant reply for ${chat.id}`, error);
    }).finally(() => {
      if (this.outboundLocks.get(chat.id) === lockPromise) {
        this.outboundLocks.delete(chat.id);
      }
    });

    return lockPromise;
  }

  private async waitForOutboundDrain(chatId: string): Promise<void> {
    await this.outboundLocks.get(chatId);
  }

  private releasePendingInitialInputs(
    activeSession: ActiveChatSession,
    options?: { wait?: boolean },
  ): Promise<void> {
    if (activeSession.closed) {
      return Promise.resolve();
    }

    if (activeSession.initialInputPending) {
      activeSession.initialInputPending = false;
    }

    const flushPromise = this.flushPendingInitialInputs(activeSession);
    if (options?.wait) {
      return flushPromise;
    }

    return Promise.resolve();
  }

  private flushPendingInitialInputs(activeSession: ActiveChatSession): Promise<void> {
    if (activeSession.closed) {
      return Promise.resolve();
    }

    const existingFlush = activeSession.initialInputFlush;
    if (existingFlush) {
      return existingFlush;
    }

    const flushPromise = (async () => {
      while (!activeSession.closed && activeSession.pendingInitialInputs.length > 0) {
        const nextInput = activeSession.pendingInitialInputs.shift();
        if (!nextInput) {
          continue;
        }

        try {
          await this.sendInput(activeSession, nextInput);
        } catch (error) {
          await this.reportRuntimeFailure(activeSession, error);
        }
      }
    })().finally(() => {
      activeSession.initialInputFlush = null;
    });

    activeSession.initialInputFlush = flushPromise;
    return flushPromise;
  }

  private async waitForConcurrencySlot(workspaceId: string): Promise<void> {
    while (
      this.activeTasks >= this.concurrencyLimit
      || (this.activeSessions.has(workspaceId) && !this.activeSessions.get(workspaceId)?.closed)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private persistSessionRef(chatId: string, sessionRef: string | null): void {
    updateChat(this.options.db, chatId, {
      sessionRef,
      lastActivityAt: new Date().toISOString(),
    });
  }

  private ensureWorkspaceOnChatBranch(
    workspace: WorkspaceRow,
    chat: ChatRow,
  ): void {
    const workspaceDir = getWorkspaceDirectory(workspace.folder, {
      rootDir: this.rootDir,
    });
    const currentBranch = getCurrentWorkspaceBranch(workspaceDir);
    if (currentBranch !== chat.active_branch) {
      checkoutWorkspaceBranch(workspaceDir, chat.active_branch);
    }
  }

  private finishRun(
    activeSession: ActiveChatSession,
    status: "completed" | "failed" | "cancelled",
    error?: string,
  ): void {
    const now = new Date().toISOString();
    updateRun(this.options.db, activeSession.runId, {
      status,
      endedAt: now,
      error: error ?? null,
    });
    appendRunEvent(this.options.db, {
      runId: activeSession.runId,
      chatId: activeSession.chat.id,
      eventType: `run_${status}`,
      payload: JSON.stringify({
        error: error ?? null,
      }),
      createdAt: now,
    });
    upsertWorkspaceRuntimeState(this.options.db, {
      workspaceId: activeSession.workspace.id,
      checkedOutBranch: activeSession.chat.active_branch,
      activeRunId: null,
      status: status === "failed" ? "error" : "idle",
      lastActivityAt: now,
      unloadAfter: calculateWorkspaceUnloadAfter(new Date(now)),
      lastError: status === "failed" ? error ?? null : null,
    });
  }

  private appendRuntimeEvent(
    activeSession: ActiveChatSession,
    eventType: string,
    payload: unknown,
  ): void {
    appendRunEvent(this.options.db, {
      runId: activeSession.runId,
      chatId: activeSession.chat.id,
      eventType,
      payload: JSON.stringify(payload),
    });
  }
}
