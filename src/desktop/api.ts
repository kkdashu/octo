import { z } from "zod";
import type {
  CreateCliGroupResult,
  GroupRuntimeSnapshotController,
} from "../kernel/types";
import { log } from "../logger";
import { WorkspaceService } from "../workspace-service";

type RouteRequest = Request & {
  params?: Record<string, string>;
};

export interface DesktopApiRouter {
  listGroups(req: Request): Response;
  listWorkspaces(req: Request): Response;
  createCliGroup(req: Request): Promise<Response>;
  createCliWorkspace(req: Request): Promise<Response>;
  createChat(req: Request): Promise<Response>;
  getSnapshot(req: Request): Promise<Response>;
  prompt(req: Request): Promise<Response>;
  abort(req: Request): Promise<Response>;
  newSession(req: Request): Promise<Response>;
  getEvents(req: Request): Promise<Response>;
  listBranches(req: Request): Promise<Response>;
  switchBranch(req: Request): Promise<Response>;
  forkBranch(req: Request): Promise<Response>;
}

export interface DesktopApiRouterOptions {
  workspaceService?: WorkspaceService;
  createCliGroup?: (input: { name?: string }) => Promise<CreateCliGroupResult>;
  createCliWorkspace?: (input: { name?: string }) => Promise<CreateCliGroupResult>;
}

const TAG = "desktop-api";

const promptSchema = z.object({
  text: z.string().trim().min(1, "消息不能为空"),
  mode: z.enum(["prompt", "follow_up", "steer"]).optional(),
});

const createCliWorkspaceSchema = z.object({
  name: z.string().optional(),
}).transform(({ name }) => {
  const normalizedName = name?.trim();
  return {
    name: normalizedName || undefined,
  };
});

const createChatSchema = z.object({
  title: z.string().optional(),
});

const switchBranchSchema = z.object({
  branch: z.string().trim().min(1, "branch 不能为空"),
  confirm: z.boolean(),
  allowDirty: z.boolean().optional(),
});

const forkBranchSchema = z.object({
  branch: z.string().trim().min(1, "branch 不能为空"),
  confirm: z.boolean(),
  fromBranch: z.string().trim().optional(),
  allowDirty: z.boolean().optional(),
});

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(status: number, error: string, details?: string): Response {
  return json(
    details ? { error, details } : { error },
    status,
  );
}

function getRequestMeta(req: Request): {
  method: string;
  path: string;
} {
  try {
    return {
      method: req.method,
      path: new URL(req.url).pathname,
    };
  } catch {
    return {
      method: req.method,
      path: req.url,
    };
  }
}

function serializeErrorForLog(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    return {
      name: error.name,
      issues: error.issues.map((issue) => issue.message),
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
}

function logRouteError(
  route: string,
  req: Request,
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  log.error(TAG, `Desktop API ${route} failed`, {
    ...getRequestMeta(req),
    ...context,
    error: serializeErrorForLog(error),
  });
}

function getWorkspaceIdParam(req: Request): string {
  const workspaceId = (req as RouteRequest).params?.workspaceId;
  if (!workspaceId) {
    throw new Error("Missing route param: workspaceId");
  }

  return workspaceId;
}

function getChatIdParam(req: Request): string {
  const chatId = (req as RouteRequest).params?.chatId
    ?? (req as RouteRequest).params?.folder;
  if (!chatId) {
    throw new Error("Missing route param: chatId");
  }

  return chatId;
}

function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function mapErrorStatus(error: unknown): number {
  if (!(error instanceof Error)) {
    return 500;
  }

  if (
    error.message.startsWith("Workspace not found:")
    || error.message.startsWith("Chat not found:")
    || error.message.startsWith("CLI group not found:")
  ) {
    return 404;
  }

  if (
    error.message.startsWith("Branch not found:")
    || error.message.includes("requires explicit confirmation")
    || error.message.includes("group_not_found")
  ) {
    return 400;
  }

  if (
    error.message.includes("active run")
    || error.message.includes("uncommitted changes")
  ) {
    return 409;
  }

  return 500;
}

function toErrorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return errorResponse(
      400,
      "invalid_request",
      error.issues.map((issue) => issue.message).join("; "),
    );
  }

  if (error instanceof Error) {
    return errorResponse(
      mapErrorStatus(error),
      "internal_error",
      error.message,
    );
  }

  return errorResponse(500, "internal_error");
}

export function createDesktopApiRouter(
  manager: GroupRuntimeSnapshotController & {
    listBranches?: (chatId: string) => {
      currentBranch: string;
      branches: string[];
      isDirty: boolean;
    };
    switchBranch?: (
      chatId: string,
      branch: string,
      options: {
        confirm: boolean;
        allowDirty?: boolean;
      },
    ) => Promise<unknown>;
    forkBranch?: (
      chatId: string,
      branch: string,
      options: {
        confirm: boolean;
        fromBranch?: string;
        allowDirty?: boolean;
      },
    ) => Promise<unknown>;
  },
  options: DesktopApiRouterOptions = {},
): DesktopApiRouter {
  const workspaceService = options.workspaceService;
  const createCliWorkspace = options.createCliWorkspace ?? options.createCliGroup;

  return {
    listGroups() {
      return json({
        groups: manager.listGroups(),
      });
    },

    listWorkspaces() {
      if (!workspaceService) {
        return json({
          workspaces: [],
        });
      }
      const summaries = manager.listGroups();
      const summaryByChatId = new Map(summaries.map((summary) => [summary.chatId, summary]));
      const workspaces = workspaceService.listWorkspaces().map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        folder: workspace.folder,
        defaultBranch: workspace.default_branch,
        profileKey: workspace.profile_key,
        isMain: workspace.is_main === 1,
        chats: workspaceService.listChats(workspace.id).map((chat) => {
          const summary = summaryByChatId.get(chat.id);
          return {
            id: chat.id,
            title: chat.title,
            activeBranch: chat.active_branch,
            sessionRef: chat.session_ref,
            isStreaming: summary?.isStreaming ?? false,
            lastActivityAt: chat.last_activity_at,
          };
        }),
      }));

      return json({ workspaces });
    },

    async createCliWorkspace(req) {
      let requestedName: string | null = null;
      try {
        if (!createCliWorkspace) {
          return errorResponse(
            501,
            "not_implemented",
            "createCliWorkspace is unavailable",
          );
        }

        const body = createCliWorkspaceSchema.parse(
          await req.json().catch(() => ({})),
        );
        requestedName = body.name ?? null;
        log.info(TAG, "Received desktop createCliGroup request", {
          ...getRequestMeta(req),
          requestedName,
        });
        const result = await createCliWorkspace(body);
        const legacyGroup = (result as { group?: { folder: string; name: string } }).group;
        const createdSummary = "summary" in result
          ? result.summary
          : {
              folder: legacyGroup?.folder ?? "",
              name: legacyGroup?.name ?? "",
            };
        log.info(TAG, "Desktop createCliGroup succeeded", {
          ...getRequestMeta(req),
          requestedName,
          status: 201,
          groupFolder: createdSummary.folder,
          groupName: createdSummary.name,
        });
        return json(result, 201);
      } catch (error) {
        logRouteError("createCliGroup", req, error, {
          requestedName,
        });
        return toErrorResponse(error);
      }
    },

    async createCliGroup(req) {
      return this.createCliWorkspace(req);
    },

    async createChat(req) {
      try {
        if (!workspaceService) {
          return errorResponse(501, "not_implemented", "workspaceService is unavailable");
        }
        const workspaceId = getWorkspaceIdParam(req);
        const body = createChatSchema.parse(
          await req.json().catch(() => ({})),
        );
        const chat = workspaceService.createChat(workspaceId, {
          title: body.title?.trim() || undefined,
        });
        const snapshot = await manager.getSnapshot(chat.id);
        return json({ chat, snapshot }, 201);
      } catch (error) {
        return toErrorResponse(error);
      }
    },

    async getSnapshot(req) {
      try {
        const chatId = getChatIdParam(req);
        const snapshot = await manager.getSnapshot(chatId);
        return json(snapshot);
      } catch (error) {
        return toErrorResponse(error);
      }
    },

    async prompt(req) {
      try {
        const chatId = getChatIdParam(req);
        const body = promptSchema.parse(await req.json());
        const snapshot = await manager.prompt(chatId, {
          text: body.text,
          mode: body.mode ?? "prompt",
        });
        return json(snapshot);
      } catch (error) {
        return toErrorResponse(error);
      }
    },

    async abort(req) {
      try {
        const chatId = getChatIdParam(req);
        const snapshot = await manager.abort(chatId);
        return json(snapshot);
      } catch (error) {
        return toErrorResponse(error);
      }
    },

    async newSession(req) {
      try {
        const chatId = getChatIdParam(req);
        const snapshot = await manager.newSession(chatId);
        return json(snapshot);
      } catch (error) {
        return toErrorResponse(error);
      }
    },

    async getEvents(req) {
      try {
        const chatId = getChatIdParam(req);
        const initialSnapshot = await manager.getSnapshot(chatId);
        const encoder = new TextEncoder();

        let unsubscribe: () => void = () => undefined;
        let closed = false;

        const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
          if (closed) {
            return;
          }

          closed = true;
          unsubscribe();
          controller.close();
        };

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(formatSseEvent("snapshot", {
                type: "snapshot",
                snapshot: initialSnapshot,
              })),
            );

            unsubscribe = manager.subscribe(chatId, (event) => {
              if (closed) {
                return;
              }

              controller.enqueue(
                encoder.encode(formatSseEvent(event.type, event)),
              );
            });

            req.signal.addEventListener("abort", () => close(controller), {
              once: true,
            });
          },
          cancel() {
            unsubscribe();
            closed = true;
          },
        });

        return new Response(stream, {
          headers: {
            "cache-control": "no-cache",
            connection: "keep-alive",
            "content-type": "text/event-stream",
          },
        });
      } catch (error) {
        return toErrorResponse(error);
      }
    },

    async listBranches(req) {
      try {
        if (!manager.listBranches) {
          return errorResponse(501, "not_implemented", "listBranches is unavailable");
        }
        const chatId = getChatIdParam(req);
        return json(manager.listBranches(chatId));
      } catch (error) {
        return toErrorResponse(error);
      }
    },

    async switchBranch(req) {
      try {
        if (!manager.switchBranch) {
          return errorResponse(501, "not_implemented", "switchBranch is unavailable");
        }
        const chatId = getChatIdParam(req);
        const body = switchBranchSchema.parse(await req.json());
        const snapshot = await manager.switchBranch(chatId, body.branch, {
          confirm: body.confirm,
          allowDirty: body.allowDirty,
        });
        return json(snapshot);
      } catch (error) {
        return toErrorResponse(error);
      }
    },

    async forkBranch(req) {
      try {
        if (!manager.forkBranch) {
          return errorResponse(501, "not_implemented", "forkBranch is unavailable");
        }
        const chatId = getChatIdParam(req);
        const body = forkBranchSchema.parse(await req.json());
        const snapshot = await manager.forkBranch(chatId, body.branch, {
          confirm: body.confirm,
          fromBranch: body.fromBranch,
          allowDirty: body.allowDirty,
        });
        return json(snapshot);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  };
}
