import { EventEmitter } from 'events';
import { loadClaudeSdk } from './sdkLoader';
import { getCurrentApiConfig, buildEnvForConfig, loadAppConfig, type CoworkApiConfig, type AppConfig } from './settings';
import { startProxy, stopProxy, getProxyStatus } from './proxy';

export type RunnerEvent =
  | { type: 'text'; content: string; sessionId?: string }
  | { type: 'thinking'; content: string; sessionId?: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; toolUseId: string; sessionId?: string }
  | { type: 'tool_result'; toolUseId: string; content: string; sessionId?: string }
  | { type: 'complete'; sessionId?: string; claudeSessionId?: string | null }
  | { type: 'error'; message: string; sessionId?: string };

export interface MiniCoworkOptions {
  /** Path to config file (overrides default discovery) */
  configPath?: string;
  /** Working directory for tool execution */
  workingDirectory?: string;
  /** System prompt to inject */
  systemPrompt?: string;
  /** Suppress info log output */
  silent?: boolean;
}

export interface RunOptions {
  prompt: string;
  /** Previous Claude session ID to continue a conversation */
  sessionId?: string;
  /** Auto-approve all tool permissions */
  autoApprove?: boolean;
}

export class MiniCowork extends EventEmitter {
  private options: MiniCoworkOptions;
  private appConfig: AppConfig | null = null;
  private proxyStarted = false;
  private abortController: AbortController | null = null;

  constructor(options: MiniCoworkOptions = {}) {
    super();
    this.options = options;
  }

  /**
   * Initialize: load config and start proxy if needed.
   * Must be called before run().
   */
  async start(): Promise<void> {
    this.appConfig = loadAppConfig(this.options.configPath);
    if (!this.appConfig) {
      throw new Error(
        'No config found. Create ~/.mini_cowork/config.json or mini_cowork.config.json in your project.'
      );
    }

    // Determine if we need OpenAI compat proxy
    const providers = this.appConfig.providers ?? {};
    const hasOpenAIFormatProvider = Object.values(providers).some(
      (p) => p?.enabled && (p.apiFormat === 'openai' || !p.apiFormat)
    );

    if (hasOpenAIFormatProvider) {
      const proxyStatus = getProxyStatus();
      if (!proxyStatus.running) {
        await startProxy();
        this.proxyStarted = true;
        if (!this.options.silent) {
          console.log('[mini_cowork] OpenAI compatibility proxy started');
        }
      }
    }
  }

  /**
   * Stop and clean up resources.
   */
  async stop(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.proxyStarted) {
      await stopProxy();
      this.proxyStarted = false;
    }
  }

  /**
   * Run a prompt and yield events as an async generator.
   */
  async *run(promptOrOptions: string | RunOptions): AsyncGenerator<RunnerEvent> {
    if (!this.appConfig) {
      throw new Error('MiniCowork not started. Call start() first.');
    }

    const opts: RunOptions =
      typeof promptOrOptions === 'string'
        ? { prompt: promptOrOptions }
        : promptOrOptions;

    const apiConfig = getCurrentApiConfig(this.appConfig);
    if (!apiConfig) {
      throw new Error(
        'Could not resolve API config. Check your provider configuration.'
      );
    }

    const sdk = await loadClaudeSdk();
    const env = buildEnvForConfig(apiConfig);

    if (this.options.workingDirectory) {
      env.CLAUDE_WORKING_DIR = this.options.workingDirectory;
    }

    this.abortController = new AbortController();

    const queryOptions: Record<string, unknown> = {
      prompt: opts.prompt,
      options: {
        cwd: this.options.workingDirectory || process.cwd(),
        env,
        abortSignal: this.abortController.signal,
      },
    };

    if (opts.sessionId) {
      queryOptions.resume = opts.sessionId;
    }

    if (this.options.systemPrompt) {
      (queryOptions.options as Record<string, unknown>).systemPrompt = this.options.systemPrompt;
    }

    if (opts.autoApprove) {
      (queryOptions.options as Record<string, unknown>).permissionMode = 'bypassPermissions';
    }

    try {
      const messages = sdk.query(queryOptions as Parameters<typeof sdk.query>[0]);

      for await (const message of messages) {
        const msg = message as Record<string, unknown>;
        const msgType = msg.type as string;

        if (msgType === 'assistant') {
          const content = msg.message as Record<string, unknown>;
          const contentBlocks = content?.content as unknown[];

          if (Array.isArray(contentBlocks)) {
            for (const block of contentBlocks) {
              const blockObj = block as Record<string, unknown>;
              const blockType = blockObj.type as string;

              if (blockType === 'text') {
                yield { type: 'text', content: blockObj.text as string };
              } else if (blockType === 'thinking') {
                yield { type: 'thinking', content: (blockObj.thinking || blockObj.text) as string };
              } else if (blockType === 'tool_use') {
                yield {
                  type: 'tool_use',
                  name: blockObj.name as string,
                  input: (blockObj.input ?? {}) as Record<string, unknown>,
                  toolUseId: blockObj.id as string,
                };
              }
            }
          }
        } else if (msgType === 'tool') {
          const toolMsg = msg as Record<string, unknown>;
          yield {
            type: 'tool_result',
            toolUseId: toolMsg.tool_use_id as string,
            content: JSON.stringify(toolMsg.content),
          };
        } else if (msgType === 'result') {
          const resultMsg = msg as Record<string, unknown>;
          yield {
            type: 'complete',
            claudeSessionId: resultMsg.session_id as string | null | undefined,
          };
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Run a prompt and collect all text output as a string.
   * Convenience wrapper around run().
   */
  async runText(promptOrOptions: string | RunOptions): Promise<string> {
    const parts: string[] = [];
    for await (const event of this.run(promptOrOptions)) {
      if (event.type === 'text') {
        parts.push(event.content);
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }
    return parts.join('');
  }

  /**
   * Abort the current running session.
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  getApiConfig(): CoworkApiConfig | null {
    if (!this.appConfig) return null;
    return getCurrentApiConfig(this.appConfig);
  }
}

/**
 * Convenience function: run a single prompt and return all events.
 */
export async function runOnce(
  prompt: string,
  options: MiniCoworkOptions = {}
): Promise<RunnerEvent[]> {
  const runner = new MiniCowork(options);
  await runner.start();

  const events: RunnerEvent[] = [];
  try {
    for await (const event of runner.run(prompt)) {
      events.push(event);
    }
  } finally {
    await runner.stop();
  }

  return events;
}
