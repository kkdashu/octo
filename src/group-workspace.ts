import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { copyDirRecursive } from "./utils";

const WORKSPACE_TEMPLATE = "groups/WORKSPACE_AGENTS.md";
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
  return resolveFromRoot(rootDir, "workspaces", folder);
}

function ensureWorkspacePiDirectories(
  folder: string,
  options: SetupGroupWorkspaceOptions = {},
): void {
  const workspaceDir = getWorkspaceDirectory(folder, options);
  mkdirSync(resolve(workspaceDir, ".pi", "skills"), { recursive: true });
  mkdirSync(resolve(workspaceDir, ".pi", "sessions"), { recursive: true });
}

export function ensureAgentsMd(
  folder: string,
  options: SetupGroupWorkspaceOptions = {},
): void {
  const rootDir = options.rootDir ?? process.cwd();
  const target = resolveFromRoot(rootDir, "workspaces", folder, "AGENTS.md");
  if (existsSync(target)) {
    return;
  }

  const template = resolveFromRoot(rootDir, WORKSPACE_TEMPLATE);
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
  options: SetupGroupWorkspaceOptions = {},
): void {
  const rootDir = options.rootDir ?? process.cwd();
  mkdirSync(resolveFromRoot(rootDir, "workspaces", folder), { recursive: true });
  ensureWorkspacePiDirectories(folder, { rootDir });
  ensureAgentsMd(folder, { rootDir });
  syncSystemSkills(folder, { rootDir });

  if (options.initGit !== false) {
    ensureWorkspaceGitRepo(folder, { rootDir });
  }
}

export function setupGroupWorkspace(
  folder: string,
  options: SetupGroupWorkspaceOptions = {},
): void {
  setupWorkspaceDirectory(folder, options);
}
