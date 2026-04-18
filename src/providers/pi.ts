import { resolve } from "node:path";

import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  ModelRegistry,
} from "../../pi-mono/packages/coding-agent/src/index.ts";
import { log } from "../logger";
import type { ImageMessagePreprocessor } from "../runtime/image-message-preprocessor";
import type {
  AgentRuntime,
  ConversationMessageInput,
  OpenConversationInput,
  ResetSessionInput,
  RuntimeDiagnosticName,
  RuntimeEvent,
  RuntimeConversation,
} from "./types";
import { createPiMcpExtensionBundle } from "./pi-mcp-extension";
import { createPiSessionManager, getPiSessionRef } from "./pi-session-ref";
import { adaptOctoTools } from "./pi-tool-adapter";
import {
  collectAssistantText,
  normalizePromptForAgent,
} from "./prompt-normalizer";

const TAG = "pi-provider";

type PiApi = "anthropic-messages" | "openai-responses" | "openai-completions";

type QueueResult<T> = IteratorResult<T, undefined>;

type PiSessionDiagnosticEvent = {
  type:
    | "turn_start"
    | "turn_end"
    | "auto_compaction_start"
    | "auto_compaction_end"
    | "auto_retry_start"
    | "auto_retry_end";
  reason?: string;
  aborted?: boolean;
  willRetry?: boolean;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  success?: boolean;
  finalError?: string;
};

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private values: T[] = [];
  private resolvers: Array<(result: QueueResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) {
      return;
    }

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ done: false, value });
      return;
    }

    this.values.push(value);
  }

  end(): void {
    if (this.ended) {
      return;
    }

    this.ended = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.({ done: true, value: undefined });
    }
  }

  next(): Promise<QueueResult<T>> {
    if (this.values.length > 0) {
      return Promise.resolve({
        done: false,
        value: this.values.shift()!,
      });
    }

    if (this.ended) {
      return Promise.resolve({
        done: true,
        value: undefined,
      });
    }

    return new Promise((resolveNext) => {
      this.resolvers.push(resolveNext);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

function toPiApi(profile: OpenConversationInput["profile"]): PiApi {
  if (profile.apiFormat === "anthropic") {
    return "anthropic-messages";
  }

  return profile.upstreamApi === "chat_completions"
    ? "openai-completions"
    : "openai-responses";
}

function buildModelRegistry(
  profile: OpenConversationInput["profile"],
): ModelRegistry {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const api = toPiApi(profile);

  modelRegistry.registerProvider(profile.profileKey, {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    api,
    authHeader: true,
    models: [
      {
        id: profile.model,
        name: profile.model,
        api,
        reasoning: true,
        input: ["text", "image"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 200000,
        maxTokens: 16384,
      },
    ],
  });

  return modelRegistry;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function buildDiagnosticEvent(
  event: PiSessionDiagnosticEvent,
): Extract<RuntimeEvent, { type: "diagnostic" }> {
  const nameByType: Record<PiSessionDiagnosticEvent["type"], RuntimeDiagnosticName> = {
    turn_start: "turn_start",
    turn_end: "turn_end",
    auto_compaction_start: "auto_compaction_start",
    auto_compaction_end: "auto_compaction_end",
    auto_retry_start: "auto_retry_start",
    auto_retry_end: "auto_retry_end",
  };

  let message: string | undefined;
  if (event.type === "auto_compaction_start" && event.reason) {
    message = `reason=${event.reason}`;
  } else if (event.type === "auto_compaction_end") {
    message = `aborted=${String(event.aborted)} willRetry=${String(event.willRetry)}`;
  } else if (
    event.type === "auto_retry_start" &&
    event.attempt !== undefined &&
    event.maxAttempts !== undefined &&
    event.delayMs !== undefined
  ) {
    message = `attempt=${event.attempt}/${event.maxAttempts} delayMs=${event.delayMs}${
      event.errorMessage ? ` error=${event.errorMessage}` : ""
    }`;
  } else if (event.type === "auto_retry_end") {
    message = `success=${String(event.success)}${
      event.finalError ? ` error=${event.finalError}` : ""
    }`;
  }

  return {
    type: "diagnostic",
    name: nameByType[event.type],
    message,
  };
}

export class PiProvider implements AgentRuntime {
  readonly name = "pi";

  constructor(
    private readonly imageMessagePreprocessor: ImageMessagePreprocessor,
  ) {}

  async resetSession(input: ResetSessionInput): Promise<{
    sessionRef: string;
  }> {
    const sessionManager = createPiSessionManager(input.workingDirectory);
    const sessionRef = getPiSessionRef(sessionManager);

    log.info(TAG, `Created fresh Pi session for ${input.groupFolder}`, {
      groupFolder: input.groupFolder,
      sessionRef,
      workingDirectory: input.workingDirectory,
      profileKey: input.profile.profileKey,
    });

    return { sessionRef };
  }

  async openConversation(input: OpenConversationInput): Promise<{
    conversation: RuntimeConversation;
    events: AsyncIterable<RuntimeEvent>;
  }> {
    const projectRoot = resolve(input.workingDirectory, "..", "..");
    const sessionManager = createPiSessionManager(
      input.workingDirectory,
      input.resumeSessionRef,
    );
    const modelRegistry = buildModelRegistry(input.profile);
    const model = modelRegistry.find(
      input.profile.profileKey,
      input.profile.model,
    );

    if (!model) {
      throw new Error(
        `Pi model registry could not resolve ${input.profile.profileKey}/${input.profile.model}`,
      );
    }

    const mcpBundle = await createPiMcpExtensionBundle(
      input.externalMcpServers,
      input.workingDirectory,
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.workingDirectory,
      extensionFactories: mcpBundle.extensionFactories,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: input.workingDirectory,
      modelRegistry,
      model,
      sessionManager,
      resourceLoader,
      tools: [
        createReadTool(input.workingDirectory),
        createBashTool(input.workingDirectory),
        createEditTool(input.workingDirectory),
        createWriteTool(input.workingDirectory),
        createGrepTool(input.workingDirectory),
        createFindTool(input.workingDirectory),
        createLsTool(input.workingDirectory),
      ],
      customTools: adaptOctoTools(input.tools),
    });

    const eventQueue = new AsyncEventQueue<RuntimeEvent>();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end") {
        const text = collectAssistantText(event.message);
        if (text) {
          eventQueue.push({
            type: "assistant_text",
            text,
          });
        }
        return;
      }

      if (
        event.type === "turn_start" ||
        event.type === "turn_end" ||
        event.type === "auto_compaction_start" ||
        event.type === "auto_compaction_end" ||
        event.type === "auto_retry_start" ||
        event.type === "auto_retry_end"
      ) {
        eventQueue.push(buildDiagnosticEvent(event));
      }
    });

    let disposed = false;

    const disposeConversation = async () => {
      if (disposed) {
        return;
      }

      disposed = true;
      unsubscribe();
      await Promise.allSettled([
        session.abort(),
        mcpBundle.dispose(),
      ]);
      session.dispose();
      eventQueue.end();
    };

    const emitCompleted = () => {
      eventQueue.push({
        type: "completed",
        sessionRef: getPiSessionRef(session.sessionManager),
      });
    };

    const sendPromptTurn = async (text: string) => {
      await session.prompt(text);
      emitCompleted();
    };

    const conversation: RuntimeConversation = {
      send: async ({ text, mode }: ConversationMessageInput) => {
        try {
          const normalizedPrompt = await normalizePromptForAgent(
            text,
            projectRoot,
            input.workingDirectory,
            this.imageMessagePreprocessor,
            TAG,
          );

          if (mode === "prompt") {
            if (session.isStreaming) {
              throw new Error(
                "Cannot send mode=prompt while the Pi conversation is streaming. Use follow_up or steer.",
              );
            }

            await sendPromptTurn(normalizedPrompt);
            return;
          }

          if (mode === "follow_up") {
            if (session.isStreaming) {
              await session.followUp(normalizedPrompt);
              return;
            }

            await sendPromptTurn(normalizedPrompt);
            return;
          }

          if (session.isStreaming) {
            await session.steer(normalizedPrompt);
            return;
          }

          await sendPromptTurn(normalizedPrompt);
        } catch (error) {
          eventQueue.push({
            type: "failed",
            error: toError(error),
          });
          throw error;
        }
      },
      close: () => {
        void disposeConversation();
      },
    };

    return {
      conversation,
      events: eventQueue,
    };
  }
}
