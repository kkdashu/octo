import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { ChannelManager } from "./channels/manager";
import { resolveAgentProfile } from "./runtime/profile-config";
import { resolveEnabledExternalMcpServers } from "./runtime/external-mcp-config";
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
const PDF_TO_MARKDOWN_SKILL_NAME = "pdf-to-markdown";

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

export function isGroupSkillInstalled(
  groupFolder: string,
  skillName: string,
  rootDir = process.cwd(),
): boolean {
  return existsSync(
    resolve(rootDir, "groups", groupFolder, ".claude", "skills", skillName, "SKILL.md"),
  );
}

export function buildGroupExternalMcpServers(
  groupFolder: string,
  rootDir = process.cwd(),
): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  if (!isGroupSkillInstalled(groupFolder, PDF_TO_MARKDOWN_SKILL_NAME, rootDir)) {
    return {};
  }

  return resolveEnabledExternalMcpServers(["markitdown"]);
}

export class GroupQueue {
  private locks: Map<string, Promise<void>> = new Map();
  private activeSessions: Map<string, { session: AgentSession; generation: number }> =
    new Map();
  private sessionGenerations: Map<string, number> = new Map();
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

  private getSessionGeneration(groupFolder: string): number {
    return this.sessionGenerations.get(groupFolder) ?? 0;
  }

  private bumpSessionGeneration(groupFolder: string): number {
    const nextGeneration = this.getSessionGeneration(groupFolder) + 1;
    this.sessionGenerations.set(groupFolder, nextGeneration);
    return nextGeneration;
  }

  /** Push a message to an active session, returns false if no active session */
  pushMessage(groupFolder: string, text: string): boolean {
    const activeSession = this.activeSessions.get(groupFolder);
    if (activeSession) {
      log.info(TAG, `Pushing follow-up message to active session: ${groupFolder}`, {
        textLength: text.length,
        textPreview: text.substring(0, 200),
      });
      activeSession.session.push(text);
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
      const sessionGeneration = this.getSessionGeneration(groupFolder);

      if (persistedSessionId && !resumeSessionId) {
        deleteSessionId(this.db, groupFolder);
        log.warn(TAG, `Discarded stale Claude session for ${groupFolder}`, {
          persistedSessionId,
          workingDirectory,
        });
      }

      log.info(TAG, `Resolved session state for ${groupFolder}`, {
        persistedSessionId,
        resumeSessionId: resumeSessionId ?? null,
        workingDirectory,
        sessionGeneration,
        willResume: !!resumeSessionId,
      });

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
        externalMcpServers: buildGroupExternalMcpServers(groupFolder),
      });

      if (sessionGeneration !== this.getSessionGeneration(groupFolder)) {
        session.close();
        this.activeTasks--;
        log.warn(TAG, `Discarding stale session startup for ${groupFolder} after generation changed`, {
          groupFolder,
          sessionGeneration,
          currentGeneration: this.getSessionGeneration(groupFolder),
        });
        return;
      }

      this.activeSessions.set(groupFolder, {
        session,
        generation: sessionGeneration,
      });
      log.info(TAG, `Agent started and session registered for ${groupFolder}`, {
        sessionGeneration,
        resumeSessionId: resumeSessionId ?? null,
      });

      // Process event stream asynchronously
      (async () => {
        try {
          for await (const event of events) {
            const isCurrentGeneration =
              sessionGeneration === this.getSessionGeneration(groupFolder);

            if (!isCurrentGeneration) {
              if (event.type === "result") {
                log.warn(TAG, `Ignoring stale result for ${groupFolder}`, {
                  staleGeneration: sessionGeneration,
                  currentGeneration: this.getSessionGeneration(groupFolder),
                  sessionId: event.sessionId,
                });
              } else if (event.type === "text") {
                log.warn(TAG, `Ignoring stale text event for ${groupFolder}`, {
                  staleGeneration: sessionGeneration,
                  currentGeneration: this.getSessionGeneration(groupFolder),
                  textPreview: event.text.substring(0, 120),
                });
              }
              continue;
            }

            if (event.type === "text") {
              log.info(TAG, `Sending agent reply to chat ${group.jid}`, {
                groupFolder,
                textPreview: event.text.substring(0, 200),
              });
              await this.channelManager.send(group.jid, event.text);
            } else if (event.type === "result") {
              log.info(TAG, `Received agent result for ${groupFolder}`, {
                sessionGeneration,
                sessionId: event.sessionId ?? null,
              });
              if (event.sessionId) {
                const previousPersistedSessionId = getSessionId(this.db, groupFolder);
                saveSessionId(this.db, groupFolder, event.sessionId);
                log.info(TAG, `Session ID saved for group ${groupFolder}`, {
                  previousPersistedSessionId,
                  sessionId: event.sessionId,
                  sessionGeneration,
                });
              }
              // Close the session after each turn to release the concurrency slot.
              // The session ID is persisted above so it can be resumed on the next message.
              session.close();
              log.info(TAG, `Session closed after turn completion for ${groupFolder}`, {
                sessionGeneration,
              });
            } else if (event.type === "error") {
              log.error(TAG, `Agent error for group ${groupFolder}`, event.error);
            }
          }
        } catch (err) {
          log.error(TAG, `Event stream error for group ${groupFolder}`, err);
        } finally {
          const activeSession = this.activeSessions.get(groupFolder);
          if (activeSession?.generation === sessionGeneration) {
            this.activeSessions.delete(groupFolder);
          }
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
    const activeSession = this.activeSessions.get(groupFolder);
    if (activeSession) {
      log.info(TAG, `Removing active session for ${groupFolder}`);
      activeSession.session.close();
      this.activeSessions.delete(groupFolder);
    }
  }

  /** Clear session for a group */
  async clearSession(
    groupFolder: string,
  ): Promise<{
    closedActiveSession: boolean;
    previousSessionId: string | null;
    sessionId: string;
    generation: number;
  }> {
    log.info(TAG, `Clearing session for group: ${groupFolder}`);

    const group = getGroupByFolder(this.db, groupFolder);
    if (!group) {
      throw new Error(`Group not found: ${groupFolder}`);
    }

    const previousSessionId = getSessionId(this.db, groupFolder);
    const generationBefore = this.getSessionGeneration(groupFolder);
    const generation = this.bumpSessionGeneration(groupFolder);
    const closedActiveSession = this.activeSessions.has(groupFolder);
    const activeSession = this.activeSessions.get(groupFolder);
    const activeSessionGeneration = activeSession?.generation ?? null;
    if (activeSession) {
      log.info(TAG, `Closing active session for ${groupFolder} before /clear session command`);
      activeSession.session.close();
      this.activeSessions.delete(groupFolder);
    }

    const requestedProfileKey = group.agent_provider || "claude";
    const profile = resolveAgentProfile(requestedProfileKey);
    const workingDirectory = resolve("groups", groupFolder);
    const persistedSessionId = previousSessionId;
    const resumeSessionId = await resolveClaudeResumeSessionId(
      workingDirectory,
      persistedSessionId,
    );

    log.info(TAG, `Resolved session state before clear for ${groupFolder}`, {
      previousSessionId,
      persistedSessionId,
      resumeSessionId: resumeSessionId ?? null,
      closedActiveSession,
      activeSessionGeneration,
      generationBefore,
      generationAfter: generation,
      workingDirectory,
      profileKey: profile.profileKey,
    });

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
    log.info(TAG, `Session cleared via Claude /clear command for ${groupFolder}`, {
      previousSessionId,
      sessionId,
      resumeSessionId: resumeSessionId ?? null,
      closedActiveSession,
      generationBefore,
      generationAfter: generation,
    });

    return {
      closedActiveSession,
      previousSessionId,
      sessionId,
      generation,
    };
  }
}

export const __test__ = {
  buildGroupExternalMcpServers,
  buildGroupMemoryPromptBlock,
  buildSessionInitialPrompt,
  isGroupSkillInstalled,
};
