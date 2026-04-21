import type { Database } from "bun:sqlite";
import { getWorkspaceDirectory } from "../group-workspace";
import { WorkspaceService } from "../workspace-service";
import { normalizePromptForAgent } from "../providers/prompt-normalizer";
import type { ImageMessagePreprocessor } from "./image-message-preprocessor";

const LOG_TAG = "runtime-input-preprocessor";

export interface RuntimeInputPreprocessor {
  prepare(chatId: string, text: string): Promise<string>;
}

export interface CreateRuntimeInputPreprocessorOptions {
  db: Database;
  rootDir: string;
  workspaceService?: WorkspaceService;
  imageMessagePreprocessor: ImageMessagePreprocessor;
}

export function createRuntimeInputPreprocessor(
  options: CreateRuntimeInputPreprocessorOptions,
): RuntimeInputPreprocessor {
  const workspaceService = options.workspaceService
    ?? new WorkspaceService(options.db, { rootDir: options.rootDir });

  return {
    async prepare(chatId: string, text: string): Promise<string> {
      const chat = workspaceService.getChatById(chatId);
      if (!chat) {
        throw new Error(`Chat not found: ${chatId}`);
      }

      const workspace = workspaceService.getWorkspaceById(chat.workspace_id);
      if (!workspace) {
        throw new Error(`Workspace not found: ${chat.workspace_id}`);
      }

      return normalizePromptForAgent(
        text,
        options.rootDir,
        getWorkspaceDirectory(workspace.folder, { rootDir: options.rootDir }),
        options.imageMessagePreprocessor,
        LOG_TAG,
      );
    },
  };
}
