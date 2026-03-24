import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { log } from "../logger";
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
const TAG = "profile-config";
const MOONSHOT_ANTHROPIC_BASE_URL = "https://api.moonshot.cn/anthropic";
const MOONSHOT_CODING_PLAN_ANTHROPIC_BASE_URL = "https://api.kimi.com/coding";

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

  log.info(TAG, `Loaded agent profiles from ${configPath}`, {
    defaultProfile: config.defaultProfile,
    profileKeys: Object.keys(config.profiles),
  });

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

function applyProviderCompatibility(config: AgentProfileConfig): AgentProfileConfig {
  if (config.provider !== "moonshot") {
    return config;
  }

  return {
    ...config,
    apiFormat: "anthropic",
    upstreamApi: undefined,
    baseUrl: config.codingPlanEnabled
      ? MOONSHOT_CODING_PLAN_ANTHROPIC_BASE_URL
      : MOONSHOT_ANTHROPIC_BASE_URL,
  };
}

export function resolveAgentProfile(profileKey?: string): ResolvedAgentProfile {
  const resolved = resolveProfileDefinition(profileKey);
  const compatibleConfig = applyProviderCompatibility(resolved.config);
  const apiKey = process.env[compatibleConfig.apiKeyEnv]?.trim();

  if (!apiKey) {
    throw new Error(
      `Environment variable ${compatibleConfig.apiKeyEnv} is required for agent profile "${resolved.key}".`,
    );
  }

  return {
    profileKey: resolved.key,
    apiFormat: compatibleConfig.apiFormat,
    upstreamApi: compatibleConfig.upstreamApi,
    baseUrl: compatibleConfig.baseUrl.trim().replace(/\/+$/, ""),
    apiKeyEnv: compatibleConfig.apiKeyEnv,
    apiKey,
    model: compatibleConfig.model,
    provider: compatibleConfig.provider,
    codingPlanEnabled: compatibleConfig.codingPlanEnabled ?? false,
  };
}

export function listAgentProfiles(): AgentProfileSummary[] {
  const config = loadAgentProfilesConfig();

  return Object.entries(config.profiles).map(([profileKey, profile]) => {
    const compatibleProfile = applyProviderCompatibility(profile);
    return {
      profileKey,
      apiFormat: compatibleProfile.apiFormat,
      upstreamApi: compatibleProfile.upstreamApi,
      baseUrl: compatibleProfile.baseUrl.trim().replace(/\/+$/, ""),
      apiKeyEnv: compatibleProfile.apiKeyEnv,
      model: compatibleProfile.model,
      provider: compatibleProfile.provider,
      codingPlanEnabled: compatibleProfile.codingPlanEnabled ?? false,
    };
  });
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
