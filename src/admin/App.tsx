import { useEffect, useState, useTransition } from "react";
import { adminApiClient } from "./api-client";
import type {
  AdminDirectoryListingDto,
  AdminFileContentDto,
  AdminGroupDetailResponse,
  AdminGroupDto,
  AdminProfileOption,
} from "./types";

type SettingsDraft = {
  name: string;
  triggerPattern: string;
  requiresTrigger: boolean;
  agentProvider: string;
};

function getParentPath(path: string): string | null {
  if (path === ".") {
    return null;
  }

  const parts = path.split("/");
  parts.pop();
  return parts.length === 0 ? "." : parts.join("/");
}

function createSettingsDraft(group: AdminGroupDto): SettingsDraft {
  return {
    name: group.name,
    triggerPattern: group.triggerPattern,
    requiresTrigger: group.requiresTrigger,
    agentProvider: group.agentProvider,
  };
}

export function App() {
  const [groups, setGroups] = useState<AdminGroupDto[]>([]);
  const [profiles, setProfiles] = useState<AdminProfileOption[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [groupDetail, setGroupDetail] = useState<AdminGroupDetailResponse | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
  const [directory, setDirectory] = useState<AdminDirectoryListingDto | null>(null);
  const [openFile, setOpenFile] = useState<AdminFileContentDto | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [statusText, setStatusText] = useState("正在加载群列表...");
  const [isPending, startTransition] = useTransition();
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSavingFile, setIsSavingFile] = useState(false);

  async function refreshGroups(preserveSelection = true) {
    const response = await adminApiClient.listGroups();
    setGroups(response.groups);
    setProfiles(response.availableProfiles);

    if (response.groups.length === 0) {
      setSelectedFolder(null);
      setStatusText("当前还没有已注册群。");
      return;
    }

    if (preserveSelection && selectedFolder && response.groups.some((group) => group.folder === selectedFolder)) {
      return;
    }

    setSelectedFolder(response.groups[0]!.folder);
  }

  async function loadGroup(folder: string, path = ".") {
    const [detail, listing] = await Promise.all([
      adminApiClient.getGroup(folder),
      adminApiClient.listFiles(folder, path),
    ]);
    setGroupDetail(detail);
    setSettingsDraft(createSettingsDraft(detail.group));
    setProfiles(detail.availableProfiles);
    setDirectory(listing);
    setOpenFile(null);
    setEditorValue("");
  }

  useEffect(() => {
    void refreshGroups(false).catch((error: unknown) => {
      setStatusText(error instanceof Error ? error.message : "加载群列表失败");
    });
  }, []);

  useEffect(() => {
    if (!selectedFolder) {
      setGroupDetail(null);
      setSettingsDraft(null);
      setDirectory(null);
      setOpenFile(null);
      setEditorValue("");
      return;
    }

    setStatusText(`正在加载 ${selectedFolder}...`);
    void loadGroup(selectedFolder).then(() => {
      setStatusText(`已加载 ${selectedFolder}`);
    }).catch((error: unknown) => {
      setStatusText(error instanceof Error ? error.message : "加载群详情失败");
    });
  }, [selectedFolder]);

  async function navigateDirectory(path: string) {
    if (!selectedFolder) return;
    try {
      const listing = await adminApiClient.listFiles(selectedFolder, path);
      setDirectory(listing);
      setStatusText(`当前目录：${listing.path}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "目录加载失败");
    }
  }

  async function openTextFile(path: string) {
    if (!selectedFolder) return;
    try {
      const file = await adminApiClient.getFile(selectedFolder, path);
      setOpenFile(file);
      setEditorValue(file.content);
      setStatusText(`已打开文件：${file.path}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "文件读取失败");
    }
  }

  async function saveSettings() {
    if (!selectedFolder || !settingsDraft) return;
    setIsSavingSettings(true);
    try {
      const response = await adminApiClient.updateGroup(selectedFolder, settingsDraft);
      setGroupDetail(response);
      setSettingsDraft(createSettingsDraft(response.group));
      await refreshGroups();
      setStatusText(`群信息已保存：${response.group.name}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "群信息保存失败");
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function saveCurrentFile() {
    if (!selectedFolder || !openFile) return;
    setIsSavingFile(true);
    try {
      const updated = await adminApiClient.updateFile(selectedFolder, openFile.path, editorValue);
      setOpenFile(updated);
      setEditorValue(updated.content);
      if (directory) {
        await navigateDirectory(directory.path);
      }
      setStatusText(`文件已保存：${updated.path}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "文件保存失败");
    } finally {
      setIsSavingFile(false);
    }
  }

  async function createFile() {
    if (!selectedFolder) return;
    const suggestedPath = directory?.path === "." || !directory ? "" : `${directory.path}/`;
    const input = window.prompt("输入新文件路径", suggestedPath);
    if (!input) return;

    try {
      const file = await adminApiClient.createFile(selectedFolder, input, "", true);
      const parentPath = getParentPath(file.path) ?? ".";
      await navigateDirectory(parentPath);
      setOpenFile(file);
      setEditorValue(file.content);
      setStatusText(`已创建文件：${file.path}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "创建文件失败");
    }
  }

  async function createFolder() {
    if (!selectedFolder) return;
    const suggestedPath = directory?.path === "." || !directory ? "" : `${directory.path}/`;
    const input = window.prompt("输入新目录路径", suggestedPath);
    if (!input) return;

    try {
      const listing = await adminApiClient.createFolder(selectedFolder, input);
      const parentPath = getParentPath(listing.path) ?? listing.path;
      await navigateDirectory(parentPath);
      setStatusText(`已创建目录：${listing.path}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "创建目录失败");
    }
  }

  const editorDirty = openFile !== null && editorValue !== openFile.content;

  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <p className="eyebrow">Octo Local Admin</p>
          <h1>群管理面板</h1>
          <button className="ghost-button" type="button" onClick={() => void refreshGroups()}>
            刷新群列表
          </button>
        </div>

        <div className="group-list">
          {groups.map((group) => (
            <button
              key={group.folder}
              type="button"
              className={`group-card${group.folder === selectedFolder ? " active" : ""}`}
              onClick={() => {
                startTransition(() => {
                  setSelectedFolder(group.folder);
                });
              }}
            >
              <span className="group-name">{group.name}</span>
              <span className="group-meta">{group.folder}</span>
              <span className="group-meta">
                {group.agentProvider}
                {group.isMain ? " · 主群" : ""}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">仅限 localhost</p>
            <h2>{groupDetail?.group.name ?? "未选择群"}</h2>
          </div>
          <div className="status-block">
            <span className="status-text">{isPending ? "切换中..." : statusText}</span>
          </div>
        </header>

        {!groupDetail || !settingsDraft ? (
          <section className="empty-panel">
            <p>请选择一个群，或者先让系统自动注册至少一个群。</p>
          </section>
        ) : (
          <div className="panel-grid">
            <section className="panel settings-panel">
              <div className="panel-title-row">
                <div>
                  <p className="eyebrow">Group Profile</p>
                  <h3>群设置</h3>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={isSavingSettings}
                  onClick={() => void saveSettings()}
                >
                  {isSavingSettings ? "保存中..." : "保存设置"}
                </button>
              </div>

              <label className="field">
                <span>群名称</span>
                <input
                  value={settingsDraft.name}
                  onChange={(event) =>
                    setSettingsDraft((current) => current
                      ? { ...current, name: event.target.value }
                      : current)}
                />
              </label>

              <label className="field">
                <span>AI 引擎</span>
                <select
                  value={settingsDraft.agentProvider}
                  onChange={(event) =>
                    setSettingsDraft((current) => current
                      ? { ...current, agentProvider: event.target.value }
                      : current)}
                >
                  {profiles.map((profile) => (
                    <option key={profile.profileKey} value={profile.profileKey}>
                      {profile.profileKey} · {profile.model}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>触发词</span>
                <input
                  value={settingsDraft.triggerPattern}
                  onChange={(event) =>
                    setSettingsDraft((current) => current
                      ? { ...current, triggerPattern: event.target.value }
                      : current)}
                />
              </label>

              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={settingsDraft.requiresTrigger}
                  onChange={(event) =>
                    setSettingsDraft((current) => current
                      ? { ...current, requiresTrigger: event.target.checked }
                      : current)}
                />
                <span>需要触发词或 @ 才响应</span>
              </label>

              <dl className="readonly-grid">
                <div>
                  <dt>Folder</dt>
                  <dd>{groupDetail.group.folder}</dd>
                </div>
                <div>
                  <dt>Chat ID</dt>
                  <dd>{groupDetail.group.jid}</dd>
                </div>
                <div>
                  <dt>Channel</dt>
                  <dd>{groupDetail.group.channelType}</dd>
                </div>
                <div>
                  <dt>Added</dt>
                  <dd>{new Date(groupDetail.group.addedAt).toLocaleString()}</dd>
                </div>
              </dl>
            </section>

            <section className="panel files-panel">
              <div className="panel-title-row">
                <div>
                  <p className="eyebrow">Workspace</p>
                  <h3>文件浏览</h3>
                </div>
                <div className="button-row">
                  <button className="ghost-button" type="button" onClick={() => void createFolder()}>
                    新建目录
                  </button>
                  <button className="ghost-button" type="button" onClick={() => void createFile()}>
                    新建文件
                  </button>
                </div>
              </div>

              <div className="path-bar">
                <span>{directory?.path ?? "."}</span>
                {directory && getParentPath(directory.path) && (
                  <button className="ghost-button" type="button" onClick={() => void navigateDirectory(getParentPath(directory.path) ?? ".")}>
                    返回上级
                  </button>
                )}
              </div>

              <div className="file-list">
                {directory?.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className={`file-entry${entry.kind === "directory" ? " directory" : ""}${openFile?.path === entry.path ? " active" : ""}`}
                    onClick={() => {
                      if (entry.kind === "directory") {
                        void navigateDirectory(entry.path);
                        return;
                      }
                      void openTextFile(entry.path);
                    }}
                  >
                    <span>{entry.kind === "directory" ? "DIR" : "FILE"}</span>
                    <strong>{entry.name}</strong>
                    <em>{entry.kind === "file" ? `${entry.size ?? 0} B` : "目录"}</em>
                  </button>
                ))}
              </div>
            </section>

            <section className="panel editor-panel">
              <div className="panel-title-row">
                <div>
                  <p className="eyebrow">Text Editor</p>
                  <h3>{openFile?.path ?? "未打开文件"}</h3>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!openFile || !editorDirty || isSavingFile}
                  onClick={() => void saveCurrentFile()}
                >
                  {isSavingFile ? "保存中..." : "保存文件"}
                </button>
              </div>

              {openFile ? (
                <textarea
                  className="editor"
                  value={editorValue}
                  onChange={(event) => setEditorValue(event.target.value)}
                  spellCheck={false}
                />
              ) : (
                <div className="empty-panel">
                  <p>从左侧文件列表选择一个文本文件后，这里会显示内容。</p>
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
