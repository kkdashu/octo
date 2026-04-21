import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getWorkspaceDirectory } from "../group-workspace";
import { resolveEnabledExternalMcpServers } from "./external-mcp-config";

const PDF_TO_MARKDOWN_SKILL_NAME = "pdf-to-markdown";

export function isWorkspaceSkillInstalled(
  workspaceFolder: string,
  skillName: string,
  rootDir = process.cwd(),
): boolean {
  return existsSync(
    resolve(
      getWorkspaceDirectory(workspaceFolder, { rootDir }),
      ".pi",
      "skills",
      skillName,
      "SKILL.md",
    ),
  );
}

export function buildGroupExternalMcpServers(
  workspaceFolder: string,
  rootDir = process.cwd(),
): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  if (!isWorkspaceSkillInstalled(workspaceFolder, PDF_TO_MARKDOWN_SKILL_NAME, rootDir)) {
    return {};
  }

  return resolveEnabledExternalMcpServers(["markitdown"]);
}
