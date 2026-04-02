import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __test__ as groupQueueTestHelpers,
} from "../src/group-queue";
import { __test__ as externalMcpConfigTestHelpers } from "../src/runtime/external-mcp-config";

const originalEnv = { ...process.env };

describe("group queue MarkItDown gating", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "octo-group-queue-"));
    externalMcpConfigTestHelpers.resetCache();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  afterEach(() => {
    externalMcpConfigTestHelpers.resetCache();
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("detects whether a curated skill is installed for the group", () => {
    const skillDir = join(
      tempDir,
      "groups",
      "main",
      ".claude",
      "skills",
      "pdf-to-markdown",
    );
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# pdf-to-markdown");

    expect(
      groupQueueTestHelpers.isGroupSkillInstalled(
        "main",
        "pdf-to-markdown",
        tempDir,
      ),
    ).toBe(true);
    expect(
      groupQueueTestHelpers.isGroupSkillInstalled(
        "main",
        "missing-skill",
        tempDir,
      ),
    ).toBe(false);
  });

  test("only injects markitdown MCP for groups with the curated skill installed", () => {
    const configPath = join(tempDir, "external-mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          servers: {
            markitdown: {
              enabled: true,
              command: "uvx",
              args: ["markitdown-mcp"],
            },
          },
        },
        null,
        2,
      ),
    );
    process.env.EXTERNAL_MCP_CONFIG_PATH = configPath;

    const skillDir = join(
      tempDir,
      "groups",
      "enabled-group",
      ".claude",
      "skills",
      "pdf-to-markdown",
    );
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# pdf-to-markdown");

    expect(
      groupQueueTestHelpers.buildGroupExternalMcpServers(
        "enabled-group",
        tempDir,
      ),
    ).toEqual({
      markitdown: {
        command: "uvx",
        args: ["markitdown-mcp"],
      },
    });
    expect(
      groupQueueTestHelpers.buildGroupExternalMcpServers(
        "disabled-group",
        tempDir,
      ),
    ).toEqual({});
  });
});
