/**
 * mini_cowork - Standalone multi-provider Claude Agent SDK runner
 *
 * Usage:
 *   import { MiniCowork } from 'mini_cowork';
 *
 *   const runner = new MiniCowork({ configPath: './mini_cowork.config.json' });
 *   await runner.start();
 *
 *   for await (const event of runner.run('Write a hello world')) {
 *     if (event.type === 'text') process.stdout.write(event.content);
 *   }
 *
 *   await runner.stop();
 */

export { MiniCowork, runOnce } from './runner';
export type { RunnerEvent, MiniCoworkOptions, RunOptions } from './runner';

export { startProxy, stopProxy, configureProxy, getProxyBaseURL, getProxyStatus } from './proxy';
export type { OpenAICompatUpstreamConfig, OpenAICompatProxyTarget, OpenAICompatProxyStatus } from './proxy';

export { loadAppConfig, resolveConfigPath, getCurrentApiConfig, buildEnvForConfig } from './settings';
export type { AppConfig, ProviderConfig, CoworkApiConfig, ApiConfigResolution, MiniCoworkConfig } from './settings';

export { loadClaudeSdk, getClaudeCodeCliPath } from './sdkLoader';
export type { ClaudeSdkModule } from './sdkLoader';

export {
  anthropicToOpenAI,
  openAIToAnthropic,
  normalizeProviderApiFormat,
  mapStopReason,
  formatSSEEvent,
  buildOpenAIChatCompletionsURL,
} from './transform';
export type { AnthropicApiFormat, OpenAIStreamChunk } from './transform';

export { DEFAULT_PROVIDERS } from './config/providers';
export type { ProviderModel, ProvidersMap } from './config/providers';
