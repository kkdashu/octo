# Chat Session 单一真相源收敛

## 问题定义

当前代码中同时存在两套 session 归属模型：

1. `chats.session_ref`：表示某个 chat 当前绑定的 Pi session 文件。
2. `sessions(group_folder -> session_ref)`：表示某个 workspace/group folder 当前绑定的 Pi session 文件。

在当前产品定义里，真实语义已经明确为：

- 一个 `workspace` 下有多个 `chat`
- 一个 `chat` 在任意时刻有一个“当前 session”
- 用户在 chat 内执行 `/new` 时，是当前 chat 切换到新的 session 文件

因此 `sessions` 表表达的是错误层级。它仍然存在会带来以下问题：

1. 基数不一致：`chat -> session` 是多条记录，`workspace -> session` 只有一条记录，无法表达同一个 workspace 下多个 chat 的真实状态。
2. 写入串扰：旧代码通过 `group_folder` 写 `sessions` 后，再回写该 workspace 的“第一个 chat”，这会把别的 chat 的 session 覆盖掉。
3. 读取歧义：只要某条路径没有显式传入 `chat.session_ref`，就会退回去读 `sessions`，导致把 workspace 级旧 session 当成 chat 当前 session。
4. 后续能力受限：session history、恢复、审计、chat 内 session 切换轨迹都无法在双真相源模型下稳定实现。

本次目标是把 session 的唯一真相源收敛到 `chats.session_ref`，删除所有仍把 session 视为 workspace/group 级别状态的代码。

## 对现有项目的影响

### 数据库

受影响文件：

- `src/db.ts`
- `scripts/reset-workspace-chat-state.ts`
- 相关测试

影响点：

1. 删除 `sessions` 表初始化与相关 helper：
   - `getSessionRef`
   - `saveSessionRef`
   - `deleteSessionRef`
   - `clearAllSessionRefs`
2. 删除 legacy group -> workspace/chat 迁移时对 `sessions` 表的兜底读取。
3. 清理测试和脚本里对 `sessions` 表的插入、查询和清空逻辑。

### Runtime / Session 恢复

受影响文件：

- `src/runtime/pi-group-runtime-factory.ts`
- `src/runtime/feishu-group-adapter.ts`
- `src/kernel/group-runtime-manager.ts`
- `src/group-queue.ts`

影响点：

1. Pi runtime factory 不能再默认从 `group_folder` 读取 session。
2. Feishu adapter 不能再在持久化 chat session 时双写 `sessions` 表。
3. 旧 `group-queue` 路径目前仍完全基于 `groupFolder -> sessionRef`，需要明确收敛策略。

### 旧模型兼容层

受影响文件：

- `src/db.ts`
- `src/cli/octo-cli-runtime-host.ts`
- `src/cli/octo-group-extension.ts`

影响点：

1. `switchGroup(group.folder)` 这类接口仍保留 group/workspace 入口，但不能再依赖 workspace 级 session。
2. 兼容 legacy `registered_groups` 的代码，如果仍要保留，也只能把 group 视为“定位 workspace/chat 的外部入口”，不能再承载 session 状态。

## 当前仍把 session 视为 workspace/group 的位置

### 1. 数据库层直接建模为 `group_folder -> session_ref`

文件：

- `src/db.ts`

现状：

- `sessions` 表定义为：

```sql
CREATE TABLE IF NOT EXISTS sessions (
  group_folder TEXT PRIMARY KEY,
  session_ref TEXT NOT NULL
)
```

问题：

- 这是 workspace/group 级唯一约束，无法表达一个 workspace 下多个 chat。

### 2. `saveSessionRef()` 会把 workspace 级 session 回写到“第一个 chat”

文件：

- `src/db.ts`

现状：

```ts
const workspace = getWorkspaceByFolder(db, folder);
if (workspace) {
  const chat = listChatsForWorkspace(db, workspace.id)[0] ?? null;
  if (chat) {
    updateChat(db, chat.id, { sessionRef });
  }
}
```

问题：

- 写入目标不是当前 chat，而是该 workspace 的第一个 chat。
- 只要 workspace 下有多个 chat，就可能写错对象。

### 3. Pi runtime factory 默认从 `group_folder` 读取 session

文件：

- `src/runtime/pi-group-runtime-factory.ts`

现状：

- `resolveGroupSessionRef()` 当前逻辑：
  - 优先读 `sessionRefOverride`
  - 否则回退到 `getSessionRef(db, groupFolder)`
  - 校验后再写回 `saveSessionRef(db, groupFolder, ...)`

问题：

- 这让 runtime 的默认行为仍然是“workspace 拥有当前 session”。
- 即便新路径显式传了 `chat.session_ref`，也仍保留错误的 fallback。

### 4. Feishu adapter 仍然双写 `chat.session_ref` 和 `sessions`

文件：

- `src/runtime/feishu-group-adapter.ts`

现状：

```ts
updateChat(this.options.db, chatId, { sessionRef, ... });
if (sessionRef) {
  saveSessionRef(this.options.db, workspace.folder, sessionRef);
}
```

问题：

- 运行时表面上以 chat 为单位，底层又同步写一份 workspace 级 session。
- 这会让旧路径继续读到一个并不可靠的 workspace 当前 session。

### 5. `group-queue` 仍完全以 `groupFolder` 为 session 主键

文件：

- `src/group-queue.ts`

现状：

- `activeConversations`、`sessionGenerations`、`clearSession()`、`openConversation()` 都基于 `groupFolder`
- 持久化和恢复都使用：
  - `getSessionRef(this.db, groupFolder)`
  - `saveSessionRef(this.db, groupFolder, ...)`
  - `deleteSessionRef(this.db, groupFolder)`

问题：

- 这是完整的旧模型残留。
- 如果这条路径还会被实际调用，它会持续把 session 当成 workspace 级状态。

### 6. legacy 迁移/兼容逻辑仍会从 `sessions` 表补 chat.session_ref

文件：

- `src/db.ts`

现状：

- `ensureLegacyChatRecord()` 中会读取 `getSessionRef(db, group.folder)` 作为 `migratedSessionRef`

问题：

- 这意味着 legacy group -> chat 的收敛过程里，session 仍来自 workspace/group 级来源。
- 本次既然明确不再保留该模型，应同步移除。

### 7. 测试仍把 `sessions` 表当成断言目标

受影响测试：

- `tests/feishu-group-adapter.test.ts`
- `tests/group-queue.test.ts`
- `tests/group-memory.test.ts`
- `tests/runtime.test.ts`
- `tests/reset-workspace-chat-state.test.ts`
- `tests/octo-cli-runtime-host.test.ts`

问题：

- 这些测试会把错误模型继续固化在代码库里。

## 实现方案

### 方案总览

将 session 收敛为 chat 级单一真相源：

1. 保留 `chats.session_ref` 作为唯一持久化位置。
2. 删除 `sessions` 表以及所有 helper。
3. runtime 创建、恢复、清理统一只接受/更新 `chat.session_ref`。
4. 所有仍以 `groupFolder` 为主键管理 session 的路径，要么：
   - 改为先解析到具体 chat，再按 chat 管理
   - 要么在确认已废弃后直接删除

### 具体改动

#### 1. 数据库收敛

修改文件：

- `src/db.ts`

计划：

1. 删除 `sessions` 表初始化代码。
2. 删除以下导出函数：
   - `getSessionRef`
   - `saveSessionRef`
   - `deleteSessionRef`
   - `clearAllSessionRefs`
3. 删除任何“通过 workspace 找第一个 chat 再同步 session”的桥接逻辑。
4. 调整 legacy 迁移逻辑，不再从 `sessions` 表补 session。

示意代码：

```ts
export function updateChatSessionRef(
  db: Database,
  chatId: string,
  sessionRef: string | null,
): void {
  updateChat(db, chatId, {
    sessionRef,
    lastActivityAt: new Date().toISOString(),
  });
}
```

注：

- 如果后续觉得需要单独 helper，可以新增 chat 级 helper；但不会再保留 workspace 级 helper。

#### 2. Pi runtime factory 去掉 workspace 级 fallback

修改文件：

- `src/runtime/pi-group-runtime-factory.ts`

计划：

1. 将 `resolveGroupSessionRef()` 改造成只处理“传入的 session ref + 本地文件校验”，不再从数据库按 `groupFolder` 查 session。
2. 去掉 `persistSessionRef` 选项及其相关双写逻辑。
3. `createPiGroupRuntime()` / `createPiGroupSessionHost()` 只返回 runtime 当前 sessionRef，由调用方决定如何写回具体 chat。

示意代码：

```ts
export function resolveSessionRefForChat(
  workingDirectory: string,
  sessionRef: string | null | undefined,
): string {
  const resolved = resolvePersistedPiSessionRef(workingDirectory, sessionRef);
  if (resolved) return resolved;

  if (sessionRef) {
    return isAbsolute(sessionRef) ? sessionRef : resolve(workingDirectory, sessionRef);
  }

  const sessionManager = SessionManager.continueRecent(
    workingDirectory,
    ensurePiSessionDir(workingDirectory),
  );
  return getPiSessionRef(sessionManager);
}
```

#### 3. Feishu adapter 只写 chat，不再写 workspace session

修改文件：

- `src/runtime/feishu-group-adapter.ts`

计划：

1. 删除 `persistSessionRef()` 中对 `saveSessionRef()` 的调用。
2. 保留 `updateChat(...sessionRef...)`。
3. clear/new session 流程只操作当前 chat。

#### 4. GroupRuntimeManager 保持 chat 级语义

修改文件：

- `src/kernel/group-runtime-manager.ts`

计划：

1. 保持现有 `managed.chat.id -> session_ref` 持久化逻辑。
2. 清理任何残留的 workspace/session 桥接参数，确保 manager 是 chat 级 runtime 控制器。

说明：

- 这一块当前已经接近目标状态，改动应较小，主要是配合 runtime factory 参数收敛。

#### 5. 处理 `group-queue`

修改文件：

- `src/group-queue.ts`
- 或相关调用方

这里需要按当前代码实际用途收敛，方案如下：

1. 如果 `group-queue` 已不是主路径，仅保留 legacy/待淘汰状态：
   - 从生产调用链中确认是否仍在使用
   - 若未使用，直接删除其 workspace 级 session 持久化逻辑，必要时整体删除该模块及测试
2. 如果 `group-queue` 仍被某些路径依赖：
   - 则必须先引入“由 groupFolder 解析到 chat”的映射
   - 后续所有 active conversation / session generation / clear session 都改为按 `chatId`

当前倾向：

- 优先删除其 workspace 级 session 持久化逻辑；
- 若该模块仍是旧 runtime 路径核心，则本次一并做 chat 化改造，不保留中间态。

#### 6. 调整测试

修改文件：

- `tests/feishu-group-adapter.test.ts`
- `tests/pi-group-runtime-factory.test.ts`
- `tests/group-runtime-manager.test.ts`
- `tests/group-queue.test.ts`
- `tests/group-memory.test.ts`
- `tests/runtime.test.ts`
- `tests/reset-workspace-chat-state.test.ts`
- `tests/octo-cli-runtime-host.test.ts`

计划：

1. 所有 session 断言都改为检查 `chat.session_ref`。
2. 删除所有对 `sessions` 表的 SQL 断言。
3. 为多 chat 场景补测试，验证一个 chat 更新 session 不会影响同 workspace 下其他 chat。

## 风险与注意事项

1. `group-queue` 是否仍在生产路径中使用，需要在实现前再次确认调用链。
2. 旧数据库里即便还残留 `sessions` 表，本次也不再读取它；这符合“删除错误模型”的方向，但要确认不会影响当前已有的本地测试夹具。
3. `registered_groups` 仍然存在时，group 只能作为入口标识存在，不能再承担 session 持久化职责。
4. 任何仍接受 `groupFolder` 入参的 session API，都必须在内部先解析到具体 chat，否则模型会再次漂移。

## Todo List

- [x] 梳理并确认 `group-queue` 是否仍在当前主调用链中使用
- [x] 删除 `src/db.ts` 中 `sessions` 表初始化与相关 helper
- [x] 删除 legacy 迁移/兼容逻辑中对 `sessions` 的读取与回填
- [x] 重构 `src/runtime/pi-group-runtime-factory.ts`，移除 workspace 级 session fallback 和双写逻辑
- [x] 修改 `src/runtime/feishu-group-adapter.ts`，只持久化 `chat.session_ref`
- [x] 清理 `src/kernel/group-runtime-manager.ts` 中与旧 session 持久化接口耦合的部分
- [x] 按确认结果改造或删除 `src/group-queue.ts` 的 workspace 级 session 逻辑
- [x] 更新受影响测试，移除对 `sessions` 表的断言
- [x] 补充多 chat 同 workspace 的 session 隔离测试
- [x] 运行相关测试并修正失败用例
