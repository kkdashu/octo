import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, resolve, sep } from "node:path";

const TABLES_TO_CLEAR = [
  "run_events",
  "runs",
  "workspace_runtime_state",
  "chat_bindings",
  "chats",
  "workspace_bindings",
  "workspace_memories",
  "workspaces",
  "scheduled_tasks",
  "group_memories",
  "registered_groups",
  "messages",
  "router_state",
] as const;

export interface ResetWorkspaceChatStateOptions {
  rootDir?: string;
  dbPath?: string;
}

function resolveRootDir(rootDir?: string): string {
  return resolve(rootDir ?? process.cwd());
}

function ensurePathWithinRoot(targetPath: string, rootPath: string): void {
  if (targetPath === rootPath) {
    return;
  }

  if (!targetPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Refusing to delete path outside root: ${targetPath}`);
  }
}

export function clearWorkspaceDirectories(rootDir?: string): void {
  const resolvedRootDir = resolveRootDir(rootDir);
  const workspacesRoot = resolve(resolvedRootDir, "workspaces");
  mkdirSync(workspacesRoot, { recursive: true });

  for (const entry of readdirSync(workspacesRoot)) {
    const targetPath = resolve(workspacesRoot, entry);
    ensurePathWithinRoot(targetPath, workspacesRoot);
    rmSync(targetPath, { recursive: true, force: true });
  }
}

function clearDatabaseTables(db: Database): void {
  db.run("BEGIN IMMEDIATE");

  try {
    for (const tableName of TABLES_TO_CLEAR) {
      db.run(`DELETE FROM ${tableName}`);
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

export function resetWorkspaceChatState(
  options: ResetWorkspaceChatStateOptions = {},
): { dbPath: string; workspacesRoot: string } {
  const rootDir = resolveRootDir(options.rootDir);
  const dbPath = resolve(options.dbPath ?? resolve(rootDir, "store", "messages.db"));
  const workspacesRoot = resolve(rootDir, "workspaces");

  clearWorkspaceDirectories(rootDir);

  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { create: false, strict: true });
    try {
      clearDatabaseTables(db);
    } finally {
      db.close();
    }
  }

  return {
    dbPath,
    workspacesRoot,
  };
}

if (import.meta.main) {
  const { dbPath, workspacesRoot } = resetWorkspaceChatState({
    rootDir: resolve(import.meta.dir, ".."),
  });

  console.log(`Reset workspace chat state in ${basename(workspacesRoot)} and ${dbPath}`);
}
