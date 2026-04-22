import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../src/db";
import { resetWorkspaceChatState } from "../scripts/reset-workspace-chat-state";

function countRows(dbPath: string, tableName: string): number {
  const db = initDatabase(dbPath);

  try {
    return Number(
      (
        db.query(`SELECT count(*) as count FROM ${tableName}`).get() as {
          count: number;
        }
      ).count,
    );
  } finally {
    db.close();
  }
}

describe("reset workspace chat state script", () => {
  test("clears workspace directories and local database state", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "octo-reset-workspace-chat-"));
    const dbPath = join(rootDir, "store", "messages.db");

    try {
      mkdirSync(join(rootDir, "workspaces", "demo"), { recursive: true });
      mkdirSync(join(rootDir, "groups"), { recursive: true });
      writeFileSync(join(rootDir, "workspaces", "demo", "note.txt"), "stale");
      writeFileSync(join(rootDir, "workspaces", "stale-file.txt"), "stale");
      symlinkSync(
        join(rootDir, "workspaces", "demo"),
        join(rootDir, "groups", "demo"),
      );

      const db = initDatabase(dbPath);
      db.query(
        `INSERT INTO workspaces (
           id,
           name,
           folder,
           default_branch,
           status,
           profile_key,
           created_at,
           updated_at
         ) VALUES (
           'ws1',
           'Workspace 1',
           'demo',
           'main',
           'active',
           'claude',
           '2026-04-21T00:00:00.000Z',
           '2026-04-21T00:00:00.000Z'
         )`,
      ).run();
      db.query(
        `INSERT INTO workspace_bindings (id, workspace_id, platform, external_id, created_at)
         VALUES ('wb1', 'ws1', 'feishu_app', 'cli_app', '2026-04-21T00:00:00.000Z')`,
      ).run();
      db.query(
        `INSERT INTO chats (
           id,
           workspace_id,
           title,
           active_branch,
           session_ref,
           status,
           trigger_pattern,
           requires_trigger,
           created_at,
           updated_at,
           last_activity_at
         ) VALUES (
           'chat1',
           'ws1',
           'Main',
           'main',
           NULL,
           'active',
           '',
           0,
           '2026-04-21T00:00:00.000Z',
           '2026-04-21T00:00:00.000Z',
           '2026-04-21T00:00:00.000Z'
         )`,
      ).run();
      db.query(
        `INSERT INTO chat_bindings (id, chat_id, platform, external_chat_id, external_thread_id, created_at)
         VALUES ('cb1', 'chat1', 'feishu', 'oc_demo', NULL, '2026-04-21T00:00:00.000Z')`,
      ).run();
      db.query(
        `INSERT INTO workspace_runtime_state (
           workspace_id,
           checked_out_branch,
           active_run_id,
           status,
           last_activity_at,
           unload_after,
           last_error,
           updated_at
         ) VALUES (
           'ws1',
           'main',
           'run1',
           'running',
           '2026-04-21T00:00:00.000Z',
           NULL,
           NULL,
           '2026-04-21T00:00:00.000Z'
         )`,
      ).run();
      db.query(
        `INSERT INTO runs (
           id,
           workspace_id,
           chat_id,
           status,
           branch,
           trigger_source,
           started_at,
           updated_at,
           ended_at,
           cancel_requested_at,
           error
         ) VALUES (
           'run1',
           'ws1',
           'chat1',
           'running',
           'main',
           'router',
           '2026-04-21T00:00:00.000Z',
           '2026-04-21T00:00:00.000Z',
           NULL,
           NULL,
           NULL
         )`,
      ).run();
      db.query(
        `INSERT INTO run_events (id, run_id, chat_id, event_type, payload, created_at)
         VALUES ('re1', 'run1', 'chat1', 'run_started', '{}', '2026-04-21T00:00:00.000Z')`,
      ).run();
      db.query(
        `INSERT INTO workspace_memories (workspace_id, key, key_type, value, source, created_at, updated_at)
         VALUES ('ws1', 'topic', 'builtin', 'demo', 'user', '2026-04-21T00:00:00.000Z', '2026-04-21T00:00:00.000Z')`,
      ).run();
      db.query(
        `INSERT INTO scheduled_tasks (
           id,
           workspace_id,
           chat_id,
           prompt,
           schedule_type,
           schedule_value,
           context_mode,
           next_run,
           last_run,
           last_result,
           status,
           created_at
         ) VALUES (
           'task1',
           'ws1',
           'chat1',
           'hello',
           'cron',
           '* * * * *',
           'isolated',
           NULL,
           NULL,
           NULL,
           'active',
           '2026-04-21T00:00:00.000Z'
         )`,
      ).run();
      db.query(
        `INSERT INTO messages (
           id,
           chat_jid,
           sender,
           sender_name,
           content,
           timestamp,
           is_from_me,
           is_bot_message,
           mentions_me
         ) VALUES (
           'msg1',
           'oc_demo',
           'u1',
           'Alice',
           'hello',
           '2026-04-21T00:00:00.000Z',
           0,
           0,
           0
         )`,
      ).run();
      db.query(
        `INSERT INTO router_state (key, value)
         VALUES ('last_timestamp:oc_demo', '2026-04-21T00:00:00.000Z')`,
      ).run();
      db.close();

      resetWorkspaceChatState({ rootDir, dbPath });

      expect(existsSync(join(rootDir, "workspaces"))).toBe(true);
      expect(readdirSync(join(rootDir, "workspaces"))).toHaveLength(0);
      expect(existsSync(join(rootDir, "groups", "demo"))).toBe(false);
      expect(countRows(dbPath, "workspaces")).toBe(0);
      expect(countRows(dbPath, "workspace_bindings")).toBe(0);
      expect(countRows(dbPath, "chats")).toBe(0);
      expect(countRows(dbPath, "chat_bindings")).toBe(0);
      expect(countRows(dbPath, "workspace_runtime_state")).toBe(0);
      expect(countRows(dbPath, "runs")).toBe(0);
      expect(countRows(dbPath, "run_events")).toBe(0);
      expect(countRows(dbPath, "workspace_memories")).toBe(0);
      expect(countRows(dbPath, "scheduled_tasks")).toBe(0);
      expect(countRows(dbPath, "messages")).toBe(0);
      expect(countRows(dbPath, "router_state")).toBe(0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
