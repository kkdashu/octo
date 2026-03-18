import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { ChannelManager } from "./channels/manager";
import type { ProviderRegistry } from "./providers/registry";
import type { AgentSession } from "./providers/types";
import { getGroupByFolder, getSessionId, saveSessionId } from "./db";
import { createGroupToolDefs } from "./tools";
import type { MessageSender } from "./tools";
import { log } from "./logger";

const TAG = "group-queue";

export class GroupQueue {
  private locks: Map<string, Promise<void>> = new Map();
  private activeSessions: Map<string, AgentSession> = new Map();
  private activeTasks = 0;
  private concurrencyLimit: number;
  private db: Database;
  private channelManager: ChannelManager;
  private providers: ProviderRegistry;

  constructor(
    db: Database,
    channelManager: ChannelManager,
    providers: ProviderRegistry,
    concurrencyLimit = 3,
  ) {
    this.db = db;
    this.channelManager = channelManager;
    this.providers = providers;
    this.concurrencyLimit = concurrencyLimit;
    log.info(TAG, `GroupQueue initialized`, { concurrencyLimit });
  }

  /** Push a message to an active session, returns false if no active session */
  pushMessage(groupFolder: string, text: string): boolean {
    const session = this.activeSessions.get(groupFolder);
    if (session) {
      log.info(TAG, `Pushing follow-up message to active session: ${groupFolder}`, {
        textLength: text.length,
        textPreview: text.substring(0, 200),
      });
      session.push(text);
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
  async enqueue(groupFolder: string, initialPrompt: string): Promise<void> {
    log.info(TAG, `Enqueuing agent task for group: ${groupFolder}`, {
      activeTasks: this.activeTasks,
      concurrencyLimit: this.concurrencyLimit,
      activeGroups: Array.from(this.activeSessions.keys()),
      promptLength: initialPrompt.length,
    });

    // Wait for per-group lock
    const existing = this.locks.get(groupFolder);
    if (existing) {
      log.debug(TAG, `Waiting for per-group lock: ${groupFolder}`);
    }
    const task = (existing ?? Promise.resolve()).then(() =>
      this.runWithConcurrencyLimit(groupFolder, initialPrompt),
    );
    this.locks.set(groupFolder, task.then(() => {}));

    // Clean up lock reference when done
    task.finally(() => {
      if (this.locks.get(groupFolder) === task.then(() => {})) {
        this.locks.delete(groupFolder);
      }
    });
  }

  private async runWithConcurrencyLimit(
    groupFolder: string,
    initialPrompt: string,
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
      const providerName = (group as any).agent_provider ?? "claude";
      const provider = this.providers.get(providerName) ?? this.providers.getDefault();

      log.info(TAG, `Using provider "${provider.name}" for group ${groupFolder}`);

      const messageSender: MessageSender = {
        send: (chatJid, text) => this.channelManager.send(chatJid, text),
        sendImage: (chatJid, filePath) => this.channelManager.sendImage(chatJid, filePath),
        refreshGroupMetadata: async () => {
          const chats = await this.channelManager.refreshGroupMetadata();
          return { count: chats.length };
        },
      };
      const tools = createGroupToolDefs(groupFolder, isMain, this.db, messageSender);
      const sessionId = getSessionId(this.db, groupFolder);

      const { session, events } = await provider.startSession({
        groupFolder,
        workingDirectory: resolve("groups", groupFolder),
        initialPrompt,
        isMain,
        resumeSessionId: sessionId ?? undefined,
        tools,
      });

      this.activeSessions.set(groupFolder, session);
      log.info(TAG, `Agent started and session registered for ${groupFolder}`);

      // Process event stream asynchronously
      (async () => {
        try {
          for await (const event of events) {
            if (event.type === "text") {
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
      })();
    } catch (err) {
      this.activeTasks--;
      log.error(TAG, `Failed to start agent for ${groupFolder}`, err);
    }
  }

  /** Remove an active session (e.g., when agent finishes) */
  removeSession(groupFolder: string) {
    const session = this.activeSessions.get(groupFolder);
    if (session) {
      log.info(TAG, `Removing active session for ${groupFolder}`);
      session.close();
      this.activeSessions.delete(groupFolder);
    }
  }
}
