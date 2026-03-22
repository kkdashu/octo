import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  configureProxy,
  getProxyBaseURL,
  getProxyStatus,
  type OpenAICompatProxyTarget,
} from './proxy';
import { normalizeProviderApiFormat, type AnthropicApiFormat } from './transform';

// Coding Plan special endpoints
const ZHIPU_CODING_PLAN_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const QWEN_CODING_PLAN_OPENAI_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1';
const QWEN_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://coding.dashscope.aliyuncs.com/apps/anthropic';
const VOLCENGINE_CODING_PLAN_OPENAI_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const VOLCENGINE_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding';
const MOONSHOT_CODING_PLAN_OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1';
const MOONSHOT_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://api.kimi.com/coding';

export type ProviderModel = {
  id: string;
};

export type ProviderConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai' | 'native';
  codingPlanEnabled?: boolean;
  models?: ProviderModel[];
};

export type AppConfig = {
  model?: {
    defaultModel?: string;
  };
  providers?: Record<string, ProviderConfig>;
};

export type CoworkApiType = 'anthropic' | 'openai';

export type CoworkApiConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: CoworkApiType;
};

export type ApiConfigResolution = {
  config: CoworkApiConfig | null;
  error?: string;
};

export type MiniCoworkConfig = {
  configPath?: string;
};

/**
 * Resolve config file path. Priority:
 * 1. Explicitly provided path
 * 2. ./mini_cowork.config.json (project-local)
 * 3. ~/.mini_cowork/config.json (global user config)
 */
export function resolveConfigPath(explicitPath?: string): string | null {
  if (explicitPath) {
    return explicitPath;
  }

  const projectLocal = join(process.cwd(), 'mini_cowork.config.json');
  if (existsSync(projectLocal)) {
    return projectLocal;
  }

  const globalConfig = join(homedir(), '.mini_cowork', 'config.json');
  if (existsSync(globalConfig)) {
    return globalConfig;
  }

  return null;
}

export function loadAppConfig(configPath?: string): AppConfig | null {
  const resolvedPath = resolveConfigPath(configPath);
  if (!resolvedPath) {
    return null;
  }

  try {
    const raw = readFileSync(resolvedPath, 'utf8');
    return JSON.parse(raw) as AppConfig;
  } catch (error) {
    console.error('[mini_cowork] Failed to load config:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

type MatchedProvider = {
  providerName: string;
  providerConfig: ProviderConfig;
  modelId: string;
  apiFormat: AnthropicApiFormat;
  baseURL: string;
};

function getEffectiveProviderApiFormat(providerName: string, apiFormat: unknown): AnthropicApiFormat {
  if (providerName === 'openai' || providerName === 'gemini') {
    return 'openai';
  }
  if (providerName === 'anthropic') {
    return 'anthropic';
  }
  return normalizeProviderApiFormat(apiFormat);
}

function providerRequiresApiKey(providerName: string): boolean {
  return providerName !== 'ollama';
}

function resolveMatchedProvider(appConfig: AppConfig): { matched: MatchedProvider | null; error?: string } {
  const providers = appConfig.providers ?? {};

  const resolveFallbackModel = (): string | undefined => {
    for (const provider of Object.values(providers)) {
      if (!provider?.enabled || !provider.models || provider.models.length === 0) {
        continue;
      }
      return provider.models[0].id;
    }
    return undefined;
  };

  const modelId = appConfig.model?.defaultModel || resolveFallbackModel();
  if (!modelId) {
    return { matched: null, error: 'No available model configured in enabled providers.' };
  }

  const providerEntry = Object.entries(providers).find(([, provider]) => {
    if (!provider?.enabled || !provider.models) {
      return false;
    }
    return provider.models.some((model) => model.id === modelId);
  });

  if (!providerEntry) {
    return { matched: null, error: `No enabled provider found for model: ${modelId}` };
  }

  const [providerName, providerConfig] = providerEntry;
  let apiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);
  let baseURL = providerConfig.baseUrl?.trim();

  // Handle Zhipu GLM Coding Plan endpoint switch
  if (providerName === 'zhipu' && providerConfig.codingPlanEnabled) {
    baseURL = ZHIPU_CODING_PLAN_BASE_URL;
    apiFormat = 'openai';
  }

  // Handle Qwen Coding Plan endpoint switch
  if (providerName === 'qwen' && providerConfig.codingPlanEnabled) {
    if (apiFormat === 'anthropic') {
      baseURL = QWEN_CODING_PLAN_ANTHROPIC_BASE_URL;
    } else {
      baseURL = QWEN_CODING_PLAN_OPENAI_BASE_URL;
      apiFormat = 'openai';
    }
  }

  // Handle Volcengine Coding Plan endpoint switch
  if (providerName === 'volcengine' && providerConfig.codingPlanEnabled) {
    if (apiFormat === 'anthropic') {
      baseURL = VOLCENGINE_CODING_PLAN_ANTHROPIC_BASE_URL;
    } else {
      baseURL = VOLCENGINE_CODING_PLAN_OPENAI_BASE_URL;
      apiFormat = 'openai';
    }
  }

  // Handle Moonshot/Kimi Coding Plan endpoint switch
  if (providerName === 'moonshot' && providerConfig.codingPlanEnabled) {
    if (apiFormat === 'anthropic') {
      baseURL = MOONSHOT_CODING_PLAN_ANTHROPIC_BASE_URL;
    } else {
      baseURL = MOONSHOT_CODING_PLAN_OPENAI_BASE_URL;
      apiFormat = 'openai';
    }
  }

  if (!baseURL) {
    return { matched: null, error: `Provider ${providerName} is missing base URL.` };
  }

  if (apiFormat === 'anthropic' && providerRequiresApiKey(providerName) && !providerConfig.apiKey?.trim()) {
    return { matched: null, error: `Provider ${providerName} requires API key for Anthropic-compatible mode.` };
  }

  return {
    matched: {
      providerName,
      providerConfig,
      modelId,
      apiFormat,
      baseURL,
    },
  };
}

export function resolveCurrentApiConfig(
  appConfig: AppConfig,
  target: OpenAICompatProxyTarget = 'local'
): ApiConfigResolution {
  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    return { config: null, error };
  }

  const resolvedBaseURL = matched.baseURL;
  const resolvedApiKey = matched.providerConfig.apiKey?.trim() || '';
  const effectiveApiKey =
    matched.providerName === 'ollama' && matched.apiFormat === 'anthropic' && !resolvedApiKey
      ? 'sk-ollama-local'
      : resolvedApiKey;

  if (matched.apiFormat === 'anthropic') {
    return {
      config: {
        apiKey: effectiveApiKey,
        baseURL: resolvedBaseURL,
        model: matched.modelId,
        apiType: 'anthropic',
      },
    };
  }

  const proxyStatus = getProxyStatus();
  if (!proxyStatus.running) {
    return {
      config: null,
      error: 'OpenAI compatibility proxy is not running.',
    };
  }

  configureProxy({
    baseURL: resolvedBaseURL,
    apiKey: resolvedApiKey || undefined,
    model: matched.modelId,
    provider: matched.providerName,
  });

  const proxyBaseURL = getProxyBaseURL(target);
  if (!proxyBaseURL) {
    return {
      config: null,
      error: 'OpenAI compatibility proxy base URL is unavailable.',
    };
  }

  return {
    config: {
      apiKey: resolvedApiKey || 'mini-cowork-openai-compat',
      baseURL: proxyBaseURL,
      model: matched.modelId,
      apiType: 'openai',
    },
  };
}

export function getCurrentApiConfig(
  appConfig: AppConfig,
  target: OpenAICompatProxyTarget = 'local'
): CoworkApiConfig | null {
  return resolveCurrentApiConfig(appConfig, target).config;
}

export function buildEnvForConfig(config: CoworkApiConfig): Record<string, string> {
  const baseEnv = { ...process.env } as Record<string, string>;

  baseEnv.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  baseEnv.ANTHROPIC_API_KEY = config.apiKey;
  baseEnv.ANTHROPIC_BASE_URL = config.baseURL;
  baseEnv.ANTHROPIC_MODEL = config.model;

  return baseEnv;
}
