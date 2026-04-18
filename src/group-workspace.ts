import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyDirRecursive } from "./utils";

const MAIN_TEMPLATE = "groups/MAIN_AGENTS.md";
const GROUP_TEMPLATE = "groups/GROUP_AGENTS.md";
const SYSTEM_SKILLS_DIR = "skills/system";

export interface SetupGroupWorkspaceOptions {
  rootDir?: string;
}

function resolveFromRoot(rootDir: string, ...parts: string[]): string {
  return resolve(rootDir, ...parts);
}

export function migrateLegacyGroupWorkspace(
  folder: string,
  options: SetupGroupWorkspaceOptions = {},
) {
  const rootDir = options.rootDir ?? process.cwd();
  const legacyAgentsPath = resolveFromRoot(rootDir, "groups", folder, "CLAUDE.md");
  const agentsPath = resolveFromRoot(rootDir, "groups", folder, "AGENTS.md");
  if (!existsSync(agentsPath) && existsSync(legacyAgentsPath)) {
    copyFileSync(legacyAgentsPath, agentsPath);
  }

  const legacySkillsDir = resolveFromRoot(rootDir, "groups", folder, ".claude", "skills");
  const piSkillsDir = resolveFromRoot(rootDir, "groups", folder, ".pi", "skills");
  if (!existsSync(piSkillsDir) && existsSync(legacySkillsDir)) {
    copyDirRecursive(legacySkillsDir, piSkillsDir);
  }
}

export function ensureAgentsMd(
  folder: string,
  isMain: boolean,
  options: SetupGroupWorkspaceOptions = {},
) {
  const rootDir = options.rootDir ?? process.cwd();
  const target = resolveFromRoot(rootDir, "groups", folder, "AGENTS.md");
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
) {
  const rootDir = options.rootDir ?? process.cwd();
  const systemSkillsDir = resolveFromRoot(rootDir, SYSTEM_SKILLS_DIR);
  if (!existsSync(systemSkillsDir)) {
    return;
  }

  const targetSkillsDir = resolveFromRoot(rootDir, "groups", folder, ".pi", "skills");
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

export function setupGroupWorkspace(
  folder: string,
  isMain: boolean,
  options: SetupGroupWorkspaceOptions = {},
) {
  const rootDir = options.rootDir ?? process.cwd();
  mkdirSync(resolveFromRoot(rootDir, "groups", folder), { recursive: true });
  migrateLegacyGroupWorkspace(folder, { rootDir });
  ensureAgentsMd(folder, isMain, { rootDir });
  syncSystemSkills(folder, { rootDir });
}
