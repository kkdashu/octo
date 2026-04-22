import type { Database } from "bun:sqlite";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  AgentSessionRuntime,
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  getAgentDir,
  ModelRegistry,
  type AgentSessionServices,
  type AgentSessionRuntimeDiagnostic,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionRuntimeResult,
  type ExtensionFactory,
  type SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import {
  getChatById,
  getWorkspaceByFolder,
  listWorkspaceMemories,
  type ChatRow,
  type WorkspaceMemoryRow,
  type WorkspaceRow,
} from "../db";
import { getWorkspaceDirectory } from "../group-workspace";
import { createPiMcpExtensionBundle } from "../providers/pi-mcp-extension";
import {
  createPiSessionManager,
  ensurePiSessionDir,
  getPiSessionRef,
  resolvePersistedPiSessionRef,
} from "../providers/pi-session-ref";
import { adaptOctoTools } from "../providers/pi-tool-adapter";
import type { MessageSender } from "../tools";
import { createWorkspaceToolDefs } from "../tools";
import { buildGroupExternalMcpServers } from "./group-external-mcp";
import { buildWorkspaceMemoryAppendSystemPrompt } from "./group-memory-prompt";
import { resolveAgentProfile } from "./profile-config";
import { emitPiSessionShutdown } from "./pi-session-shutdown";
import type { ResolvedAgentProfile } from "./types";

type PiApi = "anthropic-messages" | "openai-responses" | "openai-completions";

export interface PiGroupRuntimeContext {
  workspace: WorkspaceRow;
  chat: ChatRow | null;
  workingDirectory: string;
  profile: ResolvedAgentProfile;
}

export interface PiGroupSessionHost {
  session: CreateAgentSessionRuntimeResult["session"];
  services: AgentSessionServices;
  diagnostics: readonly AgentSessionRuntimeDiagnostic[];
  cwd: string;
  dispose(): Promise<void>;
}

export interface CreatePiGroupRuntimeFactoryOptions {
  db: Database;
  rootDir?: string;
  chatId?: string;
  createMessageSender: (context: PiGroupRuntimeContext) => MessageSender;
  getExtensionFactories?: (
    context: PiGroupRuntimeContext,
  ) => ExtensionFactory[] | Promise<ExtensionFactory[]>;
}

function toPiApi(profile: ResolvedAgentProfile): PiApi {
  if (profile.apiFormat === "anthropic") {
    return "anthropic-messages";
  }

  return profile.upstreamApi === "chat_completions"
    ? "openai-completions"
    : "openai-responses";
}

export function buildProfileModelRegistry(
  profile: ResolvedAgentProfile,
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

export function getWorkspaceFolderFromWorkingDirectory(
  workingDirectory: string,
  rootDir = process.cwd(),
): string | null {
  const groupsRoot = resolve(rootDir, "workspaces");
  const rel = relative(groupsRoot, resolve(workingDirectory));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")) {
    return null;
  }

  const [folder] = rel.split(/[\\/]/);
  return folder?.trim() || null;
}

export function getWorkspaceForWorkingDirectory(
  db: Database,
  workingDirectory: string,
  rootDir = process.cwd(),
): WorkspaceRow | null {
  const folder = getWorkspaceFolderFromWorkingDirectory(workingDirectory, rootDir);
  if (!folder) {
    return null;
  }

  return resolveRuntimeWorkspaceState(db, folder)?.workspace ?? null;
}

function resolveRuntimeWorkspaceState(
  db: Database,
  folder: string,
): {
  workspace: WorkspaceRow;
  memories: WorkspaceMemoryRow[];
} | null {
  const workspace = getWorkspaceByFolder(db, folder);
  if (!workspace) {
    return null;
  }

  return {
    workspace,
    memories: listWorkspaceMemories(db, workspace.id),
  };
}

export function resolveWorkspaceSessionRef(
  workingDirectory: string,
  sessionRefOverride?: string | null,
): string {
  const persistedSessionRef = sessionRefOverride;
  const resolvedPersistedSessionRef = resolvePersistedPiSessionRef(
    workingDirectory,
    persistedSessionRef,
  );

  if (resolvedPersistedSessionRef) {
    return resolvedPersistedSessionRef;
  }

  if (persistedSessionRef) {
    return isAbsolute(persistedSessionRef)
      ? persistedSessionRef
      : resolve(workingDirectory, persistedSessionRef);
  }

  ensurePiSessionDir(workingDirectory);
  return getPiSessionRef(createPiSessionManager(workingDirectory));
}

function createDefaultPiTools(workingDirectory: string) {
  return [
    createReadTool(workingDirectory),
    createBashTool(workingDirectory),
    createEditTool(workingDirectory),
    createWriteTool(workingDirectory),
    createGrepTool(workingDirectory),
    createFindTool(workingDirectory),
    createLsTool(workingDirectory),
  ];
}

export function createPiGroupRuntimeFactory(
  options: CreatePiGroupRuntimeFactoryOptions,
): CreateAgentSessionRuntimeFactory {
  const rootDir = options.rootDir ?? process.cwd();

  return async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }): Promise<CreateAgentSessionRuntimeResult> => {
    const folder = getWorkspaceFolderFromWorkingDirectory(cwd, rootDir);
    const runtimeState = folder ? resolveRuntimeWorkspaceState(options.db, folder) : null;
    if (!runtimeState) {
      throw new Error(`No runtime workspace matches cwd: ${cwd}`);
    }

    const { workspace, memories } = runtimeState;
    const chat = options.chatId ? getChatById(options.db, options.chatId) : null;
    const profile = resolveAgentProfile(workspace.profile_key);
    const context: PiGroupRuntimeContext = {
      workspace,
      chat,
      workingDirectory: cwd,
      profile,
    };

    const mcpBundle = await createPiMcpExtensionBundle(
      buildGroupExternalMcpServers(workspace.folder, rootDir),
      cwd,
    );

    try {
      const extraExtensionFactories = await options.getExtensionFactories?.(context) ?? [];
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRegistry: buildProfileModelRegistry(profile),
        resourceLoaderOptions: {
          appendSystemPrompt: buildWorkspaceMemoryAppendSystemPrompt(
            memories,
          ),
          extensionFactories: [
            ...mcpBundle.extensionFactories,
            ...extraExtensionFactories,
          ],
        },
      });

      const model = services.modelRegistry.find(profile.profileKey, profile.model);
      if (!model) {
        throw new Error(
          `Pi model registry could not resolve ${profile.profileKey}/${profile.model}`,
        );
      }

      const sender = options.createMessageSender(context);
      const customTools = adaptOctoTools(
        createWorkspaceToolDefs({
          workspaceId: workspace.id,
          workspaceFolder: workspace.folder,
          chatId: chat?.id ?? "",
        }, options.db, sender, rootDir),
      );

      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
        tools: createDefaultPiTools(cwd),
        customTools,
      });

      const diagnostics: AgentSessionRuntimeDiagnostic[] = [
        ...services.diagnostics,
        ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
          type: "error" as const,
          message: `Failed to load extension "${path}": ${error}`,
        })),
      ];

      return {
        ...created,
        services,
        diagnostics,
      };
    } catch (error) {
      await mcpBundle.dispose();
      throw error;
    }
  };
}

export async function createPiGroupRuntime(
  options: CreatePiGroupRuntimeFactoryOptions & {
    workspaceFolder: string;
    agentDir?: string;
    sessionRefOverride?: string | null;
  },
): Promise<{
  runtime: AgentSessionRuntime;
  workspace: WorkspaceRow;
  sessionRef: string;
}> {
  const rootDir = options.rootDir ?? process.cwd();
  const runtimeState = resolveRuntimeWorkspaceState(options.db, options.workspaceFolder);
  if (!runtimeState) {
    throw new Error(`Workspace not found: ${options.workspaceFolder}`);
  }

  const { workspace } = runtimeState;
  const workingDirectory = getWorkspaceDirectory(workspace.folder, { rootDir });
  const sessionRef = resolveWorkspaceSessionRef(
    workingDirectory,
    options.sessionRefOverride,
  );
  const sessionManager = createPiSessionManager(workingDirectory, sessionRef);
  const runtime = await createAgentSessionRuntime(
    createPiGroupRuntimeFactory(options),
    {
      cwd: workingDirectory,
      agentDir: options.agentDir ?? getAgentDir(),
      sessionManager,
    },
  );

  return {
    runtime,
    workspace,
    sessionRef: runtime.session.sessionFile ?? sessionRef,
  };
}

export async function createPiGroupSessionHost(
  options: CreatePiGroupRuntimeFactoryOptions & {
    workspaceFolder: string;
    agentDir?: string;
    sessionStartEvent?: SessionStartEvent;
    sessionRefOverride?: string | null;
  },
): Promise<{
  host: PiGroupSessionHost;
  workspace: WorkspaceRow;
  sessionRef: string;
}> {
  const rootDir = options.rootDir ?? process.cwd();
  const runtimeState = resolveRuntimeWorkspaceState(options.db, options.workspaceFolder);
  if (!runtimeState) {
    throw new Error(`Workspace not found: ${options.workspaceFolder}`);
  }

  const { workspace } = runtimeState;
  const workingDirectory = getWorkspaceDirectory(workspace.folder, { rootDir });
  const sessionRef = resolveWorkspaceSessionRef(
    workingDirectory,
    options.sessionRefOverride,
  );
  const sessionManager = createPiSessionManager(workingDirectory, sessionRef);
  const createRuntime = createPiGroupRuntimeFactory(options);
  const created = await createRuntime({
    cwd: workingDirectory,
    agentDir: options.agentDir ?? getAgentDir(),
    sessionManager,
    sessionStartEvent: options.sessionStartEvent,
  });
  const resolvedSessionRef = created.session.sessionFile ?? sessionRef;

  return {
    host: {
      session: created.session,
      services: created.services,
      diagnostics: created.diagnostics,
      cwd: created.services.cwd,
      async dispose() {
        await emitPiSessionShutdown(created.session.extensionRunner);
        created.session.dispose();
      },
    },
    workspace,
    sessionRef: resolvedSessionRef,
  };
}
