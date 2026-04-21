import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  BUILTIN_GROUP_MEMORY_KEYS,
  clearGroupMemories,
  getGroupByFolder,
  isSupportedGroupMemoryKey,
  listGroups,
  listGroupMemories,
  registerGroup,
  createTask,
  deleteGroupMemory,
  listTasks,
  type GroupMemoryRow,
  type GroupMemoryKeyType,
  upsertGroupMemory,
  updateTaskStatus,
  updateGroupProfile,
  validateGroupMemoryKey,
  type RegisteredGroup,
} from "./db";
import { listAgentProfiles, loadAgentProfilesConfig } from "./runtime/profile-config";
import {
  generateMiniMaxImage,
  MINIMAX_IMAGE_ASPECT_RATIOS,
  MINIMAX_IMAGE_MODELS,
} from "./runtime/minimax-image";
import { getWorkspaceDirectory } from "./group-workspace";
import { computeNextRun } from "./task-scheduler";
import { copyDirRecursive } from "./utils";
import { log } from "./logger";
import type { ToolDefinition } from "./providers/types";

const TAG = "tools";

/** Abstraction over message sending — allows in-process or HTTP-forwarded implementations */
export interface MessageSender {
  send(chatJid: string, text: string): Promise<void>;
  sendImage(chatJid: string, filePath: string): Promise<void>;
  refreshGroupMetadata(): Promise<{ count: number }>;
  clearSession?(groupFolder: string): Promise<{
    closedActiveSession: boolean;
    previousSessionRef: string | null;
    sessionRef: string;
    generation: number;
  }>;
}

type ResolveTargetChatResult =
  | { ok: true; chatJid: string }
  | { ok: false; message: string };

type ResolveTargetGroupResult =
  | { ok: true; group: RegisteredGroup }
  | { ok: false; message: string };

const BUILTIN_GROUP_MEMORY_LABELS: Record<string, string> = {
  topic_context: "Topic context",
  response_language: "Response language",
  response_style: "Response style",
  interaction_rule: "Interaction rule",
};

function resolveTargetChatJid(
  db: Database,
  groupFolder: string,
  isMain: boolean,
  requestedChatJid: unknown,
): ResolveTargetChatResult {
  const group = getGroupByFolder(db, groupFolder);
  if (!group) {
    return { ok: false, message: `Group not found: ${groupFolder}` };
  }

  const normalizedRequestedChatJid =
    typeof requestedChatJid === "string" ? requestedChatJid.trim() : "";
  const targetChatJid = normalizedRequestedChatJid || group.jid;

  if (!isMain && targetChatJid !== group.jid) {
    return {
      ok: false,
      message: "Permission denied: cannot send to other groups",
    };
  }

  return {
    ok: true,
    chatJid: targetChatJid,
  };
}

function resolveTargetGroup(
  db: Database,
  groupFolder: string,
  isMain: boolean,
  requestedTargetGroupFolder: unknown,
): ResolveTargetGroupResult {
  const currentGroup = getGroupByFolder(db, groupFolder);
  if (!currentGroup) {
    return { ok: false, message: `Group not found: ${groupFolder}` };
  }

  const normalizedRequestedFolder =
    typeof requestedTargetGroupFolder === "string" ? requestedTargetGroupFolder.trim() : "";
  const targetGroupFolder = normalizedRequestedFolder || currentGroup.folder;

  if (!isMain && targetGroupFolder !== currentGroup.folder) {
    return {
      ok: false,
      message: "Permission denied: cannot manage memory for other groups",
    };
  }

  const targetGroup = getGroupByFolder(db, targetGroupFolder);
  if (!targetGroup) {
    return { ok: false, message: `Group not found: ${targetGroupFolder}` };
  }

  return { ok: true, group: targetGroup };
}

function formatGroupLabel(group: RegisteredGroup): string {
  return `"${group.name}" (${group.folder})`;
}

async function handleClearSessionTool(
  db: Database,
  sender: MessageSender,
  targetGroupFolder: string,
  toolName: string,
) {
  log.info(TAG, `[${toolName}] called by main group`, { folder: targetGroupFolder });
  const target = getGroupByFolder(db, targetGroupFolder);
  if (!target) {
    log.warn(TAG, `[${toolName}] Target group not found: ${targetGroupFolder}`);
    return { content: [{ type: "text", text: `Group not found: ${targetGroupFolder}` }] };
  }
  if (!sender.clearSession) {
    log.error(TAG, `[${toolName}] clearSession not available in sender`);
    return { content: [{ type: "text", text: "Clear session not supported" }] };
  }

  const result = await sender.clearSession(targetGroupFolder);
  log.info(TAG, `[${toolName}] Session cleared for ${targetGroupFolder}`, result);

  return {
    content: [
      {
        type: "text" as const,
        text: result.closedActiveSession
          ? `Session cleared for group ${formatGroupLabel(target)}. A fresh AI session (${result.sessionRef}) is ready, and the previous active session was closed. This only clears the AI session.`
          : `Session cleared for group ${formatGroupLabel(target)}. A fresh AI session (${result.sessionRef}) is ready for the next message. This only clears the AI session.`,
      },
    ],
  };
}

function formatGroupMemoryList(
  group: RegisteredGroup,
  memories: GroupMemoryRow[],
): string {
  if (memories.length === 0) {
    return `No group memory configured for ${formatGroupLabel(group)}.`;
  }

  const builtinMemories = memories.filter((memory) => memory.key_type === "builtin");
  const customMemories = memories.filter((memory) => memory.key_type === "custom");
  const lines = [`Group memory for ${formatGroupLabel(group)}:`];

  if (builtinMemories.length > 0) {
    lines.push("Builtin:");
    for (const memory of builtinMemories) {
      const label = BUILTIN_GROUP_MEMORY_LABELS[memory.key] ?? memory.key;
      lines.push(`- ${label} (${memory.key}): ${memory.value}`);
    }
  }

  if (customMemories.length > 0) {
    lines.push("Custom:");
    for (const memory of customMemories) {
      lines.push(`- ${memory.key}: ${memory.value}`);
    }
  }

  return lines.join("\n");
}

export function createGroupToolDefs(
  groupFolder: string,
  isMain: boolean,
  db: Database,
  sender: MessageSender,
  projectRoot?: string,
): ToolDefinition[] {
  log.info(TAG, `Creating tool definitions for group: ${groupFolder}`, {
    isMain,
    toolSet: isMain ? "main (full)" : "regular (limited)",
  });

  const root = projectRoot ?? ".";

  const commonTools: ToolDefinition[] = [
    {
      name: "send_message",
      description:
        "Send a message to a chat group. Supports plain text, local Markdown images like ![alt](path.png), and local Markdown file links like [report.pdf](./report.pdf).",
      schema: {
        type: "object",
        properties: {
          chatJid: {
            type: "string",
            description: "Optional target chat ID. Omit it to send back to the current group.",
          },
          text: {
            type: "string",
            description:
              "Message content. Supports local Markdown images and local Markdown file links.",
          },
        },
        required: ["text"],
      },
      handler: async (args) => {
        const resolvedTarget = resolveTargetChatJid(db, groupFolder, isMain, args.chatJid);
        log.info(TAG, `[send_message] called by group ${groupFolder}`, {
          requestedChatJid: args.chatJid,
          resolvedChatJid: resolvedTarget.ok ? resolvedTarget.chatJid : null,
          textLength: (args.text as string).length,
          textPreview: (args.text as string).substring(0, 100),
        });
        if (!resolvedTarget.ok) {
          log.warn(TAG, `[send_message] Rejected target chat`, {
            groupFolder,
            requestedChatJid: args.chatJid,
            message: resolvedTarget.message,
          });
          return { content: [{ type: "text", text: resolvedTarget.message }] };
        }
        await sender.send(resolvedTarget.chatJid, args.text as string);
        log.info(TAG, `[send_message] Message sent successfully`);
        return { content: [{ type: "text", text: "Message sent" }] };
      },
    },
    {
      name: "send_image",
      description: "Send an image file to a chat group",
      schema: {
        type: "object",
        properties: {
          chatJid: {
            type: "string",
            description: "Optional target chat ID. Omit it to send back to the current group.",
          },
          filePath: { type: "string", description: "Image file path, relative to current group working directory" },
        },
        required: ["filePath"],
      },
      handler: async (args) => {
        const resolvedTarget = resolveTargetChatJid(db, groupFolder, isMain, args.chatJid);
        log.info(TAG, `[send_image] called by group ${groupFolder}`, {
          requestedChatJid: args.chatJid,
          resolvedChatJid: resolvedTarget.ok ? resolvedTarget.chatJid : null,
          filePath: args.filePath,
        });
        if (!resolvedTarget.ok) {
          log.warn(TAG, `[send_image] Rejected target chat`, {
            groupFolder,
            requestedChatJid: args.chatJid,
            message: resolvedTarget.message,
          });
          return { content: [{ type: "text", text: resolvedTarget.message }] };
        }

        const groupWorkdir = getWorkspaceDirectory(groupFolder, { rootDir: root });
        const absoluteFilePath = resolve(groupWorkdir, args.filePath as string);
        const rel = relative(groupWorkdir, absoluteFilePath);
        const escaped = rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");
        if (escaped) {
          log.warn(TAG, `[send_image] Rejected path outside group workdir`, { groupFolder, filePath: args.filePath, absoluteFilePath });
          return { content: [{ type: "text", text: "Invalid filePath: must stay within current group directory" }] };
        }

        if (!existsSync(absoluteFilePath)) {
          return { content: [{ type: "text", text: `File not found: ${args.filePath}` }] };
        }
        const stat = statSync(absoluteFilePath);
        if (!stat.isFile()) {
          return { content: [{ type: "text", text: `Not a file: ${args.filePath}` }] };
        }

        await sender.sendImage(resolvedTarget.chatJid, absoluteFilePath);
        log.info(TAG, `[send_image] Image sent successfully`, {
          chatJid: resolvedTarget.chatJid,
          filePath: absoluteFilePath,
        });
        return { content: [{ type: "text", text: "Image sent" }] };
      },
    },
    {
      name: "generate_image",
      description: "Generate an image from a text prompt using MiniMax and save it into the current group directory",
      schema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Text prompt for the image" },
          model: {
            type: "string",
            enum: [...MINIMAX_IMAGE_MODELS],
            default: "image-01",
            description: "MiniMax image model",
          },
          aspectRatio: {
            type: "string",
            enum: [...MINIMAX_IMAGE_ASPECT_RATIOS],
            default: "1:1",
            description: "Output aspect ratio",
          },
        },
        required: ["prompt"],
      },
      handler: async (args) => {
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        const requestedModel = typeof args.model === "string" ? args.model : "image-01";
        const requestedAspectRatio = typeof args.aspectRatio === "string" ? args.aspectRatio : "1:1";
        const model = MINIMAX_IMAGE_MODELS.includes(
          requestedModel as (typeof MINIMAX_IMAGE_MODELS)[number],
        )
          ? (requestedModel as (typeof MINIMAX_IMAGE_MODELS)[number])
          : "image-01";
        const aspectRatio = MINIMAX_IMAGE_ASPECT_RATIOS.includes(
          requestedAspectRatio as (typeof MINIMAX_IMAGE_ASPECT_RATIOS)[number],
        )
          ? (requestedAspectRatio as (typeof MINIMAX_IMAGE_ASPECT_RATIOS)[number])
          : "1:1";

        log.info(TAG, `[generate_image] called by group ${groupFolder}`, {
          model,
          aspectRatio,
          promptLength: prompt.length,
        });

        if (!prompt) {
          return { content: [{ type: "text", text: "Prompt is required for image generation." }] };
        }

        try {
          const artifact = await generateMiniMaxImage({
            groupWorkdir: getWorkspaceDirectory(groupFolder, { rootDir: root }),
            prompt,
            model,
            aspectRatio,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: true,
                    model: artifact.model,
                    aspectRatio: artifact.aspectRatio,
                    filePath: artifact.relativeFilePath,
                    message:
                      "Image generated successfully. Use send_image with this filePath to post it to the group.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          log.error(TAG, `[generate_image] failed for group ${groupFolder}`, err);
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Failed to generate image: ${message}` }] };
        }
      },
    },
    {
      name: "schedule_task",
      description: "Create a scheduled task",
      schema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Task prompt" },
          scheduleType: { type: "string", enum: ["cron"], description: "Schedule type" },
          scheduleValue: { type: "string", description: "Cron expression" },
          contextMode: { type: "string", enum: ["group", "isolated"], default: "isolated", description: "Context mode" },
        },
        required: ["prompt", "scheduleType", "scheduleValue"],
      },
      handler: async (args) => {
        log.info(TAG, `[schedule_task] called by group ${groupFolder}`, args);
        const group = getGroupByFolder(db, groupFolder);
        if (!group) {
          log.error(TAG, `[schedule_task] Group not found: ${groupFolder}`);
          return { content: [{ type: "text", text: "Group not found" }] };
        }
        let nextRun: string | null = null;
        try {
          nextRun = computeNextRun(args.scheduleValue as string);
        } catch (err) {
          log.error(TAG, `[schedule_task] Invalid cron expression: ${args.scheduleValue}`, err);
          return { content: [{ type: "text", text: `Invalid cron expression: ${args.scheduleValue}` }] };
        }
        const id = createTask(db, {
          groupFolder,
          chatJid: group.jid,
          prompt: args.prompt as string,
          scheduleType: args.scheduleType as string,
          scheduleValue: args.scheduleValue as string,
          contextMode: (args.contextMode as string) ?? "isolated",
          nextRun: nextRun ?? undefined,
        });
        log.info(TAG, `[schedule_task] Task created: ${id}, nextRun: ${nextRun}`);
        return { content: [{ type: "text", text: `Task created: ${id}, next run: ${nextRun}` }] };
      },
    },
    {
      name: "list_tasks",
      description: "List scheduled tasks for the current group",
      schema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        log.info(TAG, `[list_tasks] called by group ${groupFolder}`);
        const tasks = listTasks(db, groupFolder);
        log.debug(TAG, `[list_tasks] Found ${tasks.length} tasks`, tasks);
        return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
      },
    },
    {
      name: "pause_task",
      description: "Pause a scheduled task",
      schema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
      handler: async (args) => {
        log.info(TAG, `[pause_task] called by group ${groupFolder}`, args);
        updateTaskStatus(db, args.taskId as string, groupFolder, "paused");
        return { content: [{ type: "text", text: "Task paused" }] };
      },
    },
    {
      name: "resume_task",
      description: "Resume a paused task",
      schema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
      handler: async (args) => {
        log.info(TAG, `[resume_task] called by group ${groupFolder}`, args);
        updateTaskStatus(db, args.taskId as string, groupFolder, "active");
        return { content: [{ type: "text", text: "Task resumed" }] };
      },
    },
    {
      name: "cancel_task",
      description: "Cancel a scheduled task",
      schema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
      handler: async (args) => {
        log.info(TAG, `[cancel_task] called by group ${groupFolder}`, args);
        updateTaskStatus(db, args.taskId as string, groupFolder, "cancelled");
        return { content: [{ type: "text", text: "Task cancelled" }] };
      },
    },
    {
      name: "remember_group_memory",
      description: "Create or update long-term group memory. When the user expresses something the AI should remember, prefer mapping it to a builtin key first, and only create a custom key if no builtin key fits.",
      schema: {
        type: "object",
        properties: {
          key: { type: "string", description: `Memory key. Prefer builtin keys first: ${BUILTIN_GROUP_MEMORY_KEYS.join(", ")}. Only use a custom key when builtin keys cannot express the memory.` },
          value: { type: "string", description: "Memory value" },
          keyType: { type: "string", enum: ["builtin", "custom"], default: "builtin", description: "Choose builtin whenever possible. Use custom only when no builtin key fits." },
          targetGroupFolder: { type: "string", description: "Optional target group folder. Main group only." },
        },
        required: ["key", "value"],
      },
      handler: async (args) => {
        log.info(TAG, `[remember_group_memory] called by group ${groupFolder}`, args);
        const resolvedTarget = resolveTargetGroup(
          db,
          groupFolder,
          isMain,
          args.targetGroupFolder,
        );
        if (!resolvedTarget.ok) {
          return { content: [{ type: "text", text: resolvedTarget.message }] };
        }

        const key = typeof args.key === "string" ? args.key.trim() : "";
        const value = typeof args.value === "string" ? args.value.trim() : "";
        const keyType: GroupMemoryKeyType =
          args.keyType === "custom" ? "custom" : "builtin";

        if (!key) {
          return { content: [{ type: "text", text: "Memory key is required." }] };
        }
        if (!value) {
          return { content: [{ type: "text", text: "Memory value is required." }] };
        }

        const validationError = validateGroupMemoryKey(key, keyType);
        if (validationError) {
          return { content: [{ type: "text", text: validationError }] };
        }

        upsertGroupMemory(db, {
          groupFolder: resolvedTarget.group.folder,
          key,
          keyType,
          value,
          source: "tool",
        });

        return {
          content: [
            {
              type: "text",
              text: `Saved group memory for ${formatGroupLabel(resolvedTarget.group)}: ${key} = ${value}`,
            },
          ],
        };
      },
    },
    {
      name: "list_group_memory",
      description: "List long-term group memory for the current group or, from the main group, another group",
      schema: {
        type: "object",
        properties: {
          targetGroupFolder: { type: "string", description: "Optional target group folder. Main group only." },
        },
        required: [],
      },
      handler: async (args) => {
        log.info(TAG, `[list_group_memory] called by group ${groupFolder}`, args);
        const resolvedTarget = resolveTargetGroup(
          db,
          groupFolder,
          isMain,
          args.targetGroupFolder,
        );
        if (!resolvedTarget.ok) {
          return { content: [{ type: "text", text: resolvedTarget.message }] };
        }

        const memories = listGroupMemories(db, resolvedTarget.group.folder);
        return {
          content: [
            {
              type: "text",
              text: formatGroupMemoryList(resolvedTarget.group, memories),
            },
          ],
        };
      },
    },
    {
      name: "forget_group_memory",
      description: "Delete one long-term memory item from the current group or, from the main group, another group",
      schema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Memory key to delete" },
          targetGroupFolder: { type: "string", description: "Optional target group folder. Main group only." },
        },
        required: ["key"],
      },
      handler: async (args) => {
        log.info(TAG, `[forget_group_memory] called by group ${groupFolder}`, args);
        const resolvedTarget = resolveTargetGroup(
          db,
          groupFolder,
          isMain,
          args.targetGroupFolder,
        );
        if (!resolvedTarget.ok) {
          return { content: [{ type: "text", text: resolvedTarget.message }] };
        }

        const key = typeof args.key === "string" ? args.key.trim() : "";
        if (!key) {
          return { content: [{ type: "text", text: "Memory key is required." }] };
        }
        if (!isSupportedGroupMemoryKey(key)) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid memory key: ${key}. Use a builtin key or lowercase letters and underscores for custom keys.`,
              },
            ],
          };
        }

        const deleted = deleteGroupMemory(db, resolvedTarget.group.folder, key);
        return {
          content: [
            {
              type: "text",
              text: deleted
                ? `Deleted group memory "${key}" from ${formatGroupLabel(resolvedTarget.group)}.`
                : `Memory key not found for ${formatGroupLabel(resolvedTarget.group)}: ${key}`,
            },
          ],
        };
      },
    },
    {
      name: "clear_group_memory",
      description: "Clear all long-term memory for the current group or, from the main group, another group",
      schema: {
        type: "object",
        properties: {
          targetGroupFolder: { type: "string", description: "Optional target group folder. Main group only." },
        },
        required: [],
      },
      handler: async (args) => {
        log.info(TAG, `[clear_group_memory] called by group ${groupFolder}`, args);
        const resolvedTarget = resolveTargetGroup(
          db,
          groupFolder,
          isMain,
          args.targetGroupFolder,
        );
        if (!resolvedTarget.ok) {
          return { content: [{ type: "text", text: resolvedTarget.message }] };
        }

        const clearedCount = clearGroupMemories(db, resolvedTarget.group.folder);
        return {
          content: [
            {
              type: "text",
              text:
                clearedCount > 0
                  ? `Cleared ${clearedCount} group memory item(s) for ${formatGroupLabel(resolvedTarget.group)}.`
                  : `No group memory to clear for ${formatGroupLabel(resolvedTarget.group)}.`,
            },
          ],
        };
      },
    },
    {
      name: "list_curated_skills",
      description: "List available curated skills that can be installed into this group",
      schema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        log.info(TAG, `[list_curated_skills] called by group ${groupFolder}`);
        const curatedDir = join(root, "skills", "curated");
        if (!existsSync(curatedDir)) {
          return { content: [{ type: "text", text: "No curated skills available" }] };
        }
        const skills: Array<{ name: string; description: string; installed: boolean }> = [];
        for (const name of readdirSync(curatedDir)) {
          const skillDir = join(curatedDir, name);
          const skillMd = join(skillDir, "SKILL.md");
          if (!existsSync(skillMd)) continue;
          const content = readFileSync(skillMd, "utf-8");
          let description = "";
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch?.[1]) {
            const descMatch = fmMatch[1].match(/description:\s*(.+)/);
            if (descMatch?.[1]) description = descMatch[1].trim();
          }
          const installed = existsSync(
            join(getWorkspaceDirectory(groupFolder, { rootDir: root }), ".pi", "skills", name, "SKILL.md"),
          );
          skills.push({ name, description, installed });
        }
        log.debug(TAG, `[list_curated_skills] Found ${skills.length} curated skills`, skills);
        return { content: [{ type: "text", text: JSON.stringify(skills, null, 2) }] };
      },
    },
    {
      name: "install_curated_skill",
      description: "Install a curated skill into this group so it becomes available for use",
      schema: {
        type: "object",
        properties: { skillName: { type: "string", description: "Name of the curated skill to install" } },
        required: ["skillName"],
      },
      handler: async (args) => {
        log.info(TAG, `[install_curated_skill] called by group ${groupFolder}`, args);
        const src = join(root, "skills", "curated", args.skillName as string);
        if (!existsSync(src) || !existsSync(join(src, "SKILL.md"))) {
          log.warn(TAG, `[install_curated_skill] Skill not found: ${args.skillName}`);
          return { content: [{ type: "text", text: `Skill not found: ${args.skillName}` }] };
        }
        const dest = join(
          getWorkspaceDirectory(groupFolder, { rootDir: root }),
          ".pi",
          "skills",
          args.skillName as string,
        );
        if (existsSync(join(dest, "SKILL.md"))) {
          log.info(TAG, `[install_curated_skill] Already installed: ${args.skillName}`);
          return { content: [{ type: "text", text: `Skill already installed: ${args.skillName}` }] };
        }
        copyDirRecursive(src, dest);
        log.info(TAG, `[install_curated_skill] Installed ${args.skillName} → ${dest}`);
        return { content: [{ type: "text", text: `Skill installed: ${args.skillName}` }] };
      },
    },
  ];

  const mainOnlyTools: ToolDefinition[] = isMain
    ? [
        {
          name: "list_groups",
          description: "List all registered groups",
          schema: { type: "object", properties: {}, required: [] },
          handler: async () => {
            log.info(TAG, `[list_groups] called by main group`);
            const groups = listGroups(db);
            log.debug(TAG, `[list_groups] Found ${groups.length} groups`, groups);
            return { content: [{ type: "text", text: JSON.stringify(groups, null, 2) }] };
          },
        },
        {
          name: "register_group",
          description: "Register a new group",
          schema: {
            type: "object",
            properties: {
              jid: { type: "string", description: "Group chat ID" },
              name: { type: "string", description: "Group name" },
              folder: { type: "string", description: "Working directory name" },
              triggerPattern: { type: "string", description: "Trigger keyword" },
            },
            required: ["jid", "name", "folder", "triggerPattern"],
          },
          handler: async (args) => {
            log.info(TAG, `[register_group] called by main group`, args);
            registerGroup(db, {
              ...(args as { jid: string; name: string; folder: string; triggerPattern: string }),
              profileKey: loadAgentProfilesConfig().defaultProfile,
            });
            log.info(TAG, `[register_group] Group registered: ${args.jid}`);
            return { content: [{ type: "text", text: "Group registered" }] };
          },
        },
        {
          name: "refresh_groups",
          description: "Refresh group metadata from all channels",
          schema: { type: "object", properties: {}, required: [] },
          handler: async () => {
            log.info(TAG, `[refresh_groups] called by main group`);
            const result = await sender.refreshGroupMetadata();
            log.info(TAG, `[refresh_groups] Refreshed: ${result.count} chats`);
            return { content: [{ type: "text", text: `Refreshed: ${result.count} chats found` }] };
          },
        },
        {
          name: "cross_group_schedule_task",
          description: "Create a scheduled task for another group",
          schema: {
            type: "object",
            properties: {
              targetGroupFolder: { type: "string", description: "Target group folder name" },
              prompt: { type: "string", description: "Task prompt" },
              scheduleType: { type: "string", enum: ["cron"] },
              scheduleValue: { type: "string", description: "Cron expression" },
              contextMode: { type: "string", enum: ["group", "isolated"], default: "isolated" },
            },
            required: ["targetGroupFolder", "prompt", "scheduleType", "scheduleValue"],
          },
          handler: async (args) => {
            log.info(TAG, `[cross_group_schedule_task] called by main group`, args);
            const targetGroupFolder = args.targetGroupFolder as string;
            const targetGroup = getGroupByFolder(db, targetGroupFolder);
            if (!targetGroup) {
              log.warn(TAG, `[cross_group_schedule_task] Target group not found: ${targetGroupFolder}`);
              return { content: [{ type: "text", text: "Target group not found" }] };
            }
            let nextRun: string | null = null;
            try {
              nextRun = computeNextRun(args.scheduleValue as string);
            } catch (err) {
              log.error(TAG, `[cross_group_schedule_task] Invalid cron: ${args.scheduleValue}`, err);
              return { content: [{ type: "text", text: `Invalid cron expression: ${args.scheduleValue}` }] };
            }
            const id = createTask(db, {
              groupFolder: targetGroupFolder,
              chatJid: targetGroup.jid,
              prompt: args.prompt as string,
              scheduleType: args.scheduleType as string,
              scheduleValue: args.scheduleValue as string,
              contextMode: (args.contextMode as string) ?? "isolated",
              nextRun: nextRun ?? undefined,
            });
            log.info(TAG, `[cross_group_schedule_task] Task created: ${id} for ${targetGroupFolder}, nextRun: ${nextRun}`);
            return { content: [{ type: "text", text: `Task created for ${targetGroupFolder}: ${id}, next run: ${nextRun}` }] };
          },
        },
        {
          name: "list_profiles",
          description: "List all configured agent profiles with model and upstream details",
          schema: { type: "object", properties: {}, required: [] },
          handler: async () => {
            log.info(TAG, `[list_profiles] called by main group`);
            const config = loadAgentProfilesConfig();
            const profiles = listAgentProfiles();
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      defaultProfile: config.defaultProfile,
                      profiles,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          },
        },
        {
          name: "switch_profile",
          description: "Switch the agent profile for a group. Use list_profiles to see available profile keys.",
          schema: {
            type: "object",
            properties: {
              targetGroupFolder: { type: "string", description: "Target group folder name" },
              profileKey: { type: "string", description: "Profile key (e.g. claude, codex, kimi, kimi-cli)" },
            },
            required: ["targetGroupFolder", "profileKey"],
          },
          handler: async (args) => {
            const folder = args.targetGroupFolder as string;
            const profileKey = args.profileKey as string;
            log.info(TAG, `[switch_profile] called by main group`, { folder, profileKey });
            const target = getGroupByFolder(db, folder);
            if (!target) {
              return { content: [{ type: "text", text: `Group not found: ${folder}` }] };
            }
            const config = loadAgentProfilesConfig();
            if (!config.profiles[profileKey]) {
              const available = Object.keys(config.profiles).sort().join(", ");
              return {
                content: [
                  {
                    type: "text",
                    text: `Unknown profile: ${profileKey}. Available profiles: ${available}`,
                  },
                ],
              };
            }
            updateGroupProfile(db, folder, profileKey);
            log.info(TAG, `[switch_profile] Switched ${folder} to profile: ${profileKey}`);
            return {
              content: [
                {
                  type: "text",
                  text: `Group "${target.name}" (${folder}) switched to profile: ${profileKey}`,
                },
              ],
            };
          },
        },
        {
          name: "clear_session",
          description: "Clear only the AI session for a target group. This does not clear group memory, pending messages, or files.",
          schema: {
            type: "object",
            properties: {
              targetGroupFolder: { type: "string", description: "Target group folder name" },
            },
            required: ["targetGroupFolder"],
          },
          handler: async (args) =>
            handleClearSessionTool(
              db,
              sender,
              args.targetGroupFolder as string,
              "clear_session",
            ),
        },
        {
          name: "clear_context",
          description:
            "Compatibility alias for clear_session. This only clears the AI session for a target group.",
          schema: {
            type: "object",
            properties: {
              targetGroupFolder: { type: "string", description: "Target group folder name" },
            },
            required: ["targetGroupFolder"],
          },
          handler: async (args) =>
            handleClearSessionTool(
              db,
              sender,
              args.targetGroupFolder as string,
              "clear_context",
            ),
        },
      ]
    : [];

  const allTools = [...commonTools, ...mainOnlyTools];
  log.info(TAG, `Tool definitions created for group ${groupFolder}: ${allTools.length} tools`);
  return allTools;
}

export function getToolNames(tools: ToolDefinition[], mcpServerName: string): string[] {
  return tools.map((t) => `mcp__${mcpServerName}__${t.name}`);
}
