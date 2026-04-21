import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { copyDirRecursive } from "./utils";

const MAIN_TEMPLATE = "groups/MAIN_AGENTS.md";
const GROUP_TEMPLATE = "groups/GROUP_AGENTS.md";
const SYSTEM_SKILLS_DIR = "skills/system";

export interface SetupGroupWorkspaceOptions {
  rootDir?: string;
  initGit?: boolean;
}

function resolveFromRoot(rootDir: string, ...parts: string[]): string {
  return resolve(rootDir, ...parts);
}

export function getWorkspaceDirectory(
  folder: string,
  options: SetupGroupWorkspaceOptions = {},
): string {
  const rootDir = options.rootDir ?? process.cwd();
  const workspaceDir = resolveFromRoot(rootDir, "workspaces", folder);
  if (existsSync(workspaceDir)) {
    return workspaceDir;
  }

  const legacyDir = resolveFromRoot(rootDir, "groups", folder);
  return existsSync(legacyDir) ? legacyDir : workspaceDir;
}

export function getLegacyGroupDirectory(
  folder: string,
  options: SetupGroupWorkspaceOptions = {},
): string {
  const rootDir = options.rootDir ?? process.cwd();
  return resolveFromRoot(rootDir, "groups", folder);
}

export function migrateLegacyGroupWorkspace(
  folder: string,
  options: SetupGroupWorkspaceOptions = {},
): void {
  const rootDir = options.rootDir ?? process.cwd();
  const workspaceDir = getWorkspaceDirectory(folder, { rootDir });
  const legacyDir = getLegacyGroupDirectory(folder, { rootDir });

  if (!existsSync(workspaceDir) && existsSync(legacyDir)) {
    mkdirSync(resolveFromRoot(rootDir, "workspaces"), { recursive: true });
    renameSync(legacyDir, workspaceDir);
  }

  const legacyAgentsPath = resolveFromRoot(rootDir, "workspaces", folder, "CLAUDE.md");
  const agentsPath = resolveFromRoot(rootDir, "workspaces", folder, "AGENTS.md");
  if (!existsSync(agentsPath) && existsSync(legacyAgentsPath)) {
    copyFileSync(legacyAgentsPath, agentsPath);
  }

  const legacySkillsDir = resolveFromRoot(rootDir, "workspaces", folder, ".claude", "skills");
  const piSkillsDir = resolveFromRoot(rootDir, "workspaces", folder, ".pi", "skills");
  if (!existsSync(piSkillsDir) && existsSync(legacySkillsDir)) {
    copyDirRecursive(legacySkillsDir, piSkillsDir);
  }
}

function ensureWorkspacePiDirectories(
  folder: string,
  options: SetupGroupWorkspaceOptions = {},
): void {
  const workspaceDir = getWorkspaceDirectory(folder, options);
  mkdirSync(resolve(workspaceDir, ".pi", "skills"), { recursive: true });
  mkdirSync(resolve(workspaceDir, ".pi", "sessions"), { recursive: true });
}

function ensureLegacyGroupLink(
  folder: string,
  options: SetupGroupWorkspaceOptions = {},
): void {
  const rootDir = options.rootDir ?? process.cwd();
  const legacyDir = resolveFromRoot(rootDir, "groups", folder);
  const workspaceDir = resolveFromRoot(rootDir, "workspaces", folder);

  if (existsSync(legacyDir)) {
    return;
  }

  mkdirSync(resolveFromRoot(rootDir, "groups"), { recursive: true });
  try {
    symlinkSync(workspaceDir, legacyDir, "dir");
  } catch {
    // Ignore environments that do not allow symlink creation.
  }
}

export function ensureAgentsMd(
  folder: string,
  isMain: boolean,
  options: SetupGroupWorkspaceOptions = {},
): void {
  const rootDir = options.rootDir ?? process.cwd();
  const target = resolveFromRoot(rootDir, "workspaces", folder, "AGENTS.md");
  if (existsSync(target)) {
    return;
  }

  const template = resolveFromRoot(rootDir, isMain ? MAIN_TEMPLATE : GROUP_TEMPLATE);
  if (!existsSync(template)) {
    return;
  }

  copyFileSync(template, target);
}

export function syncSystemSkills(
  folder: string,
  options: SetupGroupWorkspaceOptions = {},
): void {
  const rootDir = options.rootDir ?? process.cwd();
  const systemSkillsDir = resolveFromRoot(rootDir, SYSTEM_SKILLS_DIR);
  if (!existsSync(systemSkillsDir)) {
    return;
  }

  const targetSkillsDir = resolveFromRoot(rootDir, "workspaces", folder, ".pi", "skills");
  mkdirSync(targetSkillsDir, { recursive: true });

  for (const skillName of readdirSync(systemSkillsDir)) {
    const src = join(systemSkillsDir, skillName);
    if (!statSync(src).isDirectory()) {
      continue;
    }

    const dest = join(targetSkillsDir, skillName);
    copyDirRecursive(src, dest);
  }
}

function runGit(
  args: string[],
  cwd: string,
): void {
  const result = spawnSync("git", args, {
    cwd,
    stdio: "ignore",
  });

  if (result.status === 0) {
    return;
  }

  const errorText = result.error?.message?.trim();
  throw new Error(errorText || `git ${args.join(" ")} failed with code ${result.status ?? "unknown"}`);
}

function hasGitHead(cwd: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd,
    stdio: "ignore",
  });
  return result.status === 0;
}

function ensureWorkspaceInitialCommit(cwd: string): void {
  if (hasGitHead(cwd)) {
    return;
  }

  runGit([
    "-c",
    "user.name=Octo",
    "-c",
    "user.email=octo@local",
    "commit",
    "--allow-empty",
    "-m",
    "Initialize workspace",
  ], cwd);
}

export function ensureWorkspaceGitRepo(
  folder: string,
  options: SetupGroupWorkspaceOptions = {},
): void {
  const workspaceDir = getWorkspaceDirectory(folder, options);
  if (!existsSync(resolve(workspaceDir, ".git"))) {
    try {
      runGit(["init", "-b", "main"], workspaceDir);
    } catch {
      runGit(["init"], workspaceDir);
      runGit(["symbolic-ref", "HEAD", "refs/heads/main"], workspaceDir);
    }
  }

  ensureWorkspaceInitialCommit(workspaceDir);
}

export function setupWorkspaceDirectory(
  folder: string,
  isMain: boolean,
  options: SetupGroupWorkspaceOptions = {},
): void {
  const rootDir = options.rootDir ?? process.cwd();
  mkdirSync(resolveFromRoot(rootDir, "workspaces", folder), { recursive: true });
  ensureWorkspacePiDirectories(folder, { rootDir });
  ensureAgentsMd(folder, isMain, { rootDir });
  syncSystemSkills(folder, { rootDir });
  ensureLegacyGroupLink(folder, { rootDir });

  if (options.initGit !== false) {
    ensureWorkspaceGitRepo(folder, { rootDir });
  }
}

export function setupGroupWorkspace(
  folder: string,
  isMain: boolean,
  options: SetupGroupWorkspaceOptions = {},
): void {
  setupWorkspaceDirectory(folder, isMain, options);
}
