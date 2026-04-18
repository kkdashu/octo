import type {
  CreateCliGroupResult,
  GroupRuntimeEvent,
  GroupRuntimeSnapshot,
  GroupRuntimeSummary,
  RuntimeRenderableMessage,
} from "./runtime-types";

export type GroupConnectionState = "idle" | "connecting" | "open" | "error";

export interface DesktopViewState {
  groups: GroupRuntimeSummary[];
  snapshotsByGroup: Record<string, GroupRuntimeSnapshot>;
  activeGroupFolder: string | null;
}

function upsertMessage(
  messages: RuntimeRenderableMessage[],
  nextMessage: RuntimeRenderableMessage,
): RuntimeRenderableMessage[] {
  const index = messages.findIndex((message) => message.id === nextMessage.id);
  if (index === -1) {
    return [...messages, nextMessage];
  }

  const next = [...messages];
  next[index] = nextMessage;
  return next;
}

export function createPlaceholderSnapshot(
  group: GroupRuntimeSummary,
): GroupRuntimeSnapshot {
  return {
    groupFolder: group.folder,
    groupName: group.name,
    profileKey: group.profileKey,
    sessionRef: group.sessionRef,
    isStreaming: group.isStreaming,
    pendingFollowUp: [],
    pendingSteering: [],
    messages: [],
  };
}

export function upsertSnapshotRecord(
  current: Record<string, GroupRuntimeSnapshot>,
  snapshot: GroupRuntimeSnapshot,
): Record<string, GroupRuntimeSnapshot> {
  return {
    ...current,
    [snapshot.groupFolder]: snapshot,
  };
}

export function prependGroupSummary(
  current: GroupRuntimeSummary[],
  group: GroupRuntimeSummary,
): GroupRuntimeSummary[] {
  return [
    group,
    ...current.filter((item) => item.folder !== group.folder),
  ];
}

export function syncSummaryWithSnapshot(
  group: GroupRuntimeSummary,
  snapshot: GroupRuntimeSnapshot,
): GroupRuntimeSummary {
  if (group.folder !== snapshot.groupFolder) {
    return group;
  }

  return {
    ...group,
    name: snapshot.groupName,
    profileKey: snapshot.profileKey,
    sessionRef: snapshot.sessionRef,
    isStreaming: snapshot.isStreaming,
  };
}

export function applyRuntimeEvent(
  snapshot: GroupRuntimeSnapshot | null,
  event: GroupRuntimeEvent,
): GroupRuntimeSnapshot | null {
  if (event.type === "snapshot") {
    return event.snapshot;
  }

  if (!snapshot || snapshot.groupFolder !== event.groupFolder) {
    return snapshot;
  }

  if (event.type === "queue_update") {
    return {
      ...snapshot,
      pendingFollowUp: [...event.followUp],
      pendingSteering: [...event.steering],
    };
  }

  if (
    event.type === "message_start"
    || event.type === "message_delta"
  ) {
    return {
      ...snapshot,
      isStreaming: true,
      messages: upsertMessage(snapshot.messages, event.message),
    };
  }

  if (event.type === "message_end") {
    return {
      ...snapshot,
      messages: upsertMessage(snapshot.messages, event.message),
    };
  }

  if (event.type === "agent_end") {
    return {
      ...snapshot,
      isStreaming: false,
    };
  }

  return snapshot;
}

export function applyCreatedCliGroup(
  state: DesktopViewState,
  result: CreateCliGroupResult,
): DesktopViewState {
  return {
    groups: prependGroupSummary(state.groups, result.group),
    snapshotsByGroup: upsertSnapshotRecord(
      state.snapshotsByGroup,
      result.snapshot,
    ),
    activeGroupFolder: result.group.folder,
  };
}
