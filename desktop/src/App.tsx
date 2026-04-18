import { useEffect, useRef, useState } from "react";
import { Composer } from "./components/composer";
import { GroupSidebar } from "./components/group-sidebar";
import { TranscriptView } from "./components/transcript-view";
import { DesktopClient } from "./lib/desktop-client";
import { getDesktopConfig } from "./lib/desktop-config";
import {
  applyCreatedCliGroup,
  applyRuntimeEvent,
  createPlaceholderSnapshot,
  syncSummaryWithSnapshot,
  upsertSnapshotRecord,
  type GroupConnectionState,
} from "./lib/runtime-state";
import type {
  GroupRuntimeEvent,
  GroupRuntimeSnapshot,
  GroupRuntimeSummary,
} from "./lib/runtime-types";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function syncGroupsWithSnapshot(
  current: GroupRuntimeSummary[],
  snapshot: GroupRuntimeSnapshot,
): GroupRuntimeSummary[] {
  return current.map((group) => syncSummaryWithSnapshot(group, snapshot));
}

function syncGroupsStreamingState(
  current: GroupRuntimeSummary[],
  groupFolder: string,
  isStreaming: boolean,
): GroupRuntimeSummary[] {
  return current.map((group) =>
    group.folder === groupFolder
      ? {
          ...group,
          isStreaming,
        }
      : group
  );
}

function getGroupByFolder(
  groups: GroupRuntimeSummary[],
  groupFolder: string | null,
): GroupRuntimeSummary | null {
  if (!groupFolder) {
    return null;
  }

  return groups.find((group) => group.folder === groupFolder) ?? null;
}

function getSnapshotForGroup(
  snapshotsByGroup: Record<string, GroupRuntimeSnapshot>,
  groups: GroupRuntimeSummary[],
  groupFolder: string | null,
): GroupRuntimeSnapshot | null {
  if (!groupFolder) {
    return null;
  }

  const snapshot = snapshotsByGroup[groupFolder];
  if (snapshot) {
    return snapshot;
  }

  const group = getGroupByFolder(groups, groupFolder);
  return group ? createPlaceholderSnapshot(group) : null;
}

export function App() {
  const [config] = useState(() => getDesktopConfig());
  const [client] = useState(() => new DesktopClient(config.sidecarBaseUrl));
  const [groups, setGroups] = useState<GroupRuntimeSummary[]>([]);
  const [activeGroupFolder, setActiveGroupFolder] = useState<string | null>(null);
  const [snapshotsByGroup, setSnapshotsByGroup] = useState<Record<string, GroupRuntimeSnapshot>>({});
  const [connectionState, setConnectionState] = useState<GroupConnectionState>("idle");
  const [composerValue, setComposerValue] = useState("");
  const [statusText, setStatusText] = useState("正在连接 desktop sidecar...");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [createGroupName, setCreateGroupName] = useState("");
  const groupsRef = useRef<GroupRuntimeSummary[]>([]);
  const snapshotsRef = useRef<Record<string, GroupRuntimeSnapshot>>({});

  groupsRef.current = groups;
  snapshotsRef.current = snapshotsByGroup;

  const activeSnapshot = getSnapshotForGroup(
    snapshotsByGroup,
    groups,
    activeGroupFolder,
  );

  function storeSnapshot(snapshot: GroupRuntimeSnapshot): void {
    setSnapshotsByGroup((current) => upsertSnapshotRecord(current, snapshot));
    setGroups((current) => syncGroupsWithSnapshot(current, snapshot));
  }

  function handleRuntimeEvent(event: GroupRuntimeEvent): void {
    if (event.type === "snapshot") {
      storeSnapshot(event.snapshot);
      return;
    }

    if (event.type === "error") {
      setStatusText(event.message);
    }

    setSnapshotsByGroup((current) => {
      const previous = getSnapshotForGroup(
        current,
        groupsRef.current,
        event.groupFolder,
      );
      const next = applyRuntimeEvent(previous, event);
      return next ? upsertSnapshotRecord(current, next) : current;
    });

    if (event.type === "message_start") {
      setGroups((current) => syncGroupsStreamingState(current, event.groupFolder, true));
      return;
    }

    if (event.type === "agent_end") {
      setGroups((current) => syncGroupsStreamingState(current, event.groupFolder, false));
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadGroups(): Promise<void> {
      try {
        const response = await client.listGroups();
        if (cancelled) {
          return;
        }

        setGroups(response.groups);
        setSnapshotsByGroup((current) => {
          const next = { ...current };
          for (const group of response.groups) {
            if (!next[group.folder]) {
              next[group.folder] = createPlaceholderSnapshot(group);
            }
          }
          return next;
        });
        setActiveGroupFolder((current) => {
          if (current && response.groups.some((group) => group.folder === current)) {
            return current;
          }

          return response.groups[0]?.folder ?? null;
        });
        setStatusText(
          response.groups.length > 0
            ? `已发现 ${response.groups.length} 个 group`
            : "当前还没有已注册群。",
        );
      } catch (error) {
        if (!cancelled) {
          setConnectionState("error");
          setStatusText(`加载 group 列表失败：${formatError(error)}`);
        }
      }
    }

    void loadGroups();
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (!activeGroupFolder) {
      setConnectionState("idle");
      return;
    }

    let cancelled = false;
    setConnectionState("connecting");
    setStatusText(`正在同步 ${activeGroupFolder}...`);

    void client.getSnapshot(activeGroupFolder).then((snapshot) => {
      if (cancelled) {
        return;
      }

      storeSnapshot(snapshot);
      setStatusText(`已加载 ${snapshot.groupName}`);
    }).catch((error) => {
      if (!cancelled) {
        setConnectionState("error");
        setStatusText(`拉取 snapshot 失败：${formatError(error)}`);
      }
    });

    const subscription = client.subscribe(activeGroupFolder, {
      onOpen: () => {
        if (cancelled) {
          return;
        }

        setConnectionState("open");
        setStatusText(`SSE 已连接：${activeGroupFolder}`);
      },
      onError: (error) => {
        if (cancelled) {
          return;
        }

        setConnectionState("error");
        setStatusText(`SSE 连接异常：${formatError(error)}`);
      },
      onEvent: (event) => {
        if (!cancelled) {
          handleRuntimeEvent(event);
        }
      },
    });

    return () => {
      cancelled = true;
      subscription.close();
    };
  }, [activeGroupFolder, client]);

  async function submitPrompt(): Promise<void> {
    if (!activeGroupFolder) {
      return;
    }

    const text = composerValue.trim();
    if (!text) {
      return;
    }

    setIsSubmitting(true);
    try {
      const snapshot = await client.prompt(activeGroupFolder, {
        text,
        mode: "prompt",
      });
      storeSnapshot(snapshot);
      setComposerValue("");
      setStatusText(`已发送到 ${snapshot.groupName}`);
    } catch (error) {
      setStatusText(`发送失败：${formatError(error)}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function abortRun(): Promise<void> {
    if (!activeGroupFolder) {
      return;
    }

    try {
      const snapshot = await client.abort(activeGroupFolder);
      storeSnapshot(snapshot);
      setStatusText(`已请求停止 ${snapshot.groupName}`);
    } catch (error) {
      setStatusText(`停止失败：${formatError(error)}`);
    }
  }

  async function createNewSession(): Promise<void> {
    if (!activeGroupFolder) {
      return;
    }

    try {
      const snapshot = await client.newSession(activeGroupFolder);
      storeSnapshot(snapshot);
      setStatusText(`已为 ${snapshot.groupName} 创建新会话`);
    } catch (error) {
      setStatusText(`新会话创建失败：${formatError(error)}`);
    }
  }

  async function createCliGroup(): Promise<void> {
    if (isCreatingGroup) {
      return;
    }

    const requestedName = createGroupName.trim();
    setIsCreatingGroup(true);
    setStatusText(
      requestedName
        ? `正在创建 group：${requestedName}...`
        : "正在创建 group...",
    );
    console.info("[octo-desktop] creating CLI group", {
      requestedName: requestedName || null,
      sidecarBaseUrl: config.sidecarBaseUrl,
    });
    try {
      const result = await client.createCliGroup({
        name: requestedName || undefined,
      });
      const nextState = applyCreatedCliGroup(
        {
          groups: groupsRef.current,
          snapshotsByGroup: snapshotsRef.current,
          activeGroupFolder,
        },
        result,
      );
      setGroups(nextState.groups);
      setSnapshotsByGroup(nextState.snapshotsByGroup);
      setActiveGroupFolder(nextState.activeGroupFolder);
      setCreateGroupName("");
      setIsCreateFormOpen(false);
      console.info("[octo-desktop] created CLI group", {
        requestedName: requestedName || null,
        groupFolder: result.group.folder,
        groupName: result.group.name,
      });
      setStatusText(`已创建 ${result.group.name}`);
    } catch (error) {
      console.error("[octo-desktop] failed to create CLI group", {
        requestedName: requestedName || null,
        error,
      });
      setStatusText(`创建 group 失败：${formatError(error)}`);
    } finally {
      setIsCreatingGroup(false);
    }
  }

  return (
    <div className="app-shell">
      <GroupSidebar
        groups={groups}
        activeGroupFolder={activeGroupFolder}
        connectionState={connectionState}
        sidecarBaseUrl={config.sidecarBaseUrl}
        isCreatingGroup={isCreatingGroup}
        isCreateFormOpen={isCreateFormOpen}
        createGroupName={createGroupName}
        onSelect={setActiveGroupFolder}
        onCreateGroup={() => {
          void createCliGroup();
        }}
        onCreateGroupNameChange={setCreateGroupName}
        onToggleCreateForm={() => {
          setIsCreateFormOpen((current) => !current);
        }}
        onCancelCreateGroup={() => {
          setCreateGroupName("");
          setIsCreateFormOpen(false);
        }}
      />
      <main className="workspace">
        <header className="workspace-header">
          <div className="workspace-heading">
            <p className="eyebrow">Octo Desktop</p>
            <h1
              className="workspace-title"
              title={activeSnapshot?.groupName ?? "未选择 group"}
            >
              {activeSnapshot?.groupName ?? "未选择 group"}
            </h1>
          </div>
          <div className="workspace-meta-panel">
            <div className="workspace-meta-status">
              <span className={`status-pill status-pill-${connectionState}`}>
                {connectionState === "open" && "SSE 已连接"}
                {connectionState === "connecting" && "正在连接"}
                {connectionState === "error" && "连接异常"}
                {connectionState === "idle" && "等待选择"}
              </span>
            </div>
            {activeSnapshot ? (
              <div className="workspace-meta-list">
                <div className="workspace-meta-row">
                  <span className="workspace-meta-label">Profile</span>
                  <span
                    className="workspace-meta-value"
                    title={activeSnapshot.profileKey}
                  >
                    {activeSnapshot.profileKey}
                  </span>
                </div>
                <div className="workspace-meta-row">
                  <span className="workspace-meta-label">Session</span>
                  <span
                    className="workspace-meta-value workspace-meta-value-session"
                    title={activeSnapshot.sessionRef ?? "未创建"}
                  >
                    {activeSnapshot.sessionRef ?? "未创建"}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </header>
        <TranscriptView snapshot={activeSnapshot} statusText={statusText} />
        <Composer
          value={composerValue}
          onChange={setComposerValue}
          onSubmit={() => {
            void submitPrompt();
          }}
          onAbort={() => {
            void abortRun();
          }}
          onNewSession={() => {
            void createNewSession();
          }}
          disabled={!activeGroupFolder}
          isStreaming={activeSnapshot?.isStreaming ?? false}
          isSubmitting={isSubmitting}
          groupName={activeSnapshot?.groupName ?? null}
        />
      </main>
    </div>
  );
}
