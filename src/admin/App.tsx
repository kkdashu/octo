import { useEffect, useState, useTransition } from "react";
import { adminApiClient } from "./api-client";
import type {
  AdminDirectoryListingDto,
  AdminFileContentDto,
  AdminGroupDetailResponse,
  AdminGroupDto,
  AdminGroupMemoryDto,
  AdminProfileOption,
} from "./types";

type SettingsDraft = {
  name: string;
  triggerPattern: string;
  requiresTrigger: boolean;
  profileKey: string;
};

type MemoryDraft = {
  mode: "create" | "edit";
  key: string;
  keyType: "builtin" | "custom";
  value: string;
};

type AdminSection = "settings" | "memory" | "files";

const BUILTIN_MEMORY_KEYS = [
  "topic_context",
  "response_language",
  "response_style",
  "interaction_rule",
] as const;

const ADMIN_SECTIONS: Array<{ id: AdminSection; label: string }> = [
  { id: "settings", label: "群设置" },
  { id: "memory", label: "群记忆" },
  { id: "files", label: "文件浏览" },
];

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
    profileKey: group.profileKey,
  };
}

function createEmptyMemoryDraft(): MemoryDraft {
  return {
    mode: "create",
    key: "",
    keyType: "builtin",
    value: "",
  };
}

function createMemoryDraft(memory: AdminGroupMemoryDto): MemoryDraft {
  return {
    mode: "edit",
    key: memory.key,
    keyType: memory.keyType,
    value: memory.value,
  };
}

export function App() {
  const [groups, setGroups] = useState<AdminGroupDto[]>([]);
  const [profiles, setProfiles] = useState<AdminProfileOption[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<AdminSection>("settings");
  const [groupDetail, setGroupDetail] = useState<AdminGroupDetailResponse | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft>(createEmptyMemoryDraft());
  const [directory, setDirectory] = useState<AdminDirectoryListingDto | null>(null);
  const [openFile, setOpenFile] = useState<AdminFileContentDto | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [statusText, setStatusText] = useState("正在加载群列表...");
  const [isPending, startTransition] = useTransition();
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSavingMemory, setIsSavingMemory] = useState(false);
  const [isDeletingMemoryKey, setIsDeletingMemoryKey] = useState<string | null>(null);
  const [isSavingFile, setIsSavingFile] = useState(false);

  function applyGroupDetail(detail: AdminGroupDetailResponse) {
    setGroupDetail(detail);
    setSettingsDraft(createSettingsDraft(detail.group));
    setProfiles(detail.availableProfiles);
  }

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
    setActiveSection("settings");
  }

  async function loadGroup(folder: string, path = ".") {
    const [detail, listing] = await Promise.all([
      adminApiClient.getGroup(folder),
      adminApiClient.listFiles(folder, path),
    ]);
    applyGroupDetail(detail);
    setMemoryDraft(createEmptyMemoryDraft());
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
      setMemoryDraft(createEmptyMemoryDraft());
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
      applyGroupDetail(response);
      await refreshGroups();
      setStatusText(`群信息已保存：${response.group.name}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "群信息保存失败");
    } finally {
      setIsSavingSettings(false);
    }
  }

  function startCreateMemory() {
    setMemoryDraft(createEmptyMemoryDraft());
    setStatusText("正在新建群记忆");
  }

  function startEditMemory(memory: AdminGroupMemoryDto) {
    setMemoryDraft(createMemoryDraft(memory));
    setStatusText(`正在编辑群记忆：${memory.key}`);
  }

  async function saveMemory() {
    if (!selectedFolder) return;
    setIsSavingMemory(true);
    try {
      const response = await adminApiClient.upsertMemory(selectedFolder, {
        key: memoryDraft.key,
        keyType: memoryDraft.keyType,
        value: memoryDraft.value,
      });
      applyGroupDetail(response);
      if (memoryDraft.mode === "create") {
        setMemoryDraft(createEmptyMemoryDraft());
      } else {
        const saved = response.memories.find((memory) => memory.key === memoryDraft.key);
        setMemoryDraft(saved ? createMemoryDraft(saved) : createEmptyMemoryDraft());
      }
      setStatusText(`群记忆已保存：${memoryDraft.key}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "群记忆保存失败");
    } finally {
      setIsSavingMemory(false);
    }
  }

  async function removeMemory(memory: AdminGroupMemoryDto) {
    if (!selectedFolder) return;
    const confirmed = window.confirm(`确认删除群记忆 ${memory.key} 吗？`);
    if (!confirmed) return;

    setIsDeletingMemoryKey(memory.key);
    try {
      const response = await adminApiClient.deleteMemory(selectedFolder, memory.key);
      applyGroupDetail(response);
      setMemoryDraft((current) =>
        current.mode === "edit" && current.key === memory.key
          ? createEmptyMemoryDraft()
          : current,
      );
      setStatusText(`已删除群记忆：${memory.key}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "删除群记忆失败");
    } finally {
      setIsDeletingMemoryKey(null);
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
  const builtinMemories = groupDetail?.memories.filter((memory) => memory.keyType === "builtin") ?? [];
  const customMemories = groupDetail?.memories.filter((memory) => memory.keyType === "custom") ?? [];

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
                  setActiveSection("settings");
                });
              }}
            >
              <span className="group-name">{group.name}</span>
              <span className="group-meta">{group.folder}</span>
              <span className="group-meta">
                {group.profileKey}
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
          <div className="content-body">
            <nav className="section-nav">
              <p className="eyebrow">Group Sections</p>
              <div className="section-nav-list">
                {ADMIN_SECTIONS.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className={`section-nav-button${activeSection === section.id ? " active" : ""}`}
                    onClick={() => setActiveSection(section.id)}
                  >
                    {section.label}
                  </button>
                ))}
              </div>
            </nav>

            <section className="section-content">
              {activeSection === "settings" && (
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
                    <span>模型线路</span>
                    <select
                      value={settingsDraft.profileKey}
                      onChange={(event) =>
                        setSettingsDraft((current) => current
                          ? { ...current, profileKey: event.target.value }
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
              )}

              {activeSection === "memory" && (
                <section className="panel memory-panel">
                  <div className="panel-title-row">
                    <div>
                      <p className="eyebrow">Group Memory</p>
                      <h3>群记忆</h3>
                    </div>
                    <div className="button-row">
                      <button className="ghost-button" type="button" onClick={startCreateMemory}>
                        新建记忆
                      </button>
                      <button
                        className="primary-button"
                        type="button"
                        disabled={isSavingMemory}
                        onClick={() => void saveMemory()}
                      >
                        {isSavingMemory ? "保存中..." : "保存记忆"}
                      </button>
                    </div>
                  </div>

                  <div className="memory-layout">
                    <div className="memory-list-card">
                      {groupDetail.memories.length === 0 ? (
                        <div className="empty-panel compact-empty">
                          <p>当前群还没有长期记忆。</p>
                        </div>
                      ) : (
                        <div className="memory-list">
                          <div className="memory-group">
                            <div className="memory-group-title">Builtin</div>
                            {builtinMemories.length === 0 ? (
                              <p className="memory-group-empty">暂无 builtin 记忆</p>
                            ) : (
                              builtinMemories.map((memory) => (
                                <article key={memory.key} className="memory-item">
                                  <div className="memory-item-header">
                                    <div className="memory-title-block">
                                      <strong>{memory.key}</strong>
                                      <span className={`memory-badge ${memory.keyType}`}>
                                        {memory.keyType}
                                      </span>
                                    </div>
                                    <div className="button-row">
                                      <button
                                        className="ghost-button"
                                        type="button"
                                        onClick={() => startEditMemory(memory)}
                                      >
                                        编辑
                                      </button>
                                      <button
                                        className="ghost-button danger-button"
                                        type="button"
                                        disabled={isDeletingMemoryKey === memory.key}
                                        onClick={() => void removeMemory(memory)}
                                      >
                                        {isDeletingMemoryKey === memory.key ? "删除中..." : "删除"}
                                      </button>
                                    </div>
                                  </div>
                                  <p className="memory-value">{memory.value}</p>
                                  <p className="memory-meta">
                                    更新于 {new Date(memory.updatedAt).toLocaleString()}
                                  </p>
                                </article>
                              ))
                            )}
                          </div>

                          <div className="memory-group">
                            <div className="memory-group-title">Custom</div>
                            {customMemories.length === 0 ? (
                              <p className="memory-group-empty">暂无 custom 记忆</p>
                            ) : (
                              customMemories.map((memory) => (
                                <article key={memory.key} className="memory-item">
                                  <div className="memory-item-header">
                                    <div className="memory-title-block">
                                      <strong>{memory.key}</strong>
                                      <span className={`memory-badge ${memory.keyType}`}>
                                        {memory.keyType}
                                      </span>
                                    </div>
                                    <div className="button-row">
                                      <button
                                        className="ghost-button"
                                        type="button"
                                        onClick={() => startEditMemory(memory)}
                                      >
                                        编辑
                                      </button>
                                      <button
                                        className="ghost-button danger-button"
                                        type="button"
                                        disabled={isDeletingMemoryKey === memory.key}
                                        onClick={() => void removeMemory(memory)}
                                      >
                                        {isDeletingMemoryKey === memory.key ? "删除中..." : "删除"}
                                      </button>
                                    </div>
                                  </div>
                                  <p className="memory-value">{memory.value}</p>
                                  <p className="memory-meta">
                                    更新于 {new Date(memory.updatedAt).toLocaleString()}
                                  </p>
                                </article>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="memory-editor-card">
                      <div className="memory-editor-header">
                        <p className="eyebrow">Memory Editor</p>
                        <h4>{memoryDraft.mode === "create" ? "新建记忆" : `编辑 ${memoryDraft.key}`}</h4>
                      </div>

                      <p className="memory-hint">
                        优先使用 builtin key：
                        {" "}
                        {BUILTIN_MEMORY_KEYS.join(", ")}
                        。只有 builtin key 不够表达时才使用 custom key。
                      </p>

                      <label className="field">
                        <span>Key</span>
                        <input
                          value={memoryDraft.key}
                          readOnly={memoryDraft.mode === "edit"}
                          onChange={(event) =>
                            setMemoryDraft((current) => ({
                              ...current,
                              key: event.target.value,
                            }))}
                        />
                      </label>

                      <label className="field">
                        <span>Key Type</span>
                        <select
                          value={memoryDraft.keyType}
                          disabled={memoryDraft.mode === "edit"}
                          onChange={(event) =>
                            setMemoryDraft((current) => ({
                              ...current,
                              keyType: event.target.value as "builtin" | "custom",
                            }))}
                        >
                          <option value="builtin">builtin</option>
                          <option value="custom">custom</option>
                        </select>
                      </label>

                      <label className="field">
                        <span>Value</span>
                        <textarea
                          className="memory-editor"
                          value={memoryDraft.value}
                          onChange={(event) =>
                            setMemoryDraft((current) => ({
                              ...current,
                              value: event.target.value,
                            }))}
                        />
                      </label>
                    </div>
                  </div>
                </section>
              )}

              {activeSection === "files" && (
                <div className="workspace-grid">
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
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => void navigateDirectory(getParentPath(directory.path) ?? ".")}
                        >
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
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
