import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  getGroupByFolder,
  listGroups,
  registerGroup,
  createTask,
  listTasks,
  updateTaskStatus,
  updateGroupProvider,
} from "./db";
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
      description: "Send a text message to a chat group",
      schema: {
        type: "object",
        properties: {
          chatJid: { type: "string", description: "Target chat ID" },
          text: { type: "string", description: "Message content" },
        },
        required: ["chatJid", "text"],
      },
      handler: async (args) => {
        log.info(TAG, `[send_message] called by group ${groupFolder}`, {
          chatJid: args.chatJid,
          textLength: (args.text as string).length,
          textPreview: (args.text as string).substring(0, 100),
        });
        if (!isMain) {
          const group = getGroupByFolder(db, groupFolder);
          if (group && args.chatJid !== group.jid) {
            log.warn(TAG, `[send_message] Permission denied: ${groupFolder} tried to send to ${args.chatJid}`);
            return { content: [{ type: "text", text: "Permission denied: cannot send to other groups" }] };
          }
        }
        await sender.send(args.chatJid as string, args.text as string);
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
          chatJid: { type: "string", description: "Target chat ID" },
          filePath: { type: "string", description: "Image file path, relative to current group working directory" },
        },
        required: ["chatJid", "filePath"],
      },
      handler: async (args) => {
        log.info(TAG, `[send_image] called by group ${groupFolder}`, {
          chatJid: args.chatJid,
          filePath: args.filePath,
        });
        if (!isMain) {
          const group = getGroupByFolder(db, groupFolder);
          if (group && args.chatJid !== group.jid) {
            log.warn(TAG, `[send_image] Permission denied: ${groupFolder} tried to send image to ${args.chatJid}`);
            return { content: [{ type: "text", text: "Permission denied: cannot send to other groups" }] };
          }
        }

        const groupWorkdir = resolve(root, "groups", groupFolder);
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

        await sender.sendImage(args.chatJid as string, absoluteFilePath);
        log.info(TAG, `[send_image] Image sent successfully`, { chatJid: args.chatJid, filePath: absoluteFilePath });
        return { content: [{ type: "text", text: "Image sent" }] };
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
            join(root, "groups", groupFolder, ".claude", "skills", name, "SKILL.md"),
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
        const dest = join(root, "groups", groupFolder, ".claude", "skills", args.skillName as string);
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
            registerGroup(db, args as { jid: string; name: string; folder: string; triggerPattern: string });
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
          name: "switch_provider",
          description: "Switch the AI agent provider for a group. Available providers: claude, codex",
          schema: {
            type: "object",
            properties: {
              targetGroupFolder: { type: "string", description: "Target group folder name" },
              provider: { type: "string", description: "Provider name (e.g. claude, codex)" },
            },
            required: ["targetGroupFolder", "provider"],
          },
          handler: async (args) => {
            const folder = args.targetGroupFolder as string;
            const provider = args.provider as string;
            log.info(TAG, `[switch_provider] called by main group`, { folder, provider });
            const target = getGroupByFolder(db, folder);
            if (!target) {
              return { content: [{ type: "text", text: `Group not found: ${folder}` }] };
            }
            updateGroupProvider(db, folder, provider);
            log.info(TAG, `[switch_provider] Switched ${folder} to provider: ${provider}`);
            return { content: [{ type: "text", text: `Group "${target.name}" (${folder}) switched to provider: ${provider}` }] };
          },
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
