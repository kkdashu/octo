import { useEffect, useState, useTransition } from "react";
import { DesktopAdminClient } from "../lib/admin-client";
import type {
  AdminDirectoryListingDto,
  AdminFileContentDto,
  AdminGroupDetailResponse,
  AdminGroupDto,
  AdminGroupMemoryDto,
  AdminProfileOption,
} from "../lib/admin-types";

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

interface AdminPageProps {
  sidecarBaseUrl: string;
}

export function AdminPage(props: AdminPageProps) {
  const [client] = useState(() => new DesktopAdminClient(props.sidecarBaseUrl));
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
    const response = await client.listGroups();
    setGroups(response.groups);
    setProfiles(response.availableProfiles);

    if (response.groups.length === 0) {
      setSelectedFolder(null);
      setStatusText("当前还没有已注册群。");
      return;
    }

    if (
      preserveSelection
      && selectedFolder
      && response.groups.some((group) => group.folder === selectedFolder)
    ) {
      return;
    }

    setSelectedFolder(response.groups[0]!.folder);
    setActiveSection("settings");
  }

  async function loadGroup(folder: string, path = ".") {
    const [detail, listing] = await Promise.all([
      client.getGroup(folder),
      client.listFiles(folder, path),
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
    if (!selectedFolder) {
      return;
    }

    try {
      const listing = await client.listFiles(selectedFolder, path);
      setDirectory(listing);
      setStatusText(`当前目录：${listing.path}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "目录加载失败");
    }
  }

  async function openTextFile(path: string) {
    if (!selectedFolder) {
      return;
    }

    try {
      const file = await client.getFile(selectedFolder, path);
      setOpenFile(file);
      setEditorValue(file.content);
      setStatusText(`已打开文件：${file.path}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "文件读取失败");
    }
  }

  async function saveSettings() {
    if (!selectedFolder || !settingsDraft) {
      return;
    }

    setIsSavingSettings(true);
    try {
      const response = await client.updateGroup(selectedFolder, settingsDraft);
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
    if (!selectedFolder) {
      return;
    }

    setIsSavingMemory(true);
    try {
      const response = await client.upsertMemory(selectedFolder, {
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
    if (!selectedFolder) {
      return;
    }

    const confirmed = window.confirm(`确认删除群记忆 ${memory.key} 吗？`);
    if (!confirmed) {
      return;
    }

    setIsDeletingMemoryKey(memory.key);
    try {
      const response = await client.deleteMemory(selectedFolder, memory.key);
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
    if (!selectedFolder || !openFile) {
      return;
    }

    setIsSavingFile(true);
    try {
      const updated = await client.updateFile(selectedFolder, openFile.path, editorValue);
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
    if (!selectedFolder) {
      return;
    }

    const suggestedPath = directory?.path === "." || !directory ? "" : `${directory.path}/`;
    const input = window.prompt("输入新文件路径", suggestedPath);
    if (!input) {
      return;
    }

    try {
      const file = await client.createFile(selectedFolder, input, "", true);
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
    if (!selectedFolder) {
      return;
    }

    const suggestedPath = directory?.path === "." || !directory ? "" : `${directory.path}/`;
    const input = window.prompt("输入新目录路径", suggestedPath);
    if (!input) {
      return;
    }

    try {
      const listing = await client.createFolder(selectedFolder, input);
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
    <div className="admin-page">
      <header className="admin-page-header">
        <div>
          <p className="eyebrow">Octo Desktop Admin</p>
          <h1>{groupDetail?.group.name ?? "群管理"}</h1>
        </div>
        <div className="admin-page-status">
          <span className="status-pill status-pill-idle">
            {isPending ? "切换中..." : statusText}
          </span>
        </div>
      </header>

      <div className="admin-page-body">
        <aside className="admin-groups-panel">
          <div className="admin-panel-heading">
            <div>
              <p className="eyebrow">Registered Groups</p>
              <h2>管理对象</h2>
            </div>
            <button
              className="button-secondary"
              type="button"
              onClick={() => void refreshGroups()}
            >
              刷新群列表
            </button>
          </div>

          <div className="admin-group-list">
            {groups.length === 0 ? (
              <div className="empty-card">
                <h3>还没有可管理的群</h3>
                <p>先在左侧创建一个 group，或等待系统自动注册群。</p>
              </div>
            ) : (
              groups.map((group) => (
                <button
                  key={group.folder}
                  type="button"
                  className={`admin-group-card${group.folder === selectedFolder ? " admin-group-card-active" : ""}`}
                  onClick={() => {
                    startTransition(() => {
                      setSelectedFolder(group.folder);
                      setActiveSection("settings");
                    });
                  }}
                >
                  <div className="admin-group-card-header">
                    <strong>{group.name}</strong>
                    {group.isMain ? <span className="group-badge">MAIN</span> : null}
                  </div>
                  <div className="admin-group-card-meta">{group.folder}</div>
                  <div className="admin-group-card-meta">
                    {group.profileKey}
                    {group.requiresTrigger ? " · 需触发" : " · 直接响应"}
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="admin-main">
          {!groupDetail || !settingsDraft ? (
            <div className="admin-empty-state">
              <div className="empty-card">
                <h3>请选择一个群</h3>
                <p>选中左侧群后，就可以调整设置、编辑记忆和管理文件。</p>
              </div>
            </div>
          ) : (
            <div className="admin-detail-layout">
              <nav className="admin-section-nav">
                <p className="eyebrow">Admin Sections</p>
                <div className="admin-section-nav-list">
                  {ADMIN_SECTIONS.map((section) => (
                    <button
                      key={section.id}
                      type="button"
                      className={`admin-section-button${activeSection === section.id ? " active" : ""}`}
                      onClick={() => setActiveSection(section.id)}
                    >
                      {section.label}
                    </button>
                  ))}
                </div>
              </nav>

              <div className="admin-section-content">
                {activeSection === "settings" ? (
                  <section className="admin-panel">
                    <div className="admin-panel-heading">
                      <div>
                        <p className="eyebrow">Group Profile</p>
                        <h2>群设置</h2>
                      </div>
                      <button
                        className="button-primary"
                        type="button"
                        disabled={isSavingSettings}
                        onClick={() => void saveSettings()}
                      >
                        {isSavingSettings ? "保存中..." : "保存设置"}
                      </button>
                    </div>

                    <label className="admin-field">
                      <span>群名称</span>
                      <input
                        value={settingsDraft.name}
                        onChange={(event) =>
                          setSettingsDraft((current) => current
                            ? { ...current, name: event.target.value }
                            : current)}
                      />
                    </label>

                    <label className="admin-field">
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
                            {profile.profileKey}
                            {" · "}
                            {profile.model}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="admin-field">
                      <span>触发词</span>
                      <input
                        value={settingsDraft.triggerPattern}
                        onChange={(event) =>
                          setSettingsDraft((current) => current
                            ? { ...current, triggerPattern: event.target.value }
                            : current)}
                      />
                    </label>

                    <label className="admin-checkbox">
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

                    <dl className="admin-readonly-grid">
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
                ) : null}

                {activeSection === "memory" ? (
                  <section className="admin-panel">
                    <div className="admin-panel-heading">
                      <div>
                        <p className="eyebrow">Group Memory</p>
                        <h2>群记忆</h2>
                      </div>
                      <div className="admin-button-row">
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={startCreateMemory}
                        >
                          新建记忆
                        </button>
                        <button
                          className="button-primary"
                          type="button"
                          disabled={isSavingMemory}
                          onClick={() => void saveMemory()}
                        >
                          {isSavingMemory ? "保存中..." : "保存记忆"}
                        </button>
                      </div>
                    </div>

                    <div className="admin-memory-layout">
                      <div className="admin-memory-list">
                        <div className="admin-memory-group">
                          <div className="admin-memory-group-title">Builtin</div>
                          {builtinMemories.length === 0 ? (
                            <p className="admin-memory-empty">暂无 builtin 记忆</p>
                          ) : (
                            builtinMemories.map((memory) => (
                              <article key={memory.key} className="admin-memory-item">
                                <div className="admin-memory-item-header">
                                  <div className="admin-memory-title">
                                    <strong>{memory.key}</strong>
                                    <span className="admin-memory-badge">{memory.keyType}</span>
                                  </div>
                                  <div className="admin-button-row">
                                    <button
                                      className="button-secondary"
                                      type="button"
                                      onClick={() => startEditMemory(memory)}
                                    >
                                      编辑
                                    </button>
                                    <button
                                      className="button-danger"
                                      type="button"
                                      disabled={isDeletingMemoryKey === memory.key}
                                      onClick={() => void removeMemory(memory)}
                                    >
                                      {isDeletingMemoryKey === memory.key ? "删除中..." : "删除"}
                                    </button>
                                  </div>
                                </div>
                                <p className="admin-memory-value">{memory.value}</p>
                                <p className="admin-memory-meta">
                                  更新于 {new Date(memory.updatedAt).toLocaleString()}
                                </p>
                              </article>
                            ))
                          )}
                        </div>

                        <div className="admin-memory-group">
                          <div className="admin-memory-group-title">Custom</div>
                          {customMemories.length === 0 ? (
                            <p className="admin-memory-empty">暂无 custom 记忆</p>
                          ) : (
                            customMemories.map((memory) => (
                              <article key={memory.key} className="admin-memory-item">
                                <div className="admin-memory-item-header">
                                  <div className="admin-memory-title">
                                    <strong>{memory.key}</strong>
                                    <span className="admin-memory-badge">{memory.keyType}</span>
                                  </div>
                                  <div className="admin-button-row">
                                    <button
                                      className="button-secondary"
                                      type="button"
                                      onClick={() => startEditMemory(memory)}
                                    >
                                      编辑
                                    </button>
                                    <button
                                      className="button-danger"
                                      type="button"
                                      disabled={isDeletingMemoryKey === memory.key}
                                      onClick={() => void removeMemory(memory)}
                                    >
                                      {isDeletingMemoryKey === memory.key ? "删除中..." : "删除"}
                                    </button>
                                  </div>
                                </div>
                                <p className="admin-memory-value">{memory.value}</p>
                                <p className="admin-memory-meta">
                                  更新于 {new Date(memory.updatedAt).toLocaleString()}
                                </p>
                              </article>
                            ))
                          )}
                        </div>
                      </div>

                      <div className="admin-panel admin-editor-panel">
                        <div className="admin-panel-heading">
                          <div>
                            <p className="eyebrow">Memory Editor</p>
                            <h2>{memoryDraft.mode === "create" ? "新建记忆" : `编辑 ${memoryDraft.key}`}</h2>
                          </div>
                        </div>

                        <p className="admin-helper-text">
                          优先使用 builtin key：
                          {" "}
                          {BUILTIN_MEMORY_KEYS.join(", ")}
                          。只有 builtin key 不够表达时才使用 custom key。
                        </p>

                        <label className="admin-field">
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

                        <label className="admin-field">
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

                        <label className="admin-field">
                          <span>Value</span>
                          <textarea
                            className="admin-memory-editor"
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
                ) : null}

                {activeSection === "files" ? (
                  <div className="admin-files-layout">
                    <section className="admin-panel">
                      <div className="admin-panel-heading">
                        <div>
                          <p className="eyebrow">Workspace</p>
                          <h2>文件浏览</h2>
                        </div>
                        <div className="admin-button-row">
                          <button
                            className="button-secondary"
                            type="button"
                            onClick={() => void createFolder()}
                          >
                            新建目录
                          </button>
                          <button
                            className="button-secondary"
                            type="button"
                            onClick={() => void createFile()}
                          >
                            新建文件
                          </button>
                        </div>
                      </div>

                      <div className="admin-path-bar">
                        <span>{directory?.path ?? "."}</span>
                        {directory && getParentPath(directory.path) ? (
                          <button
                            className="button-secondary"
                            type="button"
                            onClick={() => void navigateDirectory(getParentPath(directory.path) ?? ".")}
                          >
                            返回上级
                          </button>
                        ) : null}
                      </div>

                      <div className="admin-file-list">
                        {directory?.entries.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            className={`admin-file-entry${entry.kind === "directory" ? " admin-file-entry-directory" : ""}${openFile?.path === entry.path ? " admin-file-entry-active" : ""}`}
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

                    <section className="admin-panel">
                      <div className="admin-panel-heading">
                        <div>
                          <p className="eyebrow">Text Editor</p>
                          <h2>{openFile?.path ?? "未打开文件"}</h2>
                        </div>
                        <button
                          className="button-primary"
                          type="button"
                          disabled={!openFile || !editorDirty || isSavingFile}
                          onClick={() => void saveCurrentFile()}
                        >
                          {isSavingFile ? "保存中..." : "保存文件"}
                        </button>
                      </div>

                      {openFile ? (
                        <textarea
                          className="admin-editor"
                          value={editorValue}
                          onChange={(event) => setEditorValue(event.target.value)}
                          spellCheck={false}
                        />
                      ) : (
                        <div className="admin-empty-state admin-empty-state-compact">
                          <div className="empty-card">
                            <h3>未打开文件</h3>
                            <p>从左侧文件列表选择一个文本文件后，这里会显示内容。</p>
                          </div>
                        </div>
                      )}
                    </section>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
