import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { ChannelManager } from "../channels/manager";
import {
  getGroupByFolder,
  getSessionRef,
  saveSessionRef,
  type RegisteredGroup,
} from "../db";
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

type ActiveGroupSession = {
  host: PiGroupSessionHost;
  group: RegisteredGroup;
  generation: number;
  unsubscribe: () => void;
  reportedRuntimeFailures: Set<string>;
};

type CreateGroupSessionHostResult = {
  host: PiGroupSessionHost;
  group: RegisteredGroup;
  sessionRef: string;
};

export interface FeishuGroupAdapterOptions {
  db: Database;
  channelManager: ChannelManager;
  imageMessagePreprocessor: ImageMessagePreprocessor;
  concurrencyLimit?: number;
  rootDir?: string;
  createGroupSessionHost?: (
    groupFolder: string,
  ) => Promise<CreateGroupSessionHostResult>;
  resetGroupSession?: (groupFolder: string) => Promise<string>;
  preparePrompt?: (groupFolder: string, text: string) => Promise<string>;
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
  private readonly db: Database;
  private readonly channelManager: ChannelManager;
  private readonly imageMessagePreprocessor: ImageMessagePreprocessor;
  private readonly concurrencyLimit: number;
  private readonly rootDir: string;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly activeSessions = new Map<string, ActiveGroupSession>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly outboundLocks = new Map<string, Promise<void>>();
  private activeTasks = 0;
  private readonly createGroupSessionHost: (
    groupFolder: string,
  ) => Promise<CreateGroupSessionHostResult>;
  private readonly resetGroupSession: (groupFolder: string) => Promise<string>;
  private readonly preparePrompt: (groupFolder: string, text: string) => Promise<string>;

  constructor(options: FeishuGroupAdapterOptions) {
    this.db = options.db;
    this.channelManager = options.channelManager;
    this.imageMessagePreprocessor = options.imageMessagePreprocessor;
    this.concurrencyLimit = options.concurrencyLimit ?? 3;
    this.rootDir = options.rootDir ?? process.cwd();
    this.createGroupSessionHost = options.createGroupSessionHost
      ?? ((groupFolder) =>
        createPiGroupSessionHost({
          db: this.db,
          rootDir: this.rootDir,
          groupFolder,
          createMessageSender: (context) => this.createMessageSender(context),
        }));
    this.resetGroupSession = options.resetGroupSession
      ?? (async (groupFolder) => {
        const { runtime, group, sessionRef } = await createPiGroupRuntime({
          db: this.db,
          rootDir: this.rootDir,
          groupFolder,
          createMessageSender: (context) => this.createMessageSender(context),
        });

        try {
          await runtime.newSession();
          const nextSessionRef = runtime.session.sessionFile ?? sessionRef;
          saveSessionRef(this.db, group.folder, nextSessionRef);
          return nextSessionRef;
        } finally {
          await runtime.dispose();
        }
      });
    this.preparePrompt = options.preparePrompt
      ?? ((groupFolder, text) =>
        normalizePromptForAgent(
          text,
          this.rootDir,
          resolve(this.rootDir, "groups", groupFolder),
          this.imageMessagePreprocessor,
          TAG,
        ));

    log.info(TAG, "FeishuGroupAdapter initialized", {
      concurrencyLimit: this.concurrencyLimit,
      rootDir: this.rootDir,
    });
  }

  pushMessage(groupFolder: string, input: ConversationMessageInput): boolean {
    const activeSession = this.activeSessions.get(groupFolder);
    if (!activeSession) {
      return false;
    }

    void this.sendInput(activeSession, input).catch((error) => {
      log.error(TAG, `Failed to push ${input.mode} message to ${groupFolder}`, error);
      void this.reportRuntimeFailure(activeSession, error);
    });
    return true;
  }

  isActive(groupFolder: string): boolean {
    return this.activeSessions.has(groupFolder);
  }

  async enqueue(groupFolder: string, initialPrompt: string): Promise<void> {
    const existing = this.locks.get(groupFolder);
    const task = (existing ?? Promise.resolve()).then(() =>
      this.runTurn(groupFolder, initialPrompt),
    );
    const lockPromise = task.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(groupFolder, lockPromise);

    task.finally(() => {
      if (this.locks.get(groupFolder) === lockPromise) {
        this.locks.delete(groupFolder);
      }
    });

    return task;
  }

  async clearSession(groupFolder: string): Promise<ClearGroupSessionResult> {
    log.info(TAG, `Clearing session for group ${groupFolder}`);

    const group = getGroupByFolder(this.db, groupFolder);
    if (!group) {
      throw new Error(`Group not found: ${groupFolder}`);
    }

    const previousSessionRef = getSessionRef(this.db, groupFolder);
    const generation = this.bumpSessionGeneration(groupFolder);
    const activeSession = this.activeSessions.get(groupFolder);
    const closedActiveSession = !!activeSession;

    if (activeSession) {
      this.activeSessions.delete(groupFolder);
      try {
        await activeSession.host.session.abort();
      } catch (error) {
        log.warn(TAG, `Abort failed while clearing session for ${groupFolder}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      activeSession.unsubscribe();
      await activeSession.host.dispose().catch((error) => {
        log.warn(TAG, `Dispose failed while clearing session for ${groupFolder}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    const sessionRef = await this.resetGroupSession(groupFolder);
    saveSessionRef(this.db, groupFolder, sessionRef);

    log.info(TAG, `Session cleared for group ${groupFolder}`, {
      previousSessionRef,
      sessionRef,
      generation,
      closedActiveSession,
    });

    return {
      closedActiveSession,
      previousSessionRef,
      sessionRef,
      generation,
    };
  }

  private getSessionGeneration(groupFolder: string): number {
    return this.sessionGenerations.get(groupFolder) ?? 0;
  }

  private bumpSessionGeneration(groupFolder: string): number {
    const nextGeneration = this.getSessionGeneration(groupFolder) + 1;
    this.sessionGenerations.set(groupFolder, nextGeneration);
    return nextGeneration;
  }

  private createMessageSender(_context: PiGroupRuntimeContext) {
    return {
      send: (chatJid: string, text: string) => this.channelManager.send(chatJid, text),
      sendImage: (chatJid: string, filePath: string) =>
        this.channelManager.sendImage(chatJid, filePath),
      refreshGroupMetadata: async () => {
        const chats = await this.channelManager.refreshGroupMetadata();
        return { count: chats.length };
      },
      clearSession: (folder: string) => this.clearSession(folder),
    };
  }

  private async runTurn(groupFolder: string, initialPrompt: string): Promise<void> {
    await this.waitForConcurrencySlot(groupFolder);
    this.activeTasks += 1;

    const sessionGeneration = this.getSessionGeneration(groupFolder);
    let activeSession: ActiveGroupSession | null = null;

    log.info(TAG, `Starting Pi-native turn for ${groupFolder}`, {
      activeTasks: this.activeTasks,
      concurrencyLimit: this.concurrencyLimit,
      sessionGeneration,
    });

    try {
      const created = await this.createGroupSessionHost(groupFolder);
      if (sessionGeneration !== this.getSessionGeneration(groupFolder)) {
        await created.host.dispose();
        log.warn(TAG, `Discarding stale runtime startup for ${groupFolder}`, {
          sessionGeneration,
          currentGeneration: this.getSessionGeneration(groupFolder),
        });
        return;
      }

      activeSession = {
        host: created.host,
        group: created.group,
        generation: sessionGeneration,
        unsubscribe: () => {},
        reportedRuntimeFailures: new Set(),
      };
      const unsubscribe = created.host.session.subscribe((event: SessionEvent) => {
        this.handleSessionEvent(activeSession!, event);
      });
      activeSession.unsubscribe = unsubscribe;
      this.activeSessions.set(groupFolder, activeSession);

      await this.sendInput(activeSession, {
        mode: "prompt",
        text: initialPrompt,
      });
      await this.waitForOutboundDrain(groupFolder);

      if (sessionGeneration === this.getSessionGeneration(groupFolder)) {
        const sessionRef = created.host.session.sessionFile ?? created.sessionRef;
        saveSessionRef(this.db, groupFolder, sessionRef);
        log.info(TAG, `Saved Pi session ref after turn`, {
          groupFolder,
          sessionRef,
          sessionGeneration,
        });
      }
    } catch (error) {
      log.error(TAG, `Failed to run turn for group ${groupFolder}`, error);
      if (activeSession) {
        await this.reportRuntimeFailure(activeSession, error);
      }
    } finally {
      if (
        activeSession
        && this.activeSessions.get(groupFolder)?.generation === sessionGeneration
      ) {
        this.activeSessions.delete(groupFolder);
      }
      if (activeSession) {
        activeSession.unsubscribe();
        await activeSession.host.dispose().catch((error) => {
          log.warn(TAG, `Failed to dispose group runtime for ${groupFolder}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      this.activeTasks = Math.max(0, this.activeTasks - 1);
      log.debug(TAG, `Turn finished for ${groupFolder}`, {
        activeTasks: this.activeTasks,
        concurrencyLimit: this.concurrencyLimit,
        sessionGeneration,
      });
    }
  }

  private async sendInput(
    activeSession: ActiveGroupSession,
    input: ConversationMessageInput,
  ): Promise<void> {
    const normalizedPrompt = await this.preparePrompt(
      activeSession.group.folder,
      input.text,
    );

    if (input.mode === "prompt") {
      if (activeSession.host.session.isStreaming) {
        throw new Error(
          "Cannot send mode=prompt while the Pi session is streaming. Use follow_up or steer.",
        );
      }

      await activeSession.host.session.prompt(normalizedPrompt);
      return;
    }

    if (input.mode === "follow_up") {
      if (activeSession.host.session.isStreaming) {
        await activeSession.host.session.followUp(normalizedPrompt);
        return;
      }

      await activeSession.host.session.prompt(normalizedPrompt);
      return;
    }

    if (activeSession.host.session.isStreaming) {
      await activeSession.host.session.steer(normalizedPrompt);
      return;
    }

    await activeSession.host.session.prompt(normalizedPrompt);
  }

  private handleSessionEvent(
    activeSession: ActiveGroupSession,
    event: SessionEvent,
  ): void {
    const currentGeneration = this.getSessionGeneration(activeSession.group.folder);
    if (activeSession.generation !== currentGeneration) {
      return;
    }

    if (event.type === "message_end") {
      const message = (event.message ?? {}) as AssistantMessageLike;
      const text = collectAssistantText(
        message,
      );

      if (text) {
        void this.enqueueOutboundMessage(activeSession.group, text);
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
      log.debug(TAG, `Pi diagnostic for ${activeSession.group.folder}`, {
        type: event.type,
        sessionGeneration: activeSession.generation,
      });
    }
  }

  private async reportRuntimeFailure(
    activeSession: ActiveGroupSession,
    error: unknown,
  ): Promise<void> {
    const formatted = formatRuntimeFailureMessage(error);
    if (activeSession.reportedRuntimeFailures.has(formatted)) {
      return;
    }

    activeSession.reportedRuntimeFailures.add(formatted);
    await this.enqueueOutboundMessage(activeSession.group, formatted);
  }

  private enqueueOutboundMessage(
    group: RegisteredGroup,
    text: string,
  ): Promise<void> {
    const existing = this.outboundLocks.get(group.folder);
    const task = (existing ?? Promise.resolve()).then(async () => {
      await this.channelManager.send(group.jid, text);
    });
    const lockPromise = task.then(
      () => undefined,
      () => undefined,
    );

    this.outboundLocks.set(group.folder, lockPromise);
    task.catch((error) => {
      log.error(TAG, `Failed to send assistant reply for ${group.folder}`, error);
    }).finally(() => {
      if (this.outboundLocks.get(group.folder) === lockPromise) {
        this.outboundLocks.delete(group.folder);
      }
    });

    return lockPromise;
  }

  private async waitForOutboundDrain(groupFolder: string): Promise<void> {
    await this.outboundLocks.get(groupFolder);
  }

  private async waitForConcurrencySlot(groupFolder: string): Promise<void> {
    if (this.activeTasks >= this.concurrencyLimit) {
      log.warn(TAG, `Concurrency limit reached, waiting for slot`, {
        groupFolder,
        activeTasks: this.activeTasks,
        concurrencyLimit: this.concurrencyLimit,
      });
    }

    while (this.activeTasks >= this.concurrencyLimit) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export const __test__ = {
  extractAssistantRuntimeFailure,
  formatRuntimeFailureMessage,
  toError,
};
