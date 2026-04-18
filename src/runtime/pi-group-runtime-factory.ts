import type { Database } from "bun:sqlite";
import { relative, resolve, sep } from "node:path";
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
} from "../../pi-mono/packages/coding-agent/src/index.ts";
import { emitSessionShutdownEvent } from "../../pi-mono/packages/coding-agent/src/core/extensions/runner.ts";
import {
  deleteSessionRef,
  getGroupByFolder,
  getSessionRef,
  listGroupMemories,
  saveSessionRef,
  type RegisteredGroup,
} from "../db";
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
  const groupsRoot = resolve(rootDir, "groups");
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

  return getGroupByFolder(db, folder);
}

export function resolveGroupSessionRef(
  db: Database,
  groupFolder: string,
  workingDirectory: string,
): string {
  const persistedSessionRef = getSessionRef(db, groupFolder);
  const resolvedPersistedSessionRef = resolvePersistedPiSessionRef(
    workingDirectory,
    persistedSessionRef,
  );

  if (persistedSessionRef && !resolvedPersistedSessionRef) {
    deleteSessionRef(db, groupFolder);
  }

  if (resolvedPersistedSessionRef) {
    saveSessionRef(db, groupFolder, resolvedPersistedSessionRef);
    return resolvedPersistedSessionRef;
  }

  const sessionManager = SessionManager.continueRecent(
    workingDirectory,
    ensurePiSessionDir(workingDirectory),
  );
  const sessionRef = getPiSessionRef(sessionManager);
  saveSessionRef(db, groupFolder, sessionRef);
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
    const group = getGroupForWorkingDirectory(options.db, cwd, rootDir);
    if (!group) {
      throw new Error(`No registered group matches cwd: ${cwd}`);
    }

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
            listGroupMemories(options.db, group.folder),
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
  },
): Promise<{
  runtime: AgentSessionRuntime;
  group: RegisteredGroup;
  sessionRef: string;
}> {
  const rootDir = options.rootDir ?? process.cwd();
  const group = getGroupByFolder(options.db, options.groupFolder);
  if (!group) {
    throw new Error(`Group not found: ${options.groupFolder}`);
  }

  const workingDirectory = resolve(rootDir, "groups", group.folder);
  const sessionRef = resolveGroupSessionRef(
    options.db,
    group.folder,
    workingDirectory,
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

  saveSessionRef(options.db, group.folder, runtime.session.sessionFile ?? sessionRef);

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
  },
): Promise<{
  host: PiGroupSessionHost;
  group: RegisteredGroup;
  sessionRef: string;
}> {
  const rootDir = options.rootDir ?? process.cwd();
  const group = getGroupByFolder(options.db, options.groupFolder);
  if (!group) {
    throw new Error(`Group not found: ${options.groupFolder}`);
  }

  const workingDirectory = resolve(rootDir, "groups", group.folder);
  const sessionRef = resolveGroupSessionRef(
    options.db,
    group.folder,
    workingDirectory,
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

  saveSessionRef(options.db, group.folder, resolvedSessionRef);

  return {
    host: {
      session: created.session,
      services: created.services,
      diagnostics: created.diagnostics,
      cwd: created.services.cwd,
      async dispose() {
        await emitSessionShutdownEvent(created.session.extensionRunner);
        created.session.dispose();
      },
    },
    group,
    sessionRef: resolvedSessionRef,
  };
}
