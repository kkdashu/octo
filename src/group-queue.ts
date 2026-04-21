import type { Database } from "bun:sqlite";
import type { ChannelManager } from "./channels/manager";
import { resolvePersistedPiSessionRef } from "./providers/pi-session-ref";
import { loadAgentProfilesConfig, resolveAgentProfile } from "./runtime/profile-config";
import {
  buildWorkspaceMemoryPromptBlock,
  buildSessionInitialPrompt,
} from "./runtime/group-memory-prompt";
import {
  buildGroupExternalMcpServers,
  isWorkspaceSkillInstalled,
} from "./runtime/group-external-mcp";
import type {
  AgentRuntime,
  ConversationMessageInput,
  RuntimeConversation,
  RuntimeEvent,
} from "./providers/types";
import {
  listChatBindingsForChat,
  listWorkspaceMemories,
  type ChatRow,
  type WorkspaceRow,
} from "./db";
import { getWorkspaceDirectory } from "./group-workspace";
import { createWorkspaceToolDefs } from "./tools";
import type { MessageSender } from "./tools";
import { log } from "./logger";
import { WorkspaceService } from "./workspace-service";
import type { EnqueueRuntimeResult } from "./runtime/group-runtime-controller";

const TAG = "group-queue";

type ActiveConversationState = {
  conversation: RuntimeConversation;
  generation: number;
};

type ResolvedQueueTarget = {
  chat: ChatRow;
  workspace: WorkspaceRow;
  externalChatId: string;
};

export class GroupQueue {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly activeConversations = new Map<string, ActiveConversationState>();
  private readonly sessionGenerations = new Map<string, number>();
  private activeTasks = 0;
  private readonly workspaceService: WorkspaceService;

  constructor(
    private readonly db: Database,
    private readonly channelManager: ChannelManager,
    private readonly runtime: AgentRuntime,
    private readonly concurrencyLimit = 3,
  ) {
    this.workspaceService = new WorkspaceService(db);
    log.info(TAG, "GroupQueue initialized", { concurrencyLimit });
  }

  private getSessionGeneration(chatId: string): number {
    return this.sessionGenerations.get(chatId) ?? 0;
  }

  private bumpSessionGeneration(chatId: string): number {
    const nextGeneration = this.getSessionGeneration(chatId) + 1;
    this.sessionGenerations.set(chatId, nextGeneration);
    return nextGeneration;
  }

  private resolveTarget(chatOrWorkspaceId: string): ResolvedQueueTarget {
    const directChat = this.workspaceService.getChatById(chatOrWorkspaceId);
    const chat = directChat ?? (() => {
      const workspace = this.workspaceService.getWorkspaceById(chatOrWorkspaceId)
        ?? this.workspaceService.getWorkspaceByFolder(chatOrWorkspaceId);
      if (workspace) {
        return this.workspaceService.listChats(workspace.id)[0] ?? null;
      }
      return null;
    })();

    if (!chat) {
      throw new Error(`Chat not found: ${chatOrWorkspaceId}`);
    }

    const workspace = this.workspaceService.getWorkspaceById(chat.workspace_id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chat.workspace_id}`);
    }
    const binding = listChatBindingsForChat(this.db, chat.id)[0] ?? null;

    return {
      chat,
      workspace,
      externalChatId: binding?.external_chat_id ?? chat.id,
    };
  }

  private updateChatSessionRef(chatId: string, sessionRef: string | null): ChatRow {
    return this.workspaceService.updateChat(chatId, {
      sessionRef,
      lastActivityAt: new Date().toISOString(),
    });
  }

  private getRequestedProfileKey(target: ResolvedQueueTarget): string {
    return target.workspace.profile_key
      || loadAgentProfilesConfig().defaultProfile;
  }

  private getIsMain(target: ResolvedQueueTarget): boolean {
    return target.workspace.is_main === 1;
  }

  private logIgnoredStaleEvent(
    chatId: string,
    sessionGeneration: number,
    event: RuntimeEvent,
  ): void {
    if (event.type === "completed") {
      log.warn(TAG, `Ignoring stale completion for ${chatId}`, {
        staleGeneration: sessionGeneration,
        currentGeneration: this.getSessionGeneration(chatId),
        sessionRef: event.sessionRef,
      });
      return;
    }

    if (event.type === "assistant_text") {
      log.warn(TAG, `Ignoring stale assistant text for ${chatId}`, {
        staleGeneration: sessionGeneration,
        currentGeneration: this.getSessionGeneration(chatId),
        textPreview: event.text.substring(0, 120),
      });
    }
  }

  pushMessage(chatOrGroupId: string, input: ConversationMessageInput): boolean {
    const target = this.resolveTarget(chatOrGroupId);
    const activeConversation = this.activeConversations.get(target.chat.id);
    if (activeConversation) {
      log.info(TAG, `Pushing message to active conversation: ${target.chat.id}`, {
        mode: input.mode,
        textLength: input.text.length,
        textPreview: input.text.substring(0, 200),
      });
      void activeConversation.conversation.send(input).catch((error) => {
        log.error(TAG, `Failed to push ${input.mode} message to ${target.chat.id}`, error);
      });
      return true;
    }

    log.debug(TAG, `No active conversation for ${target.chat.id}, cannot push`);
    return false;
  }

  isActive(chatOrGroupId: string): boolean {
    return this.activeConversations.has(this.resolveTarget(chatOrGroupId).chat.id);
  }

  async enqueue(
    chatOrGroupId: string,
    initialPrompt: string,
  ): Promise<EnqueueRuntimeResult> {
    const target = this.resolveTarget(chatOrGroupId);
    log.info(TAG, `Enqueuing agent task for chat: ${target.chat.id}`, {
      activeTasks: this.activeTasks,
      concurrencyLimit: this.concurrencyLimit,
      activeChats: Array.from(this.activeConversations.keys()),
      promptLength: initialPrompt.length,
    });

    const existing = this.locks.get(target.chat.id);
    if (existing) {
      log.debug(TAG, `Waiting for per-chat lock: ${target.chat.id}`);
    }

    const task = (existing ?? Promise.resolve()).then(() =>
      this.runWithConcurrencyLimit(chatOrGroupId, initialPrompt),
    );
    const lockPromise = task.then(() => undefined);
    this.locks.set(target.chat.id, lockPromise);

    task.finally(() => {
      if (this.locks.get(target.chat.id) === lockPromise) {
        this.locks.delete(target.chat.id);
      }
    });

    return {
      status: "completed",
      failureNotified: false,
    };
  }

  private async runWithConcurrencyLimit(
    chatOrGroupId: string,
    initialPrompt: string,
  ): Promise<void> {
    const target = this.resolveTarget(chatOrGroupId);
    const chatId = target.chat.id;
    const workspaceFolder = target.workspace.folder;

    if (this.activeTasks >= this.concurrencyLimit) {
      log.warn(TAG, `Concurrency limit reached (${this.activeTasks}/${this.concurrencyLimit}), waiting for slot: ${chatId}`);
    }
    while (this.activeTasks >= this.concurrencyLimit) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.activeTasks++;
    log.info(TAG, `Starting agent for ${chatId} (active: ${this.activeTasks}/${this.concurrencyLimit})`);

    try {
      const requestedProfileKey = this.getRequestedProfileKey(target);
      const profile = resolveAgentProfile(requestedProfileKey);
      const isMain = this.getIsMain(target);

      log.info(TAG, `Using profile "${profile.profileKey}" for chat ${chatId}`, {
        requestedProfileKey,
        apiFormat: profile.apiFormat,
        model: profile.model,
      });

      const messageSender: MessageSender = {
        send: (externalChatId, text) => this.channelManager.send(externalChatId, text),
        sendImage: (externalChatId, filePath) => this.channelManager.sendImage(externalChatId, filePath),
        refreshChatMetadata: async () => {
          const chats = await this.channelManager.refreshGroupMetadata();
          return { count: chats.length };
        },
        clearSession: (chatId) => this.clearSession(chatId),
      };
      const tools = createWorkspaceToolDefs({
        workspaceId: target.workspace.id,
        workspaceFolder,
        chatId,
        isMain,
      }, this.db, messageSender);
      let currentChat = this.workspaceService.getChatById(chatId) ?? target.chat;
      const persistedSessionRef = currentChat.session_ref;
      const workingDirectory = getWorkspaceDirectory(workspaceFolder);
      const resumeSessionRef = resolvePersistedPiSessionRef(
        workingDirectory,
        persistedSessionRef,
      );
      const sessionGeneration = this.getSessionGeneration(chatId);

      if (persistedSessionRef && !resumeSessionRef) {
        currentChat = this.updateChatSessionRef(chatId, null);
        log.warn(TAG, `Discarded stale Pi session ref for ${chatId}`, {
          persistedSessionRef,
          workingDirectory,
        });
      }

      log.info(TAG, `Resolved session state for ${chatId}`, {
        persistedSessionRef,
        resumeSessionRef: resumeSessionRef ?? null,
        workingDirectory,
        sessionGeneration,
        willResume: !!resumeSessionRef,
      });

      const memories = listWorkspaceMemories(this.db, target.workspace.id);
      const memoryBlock = buildWorkspaceMemoryPromptBlock(memories);
      const initialPromptWithMemory = buildSessionInitialPrompt(
        initialPrompt,
        memories,
        !resumeSessionRef,
      );

      log.info(TAG, `Prepared session prompt for ${chatId}`, {
        resumedSession: !!resumeSessionRef,
        memoryCount: memories.length,
        memoryPolicyInjected: !resumeSessionRef,
        memoryInjected: !!memoryBlock && !resumeSessionRef,
      });

      const { conversation, events } = await this.runtime.openConversation({
        workspaceFolder,
        workingDirectory,
        isMain,
        resumeSessionRef,
        tools,
        profile,
        externalMcpServers: buildGroupExternalMcpServers(workspaceFolder),
      });

      if (sessionGeneration !== this.getSessionGeneration(chatId)) {
        conversation.close();
        this.activeTasks--;
        log.warn(TAG, `Discarding stale conversation startup for ${chatId} after generation changed`, {
          chatId,
          sessionGeneration,
          currentGeneration: this.getSessionGeneration(chatId),
        });
        return;
      }

      this.activeConversations.set(chatId, {
        conversation,
        generation: sessionGeneration,
      });
      log.info(TAG, `Agent started and conversation registered for ${chatId}`, {
        sessionGeneration,
        resumeSessionRef: resumeSessionRef ?? null,
      });

      (async () => {
        try {
          for await (const event of events) {
            const isCurrentGeneration =
              sessionGeneration === this.getSessionGeneration(chatId);

            if (!isCurrentGeneration) {
              this.logIgnoredStaleEvent(chatId, sessionGeneration, event);
              continue;
            }

            if (event.type === "assistant_text") {
              log.info(TAG, `Sending agent reply to chat ${target.externalChatId}`, {
                workspaceFolder,
                textPreview: event.text.substring(0, 200),
              });
              await this.channelManager.send(target.externalChatId, event.text);
              continue;
            }

            if (event.type === "completed") {
              log.info(TAG, `Received agent completion for ${chatId}`, {
                sessionGeneration,
                sessionRef: event.sessionRef ?? null,
              });
              if (event.sessionRef) {
                const previousPersistedSessionRef = currentChat.session_ref;
                currentChat = this.updateChatSessionRef(chatId, event.sessionRef);
                log.info(TAG, `Session ref saved for chat ${chatId}`, {
                  previousPersistedSessionRef,
                  sessionRef: event.sessionRef,
                  sessionGeneration,
                });
              }
              conversation.close();
              log.info(TAG, `Conversation closed after turn completion for ${chatId}`, {
                sessionGeneration,
              });
              continue;
            }

            if (event.type === "failed") {
              log.error(TAG, `Agent error for chat ${chatId}`, event.error);
              conversation.close();
              continue;
            }

            if (event.type === "diagnostic") {
              log.debug(TAG, `Runtime diagnostic for ${chatId}`, {
                name: event.name,
                message: event.message,
                sessionGeneration,
              });
            }
          }
        } catch (err) {
          log.error(TAG, `Event stream error for ${chatId}`, err);
        } finally {
          const activeConversation = this.activeConversations.get(chatId);
          if (activeConversation?.generation === sessionGeneration) {
            this.activeConversations.delete(chatId);
          }
          this.activeTasks--;
          log.debug(TAG, `Session ended for ${chatId}, active: ${this.activeTasks}/${this.concurrencyLimit}`);
        }
      })();

      void conversation.send({
        mode: "prompt",
        text: initialPromptWithMemory,
      }).catch((error) => {
        log.error(TAG, `Initial prompt failed for ${chatId}`, error);
      });
    } catch (err) {
      this.activeTasks--;
      log.error(TAG, `Failed to start agent for ${chatId}`, err);
    }
  }

  removeSession(chatOrGroupId: string): void {
    const target = this.resolveTarget(chatOrGroupId);
    const activeConversation = this.activeConversations.get(target.chat.id);
    if (activeConversation) {
      log.info(TAG, `Removing active session for ${target.chat.id}`);
      activeConversation.conversation.close();
      this.activeConversations.delete(target.chat.id);
    }
  }

  async clearSession(
    chatOrGroupId: string,
  ): Promise<{
    closedActiveSession: boolean;
    previousSessionRef: string | null;
    sessionRef: string;
    generation: number;
  }> {
    const target = this.resolveTarget(chatOrGroupId);
    const chatId = target.chat.id;
    const workspaceFolder = target.workspace.folder;

    log.info(TAG, `Clearing session for chat: ${chatId}`);

    const previousSessionRef = target.chat.session_ref;
    const generationBefore = this.getSessionGeneration(chatId);
    const generation = this.bumpSessionGeneration(chatId);
    const closedActiveSession = this.activeConversations.has(chatId);
    const activeConversation = this.activeConversations.get(chatId);
    const activeConversationGeneration = activeConversation?.generation ?? null;
    if (activeConversation) {
      log.info(TAG, `Closing active session for ${chatId} before /clear session command`);
      activeConversation.conversation.close();
      this.activeConversations.delete(chatId);
    }

    const requestedProfileKey = this.getRequestedProfileKey(target);
    const profile = resolveAgentProfile(requestedProfileKey);
    const workingDirectory = getWorkspaceDirectory(workspaceFolder);
    const persistedSessionRef = previousSessionRef;
    const resumeSessionRef = resolvePersistedPiSessionRef(
      workingDirectory,
      persistedSessionRef,
    );

    log.info(TAG, `Resolved session state before clear for ${chatId}`, {
      previousSessionRef,
      persistedSessionRef,
      resumeSessionRef: resumeSessionRef ?? null,
      closedActiveSession,
      activeConversationGeneration,
      generationBefore,
      generationAfter: generation,
      workingDirectory,
      profileKey: profile.profileKey,
    });

    if (persistedSessionRef && !resumeSessionRef) {
      this.updateChatSessionRef(chatId, null);
      log.warn(TAG, `Discarded stale Pi session ref before clear for ${chatId}`, {
        persistedSessionRef,
        workingDirectory,
      });
    }

    const { sessionRef } = await this.runtime.resetSession({
      workspaceFolder,
      workingDirectory,
      profile,
      resumeSessionRef,
    });

    this.updateChatSessionRef(chatId, sessionRef);
    log.info(TAG, `Session cleared via Pi local session reset for ${chatId}`, {
      previousSessionRef,
      sessionRef,
      resumeSessionRef: resumeSessionRef ?? null,
      closedActiveSession,
      generationBefore,
      generationAfter: generation,
    });

    return {
      closedActiveSession,
      previousSessionRef,
      sessionRef,
      generation,
    };
  }
}

export const __test__ = {
  buildGroupExternalMcpServers,
  buildWorkspaceMemoryPromptBlock,
  buildSessionInitialPrompt,
  isWorkspaceSkillInstalled,
};
