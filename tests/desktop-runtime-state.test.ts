import { describe, expect, test } from "bun:test";
import {
  applyCreatedCliGroup,
  applyRuntimeEvent,
  createPlaceholderSnapshot,
  syncSummaryWithSnapshot,
} from "../desktop/src/lib/runtime-state";
import type {
  CreateCliGroupResult,
  GroupRuntimeEvent,
  GroupRuntimeSnapshot,
  GroupRuntimeSummary,
} from "../src/kernel/types";

function createSummary(
  overrides: Partial<GroupRuntimeSummary> = {},
): GroupRuntimeSummary {
  return {
    folder: "main",
    name: "Main Group",
    channelType: "cli",
    profileKey: "claude",
    sessionRef: "/tmp/main.jsonl",
    isStreaming: false,
    ...overrides,
  };
}

function createSnapshot(
  overrides: Partial<GroupRuntimeSnapshot> = {},
): GroupRuntimeSnapshot {
  return {
    groupFolder: "main",
    groupName: "Main Group",
    profileKey: "claude",
    sessionRef: "/tmp/main.jsonl",
    isStreaming: false,
    pendingFollowUp: [],
    pendingSteering: [],
    messages: [],
    ...overrides,
  };
}

describe("desktop runtime state", () => {
  test("creates placeholder snapshots from group summary", () => {
    const summary = createSummary({ isStreaming: true });
    expect(createPlaceholderSnapshot(summary)).toEqual({
      groupFolder: "main",
      groupName: "Main Group",
      profileKey: "claude",
      sessionRef: "/tmp/main.jsonl",
      isStreaming: true,
      pendingFollowUp: [],
      pendingSteering: [],
      messages: [],
    });
  });

  test("applies message events and queue updates to a snapshot", () => {
    const startEvent: GroupRuntimeEvent = {
      type: "message_start",
      groupFolder: "main",
      message: {
        id: "assistant-1",
        role: "assistant",
        timestamp: 1,
        blocks: [{ type: "text", text: "正在分析..." }],
      },
    };
    const queueEvent: GroupRuntimeEvent = {
      type: "queue_update",
      groupFolder: "main",
      followUp: ["继续补充"],
      steering: ["保持简洁"],
    };
    const endEvent: GroupRuntimeEvent = {
      type: "agent_end",
      groupFolder: "main",
    };

    const afterStart = applyRuntimeEvent(createSnapshot(), startEvent);
    expect(afterStart).toMatchObject({
      isStreaming: true,
      messages: [
        {
          id: "assistant-1",
          blocks: [{ type: "text", text: "正在分析..." }],
        },
      ],
    });

    const afterQueue = applyRuntimeEvent(afterStart, queueEvent);
    expect(afterQueue).toMatchObject({
      pendingFollowUp: ["继续补充"],
      pendingSteering: ["保持简洁"],
    });

    const afterEnd = applyRuntimeEvent(afterQueue, endEvent);
    expect(afterEnd?.isStreaming).toBe(false);
  });

  test("replaces snapshot directly on snapshot event", () => {
    const replacement = createSnapshot({
      groupName: "Fresh Group",
      sessionRef: "/tmp/fresh.jsonl",
    });
    const event: GroupRuntimeEvent = {
      type: "snapshot",
      snapshot: replacement,
    };

    expect(applyRuntimeEvent(createSnapshot(), event)).toEqual(replacement);
  });

  test("syncs summary metadata from snapshot", () => {
    const summary = createSummary();
    const snapshot = createSnapshot({
      groupName: "Renamed Group",
      profileKey: "kimi",
      sessionRef: "/tmp/renamed.jsonl",
      isStreaming: true,
    });

    expect(syncSummaryWithSnapshot(summary, snapshot)).toEqual({
      ...summary,
      name: "Renamed Group",
      profileKey: "kimi",
      sessionRef: "/tmp/renamed.jsonl",
      isStreaming: true,
    });
  });

  test("applies newly created CLI group state and auto-selects it", () => {
    const created: CreateCliGroupResult = {
      group: createSummary({
        folder: "cli_20260418_test",
        name: "New Desktop Group",
        sessionRef: null,
      }),
      snapshot: createSnapshot({
        groupFolder: "cli_20260418_test",
        groupName: "New Desktop Group",
        sessionRef: null,
      }),
    };

    expect(applyCreatedCliGroup({
      groups: [createSummary()],
      snapshotsByGroup: { main: createSnapshot() },
      activeGroupFolder: "main",
    }, created)).toEqual({
      groups: [
        created.group,
        createSummary(),
      ],
      snapshotsByGroup: {
        main: createSnapshot(),
        cli_20260418_test: created.snapshot,
      },
      activeGroupFolder: "cli_20260418_test",
    });
  });
});
