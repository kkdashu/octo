import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type MessageRole = "user" | "assistant" | "system";

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

export function initDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");

  db.run(`
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      channel_type TEXT NOT NULL DEFAULT 'feishu',
      trigger_pattern TEXT NOT NULL DEFAULT '',
      added_at TEXT NOT NULL,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      mentions_me INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    )
  `);

  // Migrations: add columns that may not exist in older databases
  try {
    db.run("ALTER TABLE messages ADD COLUMN mentions_me INTEGER DEFAULT 0");
  } catch {
    // Column already exists, ignore
  }
  try {
    db.run("ALTER TABLE messages ADD COLUMN role TEXT DEFAULT 'user'");
  } catch {
    // Column already exists, ignore
  }
  db.run(`
    UPDATE messages
    SET role = CASE
      WHEN COALESCE(is_bot_message, 0) = 1 OR COALESCE(is_from_me, 0) = 1 THEN 'assistant'
      ELSE 'user'
    END
    WHERE role IS NULL
       OR TRIM(role) = ''
       OR (
         role = 'user'
         AND (COALESCE(is_bot_message, 0) = 1 OR COALESCE(is_from_me, 0) = 1)
       )
  `);
  try {
    db.run("ALTER TABLE registered_groups ADD COLUMN agent_provider TEXT DEFAULT 'claude'");
  } catch {
    // Column already exists, ignore
  }

  return db;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface RegisteredGroup {
  jid: string;
  name: string;
  folder: string;
  channel_type: string;
  trigger_pattern: string;
  added_at: string;
  requires_trigger: number;
  is_main: number;
  agent_provider: string;
}

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  role: MessageRole;
  is_from_me: number;
  is_bot_message: number;
  mentions_me: number;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function insertMessage(
  db: Database,
  msg: {
    id: string;
    chatId: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
    role?: MessageRole;
    isFromMe: boolean;
    isBotMessage?: boolean;
    mentionsMe?: boolean;
  },
) {
  const role = msg.role ?? ((msg.isBotMessage || msg.isFromMe) ? "assistant" : "user");
  db.query(
    `INSERT OR IGNORE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, role, is_from_me, is_bot_message, mentions_me)
     VALUES ($id, $chatJid, $sender, $senderName, $content, $timestamp, $role, $isFromMe, $isBotMessage, $mentionsMe)`,
  ).run({
    id: msg.id,
    chatJid: msg.chatId,
    sender: msg.sender,
    senderName: msg.senderName,
    content: msg.content,
    timestamp: msg.timestamp,
    role,
    isFromMe: msg.isFromMe ? 1 : 0,
    isBotMessage: msg.isBotMessage ? 1 : 0,
    mentionsMe: msg.mentionsMe ? 1 : 0,
  });
}

export function insertMessages(
  db: Database,
  msgs: Array<{
    id: string;
    chatId: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
    role?: MessageRole;
    isFromMe: boolean;
  }>,
) {
  const tx = db.transaction(() => {
    for (const msg of msgs) {
      insertMessage(db, msg);
    }
  });
  tx();
}

export function getUnprocessedMessages(
  db: Database,
  chatJid: string,
  since: string,
): MessageRow[] {
  return db
    .query(
      `SELECT * FROM messages
       WHERE chat_jid = $chatJid AND timestamp > $since AND role = 'user'
       ORDER BY timestamp ASC`,
    )
    .all({ chatJid, since }) as MessageRow[];
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function getGroupByJid(
  db: Database,
  jid: string,
): RegisteredGroup | null {
  return (
    (db
      .query("SELECT * FROM registered_groups WHERE jid = $jid")
      .get({ jid }) as RegisteredGroup | null) ?? null
  );
}

export function getGroupByFolder(
  db: Database,
  folder: string,
): RegisteredGroup | null {
  return (
    (db
      .query("SELECT * FROM registered_groups WHERE folder = $folder")
      .get({ folder }) as RegisteredGroup | null) ?? null
  );
}

export function listGroups(db: Database): RegisteredGroup[] {
  return db
    .query("SELECT * FROM registered_groups")
    .all() as RegisteredGroup[];
}

export function registerGroup(
  db: Database,
  group: {
    jid: string;
    name: string;
    folder: string;
    channelType?: string;
    triggerPattern?: string;
    requiresTrigger?: boolean;
    isMain?: boolean;
    agentProvider?: string;
  },
) {
  db.query(
    `INSERT INTO registered_groups (jid, name, folder, channel_type, trigger_pattern, added_at, requires_trigger, is_main, agent_provider)
     VALUES ($jid, $name, $folder, $channelType, $triggerPattern, $addedAt, $requiresTrigger, $isMain, $agentProvider)
     ON CONFLICT(jid) DO UPDATE SET
       name = $name,
       folder = $folder,
       channel_type = $channelType,
       trigger_pattern = $triggerPattern,
       requires_trigger = $requiresTrigger,
       is_main = $isMain`,
  ).run({
    jid: group.jid,
    name: group.name,
    folder: group.folder,
    channelType: group.channelType ?? "feishu",
    triggerPattern: group.triggerPattern ?? "",
    addedAt: new Date().toISOString(),
    requiresTrigger: group.requiresTrigger === false ? 0 : 1,
    isMain: group.isMain ? 1 : 0,
    agentProvider: group.agentProvider ?? "claude",
  });
}

export function updateGroupProvider(
  db: Database,
  folder: string,
  provider: string,
) {
  db.query(
    "UPDATE registered_groups SET agent_provider = $provider WHERE folder = $folder",
  ).run({ folder, provider });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function getSessionId(
  db: Database,
  folder: string,
): string | null {
  const row = db
    .query("SELECT session_id FROM sessions WHERE group_folder = $groupFolder")
    .get({ groupFolder: folder }) as { session_id: string } | null;
  return row?.session_id ?? null;
}

export function saveSessionId(
  db: Database,
  folder: string,
  sessionId: string,
) {
  db.query(
    `INSERT INTO sessions (group_folder, session_id) VALUES ($groupFolder, $sessionId)
     ON CONFLICT(group_folder) DO UPDATE SET session_id = $sessionId`,
  ).run({ groupFolder: folder, sessionId });
}

export function deleteSessionId(
  db: Database,
  folder: string,
) {
  db.query(
    "DELETE FROM sessions WHERE group_folder = $groupFolder",
  ).run({ groupFolder: folder });
}

// ---------------------------------------------------------------------------
// Router state (cursor management)
// ---------------------------------------------------------------------------

export function getRouterState(
  db: Database,
  key: string,
): string | null {
  const row = db
    .query("SELECT value FROM router_state WHERE key = $key")
    .get({ key }) as { value: string } | null;
  return row?.value ?? null;
}

export function setRouterState(
  db: Database,
  key: string,
  value: string,
) {
  db.query(
    `INSERT INTO router_state (key, value) VALUES ($key, $value)
     ON CONFLICT(key) DO UPDATE SET value = $value`,
  ).run({ key, value });
}

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

export function createTask(
  db: Database,
  task: {
    groupFolder: string;
    chatJid: string;
    prompt: string;
    scheduleType: string;
    scheduleValue: string;
    contextMode?: string;
    nextRun?: string;
  },
) {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, created_at)
     VALUES ($id, $groupFolder, $chatJid, $prompt, $scheduleType, $scheduleValue, $contextMode, $nextRun, $createdAt)`,
  ).run({
    id,
    groupFolder: task.groupFolder,
    chatJid: task.chatJid,
    prompt: task.prompt,
    scheduleType: task.scheduleType,
    scheduleValue: task.scheduleValue,
    contextMode: task.contextMode ?? "isolated",
    nextRun: task.nextRun ?? null,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export function listTasks(
  db: Database,
  groupFolder: string,
): ScheduledTask[] {
  return db
    .query(
      "SELECT * FROM scheduled_tasks WHERE group_folder = $groupFolder AND status != 'cancelled'",
    )
    .all({ groupFolder }) as ScheduledTask[];
}

export function updateTaskStatus(
  db: Database,
  taskId: string,
  groupFolder: string,
  status: string,
) {
  db.query(
    `UPDATE scheduled_tasks SET status = $status
     WHERE id = $taskId AND group_folder = $groupFolder`,
  ).run({ taskId, groupFolder, status });
}

export function getDueTasks(db: Database, now: string): ScheduledTask[] {
  return db
    .query(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= $now`,
    )
    .all({ now }) as ScheduledTask[];
}

export function updateTaskAfterRun(
  db: Database,
  taskId: string,
  nextRun: string | null,
  lastResult?: string,
) {
  db.query(
    `UPDATE scheduled_tasks
     SET next_run = $nextRun, last_run = $lastRun, last_result = $lastResult
     WHERE id = $taskId`,
  ).run({
    taskId,
    nextRun,
    lastRun: new Date().toISOString(),
    lastResult: lastResult ?? null,
  });
}
