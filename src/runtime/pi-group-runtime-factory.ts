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
  SessionManager,
  type AgentSessionServices,
  type AgentSessionRuntimeDiagnostic,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionRuntimeResult,
  type ExtensionFactory,
  type SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import {
  deleteSessionRef,
  getGroupByFolder,
  getSessionRef,
  getWorkspaceByFolder,
  listGroupMemories,
  listWorkspaceMemories,
  saveSessionRef,
  type GroupMemoryRow,
  type RegisteredGroup,
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
import { createGroupToolDefs } from "../tools";
import { buildGroupExternalMcpServers } from "./group-external-mcp";
import { buildGroupMemoryAppendSystemPrompt } from "./group-memory-prompt";
import { resolveAgentProfile } from "./profile-config";
import { emitPiSessionShutdown } from "./pi-session-shutdown";
import type { ResolvedAgentProfile } from "./types";

type PiApi = "anthropic-messages" | "openai-responses" | "openai-completions";

export interface PiGroupRuntimeContext {
  group: RegisteredGroup;
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

export function getGroupFolderFromWorkingDirectory(
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

export function getGroupForWorkingDirectory(
  db: Database,
  workingDirectory: string,
  rootDir = process.cwd(),
): RegisteredGroup | null {
  const folder = getGroupFolderFromWorkingDirectory(workingDirectory, rootDir);
  if (!folder) {
    return null;
  }

  return resolveRuntimeGroupState(db, folder)?.group ?? null;
}

function buildWorkspaceBackedGroup(
  folder: string,
  workspace: NonNullable<ReturnType<typeof getWorkspaceByFolder>>,
): RegisteredGroup {
  return {
    jid: `workspace:${workspace.id}`,
    name: workspace.name,
    folder,
    channel_type: "workspace",
    trigger_pattern: "",
    added_at: workspace.created_at,
    requires_trigger: 0,
    is_main: workspace.is_main,
    profile_key: workspace.profile_key,
  };
}

function mapWorkspaceMemoriesToGroupMemories(
  folder: string,
): (memory: ReturnType<typeof listWorkspaceMemories>[number]) => GroupMemoryRow {
  return (memory) => ({
    group_folder: folder,
    key: memory.key,
    key_type: memory.key_type,
    value: memory.value,
    source: memory.source,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
  });
}

function resolveRuntimeGroupState(
  db: Database,
  folder: string,
): {
  group: RegisteredGroup;
  memories: GroupMemoryRow[];
} | null {
  const group = getGroupByFolder(db, folder);
  if (group) {
    return {
      group,
      memories: listGroupMemories(db, folder),
    };
  }

  const workspace = getWorkspaceByFolder(db, folder);
  if (!workspace) {
    return null;
  }

  return {
    group: buildWorkspaceBackedGroup(folder, workspace),
    memories: listWorkspaceMemories(db, workspace.id).map(
      mapWorkspaceMemoriesToGroupMemories(folder),
    ),
  };
}

export function resolveGroupSessionRef(
  db: Database,
  groupFolder: string,
  workingDirectory: string,
  options?: {
    sessionRefOverride?: string | null;
    persistResolvedRef?: boolean;
  },
): string {
  const persistResolvedRef = options?.persistResolvedRef ?? true;
  const persistedSessionRef = options?.sessionRefOverride ?? getSessionRef(db, groupFolder);
  const resolvedPersistedSessionRef = resolvePersistedPiSessionRef(
    workingDirectory,
    persistedSessionRef,
  );

  if (
    persistedSessionRef
    && !resolvedPersistedSessionRef
    && options?.sessionRefOverride == null
  ) {
    deleteSessionRef(db, groupFolder);
  }

  if (resolvedPersistedSessionRef) {
    if (persistResolvedRef && options?.sessionRefOverride == null) {
      saveSessionRef(db, groupFolder, resolvedPersistedSessionRef);
    }
    return resolvedPersistedSessionRef;
  }

  if (persistedSessionRef && options?.sessionRefOverride != null) {
    return isAbsolute(persistedSessionRef)
      ? persistedSessionRef
      : resolve(workingDirectory, persistedSessionRef);
  }

  const sessionManager = SessionManager.continueRecent(
    workingDirectory,
    ensurePiSessionDir(workingDirectory),
  );
  const sessionRef = getPiSessionRef(sessionManager);
  if (persistResolvedRef && options?.sessionRefOverride == null) {
    saveSessionRef(db, groupFolder, sessionRef);
  }
  return sessionRef;
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
    const folder = getGroupFolderFromWorkingDirectory(cwd, rootDir);
    const runtimeState = folder ? resolveRuntimeGroupState(options.db, folder) : null;
    if (!runtimeState) {
      throw new Error(`No runtime workspace matches cwd: ${cwd}`);
    }

    const { group, memories } = runtimeState;
    const profile = resolveAgentProfile(group.profile_key);
    const context: PiGroupRuntimeContext = {
      group,
      workingDirectory: cwd,
      profile,
    };

    const mcpBundle = await createPiMcpExtensionBundle(
      buildGroupExternalMcpServers(group.folder, rootDir),
      cwd,
    );

    try {
      const extraExtensionFactories = await options.getExtensionFactories?.(context) ?? [];
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRegistry: buildProfileModelRegistry(profile),
        resourceLoaderOptions: {
          appendSystemPrompt: buildGroupMemoryAppendSystemPrompt(
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
        createGroupToolDefs(
          group.folder,
          group.is_main === 1,
          options.db,
          sender,
          rootDir,
        ),
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
    groupFolder: string;
    agentDir?: string;
    sessionRefOverride?: string | null;
    persistSessionRef?: boolean;
  },
): Promise<{
  runtime: AgentSessionRuntime;
  group: RegisteredGroup;
  sessionRef: string;
}> {
  const rootDir = options.rootDir ?? process.cwd();
  const runtimeState = resolveRuntimeGroupState(options.db, options.groupFolder);
  if (!runtimeState) {
    throw new Error(`Group not found: ${options.groupFolder}`);
  }

  const { group } = runtimeState;
  const workingDirectory = getWorkspaceDirectory(group.folder, { rootDir });
  const sessionRef = resolveGroupSessionRef(
    options.db,
    group.folder,
    workingDirectory,
    {
      sessionRefOverride: options.sessionRefOverride,
      persistResolvedRef: options.persistSessionRef ?? true,
    },
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

  if (options.persistSessionRef ?? true) {
    saveSessionRef(options.db, group.folder, runtime.session.sessionFile ?? sessionRef);
  }

  return {
    runtime,
    group,
    sessionRef: runtime.session.sessionFile ?? sessionRef,
  };
}

export async function createPiGroupSessionHost(
  options: CreatePiGroupRuntimeFactoryOptions & {
    groupFolder: string;
    agentDir?: string;
    sessionStartEvent?: SessionStartEvent;
    sessionRefOverride?: string | null;
    persistSessionRef?: boolean;
  },
): Promise<{
  host: PiGroupSessionHost;
  group: RegisteredGroup;
  sessionRef: string;
}> {
  const rootDir = options.rootDir ?? process.cwd();
  const runtimeState = resolveRuntimeGroupState(options.db, options.groupFolder);
  if (!runtimeState) {
    throw new Error(`Group not found: ${options.groupFolder}`);
  }

  const { group } = runtimeState;
  const workingDirectory = getWorkspaceDirectory(group.folder, { rootDir });
  const sessionRef = resolveGroupSessionRef(
    options.db,
    group.folder,
    workingDirectory,
    {
      sessionRefOverride: options.sessionRefOverride,
      persistResolvedRef: options.persistSessionRef ?? true,
    },
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

  if (options.persistSessionRef ?? true) {
    saveSessionRef(options.db, group.folder, resolvedSessionRef);
  }

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
    group,
    sessionRef: resolvedSessionRef,
  };
}
