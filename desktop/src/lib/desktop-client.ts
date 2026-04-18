import type {
  CreateCliGroupResult,
  GroupRuntimeEvent,
  GroupRuntimeSnapshot,
  GroupRuntimeSummary,
} from "./runtime-types";

type PromptMode = "prompt" | "follow_up" | "steer";

export interface DesktopClientOptions {
  onOpen?(): void;
  onError?(error: Error): void;
  onEvent(event: GroupRuntimeEvent): void;
}

export interface DesktopSubscription {
  close(): void;
}

const RUNTIME_EVENT_TYPES: GroupRuntimeEvent["type"][] = [
  "snapshot",
  "message_start",
  "message_delta",
  "message_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "queue_update",
  "agent_end",
  "error",
];

async function parseError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as {
      error?: string;
      details?: string;
    };
    if (payload.details) {
      return payload.details;
    }

    if (payload.error) {
      return payload.error;
    }
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }

  return response.statusText || `HTTP ${response.status}`;
}

export class DesktopClient {
  constructor(private readonly baseUrl: string) {}

  async listGroups(): Promise<{ groups: GroupRuntimeSummary[] }> {
    return this.request<{ groups: GroupRuntimeSummary[] }>("/api/desktop/groups");
  }

  async getSnapshot(groupFolder: string): Promise<GroupRuntimeSnapshot> {
    return this.request<GroupRuntimeSnapshot>(
      `/api/desktop/groups/${encodeURIComponent(groupFolder)}/snapshot`,
    );
  }

  async createCliGroup(
    input: { name?: string } = {},
  ): Promise<CreateCliGroupResult> {
    return this.request<CreateCliGroupResult>(
      "/api/desktop/groups/cli",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
  }

  async prompt(
    groupFolder: string,
    input: { text: string; mode?: PromptMode },
  ): Promise<GroupRuntimeSnapshot> {
    return this.request<GroupRuntimeSnapshot>(
      `/api/desktop/groups/${encodeURIComponent(groupFolder)}/prompt`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
  }

  async abort(groupFolder: string): Promise<GroupRuntimeSnapshot> {
    return this.request<GroupRuntimeSnapshot>(
      `/api/desktop/groups/${encodeURIComponent(groupFolder)}/abort`,
      { method: "POST" },
    );
  }

  async newSession(groupFolder: string): Promise<GroupRuntimeSnapshot> {
    return this.request<GroupRuntimeSnapshot>(
      `/api/desktop/groups/${encodeURIComponent(groupFolder)}/session/new`,
      { method: "POST" },
    );
  }

  subscribe(
    groupFolder: string,
    options: DesktopClientOptions,
  ): DesktopSubscription {
    const eventSource = new EventSource(
      this.resolve(`/api/desktop/groups/${encodeURIComponent(groupFolder)}/events`),
    );
    const listeners = RUNTIME_EVENT_TYPES.map((eventType) => {
      const listener = (message: Event) => {
        const payload = message as MessageEvent<string>;
        options.onEvent(JSON.parse(payload.data) as GroupRuntimeEvent);
      };

      eventSource.addEventListener(eventType, listener);
      return { eventType, listener };
    });

    eventSource.onopen = () => {
      options.onOpen?.();
    };

    eventSource.onerror = () => {
      options.onError?.(
        new Error(`Desktop event stream disconnected: ${groupFolder}`),
      );
    };

    return {
      close() {
        for (const { eventType, listener } of listeners) {
          eventSource.removeEventListener(eventType, listener);
        }
        eventSource.close();
      },
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.resolve(path), init);
    if (!response.ok) {
      throw new Error(await parseError(response));
    }

    return response.json() as Promise<T>;
  }

  private resolve(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}
