import type { GroupConnectionState } from "../lib/runtime-state";
import type { GroupRuntimeSummary } from "../lib/runtime-types";

function getConnectionLabel(state: GroupConnectionState): string {
  if (state === "open") {
    return "已连接";
  }

  if (state === "connecting") {
    return "连接中";
  }

  if (state === "error") {
    return "连接异常";
  }

  return "待命";
}

interface GroupSidebarProps {
  groups: GroupRuntimeSummary[];
  activeGroupFolder: string | null;
  connectionState: GroupConnectionState;
  sidecarBaseUrl: string;
  isCreatingGroup: boolean;
  isCreateFormOpen: boolean;
  createGroupName: string;
  onSelect(groupFolder: string): void;
  onCreateGroup(): void;
  onCreateGroupNameChange(value: string): void;
  onToggleCreateForm(): void;
  onCancelCreateGroup(): void;
}

export function GroupSidebar(props: GroupSidebarProps) {
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <p className="eyebrow">Workspace</p>
        <h2>Group Sessions</h2>
        <div className="sidebar-meta">
          <span className={`status-pill status-pill-${props.connectionState}`}>
            {getConnectionLabel(props.connectionState)}
          </span>
          <span>{props.groups.length} 个 group</span>
        </div>
        <div className="sidebar-meta">
          <span>Sidecar</span>
          <code>{props.sidecarBaseUrl}</code>
        </div>
        <button
          type="button"
          className="sidebar-action button-secondary"
          onClick={props.onToggleCreateForm}
          disabled={props.isCreatingGroup}
        >
          {props.isCreateFormOpen ? "收起创建" : "新建 Group"}
        </button>
        {props.isCreateFormOpen ? (
          <div className="sidebar-create-panel">
            <input
              className="sidebar-create-input"
              type="text"
              value={props.createGroupName}
              placeholder="输入 group 名称，可留空"
              onChange={(event) => props.onCreateGroupNameChange(event.target.value)}
              disabled={props.isCreatingGroup}
            />
            <div className="sidebar-create-actions">
              <button
                type="button"
                className="button-primary"
                onClick={props.onCreateGroup}
                disabled={props.isCreatingGroup}
              >
                {props.isCreatingGroup ? "创建中..." : "确认创建"}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={props.onCancelCreateGroup}
                disabled={props.isCreatingGroup}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}
      </header>
      <div className="group-list">
        {props.groups.length === 0 ? (
          <div className="empty-card">
            <h3>还没有可用 group</h3>
            <p>可以直接点击上方按钮创建一个新的 CLI group。</p>
          </div>
        ) : null}
        {props.groups.map((group) => (
          <button
            key={group.folder}
            className={`group-card ${
              group.folder === props.activeGroupFolder ? "group-card-active" : ""
            }`}
            type="button"
            onClick={() => props.onSelect(group.folder)}
          >
            <div className="group-card-header">
              <strong
                className="group-card-title"
                title={group.name}
              >
                {group.name}
              </strong>
              {group.isStreaming ? <span className="group-streaming-dot" /> : null}
            </div>
            <div className="group-card-footer group-card-footer-primary">
              {group.isMain ? <span className="group-badge">MAIN</span> : null}
              <span
                className="group-card-folder"
                title={group.folder}
              >
                {group.folder}
              </span>
            </div>
            <div className="group-card-footer">
              <span>Profile: {group.profileKey}</span>
              <span>{group.sessionRef ? "已恢复会话" : "尚无会话"}</span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}
