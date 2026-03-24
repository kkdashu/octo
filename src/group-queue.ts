import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { ChannelManager } from "./channels/manager";
import { resolveAgentProfile } from "./runtime/profile-config";
import { ClaudeProvider } from "./providers/claude";
import type { AgentSession } from "./providers/types";
import { deleteSessionId, getGroupByFolder, getSessionId, saveSessionId, type MessageRow } from "./db";
import { applyAutomaticMemoryUpdates, buildParticipantMemoryPrefix } from "./memory/service";
import { createGroupToolDefs } from "./tools";
import type { MessageSender } from "./tools";
import { log } from "./logger";

const TAG = "group-queue";

export interface GroupTurnInput {
  prompt: string;
  messages?: MessageRow[];
}

interface ActiveSessionState {
  session: AgentSession;
  channelType: string;
  pendingMessages: MessageRow[];
  assistantChunks: string[];
}

export async function resolveClaudeResumeSessionId(
  workingDirectory: string,
  persistedSessionId: string | null,
  listDirSessions: typeof listSessions = listSessions,
): Promise<string | undefined> {
  if (!persistedSessionId) {
    return undefined;
  }

  const sessions = await listDirSessions({
    dir: workingDirectory,
    includeWorktrees: false,
  });

  return sessions.some((session) => session.sessionId === persistedSessionId)
    ? persistedSessionId
    : undefined;
}

export class GroupQueue {
  private locks: Map<string, Promise<void>> = new Map();
  private activeSessions: Map<string, ActiveSessionState> = new Map();
  private activeTasks = 0;
  private concurrencyLimit: number;
  private db: Database;
  private channelManager: ChannelManager;
  private provider: ClaudeProvider;

  constructor(
    db: Database,
    channelManager: ChannelManager,
    provider: ClaudeProvider,
    concurrencyLimit = 3,
  ) {
    this.db = db;
    this.channelManager = channelManager;
    this.provider = provider;
    this.concurrencyLimit = concurrencyLimit;
    log.info(TAG, `GroupQueue initialized`, { concurrencyLimit });
  }

  private buildTurnPrompt(channelType: string, input: GroupTurnInput): string {
    const messages = input.messages ?? [];
    if (messages.length === 0) {
      return input.prompt;
    }

    const memoryPrefix = buildParticipantMemoryPrefix(".", channelType, messages);
    return memoryPrefix
      ? `${memoryPrefix}\n\n---\n\n${input.prompt}`
      : input.prompt;
  }

  /** Push a message to an active session, returns false if no active session */
  pushMessage(groupFolder: string, input: GroupTurnInput): boolean {
    const activeSession = this.activeSessions.get(groupFolder);
    if (activeSession) {
      const prompt = this.buildTurnPrompt(activeSession.channelType, input);
      if (input.messages?.length) {
        activeSession.pendingMessages.push(...input.messages);
      }
      log.info(TAG, `Pushing follow-up message to active session: ${groupFolder}`, {
        promptLength: prompt.length,
        promptPreview: prompt.substring(0, 200),
        messageCount: input.messages?.length ?? 0,
      });
      activeSession.session.push(prompt);
      return true;
    }
    log.debug(TAG, `No active session for ${groupFolder}, cannot push`);
    return false;
  }

  /** Check if a group has an active agent session */
  isActive(groupFolder: string): boolean {
    return this.activeSessions.has(groupFolder);
  }

  /** Enqueue a new agent task for a group (serial per-group, global concurrency limit) */
  async enqueue(groupFolder: string, input: GroupTurnInput): Promise<void> {
    log.info(TAG, `Enqueuing agent task for group: ${groupFolder}`, {
      activeTasks: this.activeTasks,
      concurrencyLimit: this.concurrencyLimit,
      activeGroups: Array.from(this.activeSessions.keys()),
      promptLength: input.prompt.length,
      messageCount: input.messages?.length ?? 0,
    });

    // Wait for per-group lock
    const existing = this.locks.get(groupFolder);
    if (existing) {
      log.debug(TAG, `Waiting for per-group lock: ${groupFolder}`);
    }
    const task = (existing ?? Promise.resolve()).then(() =>
      this.runWithConcurrencyLimit(groupFolder, input),
    );
    const lockTask = task.then(() => {});
    this.locks.set(groupFolder, lockTask);

    // Clean up lock reference when done
    task.finally(() => {
      if (this.locks.get(groupFolder) === lockTask) {
        this.locks.delete(groupFolder);
      }
    });
  }

  private async runWithConcurrencyLimit(
    groupFolder: string,
    input: GroupTurnInput,
  ): Promise<void> {
    // Wait for global concurrency slot
    if (this.activeTasks >= this.concurrencyLimit) {
      log.warn(TAG, `Concurrency limit reached (${this.activeTasks}/${this.concurrencyLimit}), waiting for slot: ${groupFolder}`);
    }
    while (this.activeTasks >= this.concurrencyLimit) {
      await new Promise((r) => setTimeout(r, 100));
    }

    this.activeTasks++;
    log.info(TAG, `Starting agent for ${groupFolder} (active: ${this.activeTasks}/${this.concurrencyLimit})`);

    try {
      const group = getGroupByFolder(this.db, groupFolder);
      if (!group) throw new Error(`Group not found: ${groupFolder}`);

      const isMain = group.is_main === 1;
      const requestedProfileKey = group.agent_provider || "claude";
      const profile = resolveAgentProfile(requestedProfileKey);

      log.info(TAG, `Using profile "${profile.profileKey}" for group ${groupFolder}`, {
        requestedProfileKey,
        apiFormat: profile.apiFormat,
        model: profile.model,
      });

      const messageSender: MessageSender = {
        send: (chatJid, text) => this.channelManager.send(chatJid, text),
        sendImage: (chatJid, filePath) => this.channelManager.sendImage(chatJid, filePath),
        refreshGroupMetadata: async () => {
          const chats = await this.channelManager.refreshGroupMetadata();
          return { count: chats.length };
        },
        clearSession: (folder) => this.clearSession(folder),
      };
      const tools = createGroupToolDefs(groupFolder, isMain, this.db, messageSender);
      const persistedSessionId = getSessionId(this.db, groupFolder);
      const workingDirectory = resolve("groups", groupFolder);
      const initialPrompt = this.buildTurnPrompt(group.channel_type, input);
      const resumeSessionId = await resolveClaudeResumeSessionId(
        workingDirectory,
        persistedSessionId,
      );

      if (persistedSessionId && !resumeSessionId) {
        deleteSessionId(this.db, groupFolder);
        log.warn(TAG, `Discarded stale Claude session for ${groupFolder}`, {
          persistedSessionId,
          workingDirectory,
        });
      }

      const { session, events } = await this.provider.startSession({
        groupFolder,
        workingDirectory,
        initialPrompt,
        isMain,
        resumeSessionId,
        tools,
        profile,
      });

      this.activeSessions.set(groupFolder, {
        session,
        channelType: group.channel_type,
        pendingMessages: [...(input.messages ?? [])],
        assistantChunks: [],
      });
      log.info(TAG, `Agent started and session registered for ${groupFolder}`);

      try {
        for await (const event of events) {
          if (event.type === "text") {
            const activeSession = this.activeSessions.get(groupFolder);
            if (activeSession) {
              activeSession.assistantChunks.push(event.text);
            }
            log.info(TAG, `Sending agent reply to chat ${group.jid}`, {
              groupFolder,
              textPreview: event.text.substring(0, 200),
            });
            await this.channelManager.send(group.jid, event.text);
          } else if (event.type === "result") {
            if (event.sessionId) {
              saveSessionId(this.db, groupFolder, event.sessionId);
              log.info(TAG, `Session ID saved for group ${groupFolder}: ${event.sessionId}`);
            }

            const activeSession = this.activeSessions.get(groupFolder);
            if (activeSession) {
              const assistantText = activeSession.assistantChunks.join("\n\n").trim();
              if (activeSession.pendingMessages.length > 0 && assistantText) {
                try {
                  const stats = applyAutomaticMemoryUpdates(
                    ".",
                    activeSession.channelType,
                    activeSession.pendingMessages,
                    assistantText,
                  );
                  log.info(TAG, `Automatic memory updates applied for ${groupFolder}`, stats);
                } catch (err) {
                  log.error(TAG, `Failed to apply automatic memory updates for ${groupFolder}`, err);
                }
              }
            }

            // Close the session after each turn to release the concurrency slot.
            // The session ID is persisted above so it can be resumed on the next message.
            this.activeSessions.delete(groupFolder);
            session.close();
            log.info(TAG, `Session closed after turn completion for ${groupFolder}`);
          } else if (event.type === "error") {
            log.error(TAG, `Agent error for group ${groupFolder}`, event.error);
          }
        }
      } catch (err) {
        log.error(TAG, `Event stream error for group ${groupFolder}`, err);
      } finally {
        this.activeSessions.delete(groupFolder);
        this.activeTasks--;
        log.debug(TAG, `Session ended for ${groupFolder}, active: ${this.activeTasks}/${this.concurrencyLimit}`);
      }
    } catch (err) {
      this.activeTasks--;
      log.error(TAG, `Failed to start agent for ${groupFolder}`, err);
    }
  }

  /** Remove an active session (e.g., when agent finishes) */
  removeSession(groupFolder: string) {
    const activeSession = this.activeSessions.get(groupFolder);
    if (activeSession) {
      log.info(TAG, `Removing active session for ${groupFolder}`);
      activeSession.session.close();
      this.activeSessions.delete(groupFolder);
    }
  }

  /** Clear session for a group (called by clear_context tool from main group) */
  async clearSession(groupFolder: string): Promise<{ closedActiveSession: boolean; sessionId: string }> {
    log.info(TAG, `Clearing session for group: ${groupFolder}`);

    const group = getGroupByFolder(this.db, groupFolder);
    if (!group) {
      throw new Error(`Group not found: ${groupFolder}`);
    }

    const closedActiveSession = this.activeSessions.has(groupFolder);
    const activeSession = this.activeSessions.get(groupFolder);
    if (activeSession) {
      log.info(TAG, `Closing active session for ${groupFolder} before slash clear`);
      activeSession.session.close();
      this.activeSessions.delete(groupFolder);
    }

    const requestedProfileKey = group.agent_provider || "claude";
    const profile = resolveAgentProfile(requestedProfileKey);
    const workingDirectory = resolve("groups", groupFolder);
    const persistedSessionId = getSessionId(this.db, groupFolder);
    const resumeSessionId = await resolveClaudeResumeSessionId(
      workingDirectory,
      persistedSessionId,
    );

    if (persistedSessionId && !resumeSessionId) {
      deleteSessionId(this.db, groupFolder);
      log.warn(TAG, `Discarded stale Claude session before clear for ${groupFolder}`, {
        persistedSessionId,
        workingDirectory,
      });
    }

    const { sessionId } = await this.provider.clearContext({
      groupFolder,
      workingDirectory,
      initialPrompt: "/clear",
      isMain: group.is_main === 1,
      resumeSessionId,
      tools: [],
      profile,
    });

    saveSessionId(this.db, groupFolder, sessionId);
    log.info(TAG, `Context cleared via Claude slash command for ${groupFolder}`, {
      sessionId,
      closedActiveSession,
    });

    return { closedActiveSession, sessionId };
  }
}
