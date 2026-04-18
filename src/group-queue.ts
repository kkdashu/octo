import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ChannelManager } from "./channels/manager";
import { resolvePersistedPiSessionRef } from "./providers/pi-session-ref";
import { loadAgentProfilesConfig, resolveAgentProfile } from "./runtime/profile-config";
import { resolveEnabledExternalMcpServers } from "./runtime/external-mcp-config";
import type {
  AgentRuntime,
  ConversationMessageInput,
  RuntimeConversation,
} from "./providers/types";
import {
  deleteSessionRef,
  getGroupByFolder,
  getSessionRef,
  listGroupMemories,
  saveSessionRef,
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

export function isGroupSkillInstalled(
  groupFolder: string,
  skillName: string,
  rootDir = process.cwd(),
): boolean {
  return existsSync(
    resolve(rootDir, "groups", groupFolder, ".pi", "skills", skillName, "SKILL.md"),
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
  private activeConversations: Map<
    string,
    { conversation: RuntimeConversation; generation: number }
  > = new Map();
  private sessionGenerations: Map<string, number> = new Map();
  private activeTasks = 0;
  private concurrencyLimit: number;
  private db: Database;
  private channelManager: ChannelManager;
  private runtime: AgentRuntime;

  constructor(
    db: Database,
    channelManager: ChannelManager,
    runtime: AgentRuntime,
    concurrencyLimit = 3,
  ) {
    this.db = db;
    this.channelManager = channelManager;
    this.runtime = runtime;
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

  /** Push a message to an active conversation, returns false if no active conversation */
  pushMessage(groupFolder: string, input: ConversationMessageInput): boolean {
    const activeConversation = this.activeConversations.get(groupFolder);
    if (activeConversation) {
      log.info(TAG, `Pushing message to active conversation: ${groupFolder}`, {
        mode: input.mode,
        textLength: input.text.length,
        textPreview: input.text.substring(0, 200),
      });
      void activeConversation.conversation.send(input).catch((error) => {
        log.error(TAG, `Failed to push ${input.mode} message to ${groupFolder}`, error);
      });
      return true;
    }
    log.debug(TAG, `No active conversation for ${groupFolder}, cannot push`);
    return false;
  }

  /** Check if a group has an active agent conversation */
  isActive(groupFolder: string): boolean {
    return this.activeConversations.has(groupFolder);
  }

  /** Enqueue a new agent task for a group (serial per-group, global concurrency limit) */
  async enqueue(groupFolder: string, initialPrompt: string): Promise<void> {
    log.info(TAG, `Enqueuing agent task for group: ${groupFolder}`, {
      activeTasks: this.activeTasks,
      concurrencyLimit: this.concurrencyLimit,
      activeGroups: Array.from(this.activeConversations.keys()),
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
    const lockPromise = task.then(() => {});
    this.locks.set(groupFolder, lockPromise);

    // Clean up lock reference when done
    task.finally(() => {
      if (this.locks.get(groupFolder) === lockPromise) {
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
      const requestedProfileKey =
        group.profile_key || loadAgentProfilesConfig().defaultProfile;
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
      const persistedSessionRef = getSessionRef(this.db, groupFolder);
      const workingDirectory = resolve("groups", groupFolder);
      const resumeSessionRef = resolvePersistedPiSessionRef(
        workingDirectory,
        persistedSessionRef,
      );
      const sessionGeneration = this.getSessionGeneration(groupFolder);

      if (persistedSessionRef && !resumeSessionRef) {
        deleteSessionRef(this.db, groupFolder);
        log.warn(TAG, `Discarded stale Pi session ref for ${groupFolder}`, {
          persistedSessionRef,
          workingDirectory,
        });
      }

      log.info(TAG, `Resolved session state for ${groupFolder}`, {
        persistedSessionRef,
        resumeSessionRef: resumeSessionRef ?? null,
        workingDirectory,
        sessionGeneration,
        willResume: !!resumeSessionRef,
      });

      const memories = listGroupMemories(this.db, groupFolder);
      const memoryBlock = buildGroupMemoryPromptBlock(memories);
      const initialPromptWithMemory = buildSessionInitialPrompt(
        initialPrompt,
        memories,
        !resumeSessionRef,
      );

      log.info(TAG, `Prepared session prompt for ${groupFolder}`, {
        resumedSession: !!resumeSessionRef,
        memoryCount: memories.length,
        memoryPolicyInjected: !resumeSessionRef,
        memoryInjected: !!memoryBlock && !resumeSessionRef,
      });

      const { conversation, events } = await this.runtime.openConversation({
        groupFolder,
        workingDirectory,
        isMain,
        resumeSessionRef,
        tools,
        profile,
        externalMcpServers: buildGroupExternalMcpServers(groupFolder),
      });

      if (sessionGeneration !== this.getSessionGeneration(groupFolder)) {
        conversation.close();
        this.activeTasks--;
        log.warn(TAG, `Discarding stale conversation startup for ${groupFolder} after generation changed`, {
          groupFolder,
          sessionGeneration,
          currentGeneration: this.getSessionGeneration(groupFolder),
        });
        return;
      }

      this.activeConversations.set(groupFolder, {
        conversation,
        generation: sessionGeneration,
      });
      log.info(TAG, `Agent started and conversation registered for ${groupFolder}`, {
        sessionGeneration,
        resumeSessionRef: resumeSessionRef ?? null,
      });

      // Process event stream asynchronously
      (async () => {
        try {
          for await (const event of events) {
            const isCurrentGeneration =
              sessionGeneration === this.getSessionGeneration(groupFolder);

            if (!isCurrentGeneration) {
              if (event.type === "completed") {
                log.warn(TAG, `Ignoring stale completion for ${groupFolder}`, {
                  staleGeneration: sessionGeneration,
                  currentGeneration: this.getSessionGeneration(groupFolder),
                  sessionRef: event.sessionRef,
                });
              } else if (event.type === "assistant_text") {
                log.warn(TAG, `Ignoring stale assistant text for ${groupFolder}`, {
                  staleGeneration: sessionGeneration,
                  currentGeneration: this.getSessionGeneration(groupFolder),
                  textPreview: event.text.substring(0, 120),
                });
              }
              continue;
            }

            if (event.type === "assistant_text") {
              log.info(TAG, `Sending agent reply to chat ${group.jid}`, {
                groupFolder,
                textPreview: event.text.substring(0, 200),
              });
              await this.channelManager.send(group.jid, event.text);
            } else if (event.type === "completed") {
              log.info(TAG, `Received agent completion for ${groupFolder}`, {
                sessionGeneration,
                sessionRef: event.sessionRef ?? null,
              });
              if (event.sessionRef) {
                const previousPersistedSessionRef = getSessionRef(this.db, groupFolder);
                saveSessionRef(this.db, groupFolder, event.sessionRef);
                log.info(TAG, `Session ref saved for group ${groupFolder}`, {
                  previousPersistedSessionRef,
                  sessionRef: event.sessionRef,
                  sessionGeneration,
                });
              }
              // Close the conversation after each turn to release the concurrency slot.
              // The session ref is persisted above so it can be resumed on the next message.
              conversation.close();
              log.info(TAG, `Conversation closed after turn completion for ${groupFolder}`, {
                sessionGeneration,
              });
            } else if (event.type === "failed") {
              log.error(TAG, `Agent error for group ${groupFolder}`, event.error);
              conversation.close();
            } else if (event.type === "diagnostic") {
              log.debug(TAG, `Runtime diagnostic for ${groupFolder}`, {
                name: event.name,
                message: event.message,
                sessionGeneration,
              });
            }
          }
        } catch (err) {
          log.error(TAG, `Event stream error for group ${groupFolder}`, err);
        } finally {
          const activeConversation = this.activeConversations.get(groupFolder);
          if (activeConversation?.generation === sessionGeneration) {
            this.activeConversations.delete(groupFolder);
          }
          this.activeTasks--;
          log.debug(TAG, `Session ended for ${groupFolder}, active: ${this.activeTasks}/${this.concurrencyLimit}`);
        }
      })();

      void conversation.send({
        mode: "prompt",
        text: initialPromptWithMemory,
      }).catch((error) => {
        log.error(TAG, `Initial prompt failed for ${groupFolder}`, error);
      });
    } catch (err) {
      this.activeTasks--;
      log.error(TAG, `Failed to start agent for ${groupFolder}`, err);
    }
  }

  /** Remove an active session (e.g., when agent finishes) */
  removeSession(groupFolder: string) {
    const activeConversation = this.activeConversations.get(groupFolder);
    if (activeConversation) {
      log.info(TAG, `Removing active session for ${groupFolder}`);
      activeConversation.conversation.close();
      this.activeConversations.delete(groupFolder);
    }
  }

  /** Clear session for a group */
  async clearSession(
    groupFolder: string,
  ): Promise<{
    closedActiveSession: boolean;
    previousSessionRef: string | null;
    sessionRef: string;
    generation: number;
  }> {
    log.info(TAG, `Clearing session for group: ${groupFolder}`);

    const group = getGroupByFolder(this.db, groupFolder);
    if (!group) {
      throw new Error(`Group not found: ${groupFolder}`);
    }

    const previousSessionRef = getSessionRef(this.db, groupFolder);
    const generationBefore = this.getSessionGeneration(groupFolder);
    const generation = this.bumpSessionGeneration(groupFolder);
    const closedActiveSession = this.activeConversations.has(groupFolder);
    const activeConversation = this.activeConversations.get(groupFolder);
    const activeConversationGeneration = activeConversation?.generation ?? null;
    if (activeConversation) {
      log.info(TAG, `Closing active session for ${groupFolder} before /clear session command`);
      activeConversation.conversation.close();
      this.activeConversations.delete(groupFolder);
    }

    const requestedProfileKey =
      group.profile_key || loadAgentProfilesConfig().defaultProfile;
    const profile = resolveAgentProfile(requestedProfileKey);
    const workingDirectory = resolve("groups", groupFolder);
    const persistedSessionRef = previousSessionRef;
    const resumeSessionRef = resolvePersistedPiSessionRef(
      workingDirectory,
      persistedSessionRef,
    );

    log.info(TAG, `Resolved session state before clear for ${groupFolder}`, {
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
      deleteSessionRef(this.db, groupFolder);
      log.warn(TAG, `Discarded stale Pi session ref before clear for ${groupFolder}`, {
        persistedSessionRef,
        workingDirectory,
      });
    }

    const { sessionRef } = await this.runtime.resetSession({
      groupFolder,
      workingDirectory,
      profile,
      resumeSessionRef,
    });

    saveSessionRef(this.db, groupFolder, sessionRef);
    log.info(TAG, `Session cleared via Pi local session reset for ${groupFolder}`, {
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
  buildGroupMemoryPromptBlock,
  buildSessionInitialPrompt,
  isGroupSkillInstalled,
};
