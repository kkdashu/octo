import type { Database } from "bun:sqlite";
import { getChatById, type ChatRow, type RunRow, type WorkspaceRow } from "../db";
import {
  appendRunEvent,
  createRun,
  getRunById,
  updateChat,
  updateRun,
  updateTurnRequest,
  upsertWorkspaceRuntimeState,
} from "../db";
import { getWorkspaceDirectory } from "../group-workspace";
import { calculateWorkspaceUnloadAfter } from "../workspace-runtime-state";
import { checkoutWorkspaceBranch, getCurrentWorkspaceBranch } from "../workspace-git";

export function ensureWorkspaceOnChatBranch(
  workspace: WorkspaceRow,
  chat: Pick<ChatRow, "active_branch">,
  options: { rootDir?: string } = {},
): void {
  const workspaceDir = getWorkspaceDirectory(workspace.folder, {
    rootDir: options.rootDir,
  });
  const currentBranch = getCurrentWorkspaceBranch(workspaceDir);
  if (currentBranch !== chat.active_branch) {
    checkoutWorkspaceBranch(workspaceDir, chat.active_branch);
  }
}

export function persistChatSessionRef(
  db: Database,
  chatId: string,
  sessionRef: string | null,
  updatedAt = new Date().toISOString(),
): ChatRow | null {
  updateChat(db, chatId, {
    sessionRef,
    lastActivityAt: updatedAt,
  });

  return getChatById(db, chatId);
}

export function startPersistedRun(
  db: Database,
  options: {
    workspace: WorkspaceRow;
    chat: ChatRow;
    triggerSource: string;
    turnRequestId?: string | null;
    startedAt?: string;
  },
): RunRow {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const run = createRun(db, {
    turnRequestId: options.turnRequestId ?? null,
    workspaceId: options.workspace.id,
    chatId: options.chat.id,
    status: "running",
    branch: options.chat.active_branch,
    triggerSource: options.triggerSource,
    startedAt,
  });

  upsertWorkspaceRuntimeState(db, {
    workspaceId: options.workspace.id,
    checkedOutBranch: options.chat.active_branch,
    activeRunId: run.id,
    status: "running",
    lastActivityAt: startedAt,
    unloadAfter: null,
  });

  appendRunEvent(db, {
    runId: run.id,
    chatId: options.chat.id,
    eventType: "run_started",
    payload: JSON.stringify({
      triggerSource: options.triggerSource,
      branch: options.chat.active_branch,
    }),
    createdAt: startedAt,
  });

  return run;
}

export function finishPersistedRun(
  db: Database,
  options: {
    workspace: WorkspaceRow;
    chat: ChatRow;
    runId: string;
    status: "completed" | "failed" | "cancelled";
    error?: string | null;
    completedAt?: string;
  },
): void {
  const completedAt = options.completedAt ?? new Date().toISOString();
  const run = getRunById(db, options.runId);
  if (!run) {
    throw new Error(`Run not found: ${options.runId}`);
  }

  if (run.turn_request_id) {
    updateTurnRequest(db, run.turn_request_id, {
      status: options.status,
      completedAt,
      error: options.error ?? null,
    });
  }

  updateRun(db, options.runId, {
    status: options.status,
    endedAt: completedAt,
    error: options.error ?? null,
  });

  appendRunEvent(db, {
    runId: options.runId,
    chatId: options.chat.id,
    eventType: `run_${options.status}`,
    payload: JSON.stringify({
      error: options.error ?? null,
    }),
    createdAt: completedAt,
  });

  upsertWorkspaceRuntimeState(db, {
    workspaceId: options.workspace.id,
    checkedOutBranch: options.chat.active_branch,
    activeRunId: null,
    status: options.status === "failed" ? "error" : "idle",
    lastActivityAt: completedAt,
    unloadAfter: calculateWorkspaceUnloadAfter(new Date(completedAt)),
    lastError: options.status === "failed" ? options.error ?? null : null,
  });
}

export function appendPersistedRuntimeEvent(
  db: Database,
  options: {
    runId: string | null;
    chatId: string;
    eventType: string;
    payload: unknown;
    createdAt?: string;
  },
): void {
  if (!options.runId) {
    return;
  }

  appendRunEvent(db, {
    runId: options.runId,
    chatId: options.chatId,
    eventType: options.eventType,
    payload: JSON.stringify(options.payload),
    createdAt: options.createdAt,
  });
}
