import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTurnRequest,
  getChatById,
  getWorkspaceRuntimeState,
  initDatabase,
} from "../src/db";
import {
  ensureWorkspaceOnChatBranch,
  finishPersistedRun,
  persistChatSessionRef,
  startPersistedRun,
} from "../src/runtime/run-lifecycle";
import {
  createWorkspaceBranch,
  getCurrentWorkspaceBranch,
} from "../src/workspace-git";
import { WorkspaceService } from "../src/workspace-service";

describe("run lifecycle helpers", () => {
  test("starts and finishes persisted runs while updating workspace runtime state", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-run-lifecycle-"));

    try {
      mkdirSync(join(rootDir, "store"), { recursive: true });
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const workspace = workspaceService.createWorkspace({
        name: "Main",
        folder: "main",
        profileKey: "claude",
        isMain: true,
      });
      const chat = workspaceService.createChat(workspace.id, {
        title: "Main",
        requiresTrigger: false,
      });
      const turnRequest = createTurnRequest(db, {
        workspaceId: workspace.id,
        chatId: chat.id,
        sourceType: "desktop",
        requestText: "hello",
      });

      const run = startPersistedRun(db, {
        workspace,
        chat,
        turnRequestId: turnRequest.id,
        triggerSource: "desktop",
        startedAt: "2026-04-22T00:00:00.000Z",
      });
      const runningState = getWorkspaceRuntimeState(db, workspace.id);
      expect(runningState).toMatchObject({
        active_run_id: run.id,
        status: "running",
        checked_out_branch: chat.active_branch,
      });

      finishPersistedRun(db, {
        workspace,
        chat,
        runId: run.id,
        status: "completed",
        completedAt: "2026-04-22T00:05:00.000Z",
      });

      const completedTurnRequest = db
        .query("SELECT status FROM turn_requests WHERE id = $id")
        .get({ id: turnRequest.id }) as { status: string } | null;
      const completedRun = db
        .query("SELECT status, ended_at FROM runs WHERE id = $id")
        .get({ id: run.id }) as { status: string; ended_at: string | null } | null;
      const completedState = getWorkspaceRuntimeState(db, workspace.id);

      expect(completedTurnRequest).toEqual({ status: "completed" });
      expect(completedRun).toEqual({
        status: "completed",
        ended_at: "2026-04-22T00:05:00.000Z",
      });
      expect(completedState).toMatchObject({
        active_run_id: null,
        status: "idle",
        checked_out_branch: chat.active_branch,
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("persists chat session refs and aligns the workspace branch", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-run-lifecycle-"));

    try {
      mkdirSync(join(rootDir, "store"), { recursive: true });
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const workspace = workspaceService.createWorkspace({
        name: "Main",
        folder: "main",
        profileKey: "claude",
        isMain: true,
      });
      const chat = workspaceService.createChat(workspace.id, {
        title: "Main",
        requiresTrigger: false,
      });
      const workspaceDir = join(rootDir, "workspaces", workspace.folder);
      createWorkspaceBranch(workspaceDir, "feature", "main");

      ensureWorkspaceOnChatBranch(
        workspace,
        { ...chat, active_branch: "feature" },
        { rootDir },
      );
      const updatedChat = persistChatSessionRef(
        db,
        chat.id,
        "fresh-session.jsonl",
        "2026-04-22T00:10:00.000Z",
      );

      expect(getCurrentWorkspaceBranch(workspaceDir)).toBe("feature");
      expect(updatedChat).toMatchObject({
        session_ref: "fresh-session.jsonl",
        last_activity_at: "2026-04-22T00:10:00.000Z",
      });
      expect(getChatById(db, chat.id)?.session_ref).toBe("fresh-session.jsonl");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("marks failed and cancelled runs with the expected workspace runtime state", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-run-lifecycle-"));

    try {
      mkdirSync(join(rootDir, "store"), { recursive: true });
      const db = initDatabase(join(rootDir, "store", "messages.db"));
      const workspaceService = new WorkspaceService(db, { rootDir });
      const workspace = workspaceService.createWorkspace({
        name: "Main",
        folder: "main",
        profileKey: "claude",
        isMain: true,
      });
      const chat = workspaceService.createChat(workspace.id, {
        title: "Main",
        requiresTrigger: false,
      });

      const failedTurnRequest = createTurnRequest(db, {
        workspaceId: workspace.id,
        chatId: chat.id,
        sourceType: "desktop",
        requestText: "fail me",
      });
      const failedRun = startPersistedRun(db, {
        workspace,
        chat,
        turnRequestId: failedTurnRequest.id,
        triggerSource: "desktop",
        startedAt: "2026-04-22T00:00:00.000Z",
      });

      finishPersistedRun(db, {
        workspace,
        chat,
        runId: failedRun.id,
        status: "failed",
        error: "401 invalid api key",
        completedAt: "2026-04-22T00:01:00.000Z",
      });

      expect(
        db.query("SELECT status, error FROM turn_requests WHERE id = $id").get({
          id: failedTurnRequest.id,
        }),
      ).toEqual({
        status: "failed",
        error: "401 invalid api key",
      });
      expect(
        db.query("SELECT status, error FROM runs WHERE id = $id").get({
          id: failedRun.id,
        }),
      ).toEqual({
        status: "failed",
        error: "401 invalid api key",
      });
      expect(getWorkspaceRuntimeState(db, workspace.id)).toMatchObject({
        active_run_id: null,
        status: "error",
        last_error: "401 invalid api key",
        checked_out_branch: chat.active_branch,
      });

      const cancelledTurnRequest = createTurnRequest(db, {
        workspaceId: workspace.id,
        chatId: chat.id,
        sourceType: "desktop",
        requestText: "cancel me",
      });
      const cancelledRun = startPersistedRun(db, {
        workspace,
        chat,
        turnRequestId: cancelledTurnRequest.id,
        triggerSource: "desktop",
        startedAt: "2026-04-22T00:02:00.000Z",
      });

      finishPersistedRun(db, {
        workspace,
        chat,
        runId: cancelledRun.id,
        status: "cancelled",
        completedAt: "2026-04-22T00:03:00.000Z",
      });

      expect(
        db.query("SELECT status, error FROM turn_requests WHERE id = $id").get({
          id: cancelledTurnRequest.id,
        }),
      ).toEqual({
        status: "cancelled",
        error: null,
      });
      expect(
        db.query("SELECT status, error FROM runs WHERE id = $id").get({
          id: cancelledRun.id,
        }),
      ).toEqual({
        status: "cancelled",
        error: null,
      });
      expect(getWorkspaceRuntimeState(db, workspace.id)).toMatchObject({
        active_run_id: null,
        status: "idle",
        last_error: null,
        checked_out_branch: chat.active_branch,
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
