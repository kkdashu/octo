// Provider directory extracted from LobsterAI renderer/config.ts

export type ProviderModel = {
  id: string;
  name: string;
  supportsImage?: boolean;
};

export type ProviderConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai';
  codingPlanEnabled?: boolean;
  models?: ProviderModel[];
};

export type ProvidersMap = Record<string, ProviderConfig>;

export const DEFAULT_PROVIDERS: ProvidersMap = {
  openai: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.openai.com',
    apiFormat: 'openai',
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4', supportsImage: true },
      { id: 'o3', name: 'o3', supportsImage: true },
    ],
  },
  gemini: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiFormat: 'openai',
    models: [
      { id: 'gemini-2.5-pro-preview', name: 'Gemini 2.5 Pro', supportsImage: true },
      { id: 'gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash', supportsImage: true },
    ],
  },
  anthropic: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.anthropic.com',
    apiFormat: 'anthropic',
    models: [
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', supportsImage: true },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', supportsImage: true },
    ],
  },
  deepseek: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiFormat: 'anthropic',
    models: [
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
      { id: 'deepseek-chat', name: 'DeepSeek Chat', supportsImage: false },
    ],
  },
  moonshot: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    apiFormat: 'anthropic',
    codingPlanEnabled: false,
    models: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5', supportsImage: true },
    ],
  },
  zhipu: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiFormat: 'anthropic',
    codingPlanEnabled: false,
    models: [
      { id: 'glm-5', name: 'GLM 5', supportsImage: false },
      { id: 'glm-4.7', name: 'GLM 4.7', supportsImage: false },
    ],
  },
  minimax: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    apiFormat: 'anthropic',
    models: [
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', supportsImage: false },
    ],
  },
  qwen: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    apiFormat: 'anthropic',
    codingPlanEnabled: false,
    models: [
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', supportsImage: false },
    ],
  },
  volcengine: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
    apiFormat: 'anthropic',
    codingPlanEnabled: false,
    models: [
      { id: 'ark-code-latest', name: 'Auto', supportsImage: false },
    ],
  },
  openrouter: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api',
    apiFormat: 'anthropic',
    models: [
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', supportsImage: true },
    ],
  },
  ollama: {
    enabled: false,
    apiKey: '',
    baseUrl: 'http://localhost:11434/v1',
    apiFormat: 'openai',
    models: [
      { id: 'qwen2.5-coder:7b', name: 'Qwen2.5 Coder 7B', supportsImage: false },
    ],
  },
  custom: {
    enabled: false,
    apiKey: '',
    baseUrl: '',
    apiFormat: 'openai',
    models: [],
  },
};
