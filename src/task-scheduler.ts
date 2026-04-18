import { CronExpressionParser } from "cron-parser";
import type { Database } from "bun:sqlite";
import type { ChannelManager } from "./channels/manager";
import { getDueTasks, updateTaskAfterRun } from "./db";
import { log } from "./logger";
import type { GroupRuntimeController } from "./runtime/group-runtime-controller";

const TAG = "scheduler";

const TIMEZONE = process.env.TZ ?? "Asia/Shanghai";

export function computeNextRun(cronExpr: string): string | null {
  const expr = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
  return expr.next().toISOString();
}

export function startScheduler(
  db: Database,
  channelManager: ChannelManager,
  groupQueue: GroupRuntimeController,
  intervalMs = 60_000,
): ReturnType<typeof setInterval> {
  log.info(TAG, `Scheduler started (interval: ${intervalMs}ms, tz: ${TIMEZONE})`);

  const timer = setInterval(() => {
    try {
      pollAndExecute(db, channelManager, groupQueue);
    } catch (err) {
      log.error(TAG, "Scheduler poll error", err);
    }
  }, intervalMs);

  // Also run once immediately
  try {
    pollAndExecute(db, channelManager, groupQueue);
  } catch (err) {
    log.error(TAG, "Scheduler initial poll error", err);
  }

  return timer;
}

function pollAndExecute(
  db: Database,
  _channelManager: ChannelManager,
  groupQueue: GroupRuntimeController,
) {
  const now = new Date().toISOString();
  const dueTasks = getDueTasks(db, now);

  if (dueTasks.length === 0) return;

  log.info(TAG, `Found ${dueTasks.length} due task(s)`, dueTasks.map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    scheduleValue: t.schedule_value,
    nextRun: t.next_run,
    contextMode: t.context_mode,
  })));

  for (const task of dueTasks) {
    // Compute next run before executing to avoid re-triggering
    let nextRun: string | null = null;
    try {
      nextRun = computeNextRun(task.schedule_value);
    } catch (err) {
      log.error(TAG, `Invalid cron expression for task ${task.id}: ${task.schedule_value}`, err);
      updateTaskAfterRun(db, task.id, null, `Error: invalid cron expression`);
      continue;
    }

    // Update next_run immediately to prevent duplicate execution
    updateTaskAfterRun(db, task.id, nextRun);

    log.info(TAG, `Executing task ${task.id} for group ${task.group_folder}`, {
      prompt: task.prompt.substring(0, 200),
      contextMode: task.context_mode,
      nextRun,
    });

    // Enqueue the task prompt into the group queue
    const prompt = `[Scheduled Task ${task.id}]\n${task.prompt}`;

    if (task.context_mode === "group" && groupQueue.isActive(task.group_folder)) {
      // Reuse active session
      log.info(TAG, `Pushing scheduled task to active session: ${task.group_folder}`);
      groupQueue.pushMessage(task.group_folder, {
        mode: "follow_up",
        text: prompt,
      });
    } else {
      // Start new agent (or queue behind existing)
      log.info(TAG, `Enqueuing scheduled task as new agent run: ${task.group_folder}`);
      groupQueue.enqueue(task.group_folder, prompt);
    }
  }
}

export const __test__ = {
  pollAndExecute,
};
