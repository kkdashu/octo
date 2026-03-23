import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type {
  AgentProfileConfig,
  AgentProfilesConfig,
  AgentProfileSummary,
  ProxyRouteHandle,
  ResolvedAgentProfile,
} from "./types";

const agentProfileConfigSchema = z.object({
  apiFormat: z.enum(["anthropic", "openai"]),
  upstreamApi: z.enum(["chat_completions", "responses"]).optional(),
  baseUrl: z.string().min(1),
  apiKeyEnv: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1).optional(),
  codingPlanEnabled: z.boolean().optional(),
});

const agentProfilesConfigSchema = z.object({
  defaultProfile: z.string().min(1),
  profiles: z.record(z.string(), agentProfileConfigSchema),
});

type CachedConfig = {
  path: string;
  mtimeMs: number;
  config: AgentProfilesConfig;
};

let cachedConfig: CachedConfig | null = null;

function getCandidateConfigPaths(): string[] {
  const configured = process.env.AGENT_PROFILES_PATH?.trim();
  if (configured) {
    return [resolve(configured)];
  }

  return [
    resolve("config/agent-profiles.json"),
    resolve("config/agent-profiles.example.json"),
  ];
}

export function resolveAgentProfilesPath(): string {
  for (const candidate of getCandidateConfigPaths()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return getCandidateConfigPaths()[0]!;
}

export function loadAgentProfilesConfig(): AgentProfilesConfig {
  const configPath = resolveAgentProfilesPath();
  if (!existsSync(configPath)) {
    throw new Error(
      `Agent profile config not found: ${configPath}. Set AGENT_PROFILES_PATH or create config/agent-profiles.json.`,
    );
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
  const parsed = JSON.parse(raw) as unknown;
  const config = agentProfilesConfigSchema.parse(parsed);

  if (!config.profiles[config.defaultProfile]) {
    throw new Error(
      `Default agent profile "${config.defaultProfile}" is not defined in ${configPath}.`,
    );
  }

  cachedConfig = {
    path: configPath,
    mtimeMs: stats.mtimeMs,
    config,
  };

  return config;
}

function resolveProfileDefinition(profileKey?: string): {
  key: string;
  config: AgentProfileConfig;
} {
  const config = loadAgentProfilesConfig();
  const requestedKey = profileKey?.trim();

  if (requestedKey && config.profiles[requestedKey]) {
    return { key: requestedKey, config: config.profiles[requestedKey] };
  }

  return {
    key: config.defaultProfile,
    config: config.profiles[config.defaultProfile]!,
  };
}

export function resolveAgentProfile(profileKey?: string): ResolvedAgentProfile {
  const resolved = resolveProfileDefinition(profileKey);
  const apiKey = process.env[resolved.config.apiKeyEnv]?.trim();

  if (!apiKey) {
    throw new Error(
      `Environment variable ${resolved.config.apiKeyEnv} is required for agent profile "${resolved.key}".`,
    );
  }

  return {
    profileKey: resolved.key,
    apiFormat: resolved.config.apiFormat,
    upstreamApi: resolved.config.upstreamApi,
    baseUrl: resolved.config.baseUrl.trim().replace(/\/+$/, ""),
    apiKeyEnv: resolved.config.apiKeyEnv,
    apiKey,
    model: resolved.config.model,
    provider: resolved.config.provider,
    codingPlanEnabled: resolved.config.codingPlanEnabled ?? false,
  };
}

export function listAgentProfiles(): AgentProfileSummary[] {
  const config = loadAgentProfilesConfig();

  return Object.entries(config.profiles).map(([profileKey, profile]) => ({
    profileKey,
    apiFormat: profile.apiFormat,
    upstreamApi: profile.upstreamApi,
    baseUrl: profile.baseUrl.trim().replace(/\/+$/, ""),
    apiKeyEnv: profile.apiKeyEnv,
    model: profile.model,
    provider: profile.provider,
    codingPlanEnabled: profile.codingPlanEnabled ?? false,
  }));
}

export function buildClaudeSdkEnv(
  profile: ResolvedAgentProfile,
  proxyRoute?: ProxyRouteHandle,
): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  const apiKey = proxyRoute?.apiKey ?? profile.apiKey;
  const baseUrl = proxyRoute?.baseUrl ?? profile.baseUrl;

  env.ANTHROPIC_AUTH_TOKEN = apiKey;
  env.ANTHROPIC_API_KEY = apiKey;
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_MODEL = profile.model;

  return env;
}
