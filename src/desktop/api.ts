import { z } from "zod";
import type {
  CreateCliGroupResult,
  GroupRuntimeSnapshotController,
} from "../kernel/types";
import { log } from "../logger";

type RouteRequest = Request & {
  params?: Record<string, string>;
};

export interface DesktopApiRouter {
  listGroups(req: Request): Response;
  createCliGroup(req: Request): Promise<Response>;
  getSnapshot(req: Request): Promise<Response>;
  prompt(req: Request): Promise<Response>;
  abort(req: Request): Promise<Response>;
  newSession(req: Request): Promise<Response>;
  getEvents(req: Request): Promise<Response>;
}

export interface DesktopApiRouterOptions {
  createCliGroup?: (input: { name?: string }) => Promise<CreateCliGroupResult>;
}

const TAG = "desktop-api";

const promptSchema = z.object({
  text: z.string().trim().min(1, "消息不能为空"),
  mode: z.enum(["prompt", "follow_up", "steer"]).optional(),
});

const createCliGroupSchema = z.object({
  name: z.string().optional(),
}).transform(({ name }) => {
  const normalizedName = name?.trim();
  return {
    name: normalizedName || undefined,
  };
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

function getFolderParam(req: Request): string {
  const folder = (req as RouteRequest).params?.folder;
  if (!folder) {
    throw new Error("Missing route param: folder");
  }

  return folder;
}

function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function mapErrorStatus(error: unknown): number {
  if (!(error instanceof Error)) {
    return 500;
  }

  if (
    error.message.startsWith("Group not found:")
    || error.message.startsWith("CLI group not found:")
  ) {
    return 404;
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
  manager: GroupRuntimeSnapshotController,
  options: DesktopApiRouterOptions = {},
): DesktopApiRouter {
  return {
    listGroups() {
      return json({
        groups: manager.listGroups(),
      });
    },

    async createCliGroup(req) {
      let requestedName: string | null = null;
      try {
        if (!options.createCliGroup) {
          log.warn(TAG, "Desktop API createCliGroup is unavailable", getRequestMeta(req));
          return errorResponse(
            501,
            "not_implemented",
            "createCliGroup is unavailable",
          );
        }

        const body = createCliGroupSchema.parse(
          await req.json().catch(() => ({})),
        );
        requestedName = body.name ?? null;
        log.info(TAG, "Received desktop createCliGroup request", {
          ...getRequestMeta(req),
          requestedName,
        });
        const result = await options.createCliGroup(body);
        log.info(TAG, "Desktop createCliGroup succeeded", {
          ...getRequestMeta(req),
          requestedName,
          status: 201,
          groupFolder: result.group.folder,
          groupName: result.group.name,
        });
        return json(result, 201);
      } catch (error) {
        logRouteError("createCliGroup", req, error, {
          requestedName,
        });
        return toErrorResponse(error);
      }
    },

    async getSnapshot(req) {
      try {
        const folder = getFolderParam(req);
        const snapshot = await manager.getSnapshot(folder);
        return json(snapshot);
      } catch (error) {
        return toErrorResponse(error);
      }
    },

    async prompt(req) {
      try {
        const folder = getFolderParam(req);
        const body = promptSchema.parse(await req.json());
        const snapshot = await manager.prompt(folder, {
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
        const folder = getFolderParam(req);
        const snapshot = await manager.abort(folder);
        return json(snapshot);
      } catch (error) {
        return toErrorResponse(error);
      }
    },

    async newSession(req) {
      try {
        const folder = getFolderParam(req);
        const snapshot = await manager.newSession(folder);
        return json(snapshot);
      } catch (error) {
        return toErrorResponse(error);
      }
    },

    async getEvents(req) {
      try {
        const folder = getFolderParam(req);
        const initialSnapshot = await manager.getSnapshot(folder);
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

            unsubscribe = manager.subscribe(folder, (event) => {
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
  };
}
