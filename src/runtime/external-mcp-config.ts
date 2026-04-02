import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { log } from "../logger";
import type { ExternalMcpServerSpec } from "../providers/types";

const TAG = "external-mcp-config";

const externalMcpServerSchema = z.object({
  enabled: z.boolean().optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const externalMcpConfigSchema = z.object({
  servers: z.record(z.string(), externalMcpServerSchema),
});

type ExternalMcpConfig = z.infer<typeof externalMcpConfigSchema>;

type CachedConfig = {
  path: string;
  mtimeMs: number;
  config: ExternalMcpConfig;
};

let cachedConfig: CachedConfig | null = null;

function getCandidateConfigPaths(): string[] {
  const configured = process.env.EXTERNAL_MCP_CONFIG_PATH?.trim();
  if (configured) {
    return [resolve(configured)];
  }

  return [
    resolve("config/external-mcp.json"),
    resolve("config/external-mcp.example.json"),
  ];
}

export function resolveExternalMcpConfigPath(): string {
  for (const candidate of getCandidateConfigPaths()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return getCandidateConfigPaths()[0]!;
}

export function loadExternalMcpConfig(): ExternalMcpConfig {
  const configPath = resolveExternalMcpConfigPath();
  if (!existsSync(configPath)) {
    return { servers: {} };
  }

  const stats = statSync(configPath);
  if (
    cachedConfig &&
    cachedConfig.path === configPath &&
    cachedConfig.mtimeMs === stats.mtimeMs
  ) {
    return cachedConfig.config;
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = externalMcpConfigSchema.parse(JSON.parse(raw) as unknown);

  cachedConfig = {
    path: configPath,
    mtimeMs: stats.mtimeMs,
    config: parsed,
  };

  log.info(TAG, `Loaded external MCP config from ${configPath}`, {
    serverNames: Object.keys(parsed.servers),
  });

  return parsed;
}

export function resolveEnabledExternalMcpServers(
  requestedServerNames?: string[],
): Record<string, ExternalMcpServerSpec> {
  const config = loadExternalMcpConfig();
  const requested = requestedServerNames?.map((name) => name.trim()).filter(Boolean);
  const candidates = requested && requested.length > 0
    ? requested
    : Object.keys(config.servers);
  const result: Record<string, ExternalMcpServerSpec> = {};

  for (const serverName of candidates) {
    const server = config.servers[serverName];
    if (!server || server.enabled === false) {
      continue;
    }

    result[serverName] = {
      command: server.command,
      ...(server.args ? { args: [...server.args] } : {}),
      ...(server.env ? { env: { ...server.env } } : {}),
    };
  }

  return result;
}

export const __test__ = {
  resetCache: () => {
    cachedConfig = null;
  },
  loadExternalMcpConfig,
  resolveEnabledExternalMcpServers,
  resolveExternalMcpConfigPath,
};
