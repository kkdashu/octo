import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test__ as externalMcpConfigTestHelpers } from "../src/runtime/external-mcp-config";

const originalEnv = { ...process.env };
const originalCwd = process.cwd();

describe("external MCP config", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "octo-external-mcp-"));
    externalMcpConfigTestHelpers.resetCache();
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    delete process.env.EXTERNAL_MCP_CONFIG_PATH;
  });

  afterEach(() => {
    externalMcpConfigTestHelpers.resetCache();
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  test("reads config from EXTERNAL_MCP_CONFIG_PATH and preserves args/env", () => {
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
              env: {
                HTTP_PROXY: "http://127.0.0.1:8080",
              },
            },
            disabled: {
              enabled: false,
              command: "disabled-mcp",
            },
          },
        },
        null,
        2,
      ),
    );

    process.env.EXTERNAL_MCP_CONFIG_PATH = configPath;

    expect(externalMcpConfigTestHelpers.resolveExternalMcpConfigPath()).toBe(configPath);
    expect(
      externalMcpConfigTestHelpers.resolveEnabledExternalMcpServers(),
    ).toEqual({
      markitdown: {
        command: "uvx",
        args: ["markitdown-mcp"],
        env: {
          HTTP_PROXY: "http://127.0.0.1:8080",
        },
      },
    });
  });

  test("falls back to config/external-mcp.example.json when no explicit config is set", () => {
    const configDir = join(tempDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "external-mcp.example.json"),
      JSON.stringify(
        {
          servers: {
            markitdown: {
              enabled: true,
              command: "markitdown-mcp",
            },
          },
        },
        null,
        2,
      ),
    );

    process.chdir(tempDir);
    externalMcpConfigTestHelpers.resetCache();

    expect(
      externalMcpConfigTestHelpers.resolveExternalMcpConfigPath().endsWith(
        "/config/external-mcp.example.json",
      ),
    ).toBe(true);
    expect(
      externalMcpConfigTestHelpers.resolveEnabledExternalMcpServers(["markitdown"]),
    ).toEqual({
      markitdown: {
        command: "markitdown-mcp",
      },
    });
  });

  test("throws when a configured server is missing command", () => {
    const configPath = join(tempDir, "external-mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          servers: {
            markitdown: {
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
    );

    process.env.EXTERNAL_MCP_CONFIG_PATH = configPath;

    expect(() => externalMcpConfigTestHelpers.loadExternalMcpConfig()).toThrow();
  });
});
