import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  BUILTIN_WORKSPACE_MEMORY_KEYS,
  clearWorkspaceMemories,
  createTask,
  deleteWorkspaceMemory,
  getWorkspaceByFolder,
  listChatBindingsForChat,
  listChatsForWorkspace,
  listTasks,
  listWorkspaceMemories,
  listWorkspaces,
  isSupportedWorkspaceMemoryKey,
  type WorkspaceMemoryKeyType,
  type WorkspaceMemoryRow,
  upsertWorkspaceMemory,
  updateTaskStatus,
  updateWorkspace,
  validateWorkspaceMemoryKey,
} from "./db";
import { getWorkspaceDirectory } from "./group-workspace";
import { log } from "./logger";
import type { ToolDefinition } from "./providers/types";
import {
  generateMiniMaxImage,
  MINIMAX_IMAGE_ASPECT_RATIOS,
  MINIMAX_IMAGE_MODELS,
} from "./runtime/minimax-image";
import { listAgentProfiles, loadAgentProfilesConfig } from "./runtime/profile-config";
import { computeNextRun } from "./task-scheduler";
import { copyDirRecursive } from "./utils";

const TAG = "tools";

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

export interface MessageSender {
  send(externalChatId: string, text: string): Promise<void>;
  sendImage(externalChatId: string, filePath: string): Promise<void>;
  refreshChatMetadata(): Promise<{ count: number }>;
  clearSession?(chatId: string): Promise<{
    closedActiveSession: boolean;
    previousSessionRef: string | null;
    sessionRef: string;
    generation: number;
  }>;
}

export interface WorkspaceToolContext {
  workspaceId: string;
  workspaceFolder: string;
  chatId: string;
  isMain: boolean;
}

type ResolveTargetExternalChatIdResult =
  | { ok: true; externalChatId: string }
  | { ok: false; message: string };

type ResolveTargetWorkspaceResult =
  | {
      ok: true;
      workspace: NonNullable<ReturnType<typeof getWorkspaceByFolder>>;
      chatId: string;
    }
  | { ok: false; message: string };

const BUILTIN_WORKSPACE_MEMORY_LABELS: Record<string, string> = {
  topic_context: "Topic context",
  response_language: "Response language",
  response_style: "Response style",
  interaction_rule: "Interaction rule",
};

function getPrimaryExternalChatId(
  db: Database,
  chatId: string,
): string | null {
  const binding = listChatBindingsForChat(db, chatId)[0] ?? null;
  return binding?.external_chat_id ?? null;
}

function resolveTargetExternalChatId(
  db: Database,
  context: WorkspaceToolContext,
  requestedExternalChatId: unknown,
): ResolveTargetExternalChatIdResult {
  const currentExternalChatId = getPrimaryExternalChatId(db, context.chatId);
  if (!currentExternalChatId) {
    return {
      ok: false,
      message: `No outbound chat binding found for chat ${context.chatId}`,
    };
  }

  const normalizedRequested =
    typeof requestedExternalChatId === "string" ? requestedExternalChatId.trim() : "";
  const targetExternalChatId = normalizedRequested || currentExternalChatId;

  if (!context.isMain && targetExternalChatId !== currentExternalChatId) {
    return {
      ok: false,
      message: "Permission denied: cannot send to other chats",
    };
  }

  return {
    ok: true,
    externalChatId: targetExternalChatId,
  };
}

function getDefaultWorkspaceChatId(
  db: Database,
  workspaceId: string,
): string | null {
  return listChatsForWorkspace(db, workspaceId)[0]?.id ?? null;
}

function resolveTargetWorkspace(
  db: Database,
  context: WorkspaceToolContext,
  requestedTargetWorkspaceFolder: unknown,
): ResolveTargetWorkspaceResult {
  const currentWorkspace = getWorkspaceByFolder(db, context.workspaceFolder);
  if (!currentWorkspace) {
    return { ok: false, message: `Workspace not found: ${context.workspaceFolder}` };
  }

  const normalizedRequested =
    typeof requestedTargetWorkspaceFolder === "string"
      ? requestedTargetWorkspaceFolder.trim()
      : "";
  const targetWorkspace = normalizedRequested
    ? getWorkspaceByFolder(db, normalizedRequested)
    : currentWorkspace;

  if (!targetWorkspace) {
    return { ok: false, message: `Workspace not found: ${normalizedRequested}` };
  }

  if (!context.isMain && targetWorkspace.id !== currentWorkspace.id) {
    return {
      ok: false,
      message: "Permission denied: cannot target another workspace",
    };
  }

  const defaultChatId = getDefaultWorkspaceChatId(db, targetWorkspace.id);
  if (!defaultChatId) {
    return {
      ok: false,
      message: `Workspace has no chat: ${targetWorkspace.folder}`,
    };
  }

  return {
    ok: true,
    workspace: targetWorkspace,
    chatId: defaultChatId,
  };
}

function formatWorkspaceLabel(
  workspace: NonNullable<ReturnType<typeof getWorkspaceByFolder>>,
): string {
  return `"${workspace.name}" (${workspace.folder})`;
}

async function handleClearSessionTool(
  db: Database,
  sender: MessageSender,
  targetWorkspaceFolder: string,
  toolName: string,
) {
  const targetWorkspace = getWorkspaceByFolder(db, targetWorkspaceFolder);
  if (!targetWorkspace) {
    return textResult(`Workspace not found: ${targetWorkspaceFolder}`);
  }

  const targetChatId = getDefaultWorkspaceChatId(db, targetWorkspace.id);
  if (!targetChatId) {
    return textResult(`Workspace has no chat: ${targetWorkspaceFolder}`);
  }

  if (!sender.clearSession) {
    log.error(TAG, `[${toolName}] clearSession not available in sender`);
    return textResult("Clear session not supported");
  }

  const result = await sender.clearSession(targetChatId);
  return {
    content: [
      {
        type: "text" as const,
        text: result.closedActiveSession
          ? `Session cleared for workspace ${formatWorkspaceLabel(targetWorkspace)}. A fresh AI session (${result.sessionRef}) is ready, and the previous active session was closed.`
          : `Session cleared for workspace ${formatWorkspaceLabel(targetWorkspace)}. A fresh AI session (${result.sessionRef}) is ready for the next message.`,
      },
    ],
  };
}

function formatWorkspaceMemoryList(
  workspace: NonNullable<ReturnType<typeof getWorkspaceByFolder>>,
  memories: WorkspaceMemoryRow[],
): string {
  if (memories.length === 0) {
    return `No workspace memory configured for ${formatWorkspaceLabel(workspace)}.`;
  }

  const builtinMemories = memories.filter((memory) => memory.key_type === "builtin");
  const customMemories = memories.filter((memory) => memory.key_type === "custom");
  const lines = [`Workspace memory for ${formatWorkspaceLabel(workspace)}:`];

  if (builtinMemories.length > 0) {
    lines.push("Builtin:");
    for (const memory of builtinMemories) {
      const label = BUILTIN_WORKSPACE_MEMORY_LABELS[memory.key] ?? memory.key;
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

export function createWorkspaceToolDefs(
  context: WorkspaceToolContext,
  db: Database,
  sender: MessageSender,
  projectRoot?: string,
): ToolDefinition[] {
  const root = projectRoot ?? ".";
  log.info(TAG, `Creating tool definitions for workspace: ${context.workspaceFolder}`, {
    isMain: context.isMain,
  });

  const commonTools: ToolDefinition[] = [
    {
      name: "send_message",
      description:
        "Send a message to a chat. Supports plain text, local Markdown images like ![alt](path.png), and local Markdown file links like [report.pdf](./report.pdf).",
      schema: {
        type: "object",
        properties: {
          externalChatId: {
            type: "string",
            description: "Optional target external chat ID. Omit to reply to the current chat.",
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
        const resolvedTarget = resolveTargetExternalChatId(
          db,
          context,
          args.externalChatId,
        );
        if (resolvedTarget.ok === false) {
          return textResult(resolvedTarget.message);
        }

        await sender.send(resolvedTarget.externalChatId, args.text as string);
        return textResult("Message sent");
      },
    },
    {
      name: "send_image",
      description: "Send an image file to a chat",
      schema: {
        type: "object",
        properties: {
          externalChatId: {
            type: "string",
            description: "Optional target external chat ID. Omit to reply to the current chat.",
          },
          filePath: {
            type: "string",
            description: "Image file path, relative to the current workspace directory",
          },
        },
        required: ["filePath"],
      },
      handler: async (args) => {
        const resolvedTarget = resolveTargetExternalChatId(
          db,
          context,
          args.externalChatId,
        );
        if (resolvedTarget.ok === false) {
          return textResult(resolvedTarget.message);
        }

        const workspaceDir = getWorkspaceDirectory(context.workspaceFolder, { rootDir: root });
        const absoluteFilePath = resolve(workspaceDir, args.filePath as string);
        const rel = relative(workspaceDir, absoluteFilePath);
        const escaped = rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");
        if (escaped) {
          return textResult("Invalid filePath: must stay within current workspace directory");
        }

        if (!existsSync(absoluteFilePath)) {
          return textResult(`File not found: ${args.filePath}`);
        }

        const stat = statSync(absoluteFilePath);
        if (!stat.isFile()) {
          return textResult(`Not a file: ${args.filePath}`);
        }

        await sender.sendImage(resolvedTarget.externalChatId, absoluteFilePath);
        return textResult("Image sent");
      },
    },
    {
      name: "generate_image",
      description: "Generate an image from a text prompt using MiniMax and save it into the current workspace directory",
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

        if (!prompt) {
          return textResult("Prompt is required for image generation.");
        }

        try {
          const artifact = await generateMiniMaxImage({
            groupWorkdir: getWorkspaceDirectory(context.workspaceFolder, { rootDir: root }),
            prompt,
            model,
            aspectRatio,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: true,
                    model: artifact.model,
                    aspectRatio: artifact.aspectRatio,
                    filePath: artifact.relativeFilePath,
                    message:
                      "Image generated successfully. Use send_image with this filePath to post it to the chat.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return textResult(`Failed to generate image: ${message}`);
        }
      },
    },
    {
      name: "schedule_task",
      description: "Create a scheduled task for the current workspace",
      schema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Task prompt" },
          scheduleType: { type: "string", enum: ["cron"], description: "Schedule type" },
          scheduleValue: { type: "string", description: "Cron expression" },
          contextMode: {
            type: "string",
            enum: ["workspace", "isolated"],
            default: "isolated",
            description: "Context mode",
          },
        },
        required: ["prompt", "scheduleType", "scheduleValue"],
      },
      handler: async (args) => {
        let nextRun: string | null = null;
        try {
          nextRun = computeNextRun(args.scheduleValue as string);
        } catch {
          return textResult(`Invalid cron expression: ${args.scheduleValue}`);
        }

        const id = createTask(db, {
          workspaceId: context.workspaceId,
          chatId: context.chatId,
          prompt: args.prompt as string,
          scheduleType: args.scheduleType as string,
          scheduleValue: args.scheduleValue as string,
          contextMode: (args.contextMode as string) ?? "isolated",
          nextRun: nextRun ?? undefined,
        });
        return textResult(`Task created: ${id}, next run: ${nextRun}`);
      },
    },
    {
      name: "list_tasks",
      description: "List scheduled tasks for the current workspace",
      schema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        const tasks = listTasks(db, context.workspaceId);
        return textResult(JSON.stringify(tasks, null, 2));
      },
    },
    {
      name: "pause_task",
      description: "Pause a scheduled task",
      schema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
      handler: async (args) => {
        updateTaskStatus(db, args.taskId as string, context.workspaceId, "paused");
        return textResult("Task paused");
      },
    },
    {
      name: "resume_task",
      description: "Resume a paused task",
      schema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
      handler: async (args) => {
        updateTaskStatus(db, args.taskId as string, context.workspaceId, "active");
        return textResult("Task resumed");
      },
    },
    {
      name: "cancel_task",
      description: "Cancel a scheduled task",
      schema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
      handler: async (args) => {
        updateTaskStatus(db, args.taskId as string, context.workspaceId, "cancelled");
        return textResult("Task cancelled");
      },
    },
    {
      name: "remember_workspace_memory",
      description: "Create or update long-term workspace memory.",
      schema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: `Memory key. Prefer builtin keys first: ${BUILTIN_WORKSPACE_MEMORY_KEYS.join(", ")}.`,
          },
          value: { type: "string", description: "Memory value" },
          keyType: {
            type: "string",
            enum: ["builtin", "custom"],
            default: "builtin",
          },
          targetWorkspaceFolder: {
            type: "string",
            description: "Optional target workspace folder. Main workspace only.",
          },
        },
        required: ["key", "value"],
      },
      handler: async (args) => {
        const resolvedTarget = resolveTargetWorkspace(
          db,
          context,
          args.targetWorkspaceFolder,
        );
        if (resolvedTarget.ok === false) {
          return textResult(resolvedTarget.message);
        }

        const key = typeof args.key === "string" ? args.key.trim() : "";
        const value = typeof args.value === "string" ? args.value.trim() : "";
        const keyType: WorkspaceMemoryKeyType =
          args.keyType === "custom" ? "custom" : "builtin";

        if (!key) {
          return textResult("Memory key is required.");
        }

        if (!value) {
          return textResult("Memory value is required.");
        }

        const validationError = validateWorkspaceMemoryKey(key, keyType);
        if (validationError) {
          return textResult(validationError);
        }

        upsertWorkspaceMemory(db, {
          workspaceId: resolvedTarget.workspace.id,
          key,
          keyType,
          value,
          source: "tool",
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Saved workspace memory for ${formatWorkspaceLabel(resolvedTarget.workspace)}: ${key} = ${value}`,
            },
          ],
        };
      },
    },
    {
      name: "list_workspace_memory",
      description: "List long-term workspace memory.",
      schema: {
        type: "object",
        properties: {
          targetWorkspaceFolder: {
            type: "string",
            description: "Optional target workspace folder. Main workspace only.",
          },
        },
        required: [],
      },
      handler: async (args) => {
        const resolvedTarget = resolveTargetWorkspace(
          db,
          context,
          args.targetWorkspaceFolder,
        );
        if (resolvedTarget.ok === false) {
          return textResult(resolvedTarget.message);
        }

        const memories = listWorkspaceMemories(db, resolvedTarget.workspace.id);
        return {
          content: [
            {
              type: "text" as const,
              text: formatWorkspaceMemoryList(resolvedTarget.workspace, memories),
            },
          ],
        };
      },
    },
    {
      name: "forget_workspace_memory",
      description: "Delete one long-term workspace memory item.",
      schema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Memory key to delete" },
          targetWorkspaceFolder: {
            type: "string",
            description: "Optional target workspace folder. Main workspace only.",
          },
        },
        required: ["key"],
      },
      handler: async (args) => {
        const resolvedTarget = resolveTargetWorkspace(
          db,
          context,
          args.targetWorkspaceFolder,
        );
        if (resolvedTarget.ok === false) {
          return textResult(resolvedTarget.message);
        }

        const key = typeof args.key === "string" ? args.key.trim() : "";
        if (!key) {
          return textResult("Memory key is required.");
        }

        if (!isSupportedWorkspaceMemoryKey(key)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Invalid memory key: ${key}. Use a builtin key or lowercase letters and underscores for custom keys.`,
              },
            ],
          };
        }

        const deleted = deleteWorkspaceMemory(db, resolvedTarget.workspace.id, key);
        return {
          content: [
            {
              type: "text" as const,
              text: deleted
                ? `Deleted workspace memory "${key}" from ${formatWorkspaceLabel(resolvedTarget.workspace)}.`
                : `Memory key not found for ${formatWorkspaceLabel(resolvedTarget.workspace)}: ${key}`,
            },
          ],
        };
      },
    },
    {
      name: "clear_workspace_memory",
      description: "Clear all long-term memory for a workspace.",
      schema: {
        type: "object",
        properties: {
          targetWorkspaceFolder: {
            type: "string",
            description: "Optional target workspace folder. Main workspace only.",
          },
        },
        required: [],
      },
      handler: async (args) => {
        const resolvedTarget = resolveTargetWorkspace(
          db,
          context,
          args.targetWorkspaceFolder,
        );
        if (resolvedTarget.ok === false) {
          return textResult(resolvedTarget.message);
        }

        const clearedCount = clearWorkspaceMemories(db, resolvedTarget.workspace.id);
        return {
          content: [
            {
              type: "text" as const,
              text:
                clearedCount > 0
                  ? `Cleared ${clearedCount} workspace memory item(s) for ${formatWorkspaceLabel(resolvedTarget.workspace)}.`
                  : `No workspace memory to clear for ${formatWorkspaceLabel(resolvedTarget.workspace)}.`,
            },
          ],
        };
      },
    },
    {
      name: "list_curated_skills",
      description: "List available curated skills that can be installed into this workspace",
      schema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        const curatedDir = join(root, "skills", "curated");
        if (!existsSync(curatedDir)) {
          return textResult("No curated skills available");
        }

        const skills: Array<{ name: string; description: string; installed: boolean }> = [];
        for (const name of readdirSync(curatedDir)) {
          const skillDir = join(curatedDir, name);
          const skillMd = join(skillDir, "SKILL.md");
          if (!existsSync(skillMd)) {
            continue;
          }

          const content = readFileSync(skillMd, "utf-8");
          let description = "";
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch?.[1]) {
            const descMatch = fmMatch[1].match(/description:\s*(.+)/);
            if (descMatch?.[1]) {
              description = descMatch[1].trim();
            }
          }

          const installed = existsSync(
            join(
              getWorkspaceDirectory(context.workspaceFolder, { rootDir: root }),
              ".pi",
              "skills",
              name,
              "SKILL.md",
            ),
          );
          skills.push({ name, description, installed });
        }

        return textResult(JSON.stringify(skills, null, 2));
      },
    },
    {
      name: "install_curated_skill",
      description: "Install a curated skill into this workspace",
      schema: {
        type: "object",
        properties: {
          skillName: { type: "string", description: "Name of the curated skill to install" },
        },
        required: ["skillName"],
      },
      handler: async (args) => {
        const src = join(root, "skills", "curated", args.skillName as string);
        if (!existsSync(src) || !existsSync(join(src, "SKILL.md"))) {
          return textResult(`Skill not found: ${args.skillName}`);
        }

        const dest = join(
          getWorkspaceDirectory(context.workspaceFolder, { rootDir: root }),
          ".pi",
          "skills",
          args.skillName as string,
        );
        if (existsSync(join(dest, "SKILL.md"))) {
          return textResult(`Skill already installed: ${args.skillName}`);
        }

        copyDirRecursive(src, dest);
        return textResult(`Skill installed: ${args.skillName}`);
      },
    },
  ];

  const mainOnlyTools: ToolDefinition[] = context.isMain
    ? [
        {
          name: "list_workspaces",
          description: "List all workspaces",
          schema: { type: "object", properties: {}, required: [] },
          handler: async () => {
            return textResult(JSON.stringify(listWorkspaces(db), null, 2));
          },
        },
        {
          name: "refresh_chats",
          description: "Refresh chat metadata from all channels",
          schema: { type: "object", properties: {}, required: [] },
          handler: async () => {
            const result = await sender.refreshChatMetadata();
            return textResult(`Refreshed: ${result.count} chats found`);
          },
        },
        {
          name: "schedule_workspace_task",
          description: "Create a scheduled task for another workspace",
          schema: {
            type: "object",
            properties: {
              targetWorkspaceFolder: { type: "string", description: "Target workspace folder name" },
              prompt: { type: "string", description: "Task prompt" },
              scheduleType: { type: "string", enum: ["cron"] },
              scheduleValue: { type: "string", description: "Cron expression" },
              contextMode: { type: "string", enum: ["workspace", "isolated"], default: "isolated" },
            },
            required: ["targetWorkspaceFolder", "prompt", "scheduleType", "scheduleValue"],
          },
          handler: async (args) => {
            const resolvedTarget = resolveTargetWorkspace(
              db,
              context,
              args.targetWorkspaceFolder,
            );
            if (resolvedTarget.ok === false) {
              return textResult(resolvedTarget.message);
            }

            let nextRun: string | null = null;
            try {
              nextRun = computeNextRun(args.scheduleValue as string);
            } catch {
              return textResult(`Invalid cron expression: ${args.scheduleValue}`);
            }

            const id = createTask(db, {
              workspaceId: resolvedTarget.workspace.id,
              chatId: resolvedTarget.chatId,
              prompt: args.prompt as string,
              scheduleType: args.scheduleType as string,
              scheduleValue: args.scheduleValue as string,
              contextMode: (args.contextMode as string) ?? "isolated",
              nextRun: nextRun ?? undefined,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Task created for ${resolvedTarget.workspace.folder}: ${id}, next run: ${nextRun}`,
                },
              ],
            };
          },
        },
        {
          name: "list_profiles",
          description: "List all configured agent profiles with model and upstream details",
          schema: { type: "object", properties: {}, required: [] },
          handler: async () => {
            const config = loadAgentProfilesConfig();
            const profiles = listAgentProfiles();
            return {
              content: [
                {
                  type: "text" as const,
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
          description: "Switch the agent profile for a workspace. Use list_profiles to see available profile keys.",
          schema: {
            type: "object",
            properties: {
              targetWorkspaceFolder: { type: "string", description: "Target workspace folder name" },
              profileKey: { type: "string", description: "Profile key" },
            },
            required: ["targetWorkspaceFolder", "profileKey"],
          },
          handler: async (args) => {
            const folder = args.targetWorkspaceFolder as string;
            const profileKey = args.profileKey as string;
            const targetWorkspace = getWorkspaceByFolder(db, folder);
            if (!targetWorkspace) {
              return textResult(`Workspace not found: ${folder}`);
            }

            const config = loadAgentProfilesConfig();
            if (!config.profiles[profileKey]) {
              const available = Object.keys(config.profiles).sort().join(", ");
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Unknown profile: ${profileKey}. Available profiles: ${available}`,
                  },
                ],
              };
            }

            updateWorkspace(db, targetWorkspace.id, { profileKey });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Workspace "${targetWorkspace.name}" (${folder}) switched to profile: ${profileKey}`,
                },
              ],
            };
          },
        },
        {
          name: "clear_session",
          description: "Clear only the AI session for a target workspace.",
          schema: {
            type: "object",
            properties: {
              targetWorkspaceFolder: { type: "string", description: "Target workspace folder name" },
            },
            required: ["targetWorkspaceFolder"],
          },
          handler: async (args) =>
            handleClearSessionTool(
              db,
              sender,
              args.targetWorkspaceFolder as string,
              "clear_session",
            ),
        },
      ]
    : [];

  const allTools = [...commonTools, ...mainOnlyTools];
  log.info(TAG, `Tool definitions created for workspace ${context.workspaceFolder}: ${allTools.length} tools`);
  return allTools;
}

export function getToolNames(tools: ToolDefinition[], mcpServerName: string): string[] {
  return tools.map((tool) => `mcp__${mcpServerName}__${tool.name}`);
}
