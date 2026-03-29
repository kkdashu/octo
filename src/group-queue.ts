import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { ChannelManager } from "./channels/manager";
import { resolveAgentProfile } from "./runtime/profile-config";
import type { AgentProvider, AgentSession } from "./providers/types";
import {
  deleteSessionId,
  getGroupByFolder,
  getSessionId,
  listGroupMemories,
  saveSessionId,
  type GroupMemoryRow,
} from "./db";
import { createGroupToolDefs } from "./tools";
import type { MessageSender } from "./tools";
import { log } from "./logger";

const TAG = "group-queue";

const BUILTIN_GROUP_MEMORY_PROMPT_LABELS: Record<string, string> = {
  topic_context: "Topic context",
  response_language: "Preferred explanation language",
  response_style: "Preferred response style",
  interaction_rule: "Interaction rule",
};

const GROUP_MEMORY_VALUE_LIMIT = 240;
const GROUP_MEMORY_BLOCK_LIMIT = 1200;
const GROUP_MEMORY_POLICY_LINES = [
  "Group memory policy:",
  "- When the user asks you to remember a stable preference, long-term rule, recurring context, or default behavior for this group, save it with remember_group_memory before replying.",
  "- Prefer builtin keys first: topic_context, response_language, response_style, interaction_rule.",
  "- Only use a custom key when no builtin key fits the memory.",
  "- Example: if the user says future replies should be in English, save response_language = English.",
  "- When the user wants to inspect, update, delete, or clear group memory, use list_group_memory, remember_group_memory, forget_group_memory, or clear_group_memory.",
];

function normalizeGroupMemoryValue(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= GROUP_MEMORY_VALUE_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, GROUP_MEMORY_VALUE_LIMIT - 3).trimEnd()}...`;
}

export function buildGroupMemoryPromptBlock(
  memories: GroupMemoryRow[],
): string | null {
  if (memories.length === 0) {
    return null;
  }

  const lines = ["Group memory:"];

  for (const memory of memories) {
    const label =
      memory.key_type === "builtin"
        ? (BUILTIN_GROUP_MEMORY_PROMPT_LABELS[memory.key] ?? memory.key)
        : `Custom ${memory.key}`;
    const line = `- ${label}: ${normalizeGroupMemoryValue(memory.value)}`;
    const nextBlock = [...lines, line].join("\n");

    if (nextBlock.length > GROUP_MEMORY_BLOCK_LIMIT) {
      lines.push("- Additional memory omitted to keep context concise.");
      break;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

function buildGroupMemoryPolicyBlock(): string {
  return GROUP_MEMORY_POLICY_LINES.join("\n");
}

export function buildSessionInitialPrompt(
  initialPrompt: string,
  memories: GroupMemoryRow[],
  shouldInjectMemoryContext: boolean,
): string {
  if (!shouldInjectMemoryContext) {
    return initialPrompt;
  }

  const sections = [buildGroupMemoryPolicyBlock()];
  const memoryBlock = buildGroupMemoryPromptBlock(memories);
  if (memoryBlock) {
    sections.push(memoryBlock);
  }
  sections.push(`Current input:\n${initialPrompt}`);

  return sections.join("\n\n");
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
  private activeSessions: Map<string, AgentSession> = new Map();
  private activeTasks = 0;
  private concurrencyLimit: number;
  private db: Database;
  private channelManager: ChannelManager;
  private provider: AgentProvider;

  constructor(
    db: Database,
    channelManager: ChannelManager,
    provider: AgentProvider,
    concurrencyLimit = 3,
  ) {
    this.db = db;
    this.channelManager = channelManager;
    this.provider = provider;
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

      const memories = listGroupMemories(this.db, groupFolder);
      const memoryBlock = buildGroupMemoryPromptBlock(memories);
      const initialPromptWithMemory = buildSessionInitialPrompt(
        initialPrompt,
        memories,
        !resumeSessionId,
      );

      log.info(TAG, `Prepared session prompt for ${groupFolder}`, {
        resumedSession: !!resumeSessionId,
        memoryCount: memories.length,
        memoryPolicyInjected: !resumeSessionId,
        memoryInjected: !!memoryBlock && !resumeSessionId,
      });

      const { session, events } = await this.provider.startSession({
        groupFolder,
        workingDirectory,
        initialPrompt: initialPromptWithMemory,
        isMain,
        resumeSessionId,
        tools,
        profile,
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
              // Close the session after each turn to release the concurrency slot.
              // The session ID is persisted above so it can be resumed on the next message.
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
      activeSession.close();
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

export const __test__ = {
  buildGroupMemoryPromptBlock,
  buildSessionInitialPrompt,
};
