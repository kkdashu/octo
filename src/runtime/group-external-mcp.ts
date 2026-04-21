import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getWorkspaceDirectory } from "../group-workspace";
import { resolveEnabledExternalMcpServers } from "./external-mcp-config";

const PDF_TO_MARKDOWN_SKILL_NAME = "pdf-to-markdown";

export function isGroupSkillInstalled(
  groupFolder: string,
  skillName: string,
  rootDir = process.cwd(),
): boolean {
  return existsSync(
    resolve(
      getWorkspaceDirectory(groupFolder, { rootDir }),
      ".pi",
      "skills",
      skillName,
      "SKILL.md",
    ),
  );
}

export function buildGroupExternalMcpServers(
  groupFolder: string,
  rootDir = process.cwd(),
): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  if (!isGroupSkillInstalled(groupFolder, PDF_TO_MARKDOWN_SKILL_NAME, rootDir)) {
    return {};
  }

  return resolveEnabledExternalMcpServers(["markitdown"]);
}
